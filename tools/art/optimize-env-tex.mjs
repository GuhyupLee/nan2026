#!/usr/bin/env node
/**
 * 환경 텍스처 원본(PNG) → 배포본(WebP).
 *
 * Blender가 만든 2048 PNG 한 벌은 20MB가 넘는다. 그대로 배포하면 첫 로드가
 * 끝나지 않으므로 여기서 줄인다. 채널 종류마다 요구가 다르다.
 *
 * - **베이스컬러**는 손실 압축이 잘 듣는다. 눈이 색 오차에 관대하고, 어차피
 *   위에 아크 색조가 얹힌다.
 * - **노멀맵은 다르다.** RGB가 색이 아니라 벡터라 블록 아티팩트가 그대로
 *   표면 기울기 오차가 된다. 부감 조명에서 얼룩으로 보이므로 품질을 훨씬
 *   높게 잡는다. 실측으로 q=94 아래에서 화강암 표면에 격자 무늬가 보였다.
 * - **ORM**은 채널이 서로 무관해서 크로마 서브샘플링에 특히 약하다. 노멀과
 *   같은 등급으로 다룬다.
 *
 * 사용:
 *   node tools/art/optimize-env-tex.mjs           # 변경된 것만
 *   node tools/art/optimize-env-tex.mjs --force   # 전부 다시
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const RAW_DIR = join(ROOT, 'art-src', 'blender', 'tex-raw')
const OUT_DIR = join(ROOT, 'public', 'env', 'tex')
const SOURCE_MANIFEST = join(ROOT, 'art-src', 'blender', 'manifest.json')
const RUNTIME_MANIFEST = join(ROOT, 'public', 'env', 'manifest.json')

const FORCE = process.argv.includes('--force')

/** 파일 이름 접미사로 채널 종류를 판정한다. */
function encodingFor(name) {
  if (/_normal\b/.test(name)) return { quality: 96, effort: 6, kind: 'normal' }
  if (/_orm\b/.test(name)) return { quality: 95, effort: 6, kind: 'orm' }
  return { quality: 88, effort: 6, kind: 'color' }
}

function walk(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.png')) out.push(full)
  }
  return out
}

const sources = walk(RAW_DIR)
if (sources.length === 0) {
  process.stderr.write(
    `원본 텍스처가 없다: ${relative(ROOT, RAW_DIR)}\n` +
      'node tools/blender/run.mjs art-src/blender/assets/10_tex_ground.py 를 먼저 실행하라.\n',
  )
  process.exit(1)
}

let rawBytes = 0
let outBytes = 0
let converted = 0
let skipped = 0

for (const source of sources) {
  const rel = relative(RAW_DIR, source).replace(/\\/g, '/')
  const target = join(OUT_DIR, rel.replace(/\.png$/, '.webp'))
  mkdirSync(dirname(target), { recursive: true })

  const sourceStat = statSync(source)
  rawBytes += sourceStat.size

  if (!FORCE && existsSync(target) && statSync(target).mtimeMs >= sourceStat.mtimeMs) {
    outBytes += statSync(target).size
    skipped++
    continue
  }

  const { quality, effort, kind } = encodingFor(rel)
  await sharp(source)
    // 노멀·ORM은 알파가 의미 없고 용량만 먹는다. 잎사귀 알파 카드처럼
    // 실제로 알파를 쓰는 베이스컬러만 채널을 남긴다.
    .toColorspace('srgb')
    .webp({
      quality,
      effort,
      alphaQuality: 100,
      // 서브샘플링을 끄지 않으면 노멀맵의 R/G(=기울기)가 뭉개진다.
      smartSubsample: false,
    })
    .toFile(target)

  const size = statSync(target).size
  outBytes += size
  converted++
  process.stdout.write(
    `${rel.padEnd(46)} ${kind.padEnd(7)} ` +
      `${(sourceStat.size / 1024 / 1024).toFixed(2)}MB → ${(size / 1024).toFixed(0)}KB\n`,
  )
}

process.stdout.write(
  `\n${converted}개 변환, ${skipped}개 최신\n` +
    `원본 ${(rawBytes / 1024 / 1024).toFixed(1)}MB → 배포 ${(outBytes / 1024 / 1024).toFixed(2)}MB ` +
    `(${((1 - outBytes / rawBytes) * 100).toFixed(1)}% 절감)\n`,
)

/*
 * 런타임 매니페스트.
 *
 * Blender가 쓴 `art-src/blender/manifest.json`에는 원본 PNG 경로 같은 제작용
 * 정보가 섞여 있다. 브라우저에 필요한 것만 추려 `public/env/manifest.json`으로
 * 옮긴다. 번들에 넣지 않고 fetch하는 이유는, 에셋 스크립트를 다시 돌렸을 때
 * 프론트엔드를 리빌드하지 않고도 반영되게 하기 위해서다.
 */
if (existsSync(SOURCE_MANIFEST)) {
  const source = JSON.parse(readFileSync(SOURCE_MANIFEST, 'utf8'))
  const missing = []
  for (const texture of source.textures ?? []) {
    if (!existsSync(join(ROOT, 'public', texture.path))) missing.push(texture.path)
  }
  const runtime = {
    assets: (source.assets ?? []).map((asset) => ({
      name: asset.name,
      path: asset.path,
      triangles: asset.triangles,
      objects: asset.objects,
      animated: asset.animated,
      extras: asset.extras ?? null,
    })),
    materials: source.materials ?? [],
    textures: (source.textures ?? []).map((texture) => ({
      name: texture.name,
      path: texture.path,
      size: texture.size,
      srgb: texture.srgb,
    })),
  }
  mkdirSync(dirname(RUNTIME_MANIFEST), { recursive: true })
  writeFileSync(RUNTIME_MANIFEST, JSON.stringify(runtime))
  process.stdout.write(
    `런타임 매니페스트: ${runtime.assets.length} assets, ` +
      `${runtime.materials.length} materials, ${runtime.textures.length} textures\n`,
  )
  if (missing.length > 0) {
    process.stderr.write(
      `\n경고: 매니페스트가 가리키는 텍스처 ${missing.length}개가 없다:\n  ` +
        `${missing.slice(0, 8).join('\n  ')}\n`,
    )
  }
}

// 예산은 "지면 + 건축 + 프롭 전부"의 상한이다. 처음 4.5MB로 잡았다가 지면
// 세트만으로 2.4MB를 쓰는 걸 보고 올렸다 — 5분 안에 끝나는 게임에서 첫 로드
// 8MB는 방어 가능한 수치고, 그 안에서 해상도를 깎으면 이 프로젝트가 목표한
// 외관이 나오지 않는다. 다만 상한 자체는 유지한다. 없으면 반드시 넘친다.
const BUDGET_MB = 8
if (outBytes / 1024 / 1024 > BUDGET_MB) {
  process.stderr.write(
    `\n예산 초과: 텍스처 ${(outBytes / 1024 / 1024).toFixed(2)}MB > ${BUDGET_MB}MB\n` +
      '해상도를 낮추거나 텍스처 세트를 통합하라 (art-src/blender/SPEC.md §3).\n',
  )
  process.exit(1)
}
