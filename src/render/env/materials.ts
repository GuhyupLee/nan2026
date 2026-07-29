import * as THREE from 'three'

import type { ArenaArc } from '../arena.ts'
import type { EnvManifest, EnvMaterialSpec } from './manifest.ts'

/**
 * 매니페스트의 머티리얼 정의를 실제 three.js 머티리얼로 만든다.
 *
 * ## 왜 익스포터가 만든 머티리얼을 안 쓰는가
 *
 * GLB에는 지오메트리와 머티리얼 **이름**만 들어 있다. 텍스처는 따로 받는다.
 * 이유는 세 가지다(자세한 건 `mw.py`의 `MaterialSpec` 독스트링).
 *
 * 그리고 어차피 갈아끼워야 한다 — 5분 아크 색 전환, 정점 컬러 지면 블렌드,
 * 바람, 차폐 디더링은 전부 표준 머티리얼에 없는 것들이고, 셰이더를 개조하지
 * 않으면 만들 수 없다.
 *
 * ## 텍스처 유닛 예산
 *
 * WebGL2가 보장하는 프래그먼트 텍스처 유닛은 16개다. `stone` 셰이더가 가장
 * 많이 쓰는데, 화강암 3장 + 마모 3장 + 이끼 2장 + 디테일 2장 = 10장이고
 * 여기에 그림자맵과 PMREM 환경맵이 붙어 12~13이 된다. **여유가 3개뿐이라
 * 세트를 더 늘릴 수 없다.** 이끼의 ORM을 빼고 상수 거칠기를 쓰는 것도 그래서다.
 */

/**
 * Blender emission strength → three emissiveIntensity 환산 계수.
 *
 * 눈으로 맞췄다. Blender 쪽 1.8(상감)이 0.32가 되어 블룸 임계 바로 아래에
 * 앉고, 6.0(등불 코어)이 1.08이 되어 살짝 넘어 번진다.
 */
const EMISSIVE_SCALE = 0.18

/**
 * 바닥 상감만 따로 더 낮춘다.
 *
 * 상감은 전투 사거리를 알려 주는 **정보**지만, 밝기를 정보량에 맞춰 올리면
 * 즉시 "게임 UI를 바닥에 그린 것"으로 보인다. 실제로 처음에는 흰 선이
 * 환경보다 앞에 떠 있었다. 돌에 박힌 금속 상감이 달빛을 되받는 정도까지
 * 낮추고, 대신 아크가 진행될 때만 살짝 올라오게 한다.
 */
const INLAY_MATERIALS = new Set(['mw/ground/inlay'])
const INLAY_EMISSIVE_SCALE = 0.055

/** 아크 단계별 표면 색조. 밝기를 유지한 채 색상만 민다. */
const ARC_TINT: readonly [number, number, number][] = [
  [0.86, 0.94, 1.14],
  [0.90, 0.93, 1.07],
  [1.02, 0.90, 1.05],
  [1.16, 0.84, 0.90],
  [1.28, 0.75, 0.79],
]

/**
 * 지면 블렌드에 쓰는 세트 이름.
 *
 * 정점 컬러 R=마모, G=이끼가 각각 어떤 텍스처를 불러올지 정한다. 이름이
 * 바뀌면 여기도 바꿔야 한다 — 매니페스트에 없으면 조용히 블렌드가 꺼진다.
 */
const BLEND_SET = {
  worn: 'mw/ground/worn-stone',
  moss: 'mw/ground/moss-lichen',
  detail: 'mw/ground/stone-detail',
} as const

