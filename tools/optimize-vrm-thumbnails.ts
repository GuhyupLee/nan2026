/**
 * Surgically replaces a VRM 1.0 metadata thumbnail with a fixed 1x1 PNG.
 *
 * The tool deliberately does not run a glTF exporter. It preserves every
 * non-thumbnail BIN byte and every JSON value except:
 *   - buffers[0].byteLength
 *   - the thumbnail bufferView byteLength
 *   - byteOffset of bufferViews after the removed thumbnail payload
 *
 * Usage:
 *   npx tsx tools/optimize-vrm-thumbnails.ts             # dry run
 *   npx tsx tools/optimize-vrm-thumbnails.ts --write     # allowed models only
 *   npx tsx tools/optimize-vrm-thumbnails.ts --check     # fail if not optimized
 *   npx tsx tools/optimize-vrm-thumbnails.ts --write path/to/avatar.vrm
 */

import { deepStrictEqual } from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const GLB_MAGIC = 0x46546c67
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

const DEFAULT_MODELS = [
  'public/models/ilhyeon.vrm',
  'public/models/wola.vrm',
] as const

/**
 * Fixed, valid 1x1 PNG (grayscale + alpha), embedded rather than generated so
 * output is byte-for-byte reproducible across sharp/libpng versions.
 */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

interface GlbBuffer {
  byteLength: number
  uri?: string
  [key: string]: unknown
}

interface GlbBufferView {
  buffer: number
  byteOffset?: number
  byteLength: number
  [key: string]: unknown
}

interface GlbImage {
  name?: string
  bufferView?: number
  mimeType?: string
  uri?: string
  [key: string]: unknown
}

