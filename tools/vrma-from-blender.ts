import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  VRM_ACTION_MOTIONS,
  VRM_RESULT_MOTIONS,
  VRMA_CLIP_ORDER,
  type VrmaClipName,
  type VrmActionStage,
  type VrmBoneName,
  type VrmVec3,
} from '../src/render/animation-data.ts'
import { generateVrmaBytes } from './generate-vrma.ts'

type VrmQuat = [x: number, y: number, z: number, w: number]

export interface BlenderSourceClip {
  name: VrmaClipName
  times: number[]
  frames: BlenderFrame[]
  loop: boolean
  phases?: Array<{ stage: VrmActionStage; time: number }>
}

export interface BlenderFrame {
  hipsPosition: VrmVec3
  rotations: Record<VrmBoneName, VrmQuat>
}

interface BlenderClipJson {
  name: VrmaClipName
  fps: number
  loop: boolean
  times: number[]
  phases?: Array<{ stage: VrmActionStage; time: number }>
  frames: BlenderFrame[]
}

interface GltfAccessor {
  bufferView: number
  componentType: number
  count: number
  type: 'SCALAR' | 'VEC3' | 'VEC4'
}

interface GltfBufferView {
  byteOffset?: number
  byteLength: number
}

interface GltfAnimation {
  name: VrmaClipName
  samplers: Array<{ input: number; output: number }>
  channels: Array<{
    sampler: number
    target: { node: number; path: 'translation' | 'rotation' }
  }>
}

interface GltfJson {
  nodes: Array<{ name?: string }>
  animations: GltfAnimation[]
  accessors: GltfAccessor[]
  bufferViews: GltfBufferView[]
}

const VRMA_TRACKED_BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
] as const satisfies readonly VrmBoneName[]

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
export const BLENDER_ANIMATION_DIR = resolve(
  SCRIPT_DIR,
  '../art-src/blender/anim/out',
)
export const VRMA_OUTPUT = resolve(
  SCRIPT_DIR,
  '../public/animations/myeongwol-combat.vrma',
)

function fail(message: string): never {
  throw new Error(`[animation:blender] ${message}`)
}

function finiteArray(
  value: unknown,
  length: number,
  label: string,
): asserts value is number[] {
  if (
    !Array.isArray(value) ||
    value.length !== length ||
    value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
  ) {
    fail(`${label} must contain ${length} finite numbers`)
  }
}