const STONE_PARS = /* glsl */ `
  uniform sampler2D uWornMap;
  uniform sampler2D uWornNormal;
  uniform sampler2D uWornOrm;
  uniform sampler2D uMossMap;
  uniform sampler2D uMossNormal;
  uniform sampler2D uDetailNormal;
  uniform sampler2D uDetailOrm;
  uniform float uUvScale;
  uniform float uDetailScale;
  uniform float uWetness;
  uniform float uArcAmount;
  uniform vec3 uArcTint;
  uniform float uBlendEnabled;

  // GLSL 전역. map_fragment에서 채우고 normal/roughness/ao 청크가 다시 읽는다.
  // 청크 순서가 고정이라(map → normal → roughness → ao) 안전하다.
  //
  // **반드시 초기화한다.** 블렌드가 꺼진 머티리얼(마모석 자체 등)에서는
  // mwWorn/mwMoss에 대입하는 분기를 타지 않는데, GLSL 전역은 초기화가
  // 보장되지 않아 쓰레기 값이 노멀과 젖음 계산으로 흘러든다. 드라이버에
  // 따라 결과가 달라져 재현이 어려운 종류의 버그다.
  vec2 mwUv = vec2( 0.0 );
  vec2 mwDetailUv = vec2( 0.0 );
  float mwWorn = 0.0;
  float mwMoss = 0.0;
  float mwWet = 0.0;
  vec3 mwOrm = vec3( 1.0, 1.0, 0.0 );

  /**
   * 높이 기반 블렌드.
   *
   * 선형 lerp로 두 텍스처를 섞으면 둘 다 반투명하게 겹쳐 보여 "디졸브"가 된다.
   * 실제 표면은 그렇지 않다 — 이끼는 **낮은 곳부터** 찬다. 표면 높이를 함께
   * 보고 문턱을 옮기면 경계가 요철을 따라 들쭉날쭉해지고, 그때 비로소 두 재질이
   * 물리적으로 만난 것처럼 읽힌다.
   */
  float heightBlend(float weight, float height, float sharpness) {
    return clamp((weight - height) * sharpness + weight, 0.0, 1.0);
  }
`

const STONE_MAP_FRAGMENT = /* glsl */ `
  mwUv = vMapUv * uUvScale;
  mwDetailUv = vMapUv * uDetailScale;

  vec4 baseTexel = texture2D( map, mwUv );
  mwOrm = texture2D( roughnessMap, mwUv ).rgb;
  // AO의 반대가 대략적인 표면 높이다. 별도 하이트맵을 한 장 더 받는 대신
  // 이미 있는 채널을 재활용한다 — 텍스처 유닛이 3개밖에 안 남았다.
  float surfaceHeight = 1.0 - mwOrm.r;

  vec3 albedo = baseTexel.rgb;

  if ( uBlendEnabled > 0.5 ) {
    // vColor는 색이 아니라 마스크다. R=마모, G=이끼, B=균열 근접도.
    mwWorn = heightBlend( vColor.r, surfaceHeight * 0.6, 2.2 );
    // 균열 근처는 무조건 닳아 있다. 파손 판석 주변이 새것처럼 보이면
    // 파손이 데칼처럼 떠 보인다.
    mwWorn = clamp( mwWorn + vColor.b * 0.55, 0.0, 1.0 );

    vec4 wornTexel = texture2D( uWornMap, mwUv );
    vec3 wornOrm = texture2D( uWornOrm, mwUv ).rgb;
    albedo = mix( albedo, wornTexel.rgb, mwWorn );
    mwOrm = mix( mwOrm, wornOrm, mwWorn );

    float wornHeight = 1.0 - mwOrm.r;
    mwMoss = heightBlend( vColor.g, wornHeight * 0.85, 3.4 );
    vec4 mossTexel = texture2D( uMossMap, mwUv );
    albedo = mix( albedo, mossTexel.rgb, mwMoss );
    // 이끼는 항상 거칠고 스페큘러가 거의 없다. ORM을 한 장 더 받지 않고
    // 상수로 밀어 넣어도 눈에 띄지 않는다.
    mwOrm.g = mix( mwOrm.g, 0.95, mwMoss );
    mwOrm.r = mix( mwOrm.r, mwOrm.r * 0.85, mwMoss );
  }

  // 디테일 ORM의 G가 마이크로 거칠기 변화다. 베이스맵에서 고주파를 걷어냈기
  // 때문에(용량 문제) 이 층이 없으면 근접 시 표면이 매끈한 플라스틱이 된다.
  float detailRough = texture2D( uDetailOrm, mwDetailUv ).g;
  mwOrm.g = clamp( mwOrm.g + ( detailRough - 0.5 ) * 0.30, 0.04, 1.0 );

  // 젖음. 낮은 곳에 물이 고인다 — 알베도가 어두워지고 거칠기가 급락해
  // 하늘이 비친다. 이 두 가지가 같이 움직여야 물로 읽힌다.
  //
  // 마스크 방향에 주의. AO(mwOrm.r)는 **파인 곳에서 낮다.** 처음에 부호를
  // 뒤집어 써서 물이 오목한 데가 아니라 노출된 평면에 고였고, 결과는
  // 판석마다 1~2m짜리 부연 반사 얼룩이 깔리는 것이었다 — 젖은 게 아니라
  // 조명이 새는 것처럼 보였다.
  mwWet = uWetness * smoothstep( 0.22, 0.68, 1.0 - mwOrm.r ) * ( 1.0 - mwMoss * 0.8 );
  albedo *= mix( 1.0, 0.55, mwWet );

  // 아크 색조. 곱셈이라 명암 구조는 보존되고 색상만 이동한다.
  albedo *= mix( vec3( 1.0 ), uArcTint, uArcAmount );

  diffuseColor *= vec4( albedo, baseTexel.a );
`

