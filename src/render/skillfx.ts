import * as THREE from 'three'

import type { CastEvent, World } from '../sim/types.ts'
import { lerp } from '../sim/vec.ts'

/**
 * 스킬 비주얼 — 빔 / 참격 / 장판 / 텔레그래프 / 충격파 / 그을음.
 *
 * enemies.ts 안에 섞여 있던 이펙트 드로잉(예광선·참격·링·장판·기둥 9개 메시)을
 * 통째로 대체한다. 존재 이유는 두 가지다.
 *
 * 1) **읽히는 이펙트.** 옛 구현은 전부 단색 박스·링을 스케일한 것이었다.
 *    단색 지오메트리는 아무리 밝게 해도 "색칠된 플라스틱"으로 보인다.
 *    빛으로 읽히려면 감쇠 그라디언트·소프트 엣지·코어 분리가 프래그먼트
 *    단위로 있어야 하고, 그건 셰이더 없이는 불가능하다. 그래서 여기 있는
 *    모든 레이어는 InstancedBufferGeometry + ShaderMaterial 한 쌍이다.
 *
 * 2) **드로우콜 감소.** 레이어 7개 = 최대 7콜. 옛 이펙트 9콜보다 적다.
 *    코어와 글로우를 메시 둘로 나누던 것을 한 셰이더 안에서 처리했기 때문이다.
 *    적 250마리와 무관하게 이 숫자는 고정이다.
 *
 * 클래스 정체성("달은 원을 파고, 해는 선을 긋는다")을 이펙트가 지킨다.
 * sim은 월아의 Q/W도 TracerEvent kind=3, 즉 **직선**으로 내보내는데
 * (kits.ts:312,354) 여기서 호(arc)로 다시 읽는다. sim을 고치지 않고
 * 렌더 전용으로 축을 복구하는 유일한 지점이다.
 *
 * 시계가 둘이라는 점을 전제로 짰다. 지속 상태(zone/blast)의 남은 시간은
 * world.time(시뮬 시계)이라 레벨업·일시정지에 같이 얼어붙고, 자체 수명을
 * 가진 연출(빔·참격·링·플레어)과 셰이더 애니메이션은 벽시계라 계속 돈다.
 * 두 개를 섞어 쓰면 일시정지 해제 순간 화면이 어긋난다 — 그래서 한 값이
 * 어느 시계를 쓰는지 필드 단위로 고정했다.
 *
 * sim 이벤트 배열은 **읽기만 한다**. 비우는 것은 main.ts의 drainEvents 단독이다.
 * 여기서 배열을 변형하면 렌더 다음에 같은 배열을 읽는 오디오가 조용히 깨진다.
 */

// ---------------------------------------------------------------------------
// 팔레트
// ---------------------------------------------------------------------------

/**
 * 발광 게인 — 후처리 블룸의 threshold가 "톤매핑 이전 선형 휘도" 기준이라
 * 색상 그대로는 블룸에 걸리지 않는다. 실측 선형 휘도는
 * 시안 #4DD0FF = 0.539, 골드 #FFD978 = 0.717, 크림슨 #FF5A6E = 0.297 이고,
 * threshold 0.9를 넘기려면 각각 최소 1.7 / 1.3 / 3.1배가 필요하다.
 * 여기 값은 그 최소치에 여유를 조금 얹은 것이다. 블룸이 아직 없는 지금도
 * 가산 블렌딩이라 밝게만 보이고 깨지지 않는다.
 */
// 발광 게인. 원래 값(2.1 / 1.7 / 3.4 / 1.5)은 **후처리가 없다는 전제**로
// 잡혔다 — 블룸 threshold 0.9를 스스로 넘겨야 빛나 보였기 때문이다. 이제
// UnrealBloom이 붙었으니 같은 값이 두 번 먹는다. 실플레이 60초를 찍어 보니
// 화면 절반이 흰 도넛이었다. 블룸 세기만 더 낮추는 대신 게인을 내린 이유는,
// 블룸을 끄는 저사양 경로('off')에서도 이펙트가 보여야 하기 때문이다 —
// 게인은 그쪽의 유일한 밝기 원천이라 너무 내리면 저사양에서 이펙트가 사라진다.
// 그 균형점이 이 값들이다.
const GAIN_CYAN = 1.35
const GAIN_GOLD = 1.15
const GAIN_CRIMSON = 1.7
const GAIN_WHITE = 1.05

const HEX_CYAN = 0x4dd0ff
const HEX_GOLD = 0xffd978
const HEX_CRIMSON = 0xff5a6e
const HEX_SILVER = 0xeaf2ff
const HEX_JADE = 0x7df0a0
const HEX_VIOLET = 0x8f6cff

/** RingEvent.kind 순서: 0=점멸 1=회복 2=폭발/궁 3=참격 4=적대 서지. */
const RING_HEX = [
  0x8fe6ff,
  HEX_JADE,
  0xffe6a3,
  HEX_CRIMSON,
  0xff7a35,
] as const
const RING_GAIN = [
  GAIN_CYAN,
  1.25,
  GAIN_GOLD,
  GAIN_CRIMSON,
  1.85,
] as const

/** Zone.kind 순서: 0=빛기둥(시안) 1=둔화장판(보라). */
const ZONE_HEX = [HEX_CYAN, HEX_VIOLET] as const
/** PendingBlast.kind 순서: 0=폭발(시안) 1=참격(크림슨). */
const BLAST_HEX = [HEX_CYAN, HEX_CRIMSON] as const

const COLOR = new THREE.Color()

// ---------------------------------------------------------------------------
// 상한 — 전부 "넘치면 가장 오래된 것 재사용"
// ---------------------------------------------------------------------------
//
// 한 프레임에 시뮬이 최대 8틱까지 몰려 돈다(MAX_TICKS_PER_FRAME=8). 그때
// 8틱치 이벤트가 한꺼번에 도착하므로 상한이 틱당 발생량과 같으면 방금 쓴
// 스킬의 이펙트가 잘려 나간다. 옛 구현은 pops/rings를 그냥 break로 버려서
// 실제로 그랬다. 여기서는 모든 풀이 "가장 진행된 것을 재사용"으로 통일된다 —
// 새 이펙트가 절대 안 보이는 것보다 낡은 이펙트가 한 프레임 일찍 사라지는
// 쪽이 훨씬 덜 눈에 띈다.

const CAP_BEAMS = 32
const CAP_SLASHES = 20
const CAP_RINGS = 28
const CAP_DECALS = 14
const CAP_FLARES = 56
/** sim의 MAX_ZONES / MAX_BLASTS와 같다(zones.ts:53-54). 넘칠 수가 없다. */
const CAP_ZONES = 12
const CAP_TELEGRAPHS = 12

/** kits.ts가 쓰는 지연 폭발 예고 시간. 전 스킬 공통 상수다. */
const BLAST_WARNING = 0.3

const TAU = Math.PI * 2

// 빔 스타일. 셰이더가 step()으로 분기하므로 순서가 곧 의미다.
const BEAM_BOLT = 0 // 원거리 평타 — 머리가 날아간다
const BEAM_LANCE = 1 // 스킬 빔 — 즉시 전체 길이
const BEAM_BLADE = 2 // 돌진 궤적 — 얇은 은선
const BEAM_ULT = 3 // 궁극 빔 — 굵고 길게 유지, 가장자리 흔들림

// 플레어 모양.
const FLARE_MUZZLE = 0
const FLARE_IMPACT = 1
const FLARE_PIERCE = 2

// ---------------------------------------------------------------------------
// 훅
// ---------------------------------------------------------------------------

export interface SkillFxHooks {
  /**
   * 타격이 성립한 지점. 파편·스파크는 여기서 직접 만들지 않고 형제 모듈에 넘긴다.
   *
   * color를 THREE.Color가 아니라 0xRRGGBB 정수로 주는 이유: 매 프레임 할당이
   * 금지라 Color를 넘기면 반드시 재사용 인스턴스가 되고, 그러면 호출부가
   * copy()를 잊는 순간 색이 조용히 뒤섞인다. 숫자에는 그 함정이 없다.
   *
   * @param angle 타격 방향(라디안). XZ 평면에서 +X가 0 — sim의 facing과 같은 규약.
   */
  onImpact?: (x: number, z: number, angle: number, color: number) => void
  /**
   * 0..1로 정규화한 흔들림 강도. 곡선과 감쇠는 흔들림 모듈이 정한다.
   *
   * **한 프레임에 여러 번 불린다.** 한 프레임에 시뮬 8틱이 몰릴 수 있고
   * 그 안에 궁극기와 폭발이 같이 들어갈 수 있다. 합산하면 강도가 1을 훌쩍
   * 넘어 화면이 발작하므로, 받는 쪽은 **최댓값**으로 처리해야 한다.
   */
  onShake?: (strength: number) => void
}

// ---------------------------------------------------------------------------
// 풀
// ---------------------------------------------------------------------------

interface FxLife {
  /** 진행도 0..1. 1을 넘으면 죽는다. */
  t: number
}

/**
 * 고정 크기 오브젝트 풀.
 *
 * 인덱스 순회 + swap-remove라 프레임당 할당이 0이다. 상한을 넘으면 가장
 * 진행된(= 가장 먼저 사라질) 항목을 빼앗아 쓴다.
 */
class FxPool<T extends FxLife> {
  readonly items: T[]
  count = 0
  /** 품질 단계가 낮추는 유효 상한. items.length가 물리적 상한이다. */
  limit: number

  constructor(capacity: number, make: () => T) {
    this.items = new Array<T>(capacity)
    for (let i = 0; i < capacity; i++) this.items[i] = make()
    this.limit = capacity
  }

  acquire(): T {
    if (this.count < this.limit) return this.items[this.count++]!
    let worst = 0
    for (let i = 1; i < this.count; i++) {
      if (this.items[i]!.t > this.items[worst]!.t) worst = i
    }
    return this.items[worst]!
  }

  /** 뒤에서부터 순회할 때만 안전하다(swap-remove). */
  remove(i: number): void {
    this.count--
    const tmp = this.items[i]!
    this.items[i] = this.items[this.count]!
    this.items[this.count] = tmp
  }

  clear(): void {
    this.count = 0
  }
}

interface BeamFx extends FxLife {
  x0: number
  z0: number
  x1: number
  z1: number
  /** 셰이더가 쓰는 월드 반폭. sim의 width 배수와 다르다. */
  halfWidth: number
  y: number
  style: number
  dur: number
  seed: number
  r: number
  g: number
  b: number
  hex: number
  /** 명중 플레어를 이미 냈는가. BOLT는 머리가 도착해야 낸다. */
  impacted: boolean
  /** 이번 프레임에 생겼는가 — 관통 플레어 매칭 대상. */
  fresh: boolean
}

interface SlashFx extends FxLife {
  cx: number
  cz: number
  /** 부착 기준 중심(플레이어 추종 전 원본). */
  bx: number
  bz: number
  /** 부착 시점의 플레이어 위치. */
  ax: number
  az: number
  follow: boolean
  angle: number
  span: number
  radius: number
  innerRatio: number
  arch: number
  bladeGain: number
  dur: number
  seed: number
  r: number
  g: number
  b: number
}

interface RingFx extends FxLife {
  x: number
  z: number
  radius: number
  dur: number
  style: number
  seed: number
  r: number
  g: number
  b: number
}