interface VrmJson {
  buffers?: GlbBuffer[]
  bufferViews?: GlbBufferView[]
  images?: GlbImage[]
  textures?: unknown[]
  accessors?: unknown[]
  extensions?: {
    VRMC_vrm?: {
      meta?: {
        thumbnailImage?: number
        [key: string]: unknown
      }
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface ParsedGlb {
  bytes: Buffer
  json: VrmJson
  jsonText: string
  jsonChunkLength: number
  bin: Buffer
  binChunkLength: number
}

interface ThumbnailContext {
  imageIndex: number
  viewIndex: number
  viewOffset: number
  viewLength: number
  oldSpan: number
  bufferLength: number
}

interface LicenseSummary {
  avatarPermission?: unknown
  commercialUsage?: unknown
  creditNotation?: unknown
  allowRedistribution?: unknown
  modification?: unknown
  reasons: string[]
  restricted: boolean
}

interface Optimization {
  output: Buffer
  before: ParsedGlb
  after: ParsedGlb
  context: ThumbnailContext
  changed: boolean
}

type CliMode = 'dry-run' | 'write' | 'check'

function fail(message: string): never {
  throw new Error(message)
}

function align4(value: number): number {
  return (value + 3) & ~3
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireInteger(
  value: unknown,
  label: string,
  minimum = 0,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    fail(`${label} must be an integer >= ${minimum}`)
  }
  return value as number
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  let cursor = 0
  while (true) {
    const found = text.indexOf(needle, cursor)
    if (found < 0) return count
    count += 1
    cursor = found + needle.length
  }
}

function replaceExactJsonValue(
  text: string,
  key: string,
  before: unknown,
  after: unknown,
): string {
  const needle = `${JSON.stringify(key)}:${JSON.stringify(before)}`
  const replacement = `${JSON.stringify(key)}:${JSON.stringify(after)}`
  const count = countOccurrences(text, needle)
  if (count !== 1) {
    fail(
      `Refusing to rewrite JSON: expected one exact ${key} array, found ${count}`,
    )
  }
  return text.replace(needle, replacement)
}

function parseGlb(bytes: Buffer, label: string): ParsedGlb {
  if (bytes.length < 28) fail(`${label}: file is too small to be a GLB`)
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) fail(`${label}: invalid GLB magic`)
  if (bytes.readUInt32LE(4) !== 2) fail(`${label}: only GLB version 2 is supported`)
  if (bytes.readUInt32LE(8) !== bytes.length) {
    fail(`${label}: header totalLength does not match the file length`)
  }

  const jsonLength = bytes.readUInt32LE(12)
  const jsonType = bytes.readUInt32LE(16)
  if (jsonType !== JSON_CHUNK) fail(`${label}: first chunk is not JSON`)
  if (jsonLength % 4 !== 0) fail(`${label}: JSON chunk is not 4-byte aligned`)
  const jsonStart = 20
  const jsonEnd = jsonStart + jsonLength
  if (jsonEnd + 8 > bytes.length) fail(`${label}: truncated JSON chunk`)

  const binLength = bytes.readUInt32LE(jsonEnd)
  const binType = bytes.readUInt32LE(jsonEnd + 4)
  if (binType !== BIN_CHUNK) fail(`${label}: second chunk is not BIN`)
  if (binLength % 4 !== 0) fail(`${label}: BIN chunk is not 4-byte aligned`)
  const binStart = jsonEnd + 8
  const binEnd = binStart + binLength
  if (binEnd !== bytes.length) {
    fail(`${label}: expected exactly one JSON and one BIN chunk`)
  }

  const jsonChunk = bytes.subarray(jsonStart, jsonEnd)
  let contentLength = jsonChunk.length
  while (contentLength > 0 && jsonChunk[contentLength - 1] === 0x20) {
    contentLength -= 1
  }
  for (let i = contentLength; i < jsonChunk.length; i += 1) {
    if (jsonChunk[i] !== 0x20) fail(`${label}: invalid JSON chunk padding`)
  }
  const jsonText = jsonChunk.subarray(0, contentLength).toString('utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonText)
  } catch (error) {
    fail(`${label}: JSON parse failed: ${String(error)}`)
  }
  if (!isRecord(parsed)) fail(`${label}: GLB JSON root is not an object`)
  const json = parsed as VrmJson

  const buffer = json.buffers?.[0]
  const bufferLength = requireInteger(
    buffer?.byteLength,
    `${label}: buffers[0].byteLength`,
  )
  if (json.buffers?.length !== 1 || buffer?.uri !== undefined) {
    fail(`${label}: only one embedded buffer is supported`)
  }
  if (binLength < bufferLength || binLength - bufferLength > 3) {
    fail(`${label}: BIN chunk length is incompatible with buffers[0]`)
  }
  for (let i = bufferLength; i < binLength; i += 1) {
    if (bytes[binStart + i] !== 0) fail(`${label}: non-zero BIN chunk padding`)
  }

  return {
    bytes,
    json,
    jsonText,
    jsonChunkLength: jsonLength,
    bin: bytes.subarray(binStart, binEnd),
    binChunkLength: binLength,
  }
}

function collectKeyValuePaths(
  value: unknown,
  key: string,
  target: number,
  path = '$',
  out: string[] = [],
): string[] {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      collectKeyValuePaths(value[i], key, target, `${path}[${i}]`, out)
    }
    return out
  }
  if (!isRecord(value)) return out
  for (const [childKey, child] of Object.entries(value)) {
    const childPath = `${path}.${childKey}`
    if (childKey === key && child === target) out.push(childPath)
    collectKeyValuePaths(child, key, target, childPath, out)
  }
  return out
}