const STONE_NORMAL_FRAGMENT = /* glsl */ `
  vec3 mapN = texture2D( normalMap, mwUv ).xyz * 2.0 - 1.0;
  if ( uBlendEnabled > 0.5 ) {
    vec3 wornN = texture2D( uWornNormal, mwUv ).xyz * 2.0 - 1.0;
    vec3 mossN = texture2D( uMossNormal, mwUv ).xyz * 2.0 - 1.0;
    mapN = mix( mapN, wornN, mwWorn );
    mapN = mix( mapN, mossN, mwMoss );
  }

  // 디테일 노멀은 UDN 블렌드로 얹는다. 단순 덧셈은 기울기가 두 배가 되어
  // 표면 전체가 과장되고, lerp는 베이스 요철을 지운다. xy만 더하고 z를
  // 유지하는 이 방식이 두 층의 디테일을 모두 살린다.
  vec3 detailN = texture2D( uDetailNormal, mwDetailUv ).xyz * 2.0 - 1.0;
  mapN = normalize( vec3( mapN.xy + detailN.xy * 0.7, mapN.z ) );

  mapN.xy *= normalScale;
  // 물이 고인 곳은 표면이 평평해진다. 요철이 그대로 남아 있으면 젖은 게
  // 아니라 젖은 색으로 칠한 것으로 보인다.
  mapN = mix( mapN, vec3( 0.0, 0.0, 1.0 ), mwWet * 0.85 );

  // 탄젠트 프레임 \`tbn\`은 three가 <normal_fragment_begin>에서 만들어 둔다.
  // USE_TANGENT 여부에 따라 정점 탄젠트 또는 화면 미분 근사로 채워지므로
  // 여기서는 분기하지 않는다.
  normal = normalize( tbn * mapN );
`

const FOLIAGE_PARS = /* glsl */ `
  uniform float uWindTime;
  uniform float uWindStrength;
  uniform vec2 uWindDir;
`

const FOLIAGE_VERTEX = /* glsl */ `
  vec3 transformed = vec3( position );

  // 바람 가중치는 정점 컬러 R이다. 뿌리 0 → 끝 1이라 밑동은 고정되고
  // 끝만 흔들린다. Blender에서 애니메이션을 굽지 않는 이유가 여기 있다 —
  // 클립을 재생하면 인스턴스마다 스키닝이 필요하지만, 이 방식은 인스턴스가
  // 몇 개든 비용이 같다.
  float windWeight = color.r;

  #ifdef USE_INSTANCING
    vec3 windWorld = ( modelMatrix * instanceMatrix * vec4( transformed, 1.0 ) ).xyz;
  #else
    vec3 windWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  #endif

  // 월드 위치를 위상으로 쓴다. 그래야 옆 포기가 같은 박자로 흔들리지 않고
  // 바람이 벌판을 훑고 지나가는 것처럼 보인다.
  float phase = windWorld.x * 0.42 + windWorld.z * 0.31;
  float gust = sin( uWindTime * 0.31 + phase * 0.18 ) * 0.5 + 0.75;
  float sway =
    sin( uWindTime * 1.7 + phase ) * 0.62 +
    sin( uWindTime * 3.1 + phase * 1.9 ) * 0.24;

  float amount = windWeight * windWeight * uWindStrength * gust;
  transformed.x += uWindDir.x * sway * amount;
  transformed.z += uWindDir.y * sway * amount;
  // 옆으로 휘면 끝이 아주 조금 내려와야 길이가 늘어난 것처럼 보이지 않는다.
  transformed.y -= abs( sway ) * amount * 0.22;
`