function validateClip(
  raw: BlenderClipJson,
  expectedName: VrmaClipName,
): BlenderSourceClip {
  if (raw.name !== expectedName) fail(`${expectedName} JSON declares ${raw.name}`)
  if (raw.fps !== 30) fail(`${expectedName} must be baked at 30 fps`)
  if (!Array.isArray(raw.times) || !Array.isArray(raw.frames)) {
    fail(`${expectedName} must contain times and frames`)
  }
  if (raw.times.length !== raw.frames.length || raw.frames.length < 2) {
    fail(`${expectedName} times/frames length mismatch`)
  }
  if (raw.times[0] !== 0) fail(`${expectedName} must start at time zero`)
  for (let index = 0; index < raw.times.length; index += 1) {
    const time = raw.times[index]!
    if (!Number.isFinite(time)) fail(`${expectedName} has a non-finite sample time`)
    if (index > 0) {
      const gap = time - raw.times[index - 1]!
      if (gap <= 0 || gap > 1 / 30 + 2e-6) {
        fail(`${expectedName} does not contain every 30 fps sample`)
      }
    }
  }

  const [, state] = expectedName.split('.')
  const isLoop =
    state === 'idle' ||
    state === 'walk' ||
    state === 'victory' ||
    state === 'defeat'
  if (raw.loop !== isLoop) {
    fail(`${expectedName} loop flag does not match its state`)
  }

  for (let frameIndex = 0; frameIndex < raw.frames.length; frameIndex += 1) {
    const frame = raw.frames[frameIndex]!
    finiteArray(frame.hipsPosition, 3, `${expectedName} frame ${frameIndex} Hips`)
    if (
      Math.abs(frame.hipsPosition[0]) > 1e-7 ||
      Math.abs(frame.hipsPosition[2]) > 1e-7
    ) {
      fail(`${expectedName} contains horizontal root motion`)
    }
    const boneNames = Object.keys(frame.rotations).sort()
    const expectedBones = [...VRMA_TRACKED_BONES].sort()
    if (
      boneNames.length !== expectedBones.length ||
      boneNames.some((bone, index) => bone !== expectedBones[index])
    ) {
      fail(`${expectedName} frame ${frameIndex} does not contain the exact 19 bones`)
    }
    for (const bone of VRMA_TRACKED_BONES) {
      const quaternion = frame.rotations[bone]
      finiteArray(
        quaternion,
        4,
        `${expectedName} frame ${frameIndex} ${bone}`,
      )
      const norm = Math.hypot(...quaternion)
      if (Math.abs(norm - 1) > 1e-5) {
        fail(`${expectedName} frame ${frameIndex} ${bone} is not normalized`)
      }
    }
  }

  if (isLoop) {
    if (JSON.stringify(raw.frames[0]) !== JSON.stringify(raw.frames.at(-1))) {
      fail(`${expectedName} first and last frames must match exactly`)
    }
    if (raw.phases !== undefined) fail(`${expectedName} loop must not declare phases`)
    if (state === 'victory' || state === 'defeat') {
      const [cls] = expectedName.split('.') as ['ranged' | 'melee', string]
      const expectedDuration = VRM_RESULT_MOTIONS[cls][state].duration
      if (Math.abs(raw.times.at(-1)! - expectedDuration) > 1e-8) {
        fail(`${expectedName} duration differs from animation-data.ts`)
      }
    }
  } else {
    const [cls, action] = expectedName.split('.') as [
      'ranged' | 'melee',
      keyof (typeof VRM_ACTION_MOTIONS)['ranged'],
    ]
    const expectedMotion = VRM_ACTION_MOTIONS[cls][action]
    const expectedPhases = expectedMotion.keyframes.map(({ stage, time }) => ({
      stage,
      time,
    }))
    if (JSON.stringify(raw.phases) !== JSON.stringify(expectedPhases)) {
      fail(`${expectedName} phases differ from animation-data.ts`)
    }
    if (Math.abs(raw.times.at(-1)! - expectedMotion.duration) > 1e-8) {
      fail(`${expectedName} duration differs from animation-data.ts`)
    }
    for (const phase of expectedPhases) {
      if (!raw.times.some((time) => Math.abs(time - phase.time) < 1e-8)) {
        fail(`${expectedName} does not sample phase ${phase.stage} at ${phase.time}`)
      }
    }
  }

  return {
    name: expectedName,
    times: raw.times,
    frames: raw.frames,
    loop: raw.loop,
    ...(raw.phases ? { phases: raw.phases } : {}),
  }
}