function validatePng(bytes: Uint8Array, label: string): {
  width: number
  height: number
} {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10] as const
  if (bytes.length < 33) fail(`${label}: PNG is too small`)
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) fail(`${label}: invalid PNG signature`)
  }
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let cursor = 8
  let width = 0
  let height = 0
  let chunkIndex = 0
  let foundEnd = false
  while (cursor < data.length) {
    if (cursor + 12 > data.length) fail(`${label}: truncated PNG chunk header`)
    const chunkLength = data.readUInt32BE(cursor)
    const type = data.toString('ascii', cursor + 4, cursor + 8)
    const chunkEnd = cursor + 12 + chunkLength
    if (chunkEnd > data.length) fail(`${label}: truncated PNG ${type} chunk`)
    if (chunkIndex === 0) {
      if (type !== 'IHDR' || chunkLength !== 13) {
        fail(`${label}: PNG does not start with a valid IHDR`)
      }
      width = data.readUInt32BE(cursor + 8)
      height = data.readUInt32BE(cursor + 12)
    }
    cursor = chunkEnd
    chunkIndex += 1
    if (type === 'IEND') {
      if (chunkLength !== 0) fail(`${label}: invalid IEND chunk`)
      if (cursor !== data.length) fail(`${label}: trailing bytes after IEND`)
      foundEnd = true
      break
    }
  }
  if (width < 1 || height < 1) fail(`${label}: invalid PNG dimensions`)
  if (!foundEnd) fail(`${label}: PNG has no IEND chunk`)
  return { width, height }
}

function getThumbnailContext(glb: ParsedGlb, label: string): ThumbnailContext {
  const { json } = glb
  const imageIndex = requireInteger(
    json.extensions?.VRMC_vrm?.meta?.thumbnailImage,
    `${label}: extensions.VRMC_vrm.meta.thumbnailImage`,
  )
  const images = json.images
  const views = json.bufferViews
  if (!images || !views) fail(`${label}: images or bufferViews are missing`)
  const image = images[imageIndex]
  if (!image) fail(`${label}: thumbnail image index is out of range`)
  if (image.uri !== undefined || image.mimeType !== 'image/png') {
    fail(`${label}: thumbnail must be an embedded image/png`)
  }
  const viewIndex = requireInteger(
    image.bufferView,
    `${label}: thumbnail image bufferView`,
  )
  const view = views[viewIndex]
  if (!view) fail(`${label}: thumbnail bufferView index is out of range`)
  if (view.buffer !== 0) fail(`${label}: thumbnail is not in buffers[0]`)
  const viewOffset = requireInteger(
    view.byteOffset ?? 0,
    `${label}: thumbnail byteOffset`,
  )
  const viewLength = requireInteger(
    view.byteLength,
    `${label}: thumbnail byteLength`,
    1,
  )
  if (viewOffset % 4 !== 0) fail(`${label}: thumbnail offset is not aligned`)

  const bufferLength = requireInteger(
    json.buffers?.[0]?.byteLength,
    `${label}: buffers[0].byteLength`,
  )
  if (viewOffset + viewLength > bufferLength) {
    fail(`${label}: thumbnail exceeds buffers[0]`)
  }
  const oldSpan = align4(viewLength)
  if (viewOffset + oldSpan > bufferLength) {
    fail(`${label}: aligned thumbnail span exceeds buffers[0]`)
  }

  const references = collectKeyValuePaths(json, 'bufferView', viewIndex)
  const expectedReference = `$.images[${imageIndex}].bufferView`
  if (
    references.length !== 1 ||
    references[0] !== expectedReference
  ) {
    fail(
      `${label}: thumbnail bufferView is shared: ${references.join(', ')}`,
    )
  }

  for (let i = 0; i < images.length; i += 1) {
    if (i !== imageIndex && images[i]?.bufferView === viewIndex) {
      fail(`${label}: another image shares the thumbnail bufferView`)
    }
  }
  // VRoid keeps an otherwise-unused Texture/Sampler pair named "Thumbnail".
  // Preserve those indices, but fail if any material actually consumes it.
  const thumbnailTextureIndices: number[] = []
  for (let i = 0; i < (json.textures?.length ?? 0); i += 1) {
    const texture = json.textures![i]
    if (
      isRecord(texture) &&
      collectKeyValuePaths(texture, 'source', imageIndex).length > 0
    ) {
      thumbnailTextureIndices.push(i)
    }
  }
  for (const textureIndex of thumbnailTextureIndices) {
    const materialReferences = collectKeyValuePaths(
      json.materials,
      'index',
      textureIndex,
      '$.materials',
    )
    if (materialReferences.length > 0) {
      fail(
        `${label}: thumbnail texture is used by a material: ${materialReferences.join(', ')}`,
      )
    }
  }

  const ranges = views.map((candidate, index) => {
    if (candidate.buffer !== 0) fail(`${label}: bufferViews[${index}] uses another buffer`)
    const offset = requireInteger(
      candidate.byteOffset ?? 0,
      `${label}: bufferViews[${index}].byteOffset`,
    )
    const length = requireInteger(
      candidate.byteLength,
      `${label}: bufferViews[${index}].byteLength`,
    )
    if (offset + length > bufferLength) {
      fail(`${label}: bufferViews[${index}] exceeds buffers[0]`)
    }
    if (offset % 4 !== 0) {
      fail(`${label}: bufferViews[${index}] is not 4-byte aligned`)
    }
    return { index, offset, end: offset + length }
  })
  ranges.sort((a, b) => a.offset - b.offset || a.end - b.end)
  for (let i = 1; i < ranges.length; i += 1) {
    const previous = ranges[i - 1]!
    const current = ranges[i]!
    if (current.offset < previous.end) {
      fail(
        `${label}: overlapping bufferViews ${previous.index} and ${current.index}`,
      )
    }
    for (let byte = previous.end; byte < current.offset; byte += 1) {
      if (glb.bin[byte] !== 0) {
        fail(
          `${label}: non-zero padding between bufferViews ${previous.index} and ${current.index}`,
        )
      }
    }
  }
  if (ranges.length > 0) {
    const first = ranges[0]!
    for (let byte = 0; byte < first.offset; byte += 1) {
      if (glb.bin[byte] !== 0) fail(`${label}: non-zero bytes before first bufferView`)
    }
    const last = ranges[ranges.length - 1]!
    for (let byte = last.end; byte < bufferLength; byte += 1) {
      if (glb.bin[byte] !== 0) fail(`${label}: non-zero bytes after last bufferView`)
    }
  }
  for (const range of ranges) {
    if (
      range.index !== viewIndex &&
      range.offset > viewOffset &&
      range.offset < viewOffset + oldSpan
    ) {
      fail(`${label}: another bufferView starts inside thumbnail padding`)
    }
  }

  validatePng(
    glb.bin.subarray(viewOffset, viewOffset + viewLength),
    `${label}: thumbnail`,
  )
  return {
    imageIndex,
    viewIndex,
    viewOffset,
    viewLength,
    oldSpan,
    bufferLength,
  }
}