/**
 * 잎 끝을 밝게 만드는 그라디언트. 단색 식생은 즉시 플라스틱으로 읽힌다.
 *
 * 배수를 크게 잡은 이유가 있다. 이 게임은 월식 밤이라 주광이 약한데,
 * 식생 알베도까지 어두우면(0.16, 0.19, 0.11) 화면에서 완전히 사라진다.
 * 처음 뿌렸을 때 800포기가 한 포기도 안 보였다. 실제 식물은 얇아서 **빛이
 * 통과한다** — 뒤에서 받은 달빛이 잎을 통해 새어 나오는 그 밝기가 여기 담긴
 * 값이고, 물리적으로도 근거가 있다.
 */
const FOLIAGE_COLOR_FRAGMENT = /* glsl */ `
  diffuseColor.rgb *= mix( vec3( 1.05, 1.15, 0.92 ), vec3( 2.35, 2.30, 1.62 ), vColor.r );
  diffuseColor.rgb *= mix( vec3( 1.0 ), uArcTint, uArcAmount );
`

export interface EnvMaterialUniforms {
  windTime: { value: number }
  windStrength: { value: number }
  windDir: { value: THREE.Vector2 }
  arcTint: { value: THREE.Color }
  arcAmount: { value: number }
  wetness: { value: number }
}

export class EnvMaterialFactory {
  /** 모든 환경 머티리얼이 공유하는 유니폼. 한 번 갱신하면 전부 반영된다. */
  readonly shared: EnvMaterialUniforms = {
    windTime: { value: 0 },
    windStrength: { value: 0.16 },
    windDir: { value: new THREE.Vector2(0.82, 0.57) },
    arcTint: { value: new THREE.Color(1, 1, 1) },
    arcAmount: { value: 0 },
    wetness: { value: 0.22 },
  }

  private readonly loader = new THREE.TextureLoader()
  private readonly textures = new Map<string, THREE.Texture>()
  private readonly built = new Map<string, THREE.Material>()
  private readonly specs: ReadonlyMap<string, EnvMaterialSpec>
  private readonly baseUrl: string
  private readonly anisotropy: number

  constructor(manifest: EnvManifest, baseUrl: string, anisotropy: number) {
    const table = new Map<string, EnvMaterialSpec>()
    for (const spec of manifest.materials) table.set(spec.name, spec)
    this.specs = table
    this.baseUrl = baseUrl
    this.anisotropy = anisotropy
  }

  private texture(path: string | null, srgb: boolean): THREE.Texture | null {
    if (!path) return null
    const key = `${path}|${srgb ? 's' : 'l'}`
    const cached = this.textures.get(key)
    if (cached) return cached
    const texture = this.loader.load(`${this.baseUrl}${path}`)
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
    // 이방성 필터링은 부감 카메라에서 특히 중요하다. 지면이 화면 위쪽으로
    // 갈수록 극단적으로 기울어 보이는데, 없으면 그 구간이 통째로 뭉갠 죽이 된다.
    texture.anisotropy = this.anisotropy
    texture.flipY = false
    texture.needsUpdate = true
    this.textures.set(key, texture)
    return texture
  }

  /** 이름으로 머티리얼을 얻는다. 같은 이름은 항상 같은 인스턴스다(드로우콜 병합). */
  get(name: string): THREE.Material | null {
    const cached = this.built.get(name)
    if (cached) return cached
    const spec = this.specs.get(name)
    if (!spec) return null
    const material = this.create(spec)
    this.built.set(name, material)
    return material
  }

