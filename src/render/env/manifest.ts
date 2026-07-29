/**
 * Blender 파이프라인이 내보낸 환경 에셋 매니페스트.
 *
 * `art-src/blender/lib/mw.py`가 쓰고 `tools/art/optimize-env-tex.mjs`가 런타임용으로
 * 추려 `public/env/manifest.json`에 놓는다. 이 파일은 그 JSON의 타입 정의와
 * 로딩만 담당한다.
 *
 * 번들에 넣지 않고 fetch하는 이유: 에셋을 다시 구웠을 때 프론트엔드를 리빌드하지
 * 않아도 반영되어야 한다. 환경 아트는 반복이 잦다.
 */

/** three.js가 머티리얼에 붙일 셰이더 확장 종류. */
export type EnvShaderKind =
  | 'default'
  | 'stone'
  | 'foliage'
  | 'cloth'
  | 'emissive'
  | 'water'
  | 'detail'

export interface EnvMaterialMaps {
  baseColor: string | null
  normal: string | null
  orm: string | null
}

export interface EnvMaterialSpec {
  name: string
  baseColor: [number, number, number, number]
  roughness: number
  metalness: number
  emission: [number, number, number] | null
  emissionStrength: number
  maps: EnvMaterialMaps
  normalScale: number
  /** 월드 미터당 텍스처 반복 수. `uv_box(1.0)`로 편 UV에 그대로 곱한다. */
  uvScale: number
  transparent: boolean
  alphaTest: number
  doubleSided: boolean
  shader: EnvShaderKind
  /** 5분 아크 색 전환에 반응하는 정도. 0이면 고정색. */
  arcResponse: number
}

export interface EnvAssetSpec {
  name: string
  path: string
  triangles: number
  objects: string[]
  animated: boolean
  extras: Record<string, unknown> | null
}

export interface EnvTextureSpec {
  name: string
  path: string
  size: [number, number]
  srgb: boolean
}

export interface EnvManifest {
  assets: EnvAssetSpec[]
  materials: EnvMaterialSpec[]
  textures: EnvTextureSpec[]
}

const EMPTY: EnvManifest = { assets: [], materials: [], textures: [] }

/**
 * 매니페스트를 읽는다.
 *
 * **실패해도 예외를 던지지 않는다.** 에셋 파이프라인이 아직 안 돌았거나 배포에
 * 환경 에셋을 포함하지 않은 빌드에서도 게임은 그대로 실행돼야 한다. 그 경우
 * 빈 매니페스트가 돌아오고, 환경 레이어는 기존 절차식 아레나만 남긴다.
 */
export async function loadEnvManifest(baseUrl: string): Promise<EnvManifest> {
  try {
    const response = await fetch(`${baseUrl}env/manifest.json`, { cache: 'no-cache' })
    if (!response.ok) return EMPTY
    const parsed = (await response.json()) as Partial<EnvManifest>
    return {
      assets: parsed.assets ?? [],
      materials: parsed.materials ?? [],
      textures: parsed.textures ?? [],
    }
  } catch {
    return EMPTY
  }
}

export function indexMaterials(
  manifest: EnvManifest,
): ReadonlyMap<string, EnvMaterialSpec> {
  const table = new Map<string, EnvMaterialSpec>()
  for (const spec of manifest.materials) table.set(spec.name, spec)
  return table
}

export function findAsset(
  manifest: EnvManifest,
  name: string,
): EnvAssetSpec | undefined {
  return manifest.assets.find((asset) => asset.name === name)
}