interface DecalFx extends FxLife {
  x: number
  z: number
  radius: number
  dur: number
  seed: number
}

interface FlareFx extends FxLife {
  x: number
  y: number
  z: number
  size: number
  angle: number
  shape: number
  dur: number
  r: number
  g: number
  b: number
}

/**
 * 폭발 추적 슬롯.
 *
 * sim에는 "터졌다" 이벤트가 없다 — PendingBlast는 배열에서 splice로 사라질
 * 뿐이다(zones.ts:73). RingEvent(kind 2/3)가 같이 나오지만 그 kind는 참격
 * 계열 링과 구분이 안 돼서 그을음 데칼을 붙일 근거로 못 쓴다. 그래서
 * world.blasts를 프레임 간 비교해 "사라진 것 = 터진 것"으로 직접 검출한다.
 * blast는 발화 외의 경로로 제거되지 않으므로 이 추론은 정확하다.
 */
interface BlastTrack {
  x: number
  z: number
  radius: number
  kind: number
  fireAt: number
  seen: boolean
  used: boolean
}

// ---------------------------------------------------------------------------
// 레이어 (InstancedBufferGeometry + ShaderMaterial 한 쌍 = 드로우콜 1)
// ---------------------------------------------------------------------------

interface NumUniform {
  value: number
}

interface InstBuf {
  readonly data: Float32Array
  readonly attr: THREE.InstancedBufferAttribute
}

function instBuf(
  geo: THREE.InstancedBufferGeometry,
  name: string,
  itemSize: number,
  capacity: number,
): InstBuf {
  const data = new Float32Array(capacity * itemSize)
  const attr = new THREE.InstancedBufferAttribute(data, itemSize)
  attr.setUsage(THREE.DynamicDrawUsage)
  geo.setAttribute(name, attr)
  return { data, attr }
}

/**
 * 평범한 BufferGeometry를 인스턴스 지오메트리로 승격한다.
 *
 * copy()를 쓰지 않는 이유: @types/three의 InstancedBufferGeometry.copy는
 * 인자를 InstancedBufferGeometry로 좁혀 놔서 일반 지오메트리를 못 받는다.
 * 속성 참조를 그대로 넘기면 복제도 없고 타입도 깨끗하다.
 */
function toInstanced(base: THREE.BufferGeometry): THREE.InstancedBufferGeometry {
  const geo = new THREE.InstancedBufferGeometry()
  geo.setIndex(base.getIndex())
  for (const name of Object.keys(base.attributes)) {
    const attr = base.attributes[name]
    if (attr) geo.setAttribute(name, attr)
  }
  return geo
}

class Layer {
  readonly geometry: THREE.InstancedBufferGeometry
  readonly material: THREE.ShaderMaterial
  readonly mesh: THREE.Mesh
  private readonly bufs: InstBuf[] = []

  constructor(base: THREE.BufferGeometry, material: THREE.ShaderMaterial, renderOrder: number) {
    this.geometry = toInstanced(base)
    this.geometry.instanceCount = 0
    this.material = material
    this.mesh = new THREE.Mesh(this.geometry, material)
    this.mesh.renderOrder = renderOrder
    // 정점 위치를 셰이더에서 만들기 때문에 바운딩이 의미가 없다.
    this.mesh.frustumCulled = false
    // 메시는 원점에 고정이고 셰이더도 modelMatrix를 안 쓴다.
    this.mesh.matrixAutoUpdate = false
  }

  attr(name: string, itemSize: number, capacity: number): Float32Array {
    const buf = instBuf(this.geometry, name, itemSize, capacity)
    this.bufs.push(buf)
    return buf.data
  }

  commit(count: number): void {
    this.geometry.instanceCount = count
    if (count === 0) return
    for (const b of this.bufs) b.attr.needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}

// ---------------------------------------------------------------------------
// 지오메트리
// ---------------------------------------------------------------------------

/**
 * 장판 볼륨 — 바닥 원판 + 아주 낮은 벽 하나의 지오메트리.
 *
 * 메시를 둘로 나누면 드로우콜이 두 배가 된다. aFace로 프래그먼트에서
 * 구분하면 한 번에 끝난다. 바닥이 벽보다 살짝 넓은(1.06) 이유는 가장자리
 * 발광 밴드가 r=1.0에 중심을 두는데, 지오메트리가 정확히 1.0에서 끝나면
 * 밴드의 바깥 절반이 잘려 선이 얇아 보이기 때문이다.
 */
function createZoneGeometry(segments: number): THREE.BufferGeometry {
  const floorR = 1.06
  const pos: number[] = []
  const face: number[] = []

  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * TAU
    const a1 = ((i + 1) / segments) * TAU
    pos.push(
      0, 0, 0,
      Math.cos(a0) * floorR, 0, Math.sin(a0) * floorR,
      Math.cos(a1) * floorR, 0, Math.sin(a1) * floorR,
    )
    face.push(0, 0, 0)
  }

  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * TAU
    const a1 = ((i + 1) / segments) * TAU
    const x0 = Math.cos(a0)
    const z0 = Math.sin(a0)
    const x1 = Math.cos(a1)
    const z1 = Math.sin(a1)
    pos.push(x0, 0, z0, x1, 0, z1, x1, 1, z1)
    pos.push(x0, 0, z0, x1, 1, z1, x0, 1, z0)
    face.push(1, 1, 1, 1, 1, 1)
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('aFace', new THREE.Float32BufferAttribute(face, 1))
  return geo
}

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------
//
// 모든 프래그먼트가 `<tonemapping_fragment>` + `<colorspace_fragment>`로 끝난다.
// MeshBasicMaterial이 자동으로 하는 것과 정확히 같은 두 줄이고, 그래서
// 옛 이펙트와 밝기 체감이 어긋나지 않는다. 나중에 EffectComposer를 붙이면
// three가 렌더 타겟 경로에서 TONE_MAPPING define을 자동으로 끄고
// linearToOutputTexel을 항등함수로 만들기 때문에 이 두 줄은 스스로 무력화된다 —
// 즉 후처리 도입 시 이 파일을 고칠 필요가 없다.
//
// 알파는 항상 1.0이고 세기는 rgb에 미리 곱한다. 가산 블렌딩이
// src.rgb * src.a + dst 이므로 결과는 같지만, 톤매핑이 알파 곱하기 *전에*
// 걸리므로 세기를 rgb에 넣어야 HDR 압축이 제대로 먹는다.