export function readBlenderClips(
  inputDirectory = BLENDER_ANIMATION_DIR,
): BlenderSourceClip[] {
  return VRMA_CLIP_ORDER.map((name) => {
    const path = resolve(inputDirectory, `${name}.json`)
    let parsed: BlenderClipJson
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as BlenderClipJson
    } catch (error) {
      fail(`${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return validateClip(parsed, name)
  })
}

function componentCount(type: GltfAccessor['type']): number {
  return type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4
}

/**
 * Pure deterministic generation used by animation-check.ts.
 *
 * generate-vrma.ts remains the sole owner of the GLB/VRMA byte layout. Its
 * deterministic output is used as a template and only accessor float payloads
 * are replaced, so Blender cannot drift the node/channel/extension structure.
 */
export function generateBlenderVrmaBytes(
  inputDirectory = BLENDER_ANIMATION_DIR,
): Uint8Array {
  const clips = readBlenderClips(inputDirectory)
  const bytes = generateVrmaBytes().slice()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(
    new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength)).trim(),
  ) as GltfJson
  const binOffset = 20 + jsonLength + 8

  const writeAccessor = (accessorIndex: number, values: readonly number[]) => {
    const accessor = json.accessors[accessorIndex]!
    const bufferView = json.bufferViews[accessor.bufferView]!
    const expectedLength = accessor.count * componentCount(accessor.type)
    if (accessor.componentType !== 5126 || values.length !== expectedLength) {
      fail(`template accessor ${accessorIndex} does not match Blender sample count`)
    }
    const byteOffset = binOffset + (bufferView.byteOffset ?? 0)
    for (let index = 0; index < values.length; index += 1) {
      view.setFloat32(byteOffset + index * 4, values[index]!, true)
    }
  }

  for (let clipIndex = 0; clipIndex < clips.length; clipIndex += 1) {
    const clip = clips[clipIndex]!
    const animation = json.animations[clipIndex]!
    if (animation.name !== clip.name) fail(`${clip.name} template order mismatch`)

    const timeAccessor = animation.samplers[0]!.input
    const templateTimeAccessor = json.accessors[timeAccessor]!
    const templateTimeView = json.bufferViews[templateTimeAccessor.bufferView]!
    const templateTimeOffset = binOffset + (templateTimeView.byteOffset ?? 0)
    if (templateTimeAccessor.count !== clip.times.length) {
      fail(`${clip.name} sample count differs from the existing writer`)
    }
    for (let index = 0; index < clip.times.length; index += 1) {
      const templateTime = view.getFloat32(templateTimeOffset + index * 4, true)
      if (Math.abs(templateTime - clip.times[index]!) > 1e-6) {
        fail(`${clip.name} sample clock differs from the existing writer`)
      }
    }

    for (const channel of animation.channels) {
      const targetName = json.nodes[channel.target.node]?.name
      const outputAccessor = animation.samplers[channel.sampler]!.output
      if (channel.target.path === 'translation') {
        if (targetName !== 'hips') fail(`${clip.name} template translates a non-Hips node`)
        writeAccessor(
          outputAccessor,
          clip.frames.flatMap((frame) => frame.hipsPosition),
        )
        continue
      }
      if (!VRMA_TRACKED_BONES.includes(targetName as VrmBoneName)) {
        fail(`${clip.name} template contains an unknown rotation node ${targetName}`)
      }
      const bone = targetName as VrmBoneName
      const values: number[] = []
      let previous: VrmQuat | null = null
      for (const frame of clip.frames) {
        let [x, y, z, w] = frame.rotations[bone]
        const norm = Math.hypot(x, y, z, w)
        x /= norm
        y /= norm
        z /= norm
        w /= norm
        if (
          previous &&
          previous[0] * x +
            previous[1] * y +
            previous[2] * z +
            previous[3] * w <
            0
        ) {
          x = -x
          y = -y
          z = -z
          w = -w
        }
        values.push(x, y, z, w)
        previous = [x, y, z, w]
      }
      writeAccessor(outputAccessor, values)
    }
  }
  return bytes
}

export function writeBlenderVrmaFile(
  outputPath = VRMA_OUTPUT,
  inputDirectory = BLENDER_ANIMATION_DIR,
): Uint8Array {
  const output = generateBlenderVrmaBytes(inputDirectory)
  mkdirSync(dirname(outputPath), { recursive: true })
  const candidate = `${outputPath}.candidate-${process.pid}`
  writeFileSync(candidate, output)
  try {
    // rename is atomic when the destination does not exist. Windows does not
    // replace an existing file with renameSync, so use a validated byte copy
    // for the committed output and always remove the staging file.
    try {
      renameSync(candidate, outputPath)
    } catch {
      copyFileSync(candidate, outputPath)
    }
  } finally {
    rmSync(candidate, { force: true })
  }
  return output
}

function outputArgument(): string {
  const index = process.argv.indexOf('--output')
  if (index < 0) return VRMA_OUTPUT
  const value = process.argv[index + 1]
  if (!value) fail('--output requires a path')
  return resolve(value)
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputPath = outputArgument()
  const output = writeBlenderVrmaFile(outputPath)
  console.log(`Generated ${outputPath}`)
  console.log(`${VRMA_CLIP_ORDER.length} Blender clips, ${output.byteLength.toLocaleString()} bytes`)
}