  private create(spec: EnvMaterialSpec): THREE.Material {
    const material = new THREE.MeshStandardMaterial({
      name: spec.name,
      color: new THREE.Color(spec.baseColor[0], spec.baseColor[1], spec.baseColor[2]),
      roughness: spec.roughness,
      metalness: spec.metalness,
      transparent: spec.transparent,
      alphaTest: spec.alphaTest,
      side: spec.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
    })

    const base = this.texture(spec.maps.baseColor, true)
    const normal = this.texture(spec.maps.normal, false)
    const orm = this.texture(spec.maps.orm, false)
    if (base) material.map = base
    if (normal) {
      material.normalMap = normal
      material.normalScale.set(spec.normalScale, spec.normalScale)
    }
    if (orm) {
      // glTF ORM 규약: R=AO, G=거칠기, B=금속성. three는 각 맵의 채널을
      // 따로 읽으므로 같은 텍스처를 세 슬롯에 물려도 샘플러는 하나다.
      material.roughnessMap = orm
      material.metalnessMap = orm
      material.aoMap = orm
      material.aoMapIntensity = 1
    }

    if (spec.emission) {
      material.emissive = new THREE.Color(...spec.emission)
      // Blender의 emission strength는 W/m² 계열의 물리 단위이고 three의
      // emissiveIntensity는 배수다. 그대로 넘기면 바닥 상감이 태양이 된다
      // (실제로 1.8을 그대로 썼더니 블룸이 화면을 하얗게 태웠다).
      //
      // 블룸 임계가 선형 휘도 1.0이라, 이 값이 1을 넘는 순간부터 번지기
      // 시작한다. 상감처럼 "빛나 보이되 광원은 아닌" 것은 1 아래에 두고,
      // 등불처럼 실제로 주변을 밝히는 것만 넘긴다.
      material.emissiveIntensity =
        spec.emissionStrength *
        (INLAY_MATERIALS.has(spec.name) ? INLAY_EMISSIVE_SCALE : EMISSIVE_SCALE)
      material.toneMapped = true
    }

    if (spec.shader === 'stone') this.extendStone(material, spec)
    else if (spec.shader === 'foliage' || spec.shader === 'cloth') {
      this.extendWind(material, spec)
    } else if (spec.shader !== 'emissive') this.extendDefault(material, spec)

    material.userData.envShader = spec.shader
    material.userData.arcResponse = spec.arcResponse
    return material
  }