const BEAM_VERT = /* glsl */ `
  attribute vec3 aStart;
  attribute vec3 aEnd;
  attribute vec4 aParam;  // x=월드 반폭 y=수명 0..1 z=스타일 w=시드
  attribute vec3 aColor;

  varying float vU;
  varying float vV;
  varying float vLife;
  varying float vStyle;
  varying float vSeed;
  varying float vLen;
  varying vec3  vColor;

  void main() {
    vec3 axis = aEnd - aStart;
    float len = max(length(axis), 1e-4);
    vec3 dir = axis / len;
    vec3 mid = (aStart + aEnd) * 0.5;

    // 축 둘레로 도는 빌보드. 바닥에 눕힌 쿼드는 52도 피치에서 납작하게
    // 찌그러져 "빛줄기"가 아니라 "바닥에 그은 선"이 된다.
    vec3 side = cross(dir, cameraPosition - mid);
    float sl = length(side);
    side = sl > 1e-4 ? side / sl : vec3(0.0, 0.0, 1.0);

    float u = position.x + 0.5;
    float v = position.y * 2.0;
    vec3 world = aStart + dir * (len * u) + side * (aParam.x * v);

    vU = u;
    vV = v;
    vLife = aParam.y;
    vStyle = aParam.z;
    vSeed = aParam.w;
    vLen = len;
    vColor = aColor;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const BEAM_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uQuality;

  varying float vU;
  varying float vV;
  varying float vLife;
  varying float vStyle;
  varying float vSeed;
  varying float vLen;
  varying vec3  vColor;


  // 가우시안. pow(x, 2.0)으로 쓰면 GLSL ES 명세상 x<0에서 결과가 정의되지
  // 않는다(8.2 "Results are undefined if x < 0"). 여기 밑수는 전부 정의역의
  // 절반에서 음수라, pow를 exp2(y*log2(x))로 내리는 드라이버(Mali·Adreno 계열에
  // 흔하다)에서 log2(음수)=NaN이 되고 가산 블렌딩에서 레이어가 통째로 깨진다.
  // 곱셈은 정의가 명확하고 ALU도 더 싸다.
  float expSq(float x) { return exp(-x * x); }
  void main() {
    float t = vLife;
    float bolt = step(vStyle, 0.5);
    float ult = step(2.5, vStyle);
    float across = abs(vV);

    // 궁극 빔만 가장자리가 흔들린다. 노이즈 텍스처 대신 주기가 어긋나는
    // 사인 두 개 — ALU 몇 개로 끝나고 비주기적으로 보인다.
    float wob = sin(vU * vLen * 0.9 + uTime * 17.0 + vSeed * 6.283)
              + sin(vU * vLen * 0.31 - uTime * 9.0 + vSeed * 3.1);
    across *= 1.0 + wob * 0.11 * ult * uQuality;

    // 코어와 글로우를 한 셰이더에서 낸다. 옛 구현은 이걸 메시 둘로 나눠
    // 드로우콜을 두 배로 쓰면서도 경계가 딱딱했다 — 박스라 감쇠가 없었다.
    float glow = exp(-across * across * 3.4);
    float core = exp(-across * across * 46.0);

    // 축방향 감쇠. 빔은 총구가 밝고 멀어질수록 옅어지며, 광탄(BOLT)은
    // 반대로 머리가 가장 밝아야 "날아가는 것"으로 읽힌다.
    float axial = mix(mix(1.0, 0.30, vU), mix(0.08, 1.0, pow(vU, 0.7)), bolt);
    // 끝단 컷은 빔 계열의 선단을 부드럽게 끝내려는 것인데, 광탄은 머리가
    // 정확히 vU=1.0에 있어서 발광 피크가 최대 43%까지 잘려 나갔다. 광탄만 끈다.
    float cap = smoothstep(0.0, 0.035, vU)
              * mix(1.0 - smoothstep(0.88, 1.0, vU), 1.0, bolt);

    // 축을 타고 흐르는 에너지 마디 — 관통 빔이 "흐른다"고 읽히는 신호.
    float flow = 0.74 + 0.26 * sin(vU * vLen * 2.2 - uTime * 26.0 + vSeed * 6.283);
    core *= mix(1.0, flow, 0.5 * uQuality * (1.0 - bolt));

    // 광탄 머리의 발광. 별도 메시 없이 같은 쿼드 안에서 처리한다.
    core += expSq((vU - 1.0) / 0.11) * exp(-across * across * 7.0) * bolt * 1.9;

    // 궁극은 절반을 유지한 뒤 꺼진다.
    // 광탄(bolt)은 0.14로 두면 목표에 닿기 전에 꺼진다 — 머리 위치가 t=0.909에
    // 도달하는데 그 시점 밝기가 0.1%였다. 원거리 평타는 0.28초마다 나가는 가장
    // 자주 보이는 이펙트라, 날아가다 사라지고 엉뚱한 곳에서 번쩍하는 것으로
    // 읽혔다. 도달 직전까지 밝기를 유지시킨다.
    float hold = mix(mix(0.14, 0.80, bolt), 0.58, ult);
    float fade = 1.0 - smoothstep(hold, 1.0, t);
    fade *= fade;

    float a = (glow * 0.55 + core * 1.45) * axial * cap * fade;
    // 코어가 셀수록 흰색으로 뜬다 — 실제 발광체의 채도 소실을 흉내낸다.
    vec3 col = vColor * a + vec3(a * a * 0.9);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const SLASH_VERT = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec4 aArc;    // x=중심각 y=벌어진 각 z=바깥반경 w=안쪽 비율
  attribute vec4 aParam;  // x=수명 0..1 y=아치 높이 z=시드 w=칼날 게인
  attribute vec3 aColor;

  varying float vU;
  varying float vV;
  varying float vLife;
  varying float vSpan;
  varying float vBlade;
  varying vec3  vColor;

  void main() {
    float u = position.x + 0.5;
    float v = position.y + 0.5;

    float ang = aArc.x + (u - 0.5) * aArc.y;
    float rad = mix(aArc.z * aArc.w, aArc.z, v);
    vec3 world = aCenter + vec3(cos(ang) * rad, 0.0, sin(ang) * rad);
    // 호를 가운데만 살짝 들어 올린다. 완전히 바닥에 눕히면 쿼터뷰에서
    // 데칼로 보이고, 들어 올리면 "허공을 벤 궤적"이 된다.
    world.y += sin(u * 3.14159265) * aParam.y;

    vU = u;
    vV = v;
    vLife = aParam.x;
    vSpan = aArc.y;
    vBlade = aParam.w;
    vColor = aColor;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const SLASH_FRAG = /* glsl */ `
  varying float vU;
  varying float vV;
  varying float vLife;
  varying float vSpan;
  varying float vBlade;
  varying vec3  vColor;

  const float PI = 3.14159265;


  // 가우시안. pow(x, 2.0)으로 쓰면 GLSL ES 명세상 x<0에서 결과가 정의되지
  // 않는다(8.2 "Results are undefined if x < 0"). 여기 밑수는 전부 정의역의
  // 절반에서 음수라, pow를 exp2(y*log2(x))로 내리는 드라이버(Mali·Adreno 계열에
  // 흔하다)에서 log2(음수)=NaN이 되고 가산 블렌딩에서 레이어가 통째로 깨진다.
  // 곱셈은 정의가 명확하고 ALU도 더 싸다.
  float expSq(float x) { return exp(-x * x); }
  void main() {
    float t = vLife;

    // 앞날이 호를 쓸고 지나간다. 0.42에 끝까지 도달하고 나머지 시간은
    // 잔상이 꺼지는 데 쓴다 — 스윕이 없으면 그냥 링이 켜졌다 꺼지는 것이다.
    float front = smoothstep(0.0, 0.42, t);
    float age = front - vU;
    float pass = step(0.0, age);
    float trail = exp(-max(age, 0.0) * 5.5);

    // 초승달: 양 끝이 뾰족해야 "벤 자국"이다. 완전한 원(회전 베기)일 때는
    // 끝이 서로 만나므로 뾰족하게 만들면 그 자리에 이음매가 보인다.
    float full = step(6.0, vSpan);
    float cres = mix(pow(max(sin(vU * PI), 0.0), 0.55), 1.0, full);

    // 넓은 반투명 색 면(잔상) + 얇은 흰 선(칼날 궤적). 한 겹이면 납작하다.
    float body = expSq((vV - 0.62) / max(0.30 * cres, 1e-3));
    float blade = expSq((vV - 0.90) / 0.055) * exp(-max(age, 0.0) * 13.0);

    float fade = 1.0 - smoothstep(0.5, 1.0, t);
    float a = pass * fade;

    vec3 col = vColor * (body * trail * 0.9 * a)
             + vec3(1.0) * (blade * a * vBlade);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const ZONE_VERT = /* glsl */ `
  attribute float aFace;  // 0=바닥 1=벽
  attribute vec3  aCenter;
  attribute vec4  aParam; // x=반경 y=높이 z=남은수명 0..1 w=kind
  attribute vec3  aColor;
  attribute float aSeed;

  varying vec3  vLocal;
  varying float vFace;
  varying float vLife;
  varying float vSeed;
  varying vec3  vColor;

  void main() {
    vec3 world = aCenter + vec3(position.x * aParam.x, position.y * aParam.y, position.z * aParam.x);
    vLocal = position;
    vFace = aFace;
    vLife = aParam.z;
    vSeed = aSeed;
    vColor = aColor;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const ZONE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uQuality;

  varying vec3  vLocal;
  varying float vFace;
  varying float vLife;
  varying float vSeed;
  varying vec3  vColor;

  const float TAU = 6.28318530718;


  // 가우시안. pow(x, 2.0)으로 쓰면 GLSL ES 명세상 x<0에서 결과가 정의되지
  // 않는다(8.2 "Results are undefined if x < 0"). 여기 밑수는 전부 정의역의
  // 절반에서 음수라, pow를 exp2(y*log2(x))로 내리는 드라이버(Mali·Adreno 계열에
  // 흔하다)에서 log2(음수)=NaN이 되고 가산 블렌딩에서 레이어가 통째로 깨진다.
  // 곱셈은 정의가 명확하고 ALU도 더 싸다.
  float expSq(float x) { return exp(-x * x); }
  void main() {
    float r = length(vLocal.xz);
    // 각도는 프래그먼트에서 만든다. 정점에서 atan을 계산해 보간하면
    // ±PI 이음매를 지나는 삼각형에서 값이 한 바퀴 뒤집혀 줄이 하나 생긴다.
    // x에 1e-6을 더하는 것은 원판 중심 정점 대비다 — atan(0,0)은 GLSL에서
    // 정의되지 않아 드라이버에 따라 NaN이 나오고, NaN은 한 번 생기면
    // 곱셈으로 전파돼 그 삼각형 전체를 검게 만든다.
    float ang = atan(vLocal.z, vLocal.x + 1e-6);

    float life = vLife;                      // 1=여유 있음 0=만료 직전
    float tt = uTime * (0.35 + life * 0.65) + vSeed * 10.0;

    // --- 바닥 ---
    // 세기 배분은 프레임버퍼를 읽어 잡았다. 처음엔 안쪽 글로우 0.30 /
    // 흐름 0.22였는데, 반경 3.6짜리 장판이 카메라 앞에 오면 내부가 통째로
    // 포화돼(픽셀 휘도 255) 안에 선 적이 안 보였다. 읽기를 담당하는 것은
    // 가장자리 링 하나이고 내부는 어디까지나 힌트다.
    float edge = expSq((r - 1.0) / 0.055);
    float inflow = smoothstep(0.62, 1.0, fract(r * 3.2 + tt * 0.9))
                 * (1.0 - smoothstep(0.72, 1.02, r));
    float coreGlow = exp(-r * r * 2.2) * 0.12;
    // 서로 반대로 도는 룬 고리 두 개. 회전 방향이 어긋나야 "돌고 있다"가
    // 한눈에 읽힌다 — 같은 방향이면 그냥 무늬로 보인다.
    float runeA = expSq((r - 0.72) / 0.030) * step(0.58, fract(ang / TAU * 12.0 + tt * 0.05));
    float runeB = expSq((r - 0.88) / 0.018) * step(0.72, fract(ang / TAU * 24.0 - tt * 0.08));
    float floorLum = edge * 0.95 + inflow * 0.14 + coreGlow
                   + (runeA * 0.5 + runeB * 0.38) * uQuality;

    // --- 벽(아주 낮은 볼륨) ---
    // 위로 갈수록 급히 옅어진다. 안에 있는 적이 안 보이면 장판이 아니라 벽이다.
    float h = clamp(vLocal.y, 0.0, 1.0);
    float streak = 0.55 + 0.45 * sin(ang * 14.0 + tt * 1.6 + h * 4.0);
    float wallLum = pow(1.0 - h, 1.6) * (0.22 + streak * 0.18 * uQuality);

    float lum = mix(floorLum, wallLum, vFace);

    // 만료 직전에는 깜빡이고 어두워진다 — "곧 사라진다"가 곧 정보다.
    float dying = smoothstep(0.35, 0.0, life);
    lum *= (0.35 + life * 0.65) * mix(1.0, 0.55 + 0.45 * sin(uTime * 26.0 + vSeed * 5.0), dying);

    vec3 col = mix(vColor * 0.45 + vec3(0.05), vColor, life) * lum;

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const TELE_VERT = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec4 aParam; // x=반경 y=차오름 0..1 z=예비 w=시드
  attribute vec3 aColor;

  varying vec2  vP;
  varying float vProg;
  varying float vRadius;
  varying float vSeed;
  varying vec3  vColor;

  void main() {
    // 1.08배로 넓혀 그린다. 윤곽선 밴드가 r=1.0에 중심을 두는데 지오메트리가
    // 정확히 1.0에서 끝나면 바깥 절반이 잘려 선이 얇아 보인다.
    vec2 p = position.xy * 1.08;
    vec3 world = aCenter + vec3(p.x * aParam.x, 0.0, p.y * aParam.x);
    vP = p;
    vProg = aParam.y;
    vRadius = aParam.x;
    vSeed = aParam.w;
    vColor = aColor;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const TELE_FRAG = /* glsl */ `
  uniform float uTime;
  uniform vec3  uDanger;

  varying vec2  vP;
  varying float vProg;
  varying float vRadius;
  varying float vSeed;
  varying vec3  vColor;


  // 가우시안. pow(x, 2.0)으로 쓰면 GLSL ES 명세상 x<0에서 결과가 정의되지
  // 않는다(8.2 "Results are undefined if x < 0"). 여기 밑수는 전부 정의역의
  // 절반에서 음수라, pow를 exp2(y*log2(x))로 내리는 드라이버(Mali·Adreno 계열에
  // 흔하다)에서 log2(음수)=NaN이 되고 가산 블렌딩에서 레이어가 통째로 깨진다.
  // 곱셈은 정의가 명확하고 ALU도 더 싸다.
  float expSq(float x) { return exp(-x * x); }
  void main() {
    float r = length(vP);
    float ang = atan(vP.y, vP.x + 1e-6);   // 중심 정점의 atan(0,0) 회피
    float prog = vProg;

    // 선 두께를 월드 단위로 고정한다. 정규화 두께를 쓰면 반경 6짜리 폭발의
    // 윤곽선이 반경 3짜리의 두 배로 굵어져 "더 위험해 보이는" 왜곡이 생긴다.
    float outlineW = 0.16 / max(vRadius, 0.5);
    float fillW = 0.10 / max(vRadius, 0.5);

    float outline = expSq((r - 1.0) / outlineW);
    // 안쪽이 중심에서 바깥으로 차오른다. 차오르는 게 보여야 회피가 가능하다.
    float fill = 1.0 - smoothstep(prog - fillW, prog + fillW, r);
    float lead = expSq((r - prog) / (0.13 / max(vRadius, 0.5)));
    // 평평한 원반이 아니라 "위험 구역"으로 읽히게 방사 해칭을 깐다.
    float hatch = 0.62 + 0.38 * sin(r * vRadius * 6.0 + ang * 3.0 + vSeed * 6.283);

    // 터지기 직전 급가속 점멸. 0.3초 예고 중 마지막 0.08초에 몰린다.
    float imminent = smoothstep(0.72, 1.0, prog);
    float blink = 1.0 + imminent * (0.6 + 0.6 * sin(uTime * 44.0));

    vec3 col = vColor * ((outline * (0.85 + imminent * 0.9) + lead * 1.15) * blink)
             + uDanger * (fill * hatch * (0.14 + prog * 0.34) * blink);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const RING_VERT = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec4 aParam; // x=최종반경 y=수명 0..1 z=스타일 w=시드
  attribute vec3 aColor;

  varying float vBand;
  varying vec2  vDir;
  varying float vLife;
  varying float vStyle;
  varying float vSeed;
  varying vec3  vColor;

  void main() {
    // 지오메트리는 0.5~1.0 고리다. 그 폭을 매 인스턴스마다 밴드 위치로
    // 다시 매핑하면 화면을 덮는 픽셀이 실제 링 두께만큼으로 줄어든다 —
    // 반경 9짜리 원판을 통째로 그리는 것보다 오버드로우가 한 자릿수 적다.
    float d = length(position.xy);
    float v = clamp((d - 0.5) * 2.0, 0.0, 1.0);
    vec2 dir = d > 1e-5 ? position.xy / d : vec2(1.0, 0.0);

    float t = aParam.y;
    float grow = 1.0 - (1.0 - t) * (1.0 - t);      // ease-out: 튀어나갔다 잦아든다
    float mid = aParam.x * grow;
    float band = (0.30 + aParam.x * 0.10) * mix(1.0, 0.35, t);
    float rad = max(mid + (v - 0.5) * 2.0 * band, 0.0);

    vec3 world = aCenter + vec3(dir.x * rad, 0.0, dir.y * rad);
    vBand = v;
    vDir = dir;
    vLife = t;
    vStyle = aParam.z;
    vSeed = aParam.w;
    vColor = aColor;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const RING_FRAG = /* glsl */ `
  uniform float uQuality;

  varying float vBand;
  varying vec2  vDir;
  varying float vLife;
  varying float vStyle;
  varying float vSeed;
  varying vec3  vColor;


  // 가우시안. pow(x, 2.0)으로 쓰면 GLSL ES 명세상 x<0에서 결과가 정의되지
  // 않는다(8.2 "Results are undefined if x < 0"). 여기 밑수는 전부 정의역의
  // 절반에서 음수라, pow를 exp2(y*log2(x))로 내리는 드라이버(Mali·Adreno 계열에
  // 흔하다)에서 log2(음수)=NaN이 되고 가산 블렌딩에서 레이어가 통째로 깨진다.
  // 곱셈은 정의가 명확하고 ALU도 더 싸다.
  float expSq(float x) { return exp(-x * x); }
  void main() {
    float t = vLife;
    float shock = step(1.5, vStyle);   // 2=폭발/궁 3=참격 → 더 단단한 충격파

    float soft = expSq((vBand - 0.5) / 0.30);
    float rim = expSq((vBand - 0.66) / 0.09);

    float ang = atan(vDir.y, vDir.x);
    float ripple = 1.0 - 0.22 * uQuality * (0.5 + 0.5 * sin(ang * 18.0 + vSeed * 6.283));

    float fade = (1.0 - t) * (1.0 - t);
    float lum = (soft * 0.75 + rim * mix(0.7, 1.5, shock)) * ripple * fade;

    vec3 col = vColor * lum + vec3(lum * lum * 0.7);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const DECAL_VERT = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec3 aParam; // x=반경 y=수명 0..1 z=시드

  varying vec2  vP;
  varying float vLife;
  varying float vSeed;

  void main() {
    vec2 p = position.xy;
    vec3 world = aCenter + vec3(p.x * aParam.x, 0.0, p.y * aParam.x);
    vP = p;
    vLife = aParam.y;
    vSeed = aParam.z;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const DECAL_FRAG = /* glsl */ `
  uniform vec3 uAsh;
  uniform vec3 uEmber;

  varying vec2  vP;
  varying float vLife;
  varying float vSeed;

  void main() {
    float r = length(vP);
    float ang = atan(vP.y, vP.x + 1e-6);   // 중심 정점의 atan(0,0) 회피

    // 가산 그을음이다. 곱하기 블렌딩으로 어둡게 하는 게 물리적으로는
    // 맞지만 아레나 바닥이 이미 0x0d1424로 거의 검어서 아무것도 안 보인다.
    // 따뜻한 재 색을 더해 색상만 어긋나게 하는 쪽이 이 바닥에서 훨씬 읽힌다.
    float wob = 0.86 + 0.14 * sin(ang * 5.0 + vSeed * 6.283) + 0.07 * sin(ang * 11.0 - vSeed * 3.0);
    float mask = 1.0 - smoothstep(wob * 0.5, wob, r);
    float crack = smoothstep(0.5, 1.0, 0.5 + 0.5 * sin(ang * 9.0 + vSeed * 4.0))
                * smoothstep(0.12, 0.8, r);

    float t = vLife;
    // 잔불이 먼저 식고 재가 남는다. 감쇠를 4.5→12, 계수를 1.3→0.28로 낮췄다.
    // 원래 값은 폭발 반경 6짜리 데칼(지름 11유닛 ≈ 화면 가로의 48%)을 0.4초 동안
    // 주황으로 덮었다. 시안/크림슨 어느 팔레트에도 없는 색이 화면 절반을 먹으면
    // 폭발이 아니라 렌더 오류로 읽힌다.
    float ember = exp(-t * 12.0);
    vec3 col = uAsh * mask * (0.55 + crack * 0.5) + uEmber * (crack * mask * ember * 0.28);
    col *= 1.0 - smoothstep(0.5, 1.0, t);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const FLARE_VERT = /* glsl */ `
  attribute vec3 aPos;
  attribute vec4 aParam; // x=크기 y=수명 0..1 z=월드 각도 w=모양
  attribute vec3 aColor;

  varying vec2  vQ;
  varying float vLife;
  varying float vShape;
  varying vec3  vColor;

  void main() {
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

    // 줄기(streak)를 월드 각도에 맞춘다. 카메라가 52도로 내려다보므로
    // 월드 XZ 각도를 화면 각도로 그냥 쓰면 어긋난다 — 뷰 공간으로 옮겨서 잰다.
    vec3 dirView = (viewMatrix * vec4(cos(aParam.z), 0.0, sin(aParam.z), 0.0)).xyz;
    float sa = atan(dirView.y, dirView.x);
    float cs = cos(sa);
    float sn = sin(sa);

    vec2 q = position.xy * 2.0;
    vec2 rot = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);
    vec3 world = aPos + (right * rot.x + up * rot.y) * aParam.x;

    vQ = q;
    vLife = aParam.y;
    vShape = aParam.w;
    vColor = aColor;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`

const FLARE_FRAG = /* glsl */ `
  varying vec2  vQ;
  varying float vLife;
  varying float vShape;
  varying vec3  vColor;


  // 가우시안. pow(x, 2.0)으로 쓰면 GLSL ES 명세상 x<0에서 결과가 정의되지
  // 않는다(8.2 "Results are undefined if x < 0"). 여기 밑수는 전부 정의역의
  // 절반에서 음수라, pow를 exp2(y*log2(x))로 내리는 드라이버(Mali·Adreno 계열에
  // 흔하다)에서 log2(음수)=NaN이 되고 가산 블렌딩에서 레이어가 통째로 깨진다.
  // 곱셈은 정의가 명확하고 ALU도 더 싸다.
  float expSq(float x) { return exp(-x * x); }
  void main() {
    float t = vLife;
    float d = length(vQ);

    float s0 = step(vShape, 0.5);                          // 머즐
    float s1 = step(0.5, vShape) * step(vShape, 1.5);      // 명중 원반
    float s2 = step(1.5, vShape);                          // 관통 마디

    float core = exp(-d * d * 7.0);
    float streak = exp(-vQ.y * vQ.y * 120.0) * exp(-abs(vQ.x) * 2.0);
    float star = exp(-vQ.y * vQ.y * 70.0) * exp(-abs(vQ.x) * 3.0)
               + exp(-vQ.x * vQ.x * 70.0) * exp(-abs(vQ.y) * 3.0);
    float shockRing = expSq((d - t) / 0.16) * (1.0 - t);

    float fade = (1.0 - t) * (1.0 - t);
    float lum = (core * (1.7 * s0 + 1.15 * s1 + 1.35 * s2)
               + streak * 1.5 * s0
               + shockRing * 1.7 * s1
               + star * 0.9 * s2) * fade;

    vec3 col = vColor * lum + vec3(lum * lum * 0.8);

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

// ---------------------------------------------------------------------------

/** 위치에서 안정적인 시드를 뽑는다. 프레임마다 난수를 쓰면 무늬가 떨린다. */
function seedFrom(x: number, z: number): number {
  const v = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453
  return v - Math.floor(v)
}

export class SkillFx {
  private readonly scene: THREE.Scene
  private readonly hooks: SkillFxHooks

  private readonly uTime: NumUniform = { value: 0 }
  private readonly uQuality: NumUniform = { value: 1 }

  private readonly beamLayer: Layer
  private readonly slashLayer: Layer
  private readonly zoneLayer: Layer
  private readonly teleLayer: Layer
  private readonly ringLayer: Layer
  private readonly decalLayer: Layer
  private readonly flareLayer: Layer

  private readonly beamStart: Float32Array
  private readonly beamEnd: Float32Array
  private readonly beamParam: Float32Array
  private readonly beamColor: Float32Array

  private readonly slashCenter: Float32Array
  private readonly slashArc: Float32Array
  private readonly slashParam: Float32Array
  private readonly slashColor: Float32Array

  private readonly zoneCenter: Float32Array
  private readonly zoneParam: Float32Array
  private readonly zoneColor: Float32Array
  private readonly zoneSeed: Float32Array

  private readonly teleCenter: Float32Array
  private readonly teleParam: Float32Array
  private readonly teleColor: Float32Array

  private readonly ringCenter: Float32Array
  private readonly ringParam: Float32Array
  private readonly ringColor: Float32Array

  private readonly decalCenter: Float32Array
  private readonly decalParam: Float32Array

  private readonly flarePos: Float32Array
  private readonly flareParam: Float32Array
  private readonly flareColor: Float32Array

  private readonly beams: FxPool<BeamFx>
  private readonly slashes: FxPool<SlashFx>
  private readonly rings: FxPool<RingFx>
  private readonly decals: FxPool<DecalFx>
  private readonly flares: FxPool<FlareFx>

  private readonly tracked: BlastTrack[] = []
  /** uTime 기준점. performance.now()를 그대로 넣으면 float32 정밀도가 아깝다. */
  private origin = -1

  constructor(scene: THREE.Scene, hooks: SkillFxHooks = {}) {
    this.scene = scene
    this.hooks = hooks

    const shared = { uTime: this.uTime, uQuality: this.uQuality }
    const additive = {
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    } as const
    // 바닥에 붙는 레이어는 아레나 원판과 같은 평면에 놓인다. y 오프셋만으로는
    // 원거리에서 깊이 정밀도가 부족해 지글거린다.
    const ground = {
      ...additive,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    } as const

    this.beamLayer = new Layer(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        uniforms: shared,
        side: THREE.DoubleSide,
        ...additive,
      }),
      22,
    )
    this.beamStart = this.beamLayer.attr('aStart', 3, CAP_BEAMS)
    this.beamEnd = this.beamLayer.attr('aEnd', 3, CAP_BEAMS)
    this.beamParam = this.beamLayer.attr('aParam', 4, CAP_BEAMS)
    this.beamColor = this.beamLayer.attr('aColor', 3, CAP_BEAMS)

    // 호 방향 56분할이면 반경 4.6짜리 호에서 한 조각이 약 0.1 월드유닛 —
    // 게임 카메라 거리에서 다각형 티가 안 난다. 반경 방향은 3이면 충분하다
    // (프로파일 전부를 프래그먼트가 만들기 때문).
    this.slashLayer = new Layer(
      new THREE.PlaneGeometry(1, 1, 56, 3),
      new THREE.ShaderMaterial({
        vertexShader: SLASH_VERT,
        fragmentShader: SLASH_FRAG,
        // 참격은 시간 유니폼을 안 쓴다. 스윕 진행도가 수명에서 나오므로
        // 벽시계를 섞으면 오히려 프레임률에 따라 궤적이 달라진다.
        uniforms: {},
        side: THREE.DoubleSide,
        ...additive,
      }),
      21,
    )
    this.slashCenter = this.slashLayer.attr('aCenter', 3, CAP_SLASHES)
    this.slashArc = this.slashLayer.attr('aArc', 4, CAP_SLASHES)
    this.slashParam = this.slashLayer.attr('aParam', 4, CAP_SLASHES)
    this.slashColor = this.slashLayer.attr('aColor', 3, CAP_SLASHES)

    this.zoneLayer = new Layer(
      createZoneGeometry(48),
      new THREE.ShaderMaterial({
        vertexShader: ZONE_VERT,
        fragmentShader: ZONE_FRAG,
        uniforms: shared,
        ...ground,
      }),
      3,
    )
    this.zoneCenter = this.zoneLayer.attr('aCenter', 3, CAP_ZONES)
    this.zoneParam = this.zoneLayer.attr('aParam', 4, CAP_ZONES)
    this.zoneColor = this.zoneLayer.attr('aColor', 3, CAP_ZONES)
    this.zoneSeed = this.zoneLayer.attr('aSeed', 1, CAP_ZONES)

    this.teleLayer = new Layer(
      new THREE.CircleGeometry(1, 48),
      new THREE.ShaderMaterial({
        vertexShader: TELE_VERT,
        fragmentShader: TELE_FRAG,
        uniforms: {
          uTime: this.uTime,
          uDanger: { value: new THREE.Color(0xff4a2e) },
        },
        ...ground,
      }),
      4,
    )
    this.teleCenter = this.teleLayer.attr('aCenter', 3, CAP_TELEGRAPHS)
    this.teleParam = this.teleLayer.attr('aParam', 4, CAP_TELEGRAPHS)
    this.teleColor = this.teleLayer.attr('aColor', 3, CAP_TELEGRAPHS)

    this.ringLayer = new Layer(
      new THREE.RingGeometry(0.5, 1, 72, 1),
      new THREE.ShaderMaterial({
        vertexShader: RING_VERT,
        fragmentShader: RING_FRAG,
        uniforms: { uQuality: this.uQuality },
        ...ground,
      }),
      20,
    )
    this.ringCenter = this.ringLayer.attr('aCenter', 3, CAP_RINGS)
    this.ringParam = this.ringLayer.attr('aParam', 4, CAP_RINGS)
    this.ringColor = this.ringLayer.attr('aColor', 3, CAP_RINGS)

    this.decalLayer = new Layer(
      new THREE.CircleGeometry(1, 28),
      new THREE.ShaderMaterial({
        vertexShader: DECAL_VERT,
        fragmentShader: DECAL_FRAG,
        uniforms: {
          uAsh: { value: new THREE.Color(0x241512) },
          uEmber: { value: new THREE.Color(0xff6a2a) },
        },
        ...ground,
      }),
      2,
    )
    this.decalCenter = this.decalLayer.attr('aCenter', 3, CAP_DECALS)
    this.decalParam = this.decalLayer.attr('aParam', 3, CAP_DECALS)

    this.flareLayer = new Layer(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShaderMaterial({
        vertexShader: FLARE_VERT,
        fragmentShader: FLARE_FRAG,
        uniforms: {},
        side: THREE.DoubleSide,
        ...additive,
      }),
      23,
    )
    this.flarePos = this.flareLayer.attr('aPos', 3, CAP_FLARES)
    this.flareParam = this.flareLayer.attr('aParam', 4, CAP_FLARES)
    this.flareColor = this.flareLayer.attr('aColor', 3, CAP_FLARES)

    scene.add(
      this.decalLayer.mesh,
      this.zoneLayer.mesh,
      this.teleLayer.mesh,
      this.ringLayer.mesh,
      this.slashLayer.mesh,
      this.beamLayer.mesh,
      this.flareLayer.mesh,
    )

    this.beams = new FxPool<BeamFx>(CAP_BEAMS, () => ({
      x0: 0, z0: 0, x1: 0, z1: 0, halfWidth: 0.3, y: 0.95,
      style: BEAM_LANCE, t: 0, dur: 0.2, seed: 0,
      r: 1, g: 1, b: 1, hex: 0xffffff, impacted: false, fresh: false,
    }))
    this.slashes = new FxPool<SlashFx>(CAP_SLASHES, () => ({
      cx: 0, cz: 0, bx: 0, bz: 0, ax: 0, az: 0, follow: false,
      angle: 0, span: 2, radius: 3, innerRatio: 0.45, arch: 0.4, bladeGain: 1.2,
      t: 0, dur: 0.28, seed: 0, r: 1, g: 1, b: 1,
    }))
    this.rings = new FxPool<RingFx>(CAP_RINGS, () => ({
      x: 0, z: 0, radius: 1, t: 0, dur: 0.4, style: 0, seed: 0, r: 1, g: 1, b: 1,
    }))
    this.decals = new FxPool<DecalFx>(CAP_DECALS, () => ({
      x: 0, z: 0, radius: 1, t: 0, dur: 1.5, seed: 0,
    }))
    this.flares = new FxPool<FlareFx>(CAP_FLARES, () => ({
      x: 0, y: 1, z: 0, size: 1, angle: 0, shape: FLARE_MUZZLE,
      t: 0, dur: 0.2, r: 1, g: 1, b: 1,
    }))

    for (let i = 0; i < CAP_TELEGRAPHS; i++) {
      this.tracked.push({ x: 0, z: 0, radius: 0, kind: 0, fireAt: 0, seen: false, used: false })
    }
  }

  /**
   * 품질 손잡이. 1=전체, 0=최소.
   *
   * 셰이더 레이어만 끄면 오버드로우가 그대로 남으므로 풀 상한도 같이 내린다.
   * 모바일에서 실제로 비싼 것은 룬·흔들림 계산이 아니라 화면을 덮는 픽셀 수다.
   *
   * 장판과 폭발 예고는 일부러 건드리지 않는다. 둘은 "여기 서 있으면 죽는다"는
   * 게임플레이 정보이지 장식이 아니다. 품질을 낮췄다고 예고가 잘려 나가면
   * 저사양 기기에서만 피할 수 없는 폭발이 생긴다. 게다가 둘 다 sim이
   * 12개로 이미 묶어 두었다(zones.ts:53-54).
   */
  setQuality(level: number): void {
    const q = THREE.MathUtils.clamp(level, 0, 1)
    this.uQuality.value = q
    const scale = 0.45 + q * 0.55
    this.beams.limit = Math.max(6, Math.round(CAP_BEAMS * scale))
    this.slashes.limit = Math.max(4, Math.round(CAP_SLASHES * scale))
    this.rings.limit = Math.max(6, Math.round(CAP_RINGS * scale))
    this.decals.limit = Math.max(3, Math.round(CAP_DECALS * scale))
    this.flares.limit = Math.max(10, Math.round(CAP_FLARES * scale))
  }

  /** 판이 바뀔 때 부른다. 이전 판의 폭발 추적이 남으면 유령 폭발이 한 번 터진다. */
  reset(): void {
    this.beams.clear()
    this.slashes.clear()
    this.rings.clear()
    this.decals.clear()
    this.flares.clear()
    for (const b of this.tracked) b.used = false
    this.origin = -1
  }

  /**
   * @param alpha 마지막 틱 이후 경과 비율. 참격이 플레이어를 따라붙는 데 쓴다.
   * @param now   벽시계 초. 셰이더 애니메이션의 시계.
   * @param dt    벽시계 경과 초(0.1로 클램프된 값). 이펙트 수명의 시계.
   */
  update(world: World, alpha: number, now: number, dt: number): void {
    if (this.origin < 0) this.origin = now
    this.uTime.value = now - this.origin

    const px = lerp(world.player.prevPos.x, world.player.pos.x, alpha)
    const pz = lerp(world.player.prevPos.y, world.player.pos.y, alpha)

    this.captureCasts(world)
    this.captureTracers(world)
    this.captureRings(world)
    this.capturePierce(world)
    this.trackBlasts(world)

    this.drawZones(world)
    this.drawTelegraphs(world)
    this.drawBeams(dt)
    this.drawSlashes(px, pz, dt)
    this.drawRings(dt)
    this.drawDecals(dt)
    this.drawFlares(dt)
  }

  // -------------------------------------------------------------------------
  // 수집
  // -------------------------------------------------------------------------

  /**
   * QWER 시전 서명.
   *
   * 예광선·링·장판은 "무엇이 맞았는가"를 보여 주는 결과 이벤트다. 그것만
   * 역추론하면 순간이동 뒤 출발점을 잃고, 일현 W/E도 원형 범위 표시가 먼저
   * 보여 두 클래스가 같은 마법처럼 읽힌다. CastEvent의 시전 순간 선분을
   * 직접 소비해 일현은 광선·낙광, 월아는 호와 원으로 첫 프레임을 연다.
   *
   * 아래 8개 분기는 모두 constructor에서 미리 만든 FxPool 객체만 acquire한다.
   * 시전 중 지오메트리·머티리얼·Object3D를 새로 만들지 않는다.
   */
  private captureCasts(world: World): void {
    for (let i = 0; i < world.casts.length; i++) {
      const cast = world.casts[i]!
      if (
        cast.slot !== 'q' &&
        cast.slot !== 'w' &&
        cast.slot !== 'e' &&
        cast.slot !== 'r'
      ) {
        continue
      }

      if (world.playerClass === 'ranged') this.spawnRangedCast(cast)
      else this.spawnMeleeCast(cast)
    }
  }

  /** 일현(日弦): 광학 장치마다 낙광·견인·광탄·광선을 구분해 읽힌다. */
  private spawnRangedCast(cast: CastEvent): void {
    const x0 = cast.originX
    const z0 = cast.originY
    const x1 = cast.targetX
    const z1 = cast.targetY
    const nx = -Math.sin(cast.angle)
    const nz = Math.cos(cast.angle)

    switch (cast.slot) {
      case 'q':
        // 낙광 — 가는 조준선 뒤 목표 지점에 수직 광주와 초점 링이 꽂힌다.
        // R과 같은 직선 빔으로 보이면 Q를 교체한 이유가 시각적으로 사라진다.
        this.spawnBeam(
          x0, z0, x1, z1, BEAM_BLADE, 0.035, 0.09,
          HEX_CYAN, GAIN_CYAN, 0.42,
        )
        this.spawnRing(x1, z1, 3.6, 0.42, 2, HEX_GOLD, GAIN_GOLD)
        this.spawnRing(x1, z1, 2.25, 0.3, 3, HEX_CYAN, GAIN_CYAN)
        this.spawnFlare(
          x1, 0.7, z1, 1.35, cast.angle,
          FLARE_IMPACT, 0.3, HEX_GOLD, GAIN_GOLD,
        )
        this.spawnFlare(
          x1, 2.3, z1, 1.15, cast.angle,
          FLARE_PIERCE, 0.24, HEX_SILVER, GAIN_WHITE,
        )
        this.spawnFlare(
          x1, 4.1, z1, 0.9, cast.angle,
          FLARE_PIERCE, 0.2, HEX_CYAN, GAIN_CYAN,
        )
        this.hooks.onShake?.(0.48)
        this.hooks.onImpact?.(x1, z1, cast.angle, HEX_GOLD)
        break
      case 'w':
        // 굴절 — 평행한 두 잔상이 출발·착지점을 한 번에 연결한다.
        this.spawnBeam(
          x0 + nx * 0.2, z0 + nz * 0.2, x1 + nx * 0.2, z1 + nz * 0.2,
          BEAM_BLADE, 0.08, 0.2, HEX_CYAN, GAIN_CYAN, 0.9,
        )
        this.spawnBeam(
          x0 - nx * 0.2, z0 - nz * 0.2, x1 - nx * 0.2, z1 - nz * 0.2,
          BEAM_BLADE, 0.06, 0.16, HEX_SILVER, GAIN_WHITE, 1.1,
        )
        break
      case 'e': {
        // 분광 — 목표까지 실제로 전진하는 금백색 광탄. 폭발 원보다 먼저 읽힌다.
        const travel = THREE.MathUtils.clamp(Math.hypot(x1 - x0, z1 - z0) / 45, 0.18, 0.32)
        this.spawnBeam(
          x0, z0, x1, z1, BEAM_BOLT, 0.3, travel,
          HEX_GOLD, GAIN_GOLD, 1.05,
        )
        break
      }
      case 'r':
        // 일현 — 광폭 빔의 양쪽 레일. 화면 끝까지 선형이라는 사실을 즉시 박는다.
        this.spawnBeam(
          x0 + nx * 0.34, z0 + nz * 0.34, x1 + nx * 0.34, z1 + nz * 0.34,
          BEAM_LANCE, 0.09, 0.18, HEX_GOLD, GAIN_GOLD, 1.02,
        )
        this.spawnBeam(
          x0 - nx * 0.34, z0 - nz * 0.34, x1 - nx * 0.34, z1 - nz * 0.34,
          BEAM_LANCE, 0.07, 0.15, HEX_SILVER, GAIN_WHITE, 1.12,
        )
        break
    }
  }

  /** 월아(月牙): Q/W/E/R 모두 시전 중심을 감싸는 호 또는 완전한 원이다. */
  private spawnMeleeCast(cast: CastEvent): void {
    const x0 = cast.originX
    const z0 = cast.originY
    const x1 = cast.targetX
    const z1 = cast.targetY

    switch (cast.slot) {
      case 'q':
        // 인월참 — 정면을 물어뜯는 단일 초승달.
        this.spawnSlash(x0, z0, cast.angle, 1.7, 3.5, 0.19, 1.15, x0, z0, false)
        break
      case 'w':
        // 이합참 — 출발점에서 닫히고 착지점에서 열리는 한 쌍의 반월.
        this.spawnSlash(
          x0, z0, cast.angle + Math.PI, 2.1, 2.8, 0.18, 1.0, x0, z0, false,
        )
        this.spawnSlash(x1, z1, cast.angle, 2.7, 3.7, 0.24, 1.3, x1, z1, false)
        break
      case 'e':
        // 월륜 — 바깥 판정 링과 겹치기 전 안쪽에서 한 바퀴 도는 칼날.
        this.spawnSlash(x0, z0, cast.angle, TAU, 5.8, 0.34, 1.45, x0, z0, false)
        this.spawnRing(x0, z0, 6.3, 0.36, 3, HEX_CRIMSON, GAIN_CRIMSON)
        break
      case 'r':
        // 만월난무 — 은빛 만월이 먼저 차오르고 크림슨 칼날이 외곽을 닫는다.
        this.spawnRing(x0, z0, 3.4, 0.34, 3, HEX_SILVER, GAIN_WHITE)
        this.spawnSlash(x0, z0, cast.angle, TAU, 5.1, 0.46, 1.7, x0, z0, false)
        this.spawnFlare(
          x0, 0.85, z0, 1.35, cast.angle,
          FLARE_PIERCE, 0.26, HEX_CRIMSON, GAIN_CRIMSON,
        )
        break
    }
  }

  private captureTracers(world: World): void {
    const melee = world.playerClass === 'melee'
    const px = world.player.pos.x
    const pz = world.player.pos.y

    for (let i = 0; i < world.tracers.length; i++) {
      const tr = world.tracers[i]!
      const dx = tr.x1 - tr.x0
      const dz = tr.y1 - tr.y0
      const len = Math.hypot(dx, dz)
      if (len < 1e-4) continue
      const angle = Math.atan2(dz, dx)

      // 월아의 타격은 전부 원이다. sim은 근접 Q/W도 kind=3 직선으로 내보내지만
      // (kits.ts:312,354) 그건 판정 형태일 뿐이고, 화면에서 그대로 직선 박스로
      // 그리면 "달은 원을 판다"는 두 클래스 대비가 스킬에서만 무너진다.
      if (tr.kind === 3 || (tr.kind === 0 && melee)) {
        // 참격의 중심은 언제나 "지금 플레이어가 서 있는 곳"이다. Q는 시전
        // 위치에 남아 있고 W는 끝점으로 순간이동해 있으므로, 어느 끝이
        // 플레이어에 가까운지로 판별하면 두 경우가 같은 규칙에 들어온다.
        const atEnd = Math.hypot(px - tr.x1, pz - tr.y1) < 0.75
        const cx = atEnd ? tr.x1 : tr.x0
        const cz = atEnd ? tr.y1 : tr.y0

        if (tr.kind === 3) {
          this.spawnSlash(cx, cz, angle, 1.75 + Math.min(tr.width, 3) * 0.22,
            THREE.MathUtils.clamp(len * 0.7, 2.2, 4.6), 0.28, 1.35, px, pz, true)
          // 돌진했을 때만 지나온 길에 칼날 궤적을 남긴다. 제자리 참격에
          // 궤적선을 그으면 "찔렀다"로 읽혀 원의 정체성과 충돌한다.
          if (atEnd && len > 2.5) {
            this.spawnBeam(tr.x0, tr.y0, tr.x1, tr.y1, BEAM_BLADE, 0.13, 0.16,
              HEX_SILVER, GAIN_WHITE, 1.05)
          }
        } else {
          this.spawnSlash(cx, cz, angle, 1.55,
            THREE.MathUtils.clamp(len * 0.86, 1.6, 3.2), 0.2, 0.9, px, pz, true)
        }
        continue
      }

      if (tr.kind === 0) {
        // 원거리 평타. 사거리에 비례한 비행시간 — 짧은 사거리에서 광탄이
        // 굼떠 보이지 않게 상·하한을 둔다(옛 구현에서 측정해 잡은 값).
        this.spawnBeam(tr.x0, tr.y0, tr.x1, tr.y1, BEAM_BOLT, 0.24,
          THREE.MathUtils.clamp(len / 85, 0.1, 0.22), HEX_CYAN, GAIN_CYAN, 0.88)
      } else if (tr.kind === 2) {
        this.spawnBeam(tr.x0, tr.y0, tr.x1, tr.y1, BEAM_ULT, 0.18 + tr.width * 0.3,
          0.62, HEX_GOLD, GAIN_GOLD, 0.95)
        this.hooks.onShake?.(1)
      } else {
        this.spawnBeam(tr.x0, tr.y0, tr.x1, tr.y1, BEAM_LANCE, 0.18 + tr.width * 0.3,
          0.24, HEX_CYAN, GAIN_CYAN, 0.95)
        this.hooks.onShake?.(0.16)
      }
    }
  }

  private captureRings(world: World): void {
    for (let i = 0; i < world.rings.length; i++) {
      const ev = world.rings[i]!
      const kind = ev.kind >= 0 && ev.kind < RING_HEX.length ? ev.kind : 0

      const r = this.rings.acquire()
      r.x = ev.x
      r.z = ev.y
      r.radius = ev.radius
      r.t = 0
      // RingEvent에는 지속시간이 없다. 옛 구현은 전부 0.42초를 먹여서
      // 반경 3.4 월참과 반경 9 월륜이 같은 시간에 사라졌고, 그러면 규모
      // 차이가 화면에서 통째로 지워진다. 반경에서 유도해 복구한다.
      r.dur = 0.26 + ev.radius * 0.032
      r.style = kind
      r.seed = seedFrom(ev.x, ev.y)
      this.setColor(r, RING_HEX[kind]!, RING_GAIN[kind]!)

      // 회전 베기는 완전한 원, 사선 베기는 호의 일부. 월륜(9)과 만월난무
      // 마지막 타(7)만 한 바퀴를 돌고, 월참·궁 일반타·이합참 착지(3.4~3.5)는
      // 넓은 호다. 반경이 그 둘을 정확히 갈라 주므로 추가 이벤트가 필요 없다.
      if (kind === 3 && ev.radius >= 3 && !this.hasFreshSlashNear(ev.x, ev.y)) {
        const full = ev.radius >= 5
        // 월륜은 시전 위치에 0.3초 지연 폭발을 심고 그 자리에서 링이 난다.
        // 따라붙게 두면 그동안 이동한 만큼(근접 속도 10.5 × 0.3s = 최대 3.15유닛)
        // 크림슨 원만 플레이어 쪽으로 끌려와 링·그을음과 어긋난다.
        this.spawnSlash(ev.x, ev.y, world.player.facing, full ? TAU : 2.4,
          ev.radius * 0.88, full ? 0.42 : 0.3, full ? 1.6 : 1.2, ev.x, ev.y, false)
      }
    }
  }

  /**
   * 관통 마디.
   *
   * sim에 피격 이벤트가 없어서(damage.ts는 위치도 피해량도 남기지 않는다)
   * "이 빔이 몇 마리를 꿰뚫었는가"를 알 방법이 하나뿐이다 — 같은 프레임의
   * 사망 이벤트를 빔 선분에 투영하는 것. 근사지만 관통이 이 클래스의
   * 정체성이라 마디 없이 그냥 선만 그리면 그 정체성이 화면에 안 나온다.
   */
  private capturePierce(world: World): void {
    if (world.deaths.length === 0) return

    for (let bi = 0; bi < this.beams.count; bi++) {
      const b = this.beams.items[bi]!
      if (!b.fresh) continue
      if (b.style !== BEAM_LANCE && b.style !== BEAM_ULT) continue

      const dx = b.x1 - b.x0
      const dz = b.z1 - b.z0
      const lenSq = dx * dx + dz * dz
      if (lenSq < 1e-6) continue
      const angle = Math.atan2(dz, dx) + Math.PI * 0.5
      // 판정 폭(빔 반폭)보다 넉넉히 잡는다. 사망 위치는 넉백이 이미 한 틱
      // 먹은 뒤일 수 있어서 선분에 딱 붙어 있지 않다.
      const reach = b.halfWidth * 2 + 1.2

      let placed = 0
      for (let di = 0; di < world.deaths.length && placed < 6; di++) {
        const d = world.deaths[di]!
        const u = ((d.x - b.x0) * dx + (d.y - b.z0) * dz) / lenSq
        if (u < 0.02 || u > 0.99) continue
        const cx = b.x0 + dx * u
        const cz = b.z0 + dz * u
        const off = Math.hypot(d.x - cx, d.y - cz)
        if (off > reach) continue

        this.spawnFlare(cx, b.y, cz, 0.8, angle, FLARE_PIERCE, 0.22, b.hex, GAIN_WHITE)
        // 앞의 둘만 파티클을 부른다 — 궁극기 한 방에 수십 마리가 죽으면
        // 형제 파티클 모듈이 그 프레임에 통째로 잠긴다.
        if (placed < 2) this.hooks.onImpact?.(cx, cz, angle, b.hex)
        placed++
      }
    }
  }

  /**
   * 폭발 검출 — world.blasts에서 사라진 항목을 찾는다.
   * blast는 발화 외의 경로로 제거되지 않으므로(zones.ts:70-87) 이 추론은 정확하다.
   */
  private trackBlasts(world: World): void {
    for (const t of this.tracked) t.seen = false

    for (let i = 0; i < world.blasts.length; i++) {
      const b = world.blasts[i]!
      let slot: BlastTrack | null = null
      for (const t of this.tracked) {
        // z(=b.y)까지 봐야 한다. x와 fireAt만 비교했더니, 같은 틱에 x가 같고
        // z만 다른 폭발 두 개가 서로의 슬롯을 덮어써서 아직 안 터진 자리에
        // 그을음·섬광·화면흔들림이 헛발동했다. 지금 sim의 pushBlast 호출부는
        // 클래스당 하나씩이라 도달하지 않지만, 이 추적의 근거가 "위치 동일성"인데
        // 좌표를 절반만 보는 건 스킬 하나만 추가돼도 무너진다.
        if (
          t.used &&
          Math.abs(t.x - b.x) < 1e-4 &&
          Math.abs(t.z - b.y) < 1e-4 &&
          Math.abs(t.fireAt - b.fireAt) < 1e-4
        ) {
          slot = t
          break
        }
      }
      if (!slot) {
        for (const t of this.tracked) {
          if (!t.used) {
            slot = t
            break
          }
        }
      }
      if (!slot) continue
      slot.x = b.x
      slot.z = b.y
      slot.radius = b.radius
      slot.kind = b.kind
      slot.fireAt = b.fireAt
      slot.used = true
      slot.seen = true
    }

    for (const t of this.tracked) {
      if (!t.used || t.seen) continue
      t.used = false
      this.detonate(t.x, t.z, t.radius, t.kind)
    }
  }

  private detonate(x: number, z: number, radius: number, kind: number): void {
    const hex = BLAST_HEX[kind] ?? HEX_CYAN
    const gain = kind === 1 ? GAIN_CRIMSON : GAIN_GOLD

    const d = this.decals.acquire()
    d.x = x
    d.z = z
    d.radius = radius * 0.92
    d.t = 0
    d.dur = 1.6
    d.seed = seedFrom(x, z)

    this.spawnFlare(x, 0.55, z, radius * 0.55, 0, FLARE_IMPACT, 0.34, hex, gain)
    // 반경 6짜리 스킬 폭발이 0.67, 반경 3짜리가 0.44. 상한 1은 궁극 빔이 갖는다.
    this.hooks.onShake?.(Math.min(1, 0.22 + radius * 0.075))
    this.hooks.onImpact?.(x, z, 0, hex)
  }

  // -------------------------------------------------------------------------
  // 생성
  // -------------------------------------------------------------------------

  private spawnBeam(
    x0: number, z0: number, x1: number, z1: number,
    style: number, halfWidth: number, dur: number,
    hex: number, gain: number, y: number,
  ): void {
    const b = this.beams.acquire()
    b.x0 = x0
    b.z0 = z0
    b.x1 = x1
    b.z1 = z1
    b.style = style
    b.halfWidth = halfWidth
    b.y = y
    b.t = 0
    b.dur = dur
    b.seed = Math.random()
    b.hex = hex
    b.impacted = false
    b.fresh = true
    this.setColor(b, hex, gain)

    const angle = Math.atan2(z1 - z0, x1 - x0)
    // 머즐 플래시는 스타일과 무관하게 발사 즉시 — 발사감의 절반이 여기서 나온다.
    //
    // 크기 계수를 조심해야 한다. 머즐은 플레이어 발밑, 즉 카메라에서
    // 가장 가까운 지점에 뜬다. 반폭에 2.4를 곱했더니 궁극 빔에서 반경 5가
    // 나왔고, 프레임버퍼를 읽어 보니 화면의 3분의 1이 흰색으로 날아갔다.
    // 0.7이면 궁극 1.8 / 스킬 0.9 / 광탄 0.7 — 카메라 거리에서 읽히되
    // 화면을 먹지 않는다.
    this.spawnFlare(x0, y, z0, 0.5 + halfWidth * 0.7, angle, FLARE_MUZZLE, 0.16, hex, gain)

    // 광탄만 명중을 미룬다. 나머지는 선이 이미 끝점까지 그어져 있으므로
    // 명중 원반이 같은 프레임에 떠야 한다.
    if (style !== BEAM_BOLT) this.impact(b)
  }

  private impact(b: BeamFx): void {
    if (b.impacted) return
    b.impacted = true
    const angle = Math.atan2(b.z1 - b.z0, b.x1 - b.x0)
    const size = b.style === BEAM_ULT ? 1.7 : b.style === BEAM_BLADE ? 0.75 : 1.15
    this.spawnFlare(b.x1, b.y, b.z1, size, angle, FLARE_IMPACT, 0.28, b.hex, GAIN_WHITE)
    this.hooks.onImpact?.(b.x1, b.z1, angle, b.hex)
  }

  /**
   * @param ax 부착 기준이 될 **스폰 시점의 플레이어 위치**. cx와 반드시 달라야
   *   한다 — 둘을 같은 값으로 넣었더니 drawSlashes의 "cx = bx + (px - ax)"가
   *   항등적으로 "cx = px"가 되어, 모든 참격이 첫 프레임에 플레이어 발밑으로
   *   순간이동했다. 지연 폭발에서 파생된 참격이 폭발 지점이 아니라 플레이어를
   *   따라다니는 버그가 그것이었다.
   * @param follow 플레이어를 따라붙을지. 지연 폭발처럼 **터진 자리에 고정돼야**
   *   하는 참격은 false여야 링·그을음과 정렬된다.
   */
  private spawnSlash(
    cx: number, cz: number, angle: number, span: number,
    radius: number, dur: number, bladeGain: number,
    ax: number, az: number, follow: boolean,
  ): void {
    const s = this.slashes.acquire()
    s.cx = cx
    s.cz = cz
    s.bx = cx
    s.bz = cz
    s.ax = ax
    s.az = az
    s.follow = follow
    s.angle = angle
    s.span = span
    s.radius = radius
    // 안쪽 비율이 클수록 얇은 초승달이 된다. 큰 원은 상대적으로 얇아야
    // "휘두른 궤적"이지 "채워진 원판"이 아니다.
    s.innerRatio = span >= 6 ? 0.72 : 0.5
    // 한 바퀴 도는 원은 아치를 주면 반대쪽이 들려 기울어 보인다.
    s.arch = (0.32 + radius * 0.1) * (1 - Math.min(span, TAU) / TAU)
    s.bladeGain = bladeGain
    s.t = 0
    s.dur = dur
    s.seed = Math.random()
    this.setColor(s, HEX_CRIMSON, GAIN_CRIMSON)
  }

  private spawnFlare(
    x: number, y: number, z: number, size: number, angle: number,
    shape: number, dur: number, hex: number, gain: number,
  ): void {
    const f = this.flares.acquire()
    f.x = x
    f.y = y
    f.z = z
    f.size = size
    f.angle = angle
    f.shape = shape
    f.t = 0
    f.dur = dur
    this.setColor(f, hex, gain)
  }

  private spawnRing(
    x: number,
    z: number,
    radius: number,
    dur: number,
    style: number,
    hex: number,
    gain: number,
  ): void {
    const r = this.rings.acquire()
    r.x = x
    r.z = z
    r.radius = radius
    r.t = 0
    r.dur = dur
    r.style = style
    r.seed = seedFrom(x + radius * 0.13, z - radius * 0.07)
    this.setColor(r, hex, gain)
  }

  /** 링/참격 중복 방지 — 같은 자리에서 방금 시작한 참격이 있으면 두 번 그리지 않는다. */
  private hasFreshSlashNear(x: number, z: number): boolean {
    for (let i = 0; i < this.slashes.count; i++) {
      const s = this.slashes.items[i]!
      if (s.t > 0.2) continue
      if (Math.hypot(s.cx - x, s.cz - z) < 1.4) return true
    }
    return false
  }

  private setColor(fx: { r: number; g: number; b: number }, hex: number, gain: number): void {
    COLOR.set(hex).multiplyScalar(gain)
    fx.r = COLOR.r
    fx.g = COLOR.g
    fx.b = COLOR.b
  }

  // -------------------------------------------------------------------------
  // 기록
  // -------------------------------------------------------------------------

  private drawBeams(dt: number): void {
    let n = 0
    for (let i = this.beams.count - 1; i >= 0; i--) {
      const b = this.beams.items[i]!
      b.t += dt / b.dur
      b.fresh = false
      if (b.t >= 1) {
        this.beams.remove(i)
        continue
      }

      let x0 = b.x0
      let z0 = b.z0
      let x1 = b.x1
      let z1 = b.z1

      if (b.style === BEAM_BOLT) {
        // 광탄은 선 전체가 동시에 켜지면 안 된다. 짧은 꼬리를 달고 이동한다.
        const dx = b.x1 - b.x0
        const dz = b.z1 - b.z0
        const len = Math.hypot(dx, dz)
        const head = Math.min(1, b.t * 1.1)
        const tail = Math.max(0, head - Math.min(2.4, len * head) / Math.max(len, 1e-4))
        x0 = b.x0 + dx * tail
        z0 = b.z0 + dz * tail
        x1 = b.x0 + dx * head
        z1 = b.z0 + dz * head
        if (head >= 0.99) this.impact(b)
      }

      const o3 = n * 3
      const o4 = n * 4
      this.beamStart[o3] = x0
      this.beamStart[o3 + 1] = b.y
      this.beamStart[o3 + 2] = z0
      this.beamEnd[o3] = x1
      this.beamEnd[o3 + 1] = b.y
      this.beamEnd[o3 + 2] = z1
      this.beamParam[o4] = b.halfWidth
      this.beamParam[o4 + 1] = b.t
      this.beamParam[o4 + 2] = b.style
      this.beamParam[o4 + 3] = b.seed
      this.beamColor[o3] = b.r
      this.beamColor[o3 + 1] = b.g
      this.beamColor[o3 + 2] = b.b
      n++
    }
    this.beamLayer.commit(n)
  }

  private drawSlashes(px: number, pz: number, dt: number): void {
    let n = 0
    for (let i = this.slashes.count - 1; i >= 0; i--) {
      const s = this.slashes.items[i]!
      s.t += dt / s.dur
      if (s.t >= 1) {
        this.slashes.remove(i)
        continue
      }

      if (s.follow) {
        const dx = px - s.ax
        const dz = pz - s.az
        // 3유닛 넘게 벌어졌으면 이동이 아니라 순간이동이다(이합참 7,
        // 만월난무의 적 추적 텔레포트). 그때 참격이 따라가면 이미 벤 자리가
        // 통째로 순간이동해 화면이 튄다 — 거기서 떼어낸다.
        if (dx * dx + dz * dz > 9) {
          s.follow = false
        } else {
          s.cx = s.bx + dx
          s.cz = s.bz + dz
        }
      }

      const o3 = n * 3
      const o4 = n * 4
      this.slashCenter[o3] = s.cx
      this.slashCenter[o3 + 1] = 0.2
      this.slashCenter[o3 + 2] = s.cz
      this.slashArc[o4] = s.angle
      this.slashArc[o4 + 1] = s.span
      this.slashArc[o4 + 2] = s.radius
      this.slashArc[o4 + 3] = s.innerRatio
      this.slashParam[o4] = s.t
      this.slashParam[o4 + 1] = s.arch
      this.slashParam[o4 + 2] = s.seed
      this.slashParam[o4 + 3] = s.bladeGain
      this.slashColor[o3] = s.r
      this.slashColor[o3 + 1] = s.g
      this.slashColor[o3 + 2] = s.b
      n++
    }
    this.slashLayer.commit(n)
  }

  private drawRings(dt: number): void {
    let n = 0
    for (let i = this.rings.count - 1; i >= 0; i--) {
      const r = this.rings.items[i]!
      r.t += dt / r.dur
      if (r.t >= 1) {
        this.rings.remove(i)
        continue
      }
      const o3 = n * 3
      const o4 = n * 4
      this.ringCenter[o3] = r.x
      this.ringCenter[o3 + 1] = 0.07
      this.ringCenter[o3 + 2] = r.z
      this.ringParam[o4] = r.radius
      this.ringParam[o4 + 1] = r.t
      this.ringParam[o4 + 2] = r.style
      this.ringParam[o4 + 3] = r.seed
      this.ringColor[o3] = r.r
      this.ringColor[o3 + 1] = r.g
      this.ringColor[o3 + 2] = r.b
      n++
    }
    this.ringLayer.commit(n)
  }

  private drawDecals(dt: number): void {
    let n = 0
    for (let i = this.decals.count - 1; i >= 0; i--) {
      const d = this.decals.items[i]!
      d.t += dt / d.dur
      if (d.t >= 1) {
        this.decals.remove(i)
        continue
      }
      const o3 = n * 3
      this.decalCenter[o3] = d.x
      this.decalCenter[o3 + 1] = 0.018
      this.decalCenter[o3 + 2] = d.z
      this.decalParam[o3] = d.radius
      this.decalParam[o3 + 1] = d.t
      this.decalParam[o3 + 2] = d.seed
      n++
    }
    this.decalLayer.commit(n)
  }

  private drawFlares(dt: number): void {
    let n = 0
    for (let i = this.flares.count - 1; i >= 0; i--) {
      const f = this.flares.items[i]!
      f.t += dt / f.dur
      if (f.t >= 1) {
        this.flares.remove(i)
        continue
      }
      const o3 = n * 3
      const o4 = n * 4
      this.flarePos[o3] = f.x
      this.flarePos[o3 + 1] = f.y
      this.flarePos[o3 + 2] = f.z
      this.flareParam[o4] = f.size
      this.flareParam[o4 + 1] = f.t
      this.flareParam[o4 + 2] = f.angle
      this.flareParam[o4 + 3] = f.shape
      this.flareColor[o3] = f.r
      this.flareColor[o3 + 1] = f.g
      this.flareColor[o3 + 2] = f.b
      n++
    }
    this.flareLayer.commit(n)
  }

  /** 장판은 이벤트가 아니라 지속 상태다. 매 프레임 통째로 다시 읽는다. */
  private drawZones(world: World): void {
    let n = 0
    for (let i = 0; i < world.zones.length && n < CAP_ZONES; i++) {
      const z = world.zones[i]!
      const hex = ZONE_HEX[z.kind] ?? ZONE_HEX[0]!
      COLOR.set(hex).multiplyScalar(z.kind === 1 ? 2.0 : GAIN_CYAN)

      const o3 = n * 3
      const o4 = n * 4
      this.zoneCenter[o3] = z.x
      this.zoneCenter[o3 + 1] = 0.032
      this.zoneCenter[o3 + 2] = z.y
      this.zoneParam[o4] = z.radius
      // 빛기둥(0)은 허리 높이, 둔화장판(1)은 발목 높이. 옛 구현의 3.6짜리
      // 원기둥은 안에 있는 적과 캐릭터를 통째로 가려서 정작 장판 안에서
      // 무슨 일이 벌어지는지가 안 보였다.
      this.zoneParam[o4 + 1] = z.kind === 0 ? 1.15 : 0.38
      // 총 지속시간을 sim이 안 알려주므로 "마지막 0.9초"만 만료 연출로 쓴다.
      this.zoneParam[o4 + 2] = THREE.MathUtils.clamp((z.expireAt - world.time) / 0.9, 0, 1)
      this.zoneParam[o4 + 3] = z.kind
      this.zoneColor[o3] = COLOR.r
      this.zoneColor[o3 + 1] = COLOR.g
      this.zoneColor[o3 + 2] = COLOR.b
      this.zoneSeed[n] = seedFrom(z.x, z.y)
      n++
    }
    this.zoneLayer.commit(n)
  }

  private drawTelegraphs(world: World): void {
    let n = 0
    for (let i = 0; i < world.blasts.length && n < CAP_TELEGRAPHS; i++) {
      const b = world.blasts[i]!
      const hex = BLAST_HEX[b.kind] ?? BLAST_HEX[0]!
      COLOR.set(hex).multiplyScalar(b.kind === 1 ? GAIN_CRIMSON : GAIN_CYAN)

      const o3 = n * 3
      const o4 = n * 4
      this.teleCenter[o3] = b.x
      this.teleCenter[o3 + 1] = 0.045
      this.teleCenter[o3 + 2] = b.y
      this.teleParam[o4] = b.radius
      this.teleParam[o4 + 1] = THREE.MathUtils.clamp(
        1 - (b.fireAt - world.time) / BLAST_WARNING, 0, 1,
      )
      this.teleParam[o4 + 2] = b.kind
      this.teleParam[o4 + 3] = seedFrom(b.x, b.y)
      this.teleColor[o3] = COLOR.r
      this.teleColor[o3 + 1] = COLOR.g
      this.teleColor[o3 + 2] = COLOR.b
      n++
    }
    this.teleLayer.commit(n)
  }

  dispose(): void {
    for (const layer of [
      this.beamLayer,
      this.slashLayer,
      this.zoneLayer,
      this.teleLayer,
      this.ringLayer,
      this.decalLayer,
      this.flareLayer,
    ]) {
      this.scene.remove(layer.mesh)
      layer.dispose()
    }
  }
}

/* ---------------------------------------------------------------------------
 * 통합 방법 (renderer.ts — 통합자가 직렬로 처리한다)
 * ---------------------------------------------------------------------------
 *
 * 1) import 추가
 *      import { SkillFx } from './skillfx.ts'
 *
 * 2) 필드 추가 (renderer.ts:60 EnemyRenderer 옆)
 *      private readonly skillFx: SkillFx
 *
 * 3) 생성 — EnemyRenderer 생성 직후(renderer.ts:117). 훅은 형제 모듈이 준비되면
 *    채운다. 지금 비워 두어도 동작한다(옵셔널 호출).
 *      this.skillFx = new SkillFx(this.scene, {
 *        onImpact: (x, z, angle, color) => this.particles.burst(x, z, angle, color),
 *        onShake:  (strength) => this.shake.add(strength),
 *      })
 *
 * 4) 갱신 — renderer.ts:318 `this.enemyRenderer.update(world, alpha, dt)` **바로 다음 줄**.
 *      this.skillFx.update(world, alpha, now, dt)
 *    - now/dt는 render() 맨 앞(renderer.ts:284-287)에서 이미 만들어져 있는 값을 그대로 넘긴다.
 *      now는 초 단위 벽시계, dt는 0.1로 클램프된 벽시계 델타다.
 *    - alpha는 render()의 인자를 그대로 넘긴다(참격이 플레이어를 따라붙는 데 쓴다).
 *    - **반드시 drainEvents(main.ts:189)보다 앞이어야 한다.** render()가 이미 그 앞이므로
 *      이 위치면 자동으로 만족한다.
 *    - 이벤트 배열은 읽기만 한다. 절대 비우지 마라 — audio.update(main.ts:187)가
 *      렌더 뒤·drain 전에 같은 배열(casts/attacks/deaths)을 읽는다.
 *
 * 5) 판 시작 — beginRun 경로에서 렌더러가 초기화될 때 한 번.
 *      this.skillFx.reset()
 *    이걸 빼면 이전 판에서 추적 중이던 폭발이 새 판 첫 프레임에 한 번 터진다.
 *
 * 6) 품질 — updateRenderQuality(renderer.ts:336)에서 `constrained`가 참일 때.
 *      this.skillFx.setQuality(constrained ? 0.45 : 1)
 *
 * 7) 정리 — dispose()(renderer.ts:464 enemyRenderer.dispose() 옆).
 *      this.skillFx.dispose()
 *
 * 8) **enemies.ts에서 걷어낼 것** (이 모듈이 전부 대체한다):
 *      - 필드/메시: tracerMesh, tracerCoreMesh, projectileMesh, slashMesh,
 *        ringMesh, fieldDiscMesh, fieldEdgeMesh, pillarMesh (8개)
 *      - 메서드: drawFields, drawRings, drawTracers, captureTracers, setLineAt
 *      - 상태: rings[], tracers[], TracerFx/Ring/TracerStyle 타입,
 *        RING_COLORS/TRACER_COLORS/TRACER_CORE_COLORS/ZONE_COLORS,
 *        MAX_TRACERS/MAX_PROJECTILES/MAX_SLASHES/MAX_RINGS/RING_DURATION/
 *        MAX_FIELD_DISCS/MAX_FIELD_EDGES/MAX_PILLARS/BLAST_WARNING_DURATION
 *      - update()에는 drawEnemies + drawPops만 남는다(팝은 사망 연출 모듈 담당).
 *    이 8개를 지우면 드로우콜이 8 줄고 여기서 7이 늘어 순증 -1이다.
 *
 * 9) 후처리(EffectComposer)를 나중에 붙일 때 이 파일은 손대지 않아도 된다.
 *    모든 프래그먼트가 <tonemapping_fragment> + <colorspace_fragment>로 끝나는데,
 *    three가 렌더 타겟 경로에서 TONE_MAPPING define을 자동으로 끄고
 *    linearToOutputTexel을 항등함수로 바꾸므로 두 줄이 스스로 무력화된다.
 *    발광 게인(GAIN_*)은 블룸 threshold 0.9를 넘도록 이미 잡아 두었다.
 *
 * 성능: 드로우콜 +7 고정(모두 인스턴스, 비어 있으면 three가 draw를 건너뛴다).
 *       프레임당 힙 할당 0 — 풀·타입배열·스크래치 Color를 전부 생성자에서 잡는다.
 *       상한: 빔 32 / 참격 20 / 링 28 / 데칼 14 / 플레어 56 / 장판 12 / 예고 12.
 * --------------------------------------------------------------------------- */