function getLicenseSummary(json: VrmJson): LicenseSummary {
  const meta = json.extensions?.VRMC_vrm?.meta
  const avatarPermission = meta?.avatarPermission
  const commercialUsage = meta?.commercialUsage
  const creditNotation = meta?.creditNotation
  const allowRedistribution = meta?.allowRedistribution
  const modification = meta?.modification
  const reasons: string[] = []
  if (modification === 'prohibited') reasons.push('modification=prohibited')
  if (allowRedistribution === false) reasons.push('allowRedistribution=false')
  if (commercialUsage === 'personalNonProfit') {
    reasons.push('commercialUsage=personalNonProfit')
  }
  return {
    avatarPermission,
    commercialUsage,
    creditNotation,
    allowRedistribution,
    modification,
    reasons,
    restricted: reasons.length > 0,
  }
}

function viewBytes(
  glb: ParsedGlb,
  view: GlbBufferView,
  label: string,
): Buffer {
  const offset = requireInteger(view.byteOffset ?? 0, `${label}.byteOffset`)
  const length = requireInteger(view.byteLength, `${label}.byteLength`)
  if (offset + length > glb.bin.length) fail(`${label} exceeds BIN data`)
  return glb.bin.subarray(offset, offset + length)
}

function verifyTransformation(
  before: ParsedGlb,
  after: ParsedGlb,
  beforeContext: ThumbnailContext,
): void {
  const afterContext = getThumbnailContext(after, 'optimized output')
  if (
    afterContext.imageIndex !== beforeContext.imageIndex ||
    afterContext.viewIndex !== beforeContext.viewIndex ||
    afterContext.viewOffset !== beforeContext.viewOffset
  ) {
    fail('Thumbnail image/bufferView indices or starting offset changed')
  }
  if (afterContext.viewLength !== ONE_PIXEL_PNG.length) {
    fail('Optimized thumbnail byteLength is incorrect')
  }
  const optimizedThumbnail = viewBytes(
    after,
    after.json.bufferViews![afterContext.viewIndex]!,
    'optimized thumbnail',
  )
  if (!optimizedThumbnail.equals(ONE_PIXEL_PNG)) {
    fail('Optimized thumbnail bytes do not match the fixed 1x1 PNG')
  }
  const dimensions = validatePng(optimizedThumbnail, 'optimized thumbnail')
  if (dimensions.width !== 1 || dimensions.height !== 1) {
    fail('Optimized thumbnail is not 1x1')
  }

  const expectedJson = structuredClone(before.json)
  const expectedViews = expectedJson.bufferViews!
  const expectedBuffers = expectedJson.buffers!
  const newSpan = align4(ONE_PIXEL_PNG.length)
  const removedBytes = beforeContext.oldSpan - newSpan
  expectedViews[beforeContext.viewIndex]!.byteLength = ONE_PIXEL_PNG.length
  for (let i = 0; i < expectedViews.length; i += 1) {
    if (i === beforeContext.viewIndex) continue
    const offset = expectedViews[i]!.byteOffset ?? 0
    if (offset >= beforeContext.viewOffset + beforeContext.oldSpan) {
      expectedViews[i]!.byteOffset = offset - removedBytes
    }
  }
  expectedBuffers[0]!.byteLength = beforeContext.bufferLength - removedBytes
  deepStrictEqual(
    after.json,
    expectedJson,
    'GLB JSON changed outside the allowed buffer length/offset fields',
  )

  const beforeViews = before.json.bufferViews!
  const afterViews = after.json.bufferViews!
  if (beforeViews.length !== afterViews.length) {
    fail('bufferViews array length changed')
  }
  for (let i = 0; i < beforeViews.length; i += 1) {
    if (i === beforeContext.viewIndex) continue
    const beforeHash = sha256(viewBytes(before, beforeViews[i]!, `before view ${i}`))
    const afterHash = sha256(viewBytes(after, afterViews[i]!, `after view ${i}`))
    if (beforeHash !== afterHash) {
      fail(`Non-thumbnail bufferView ${i} payload changed`)
    }
  }

  const beforeImages = before.json.images ?? []
  const afterImages = after.json.images ?? []
  for (let i = 0; i < beforeImages.length; i += 1) {
    if (i === beforeContext.imageIndex) continue
    const beforeView = beforeImages[i]?.bufferView
    const afterView = afterImages[i]?.bufferView
    if (beforeView === undefined || afterView === undefined) continue
    const beforeHash = sha256(
      viewBytes(before, beforeViews[beforeView]!, `before image ${i}`),
    )
    const afterHash = sha256(
      viewBytes(after, afterViews[afterView]!, `after image ${i}`),
    )
    if (beforeHash !== afterHash) fail(`Non-thumbnail image ${i} changed`)
  }
}