  /** 아크 색조만 붙이는 최소 확장. */
  private extendDefault(material: THREE.MeshStandardMaterial, spec: EnvMaterialSpec): void {
    const shared = this.shared
    const uvScale = spec.uvScale
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uArcTint = shared.arcTint
      shader.uniforms.uArcAmount = { value: 0 }
      shader.uniforms.uUvScale = { value: uvScale }
      material.userData.arcUniform = shader.uniforms.uArcAmount
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'uniform vec3 uArcTint;\nuniform float uArcAmount;\nuniform float uUvScale;\nvoid main() {',
        )
        .replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
             diffuseColor *= texture2D( map, vMapUv * uUvScale );
           #endif
           diffuseColor.rgb *= mix( vec3( 1.0 ), uArcTint, uArcAmount );`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = roughness;
           #ifdef USE_ROUGHNESSMAP
             roughnessFactor *= texture2D( roughnessMap, vRoughnessMapUv * uUvScale ).g;
           #endif`,
        )
        .replace(
          '#include <metalnessmap_fragment>',
          `float metalnessFactor = metalness;
           #ifdef USE_METALNESSMAP
             metalnessFactor *= texture2D( metalnessMap, vMetalnessMapUv * uUvScale ).b;
           #endif`,
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#ifdef USE_NORMALMAP_TANGENTSPACE
             vec3 mapN = texture2D( normalMap, vNormalMapUv * uUvScale ).xyz * 2.0 - 1.0;
             mapN.xy *= normalScale;
             normal = normalize( tbn * mapN );
           #endif`,
        )
    }
  }

  /** 지면·석재. 3세트 블렌드 + 디테일 + 젖음 + 아크. */
  private extendStone(material: THREE.MeshStandardMaterial, spec: EnvMaterialSpec): void {
    const shared = this.shared
    const wornSpec = this.specs.get(BLEND_SET.worn)
    const mossSpec = this.specs.get(BLEND_SET.moss)
    const detailSpec = this.specs.get(BLEND_SET.detail)

    // 블렌드 세트가 없으면(예: 마모 텍스처를 아직 안 구웠다) 조용히 단일
    // 텍스처로 떨어진다. 셰이더가 컴파일 실패해 화면이 검게 나가는 것보다
    // 낫다 — 파이프라인이 반쯤 돌아간 중간 상태가 정상적인 작업 상태다.
    const blendable =
      spec.name !== BLEND_SET.worn &&
      spec.name !== BLEND_SET.moss &&
      wornSpec !== undefined &&
      mossSpec !== undefined

    const wornMap = blendable ? this.texture(wornSpec!.maps.baseColor, true) : null
    const wornNormal = blendable ? this.texture(wornSpec!.maps.normal, false) : null
    const wornOrm = blendable ? this.texture(wornSpec!.maps.orm, false) : null
    const mossMap = blendable ? this.texture(mossSpec!.maps.baseColor, true) : null
    const mossNormal = blendable ? this.texture(mossSpec!.maps.normal, false) : null
    const detailNormal = this.texture(detailSpec?.maps.normal ?? null, false)
    const detailOrm = this.texture(detailSpec?.maps.orm ?? null, false)

    const enabled = blendable && wornMap !== null && mossMap !== null

    material.vertexColors = true
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uWornMap = { value: wornMap ?? material.map }
      shader.uniforms.uWornNormal = { value: wornNormal ?? material.normalMap }
      shader.uniforms.uWornOrm = { value: wornOrm ?? material.roughnessMap }
      shader.uniforms.uMossMap = { value: mossMap ?? material.map }
      shader.uniforms.uMossNormal = { value: mossNormal ?? material.normalMap }
      shader.uniforms.uDetailNormal = { value: detailNormal ?? material.normalMap }
      shader.uniforms.uDetailOrm = { value: detailOrm ?? material.roughnessMap }
      shader.uniforms.uUvScale = { value: spec.uvScale }
      shader.uniforms.uDetailScale = { value: (detailSpec?.uvScale ?? 4) }
      shader.uniforms.uWetness = shared.wetness
      shader.uniforms.uArcTint = shared.arcTint
      shader.uniforms.uArcAmount = { value: 0 }
      shader.uniforms.uBlendEnabled = { value: enabled ? 1 : 0 }
      material.userData.arcUniform = shader.uniforms.uArcAmount
      if (enabled) material.userData.blendUniform = shader.uniforms.uBlendEnabled

      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${STONE_PARS}\nvoid main() {`)
        // 정점 컬러는 마스크다. three의 기본 동작(알베도에 곱하기)을 반드시
        // 꺼야 한다 — 안 그러면 이끼 마스크가 그대로 초록 얼룩으로 찍힌다.
        .replace('#include <color_fragment>', '')
        .replace('#include <map_fragment>', STONE_MAP_FRAGMENT)
        .replace('#include <normal_fragment_maps>', STONE_NORMAL_FRAGMENT)
        .replace(
          '#include <roughnessmap_fragment>',
          'float roughnessFactor = roughness * mix( mwOrm.g, 0.06, mwWet );',
        )
        .replace(
          '#include <metalnessmap_fragment>',
          'float metalnessFactor = metalness * mwOrm.b;',
        )
        .replace(
          '#include <aomap_fragment>',
          // 블렌드된 ORM의 R을 그대로 AO로 쓴다. 기본 청크는 aoMap을 다시
          // 샘플링하는데, 그러면 이끼가 낀 곳에서도 화강암의 AO가 남아
          // 요철이 두 겹으로 보인다.
          `float ambientOcclusion = ( mwOrm.r - 1.0 ) * aoMapIntensity + 1.0;
           reflectedLight.indirectDiffuse *= ambientOcclusion;
           #if defined( USE_ENVMAP ) && defined( STANDARD )
             float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
             reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
           #endif`,
        )
    }
  }

  /** 식생·천. 정점 셰이더 바람 + 아크. */
  private extendWind(material: THREE.MeshStandardMaterial, spec: EnvMaterialSpec): void {
    const shared = this.shared
    const strengthScale = spec.shader === 'cloth' ? 3.4 : 1
    material.vertexColors = true
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uWindTime = shared.windTime
      shader.uniforms.uWindStrength = { value: shared.windStrength.value * strengthScale }
      shader.uniforms.uWindDir = shared.windDir
      shader.uniforms.uArcTint = shared.arcTint
      shader.uniforms.uArcAmount = { value: 0 }
      material.userData.arcUniform = shader.uniforms.uArcAmount
      material.userData.windUniform = shader.uniforms.uWindStrength
      material.userData.windScale = strengthScale

      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${FOLIAGE_PARS}\nvoid main() {`)
        .replace('#include <begin_vertex>', FOLIAGE_VERTEX)
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', 'uniform vec3 uArcTint;\nuniform float uArcAmount;\nvoid main() {')
        .replace('#include <color_fragment>', FOLIAGE_COLOR_FRAGMENT)
    }
  }

  /**
   * 5분 아크를 모든 환경 머티리얼에 반영한다.
   *
   * 공유 유니폼 객체를 쓰므로 색 하나만 갱신하면 전부 따라온다. 머티리얼별
   * `arcResponse`만 개별 유니폼이라 그것만 순회한다.
   */
  applyArc(arc: Readonly<ArenaArc>): void {
    const tint = this.shared.arcTint.value
    tint
      .setRGB(...ARC_TINT[0])
      .lerp(new THREE.Color(...ARC_TINT[1]), arc.dusk)
      .lerp(new THREE.Color(...ARC_TINT[2]), arc.eclipse)
      .lerp(new THREE.Color(...ARC_TINT[3]), arc.boss)
      .lerp(new THREE.Color(...ARC_TINT[4]), arc.phaseTwo)

    // 비가 오는 게임이 아니므로 젖음은 상수에 가깝지만, 보스 단계에서
    // 살짝 올려 지면이 빛을 더 되비치게 한다. 화면이 붉어질 때 반사가
    // 같이 늘어야 "달아올랐다"로 읽힌다.
    this.shared.wetness.value = 0.22 + arc.boss * 0.14 + arc.phaseTwo * 0.10

    for (const material of this.built.values()) {
      const uniform = material.userData.arcUniform as { value: number } | undefined
      if (uniform) uniform.value = (material.userData.arcResponse as number) ?? 1
    }
  }

  /** 바람 시계. 렌더 프레임 간격으로 진행시킨다. */
  advanceWind(dt: number): void {
    this.shared.windTime.value += dt
  }

  /**
   * 저사양 경로.
   *
   * `stone` 셰이더는 화면의 대부분을 덮으면서 픽셀마다 텍스처를 10번
   * 읽는다. 통합 그래픽에서는 이것 하나가 프레임 예산을 넘긴다. 낮은
   * 단계에서는 마모·이끼 블렌드를 꺼서 3번으로 줄인다. 정점 컬러가 만드는
   * 변주는 사라지지만 화면은 그대로 돌아간다 — 이게 옳은 트레이드다.
   *
   * 유니폼만 바꾸므로 셰이더 재컴파일이 없다. `#define`으로 분기하면 단계를
   * 바꿀 때마다 프로그램이 다시 만들어져 오히려 멈춘다.
   */
  setQuality(high: boolean): void {
    for (const material of this.built.values()) {
      const uniform = material.userData.blendUniform as { value: number } | undefined
      if (uniform) uniform.value = high ? 1 : 0
    }
  }

  setWindStrength(strength: number): void {
    this.shared.windStrength.value = strength
    for (const material of this.built.values()) {
      const uniform = material.userData.windUniform as { value: number } | undefined
      if (uniform) uniform.value = strength * ((material.userData.windScale as number) ?? 1)
    }
  }

  dispose(): void {
    for (const texture of this.textures.values()) texture.dispose()
    for (const material of this.built.values()) material.dispose()
    this.textures.clear()
    this.built.clear()
  }
}