export function optimizeVrm(bytes: Buffer, label: string): Optimization {
  const before = parseGlb(bytes, label)
  const context = getThumbnailContext(before, label)
  const oldThumbnail = viewBytes(
    before,
    before.json.bufferViews![context.viewIndex]!,
    `${label}: thumbnail`,
  )
  const alreadyOptimized =
    oldThumbnail.length === ONE_PIXEL_PNG.length &&
    oldThumbnail.equals(ONE_PIXEL_PNG)
  if (alreadyOptimized) {
    return {
      output: bytes,
      before,
      after: before,
      context,
      changed: false,
    }
  }

  const newSpan = align4(ONE_PIXEL_PNG.length)
  if (newSpan >= context.oldSpan) {
    fail(`${label}: replacement would not reduce the BIN payload`)
  }
  const removedBytes = context.oldSpan - newSpan
  const logicalBin = before.bin.subarray(0, context.bufferLength)
  const newLogicalBin = Buffer.concat([
    logicalBin.subarray(0, context.viewOffset),
    ONE_PIXEL_PNG,
    Buffer.alloc(newSpan - ONE_PIXEL_PNG.length),
    logicalBin.subarray(context.viewOffset + context.oldSpan),
  ])
  if (newLogicalBin.length !== context.bufferLength - removedBytes) {
    fail(`${label}: rebuilt BIN length is inconsistent`)
  }

  const originalBuffers = before.json.buffers!
  const originalViews = before.json.bufferViews!
  const updatedBuffers = originalBuffers.map((buffer) => ({ ...buffer }))
  const updatedViews = originalViews.map((view) => ({ ...view }))
  updatedBuffers[0]!.byteLength = newLogicalBin.length
  updatedViews[context.viewIndex]!.byteLength = ONE_PIXEL_PNG.length
  for (let i = 0; i < updatedViews.length; i += 1) {
    if (i === context.viewIndex) continue
    const offset = updatedViews[i]!.byteOffset ?? 0
    if (offset >= context.viewOffset + context.oldSpan) {
      updatedViews[i]!.byteOffset = offset - removedBytes
    }
  }

  let updatedJsonText = replaceExactJsonValue(
    before.jsonText,
    'buffers',
    originalBuffers,
    updatedBuffers,
  )
  updatedJsonText = replaceExactJsonValue(
    updatedJsonText,
    'bufferViews',
    originalViews,
    updatedViews,
  )
  const jsonContent = Buffer.from(updatedJsonText, 'utf8')
  const jsonChunk = Buffer.alloc(align4(jsonContent.length), 0x20)
  jsonContent.copy(jsonChunk)
  const binChunk = Buffer.alloc(align4(newLogicalBin.length))
  newLogicalBin.copy(binChunk)

  const output = Buffer.alloc(12 + 8 + jsonChunk.length + 8 + binChunk.length)
  output.writeUInt32LE(GLB_MAGIC, 0)
  output.writeUInt32LE(2, 4)
  output.writeUInt32LE(output.length, 8)
  output.writeUInt32LE(jsonChunk.length, 12)
  output.writeUInt32LE(JSON_CHUNK, 16)
  jsonChunk.copy(output, 20)
  const binHeader = 20 + jsonChunk.length
  output.writeUInt32LE(binChunk.length, binHeader)
  output.writeUInt32LE(BIN_CHUNK, binHeader + 4)
  binChunk.copy(output, binHeader + 8)

  const after = parseGlb(output, `${label}: optimized output`)
  verifyTransformation(before, after, context)
  return { output, before, after, context, changed: true }
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (
      !isRecord(error) ||
      error.code !== 'ENOENT'
    ) {
      throw error
    }
  }
}

async function writeVerified(
  path: string,
  source: Buffer,
  optimization: Optimization,
): Promise<void> {
  const tempPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.thumbnail.tmp`,
  )
  await removeIfPresent(tempPath)
  try {
    await writeFile(tempPath, optimization.output, { flag: 'wx' })
    const staged = await readFile(tempPath)
    const stagedOptimization = optimizeVrm(staged, `${path}: staged`)
    if (stagedOptimization.changed) {
      fail(`${path}: staged file is not idempotently optimized`)
    }
    if (!staged.equals(optimization.output)) {
      fail(`${path}: staged file differs from verified output`)
    }

    // Refuse to overwrite if another process changed the source while this
    // relatively expensive verification was running.
    const current = await readFile(path)
    if (sha256(current) !== sha256(source)) {
      fail(`${path}: source changed during optimization`)
    }
    await rename(tempPath, path)
  } finally {
    await removeIfPresent(tempPath)
  }
}

function parseCli(argv: readonly string[]): {
  mode: CliMode
  paths: string[]
} {
  let mode: CliMode = 'dry-run'
  const paths: string[] = []
  for (const arg of argv) {
    if (arg === '--write') {
      if (mode === 'check') fail('Choose either --write or --check')
      mode = 'write'
    } else if (arg === '--check') {
      if (mode === 'write') fail('Choose either --write or --check')
      mode = 'check'
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: npx tsx tools/optimize-vrm-thumbnails.ts [--write|--check] [file.vrm ...]',
      )
      process.exit(0)
    } else if (arg.startsWith('-')) {
      fail(`Unknown option: ${arg}`)
    } else {
      paths.push(arg)
    }
  }
  return {
    mode,
    paths: (paths.length > 0 ? paths : [...DEFAULT_MODELS]).map((path) =>
      resolve(path),
    ),
  }
}

async function main(): Promise<void> {
  const dimensions = validatePng(ONE_PIXEL_PNG, 'embedded replacement')
  if (dimensions.width !== 1 || dimensions.height !== 1) {
    fail('Embedded replacement PNG is not 1x1')
  }

  const { mode, paths } = parseCli(process.argv.slice(2))
  const jobs: {
    path: string
    source: Buffer
    optimization: Optimization
    license: LicenseSummary
  }[] = []
  for (const path of paths) {
    const source = await readFile(path)
    const optimization = optimizeVrm(source, path)
    const license = getLicenseSummary(optimization.before.json)
    jobs.push({ path, source, optimization, license })
  }

  const restricted = jobs.filter(
    (job) =>
      job.optimization.changed &&
      job.license.restricted,
  )
  const needsChanges = jobs.some((job) => job.optimization.changed)
  for (const { path, source, optimization, license } of jobs) {
    const saved = source.length - optimization.output.length
    let action = optimization.changed
      ? 'needs optimization'
      : 'already optimized'

    if (
      optimization.changed &&
      mode === 'write' &&
      restricted.length === 0
    ) {
      await writeVerified(path, source, optimization)
      const written = await readFile(path)
      const finalCheck = optimizeVrm(written, `${path}: final`)
      if (finalCheck.changed) fail(`${path}: final idempotence check failed`)
      action = 'optimized'
    } else if (optimization.changed && mode === 'write') {
      action = license.restricted
        ? 'write refused'
        : 'write skipped (batch refused)'
    }
    console.log(
      [
        `${basename(path)}: ${action}`,
        `thumbnail ${optimization.context.viewLength.toLocaleString()} -> ${ONE_PIXEL_PNG.length} bytes`,
        `file ${formatMiB(source.length)} -> ${formatMiB(optimization.output.length)}`,
        `saved ${formatMiB(saved)}`,
        `license avatarPermission=${String(license.avatarPermission)} commercialUsage=${String(license.commercialUsage)} creditNotation=${String(license.creditNotation)} allowRedistribution=${String(license.allowRedistribution)} modification=${String(license.modification)}`,
        license.restricted
          ? `decision REFUSED (${license.reasons.join(', ')})`
          : 'decision allowed',
        `sha256 ${sha256(optimization.output)}`,
      ].join(' | '),
    )
  }

  if (mode !== 'dry-run' && restricted.length > 0) {
    fail(
      `${mode} refused for restricted VRM metadata: ` +
        restricted
          .map(
            (job) =>
              `${basename(job.path)} (${job.license.reasons.join(', ')})`,
          )
          .join('; '),
    )
  }
  if (mode === 'check' && needsChanges) {
    fail('One or more VRM thumbnails are not optimized')
  }
}

const entryPath = process.argv[1]
if (
  entryPath &&
  import.meta.url === pathToFileURL(resolve(entryPath)).href
) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
