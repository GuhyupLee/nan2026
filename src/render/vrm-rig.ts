import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import type { PlayerClass } from '../sim/types.ts'
import { CHARACTER_HEIGHT, type CharacterAction, type CharacterRig } from './rig.ts'

/**
 * VRoid Studio에서 뽑은 VRM 캐릭터.
 *
 * 프리미티브를 깎아 만든 얼굴은 근접에서 한계가 명확했다. 눈을 구로 만들어
 * 머리 표면에 앉히려는 시도를 세 번 했는데, 애초에 업계가 안 쓰는 방식이다 —
 * 애니메 3D는 형상이 아니라 **셰이딩**이 만든다. VRM 규격은 MToon(툰 셰이더)과
 * 스프링본(머리카락·치마 물리)을 규격 안에 갖고 있어서, 파일을 얹는 것만으로
 * 셀셰이딩과 관성 연출이 따라온다.
 *
 * ## 좌표 규약
 *
 * VRM 1.0 모델은 **+Z를 보고 서 있고 왼쪽이 +X**다. 우리 sim은 facing 0이
 * +X라서, vrm.scene을 감싼 안쪽 그룹을 Y축으로 +90도 돌려 맞춘다.
 * 바깥 그룹(`group`)은 렌더러가 `rotation.y = -facing`으로 돌린다.
 *
 * ## 본 축
 *
 * `getNormalizedBoneNode`가 주는 정규화 본은 **T포즈에서 회전이 전부 항등**이고
 * 로컬 축이 월드 축과 정렬돼 있다. 덕분에 축의 의미가 고정된다:
 *
 * | 본 | x | y | z |
 * |---|---|---|---|
 * | spine/chest/head | 앞뒤 숙임(+앞) | 좌우 비틀기(+왼쪽) | 좌우 기울임(+오른쪽) |
 * | upperArm | 앞뒤 스윙(−앞) | 비틀기 | 들어올리기(T포즈 복귀 방향) |
 * | lowerArm | — | 팔꿈치(−side가 앞으로) | — |
 * | upperLeg | 앞뒤 스윙(−앞) | 벌리기 | 좌우 벌림 |
 * | lowerLeg | 무릎(+가 뒤로) | — | — |
 *
 * THREE의 기본 오일러 순서는 XYZ = Rx·Ry·Rz라 **z가 먼저, x가 마지막**에
 * 적용된다. 팔에서 이 순서가 중요하다 — z로 팔을 내린 다음 x로 흔들어야
 * 어깨에서 앞뒤로 스윙한다. 순서가 반대면 T포즈 상태로 위아래로 퍼덕인다.
 */

/** 왼쪽이 +1. 본 이름과 축 부호를 한 번에 뒤집는 데 쓴다. */
type Side = 1 | -1

const MODEL_URL: Record<PlayerClass, string> = {
  melee: 'models/wola.vrm',
  ranged: 'models/ilhyeon.vrm',
}

const ACCENT: Record<PlayerClass, number> = {
  melee: 0xff5a6e,
  ranged: 0x4dd0ff,
}

/** T포즈에서 자연스러운 대기 자세로 내리는 기본 오프셋. */
const REST = {
  /** 팔을 몸 옆으로 내리는 각. T포즈(0)에서 이만큼 내린다. */
  armDown: 1.31,
  /** 내린 팔이 몸통에 파묻히지 않게 살짝 앞으로. */
  armForward: -0.06,
  /** 팔꿈치 기본 굽힘. 완전히 편 팔은 인형처럼 보인다. */
  elbow: 0.16,
  /** 다리를 살짝 벌려 선다. */
  legSplay: 0.028,
}

/**
 * 대기 상태에서 무기가 향하는 방향. 캐릭터 공간(+X 앞, +Y 위, +Z 오른쪽)이고
 * 무기의 로컬 +Y(칼끝·지팡이 끝)를 어디로 보낼지를 정한다.
 */
const WEAPON_REST: Record<PlayerClass, [number, number, number]> = {
  // 지팡이는 수직으로 짚는다. 머리 위로 솟은 보주가 원거리 클래스의 실루엣이다.
  ranged: [0, 0, 0],
  // 칼은 앞을 향해 낮게 겨눈다. 쿼터뷰에서 칼끝이 진행 방향을 가리켜야
  // 근접 클래스라는 게 한눈에 읽힌다.
  melee: [0.15, 0, -1.35],
}

interface VrmPose {
  hips: [number, number, number]
  spine: [number, number, number]
  chest: [number, number, number]
  head: [number, number, number]
  /**
   * 팔 — `[앞으로, 비틀기, 들어올림, 팔꿈치]`. armR이 무기를 든 오른팔.
   *
   * 네 값 모두 **좌우 대칭으로 같은 뜻**이다. 처음에는 본의 로컬 축 값을
   * 그대로 적었는데 z의 부호가 좌우에서 반대라, 오른팔에 +0.95를 주면
   * T포즈를 지나 머리 위로 넘어가 버렸다(치마 스프링본까지 같이 터졌다).
   *
   * - `앞으로` + 면 팔이 앞으로 나온다
   * - `비틀기` + 면 몸 안쪽으로 감긴다
   * - `들어올림` **0 = 옆구리 · 1.31 = 수평(T포즈) · 2.2 = 머리 위**. 절대값이다
   * - `팔꿈치` + 면 굽는다
   */
  armR: [number, number, number, number]
  armL: [number, number, number, number]
  /**
   * 무기가 향할 방향. **캐릭터 공간**(+X 앞, +Y 위, +Z 오른쪽) 기준 오일러이며
   * 기본 자세(`WEAPON_REST`)에 더해진다.
   *
   * 손 본의 로컬 축으로 무기를 맞추는 방식을 먼저 썼는데, VRoid 손 본은
   * 로컬 −X가 손가락, +Z가 엄지라 직관과 전혀 안 맞아서 매번 빗나갔다.
   * 무엇보다 칼의 **궤적**이 근접 타격감의 전부인데, 손 본 기준으로는
   * 그 궤적을 설계할 수가 없다. 그래서 매 프레임 손의 월드 회전을 상쇄하고
   * 여기 적힌 방향을 그대로 쓴다 — 손은 위치만 나르고 방향은 우리가 잡는다.
   */
  aim: [number, number, number]
  /** 몸 전체를 띄우는 높이. 도약·회피에 쓴다. */
  lift: number
}

const ZERO: VrmPose = {
  hips: [0, 0, 0],
  spine: [0, 0, 0],
  chest: [0, 0, 0],
  head: [0, 0, 0],
  armR: [0, 0, 0, 0],
  armL: [0, 0, 0, 0],
  aim: [0, 0, 0],
  lift: 0,
}

const ACTION_DURATION: Record<CharacterAction, number> = {
  attack: 0.26,
  empowered: 0.46,
  ult: 0.34,
  q: 0.36,
  w: 0.44,
  e: 0.58,
  r: 0.9,
}

/**
 * 시전 포즈.
 *
 * 축을 하나만 쓰면 2D 그림처럼 납작해서, 모든 동작이 **비틀기(y) · 숙임(x) ·
 * 기울임(z)** 을 함께 쓴다. 골반과 어깨를 반대로 비트는 것이 특히 중요하다 —
 * 그 반대 위상 하나가 "포즈를 취한 인형"을 "힘을 쓰는 사람"으로 바꾼다.
 */
const POSES: Record<PlayerClass, Record<CharacterAction, VrmPose>> = {
  // 일현 — 지팡이로 선을 긋는다. 상체를 열고 팔을 뻗는 계열.
  ranged: {
    // 평타: 지팡이를 앞으로 툭 내민다. 짧고 반복되므로 크게 쓰지 않는다.
    attack: {
      hips: [0, -0.1, 0],
      spine: [0.04, -0.16, 0.04],
      chest: [0, -0.1, 0],
      head: [0.02, 0.14, 0],
      armR: [0.45, 0.15, 0.85, 0.55],
      armL: [0.20, 0.00, 0.30, 0.35],
      aim: [0, 0, 0.3],
      lift: 0,
    },
    // 강화 평타: 같은 동작을 크게. 몸이 따라 열린다.
    empowered: {
      hips: [0, -0.2, 0.04],
      spine: [-0.06, -0.3, 0.08],
      chest: [-0.04, -0.16, 0.04],
      head: [0.04, 0.26, 0],
      armR: [0.65, 0.20, 1.00, 0.45],
      armL: [0.32, 0.05, 0.45, 0.50],
      aim: [0, 0, 0.42],
      lift: 0.02,
    },
    // Q 관통: 지팡이를 수평으로 찔러 넣는다. 어깨 라인이 표적을 향한다.
    q: {
      hips: [0, -0.26, 0],
      spine: [0.1, -0.4, 0.06],
      chest: [0.04, -0.2, 0],
      head: [0.06, 0.34, 0],
      armR: [0.80, 0.25, 1.15, 0.25],
      armL: [-0.30, -0.20, 0.45, 0.95],
      aim: [0, 0, 0.24],
      lift: 0.01,
    },
    // W 굴절: 몸을 비틀며 옆으로 미끄러진다. 회피 동작이라 무게가 죽는다.
    w: {
      hips: [-0.16, 0.34, -0.12],
      spine: [-0.2, 0.4, -0.16],
      chest: [-0.1, 0.2, -0.08],
      head: [0.1, -0.5, 0.1],
      armR: [-0.30, -0.15, 0.50, 0.80],
      armL: [0.50, 0.20, 0.80, 0.60],
      aim: [0.3, 0, -0.3],
      lift: 0.09,
    },
    // E 성역: 지팡이를 머리 위로 들어 원을 그린다. 몸이 활처럼 젖는다.
    e: {
      hips: [-0.1, 0, 0],
      spine: [-0.26, 0.12, 0],
      chest: [-0.16, 0.06, 0],
      head: [-0.24, 0, 0],
      armR: [0.15, 0.30, 1.85, 0.85],
      armL: [0.25, 0.30, 1.55, 1.15],
      aim: [0, 0, -0.4],
      lift: 0.05,
    },
    // R 종막: 궁극기. 가장 크게 젖혔다가 내리꽂는다.
    r: {
      hips: [0.12, -0.16, 0],
      spine: [-0.4, -0.24, 0.1],
      chest: [-0.24, -0.12, 0.06],
      head: [-0.3, 0.2, 0],
      armR: [0.05, 0.15, 2.15, 0.45],
      armL: [0.20, 0.20, 1.50, 0.95],
      aim: [0, 0, -0.55],
      lift: 0.13,
    },
    // 궁극기 후속타
    ult: {
      hips: [0.16, -0.2, 0.06],
      spine: [0.3, -0.34, 0.12],
      chest: [0.16, -0.18, 0.06],
      head: [0.14, 0.24, 0],
      armR: [0.95, 0.25, 0.95, 0.20],
      armL: [0.25, 0.10, 0.55, 0.65],
      aim: [0, 0, 0.5],
      lift: 0.04,
    },
  },

  // 월아 — 칼로 원을 판다. 몸을 감았다 푸는 회전 계열.
  melee: {
    // 평타: 사선 베기. 골반→어깨→칼 순으로 풀린다.
    attack: {
      hips: [0, 0.22, 0],
      spine: [0.14, -0.42, 0.16],
      chest: [0.08, -0.24, 0.1],
      head: [0.04, 0.3, 0.06],
      armR: [0.55, 0.25, 1.00, 0.50],
      armL: [-0.25, -0.15, 0.45, 0.65],
      aim: [0, 0, 0.55],
      lift: 0.01,
    },
    // 강화 평타(월참): 크게 감았다 푼다. 회전이 두 배.
    empowered: {
      hips: [-0.04, 0.5, -0.06],
      spine: [0.18, -0.75, 0.26],
      chest: [0.1, -0.4, 0.16],
      head: [0.06, 0.55, 0.1],
      armR: [0.70, 0.30, 1.18, 0.40],
      armL: [-0.35, -0.20, 0.60, 0.85],
      aim: [0, 0, 0.85],
      lift: 0.04,
    },
    // Q 초승: 발도. 몸을 낮추고 칼을 몸 앞으로 가로질러 뽑는다.
    q: {
      hips: [0.16, 0.4, -0.08],
      spine: [0.24, -0.66, 0.22],
      chest: [0.12, -0.34, 0.12],
      head: [0.02, 0.5, 0.08],
      armR: [0.65, 0.40, 0.72, 0.95],
      armL: [-0.15, -0.30, 0.55, 1.05],
      aim: [0, 0, 0.7],
      lift: -0.03,
    },
    // W 보법: 파고드는 대시. 몸을 앞으로 접고 칼을 뒤로 흘린다.
    w: {
      hips: [0.3, -0.2, 0],
      spine: [0.36, 0.3, -0.12],
      chest: [0.2, 0.16, -0.06],
      head: [-0.24, -0.3, 0],
      armR: [-0.55, -0.20, 0.50, 0.55],
      armL: [0.60, 0.25, 0.70, 0.95],
      aim: [0, 0, -0.5],
      lift: 0.11,
    },
    // E 회선: 제자리 회전 베기. 골반과 어깨를 최대로 반대로 감고
    // 양팔을 수평까지만 편다 — 더 올리면 회전이 아니라 만세가 된다.
    e: {
      hips: [-0.06, -0.62, 0.1],
      spine: [0.1, 0.85, -0.2],
      chest: [0.04, 0.45, -0.1],
      head: [0.04, -0.7, -0.1],
      armR: [0.15, 0.20, 1.20, 0.30],
      armL: [-0.40, -0.20, 1.05, 0.45],
      aim: [0, 0, 0.35],
      lift: 0.03,
    },
    // R 월륜: 궁극기. 위로 솟았다가 내리찍는다.
    r: {
      hips: [-0.2, 0.3, 0],
      spine: [-0.42, -0.5, 0.18],
      chest: [-0.24, -0.26, 0.1],
      head: [-0.34, 0.34, 0],
      armR: [0.05, 0.10, 2.10, 0.35],
      armL: [0.12, 0.10, 1.70, 0.60],
      aim: [0, 0, -0.6],
      lift: 0.16,
    },
    // 궁극기 후속타 — 내리꽂은 직후
    ult: {
      hips: [0.34, 0.1, 0],
      spine: [0.5, -0.3, 0.12],
      chest: [0.26, -0.16, 0.06],
      head: [0.2, 0.2, 0],
      armR: [0.75, 0.25, 0.45, 0.40],
      armL: [0.15, 0.10, 0.35, 0.75],
      aim: [0, 0, 0.75],
      lift: -0.05,
    },
  },
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** 0에서 올라갔다 내려오는 종. 크고 느린 동작(E·R)의 강도 곡선. */
function bell(t: number): number {
  return Math.sin(clamp01(t) * Math.PI)
}

/** 앞부분에서 확 치고 천천히 풀린다. 짧고 반복되는 동작(평타·Q)에 쓴다. */
function snap(t: number): number {
  const x = clamp01(t)
  return x < 0.28 ? x / 0.28 : 1 - (x - 0.28) / 0.72
}

// ---------------------------------------------------------------------------
// 로딩
// ---------------------------------------------------------------------------

const loader = new GLTFLoader()
loader.register((parser) => new VRMLoaderPlugin(parser))

const pending = new Map<PlayerClass, Promise<VRM | null>>()
const ready = new Map<PlayerClass, VRM>()

async function load(cls: PlayerClass): Promise<VRM | null> {
  const url = `${import.meta.env.BASE_URL}${MODEL_URL[cls]}`
  try {
    const gltf = await loader.loadAsync(url)
    const vrm = gltf.userData.vrm as VRM | undefined
    if (!vrm) return null

    // VRoid는 안 쓰는 정점·표정 모프를 잔뜩 넣어 내보낸다. 우리는 표정을
    // 쓰지 않으므로 전부 털어낸다. 파일이 아니라 GPU 메모리와 스킨 비용이 준다.
    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    VRMUtils.combineSkeletons(gltf.scene)
    VRMUtils.combineMorphs(vrm)

    vrm.scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (!m.isMesh) return
      m.castShadow = true
      m.receiveShadow = false
      // 스킨드 메시는 바인드 포즈 기준 바운딩으로 컬링돼서, 팔을 크게 휘두르면
      // 화면 가장자리에서 통째로 사라진다. 캐릭터는 하나뿐이라 컬링이 아깝지 않다.
      m.frustumCulled = false
    })

    // VRM 0.x는 -Z를 본다. 1.0 규약(+Z)으로 맞춰 아래 회전 계산을 하나로 둔다.
    VRMUtils.rotateVRM0(vrm)

    ready.set(cls, vrm)
    return vrm
  } catch (err) {
    // 파일이 없는 건 정상 경로다 — 프로시저럴 모델로 조용히 폴백한다.
    console.warn(`[vrm] ${url} 로드 실패, 프로시저럴 모델로 폴백`, err)
    return null
  }
}

/** 두 모델을 백그라운드로 받기 시작한다. 메인 메뉴가 뜨는 동안 돌아간다. */
export function startVrmPreload(): void {
  for (const cls of ['ranged', 'melee'] as PlayerClass[]) {
    if (!pending.has(cls)) pending.set(cls, load(cls))
  }
}

/** 해당 클래스의 VRM이 준비될 때까지 기다린다. 실패하면 false. */
export async function ensureVrm(cls: PlayerClass): Promise<boolean> {
  if (ready.has(cls)) return true
  if (!pending.has(cls)) pending.set(cls, load(cls))
  return (await pending.get(cls)!) !== null
}

export function hasVrm(cls: PlayerClass): boolean {
  return ready.has(cls)
}

// ---------------------------------------------------------------------------
// 무기
// ---------------------------------------------------------------------------

function metal(color: number, rough = 0.24): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.85 })
}

function glow(color: number, intensity = 0.7): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.3,
    metalness: 0.1,
  })
}

function mesh(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  pos?: [number, number, number],
  rot?: [number, number, number],
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  if (pos) m.position.set(...pos)
  if (rot) m.rotation.set(...rot)
  m.castShadow = true
  m.frustumCulled = false
  parent.add(m)
  return m
}

/**
 * 손에 쥐는 무기. VRoid는 소품을 못 만들기 때문에 여기서 만들어 손 본에 붙인다.
 *
 * 원점이 **손잡이 한가운데**다. 손 본의 원점이 주먹 안쪽이라 여기에 맞춰야
 * 쥔 것처럼 보인다. Y+가 칼끝/지팡이 끝 방향.
 */
function buildWeapon(cls: PlayerClass): THREE.Group {
  const g = new THREE.Group()
  const accent = glow(ACCENT[cls])

  if (cls === 'melee') {
    // 카타나는 신장 1.75 기준 전장 1.0m 안팎이어야 손에 맞는다.
    g.scale.setScalar(0.84)
    const blade = metal(0xdbe3ec, 0.14)
    const wrap = new THREE.MeshStandardMaterial({ color: 0x2b3240, roughness: 0.8 })
    // 날 — 살짝 휜 느낌을 주려고 두 토막으로 나눠 각도를 준다.
    // 실제 카타나 날 폭은 3cm 남짓인데 그대로 만들었더니 쿼터뷰에서 칼이 아니라
    // 창처럼 읽혔다. 폭을 두 배 가까이 과장해야 검으로 보인다.
    mesh(g, new THREE.BoxGeometry(0.058, 0.5, 0.014), blade, [0, 0.35, 0])
    mesh(g, new THREE.BoxGeometry(0.054, 0.42, 0.014), blade, [0, 0.79, 0.022], [0.07, 0, 0])
    mesh(g, new THREE.ConeGeometry(0.038, 0.15, 4), blade, [0, 1.06, 0.04], [0.07, Math.PI / 4, 0])
    // 날등의 발광 라인 — 쿼터뷰에서 칼의 궤적을 읽게 해주는 유일한 신호
    mesh(g, new THREE.BoxGeometry(0.009, 0.9, 0.018), accent, [0, 0.57, 0.014])
    // 츠바
    mesh(g, new THREE.CylinderGeometry(0.068, 0.068, 0.014, 16), accent, [0, 0.09, 0])
    // 자루
    mesh(g, new THREE.CylinderGeometry(0.021, 0.019, 0.24, 12), wrap, [0, -0.04, 0])
    mesh(g, new THREE.SphereGeometry(0.025, 12, 8), accent, [0, -0.17, 0])
    return g
  }

  // 그립이 원점이고 y+가 지팡이 끝이다. 손 높이(≈0.99)에서 보주가 머리 위로
  // 오도록 전체를 내려 잡았다 — 처음에는 보주가 화면 밖으로 나갔다.
  const gold = metal(0xe0bc6a, 0.3)
  mesh(g, new THREE.CylinderGeometry(0.017, 0.017, 1.24, 12), gold, [0, 0.17, 0])
  mesh(g, new THREE.TorusGeometry(0.058, 0.012, 8, 20), gold, [0, 0.65, 0], [Math.PI / 2, 0, 0])
  mesh(g, new THREE.OctahedronGeometry(0.09, 1), accent, [0, 0.75, 0])
  mesh(g, new THREE.TorusGeometry(0.125, 0.01, 8, 24), accent, [0, 0.75, 0], [0.5, 0.35, 0])
  mesh(g, new THREE.TorusGeometry(0.16, 0.008, 8, 28), accent, [0, 0.75, 0], [-0.4, -0.2, 0.3])
  return g
}

// ---------------------------------------------------------------------------
// 리그
// ---------------------------------------------------------------------------

interface Joints {
  hips: THREE.Object3D
  spine: THREE.Object3D
  chest: THREE.Object3D | null
  head: THREE.Object3D | null
  upperArm: [THREE.Object3D | null, THREE.Object3D | null]
  lowerArm: [THREE.Object3D | null, THREE.Object3D | null]
  hand: [THREE.Object3D | null, THREE.Object3D | null]
  upperLeg: [THREE.Object3D | null, THREE.Object3D | null]
  lowerLeg: [THREE.Object3D | null, THREE.Object3D | null]
  foot: [THREE.Object3D | null, THREE.Object3D | null]
}

function set(node: THREE.Object3D | null, x: number, y: number, z: number): void {
  if (node) node.rotation.set(x, y, z)
}

/**
 * VRM 하나로 리그를 만든다.
 *
 * VRM 인스턴스는 캐시에 남아 판을 넘어 재사용된다. 그래서 `dispose`는
 * 모델을 파괴하지 않고 무기만 정리한다 — 파괴하면 다음 판에서 빈 캐릭터가 뜬다.
 */
export function createVrmRig(cls: PlayerClass): CharacterRig | null {
  const vrm = ready.get(cls)
  if (!vrm) return null

  const humanoid = vrm.humanoid
  const group = new THREE.Group()
  const orient = new THREE.Group()
  // VRM은 +Z를 보고 sim의 facing 0은 +X다.
  orient.rotation.y = Math.PI / 2
  group.add(orient)
  orient.add(vrm.scene)

  // VRoid 기본 신장이 얼마든 게임 스케일에 맞춘다. 아레나·카메라·적 크기가
  // 전부 1.75 기준으로 잡혀 있어서, 여기서 정규화해야 나머지가 안 흔들린다.
  const box = new THREE.Box3().setFromObject(vrm.scene)
  const h = box.max.y - box.min.y
  if (h > 0.1) {
    const s = CHARACTER_HEIGHT / h
    orient.scale.setScalar(s)
  }

  const j: Joints = {
    hips: humanoid.getNormalizedBoneNode('hips')!,
    spine: humanoid.getNormalizedBoneNode('spine')!,
    chest:
      humanoid.getNormalizedBoneNode('upperChest') ?? humanoid.getNormalizedBoneNode('chest'),
    head: humanoid.getNormalizedBoneNode('head'),
    upperArm: [
      humanoid.getNormalizedBoneNode('leftUpperArm'),
      humanoid.getNormalizedBoneNode('rightUpperArm'),
    ],
    lowerArm: [
      humanoid.getNormalizedBoneNode('leftLowerArm'),
      humanoid.getNormalizedBoneNode('rightLowerArm'),
    ],
    hand: [
      humanoid.getNormalizedBoneNode('leftHand'),
      humanoid.getNormalizedBoneNode('rightHand'),
    ],
    upperLeg: [
      humanoid.getNormalizedBoneNode('leftUpperLeg'),
      humanoid.getNormalizedBoneNode('rightUpperLeg'),
    ],
    lowerLeg: [
      humanoid.getNormalizedBoneNode('leftLowerLeg'),
      humanoid.getNormalizedBoneNode('rightLowerLeg'),
    ],
    foot: [
      humanoid.getNormalizedBoneNode('leftFoot'),
      humanoid.getNormalizedBoneNode('rightFoot'),
    ],
  }

  // 무기는 raw 본에 붙인다. 정규화 본은 매 프레임 raw로 복사되는 프록시라
  // 실제 스킨이 따라가는 건 raw 쪽이다.
  const weapon = buildWeapon(cls)
  const rawHand = humanoid.getRawBoneNode('rightHand')
  if (rawHand) {
    // 손 본은 무기의 **위치**만 나른다. 방향은 매 프레임 월드 기준으로 다시
    // 잡으므로 여기서 회전을 줄 필요가 없다.
    rawHand.add(weapon)
  }
  // 손 본의 월드 스케일이 1이 아니면(VRoid는 1.2 안팎) 무기까지 같이 커진다.
  // 무기는 게임 스케일(신장 1.75) 기준으로 만들었으므로 역보정한다.
  const handScale = rawHand
    ? rawHand.getWorldScale(new THREE.Vector3()).x || 1
    : 1
  // setScalar가 아니라 곱하기다 — buildWeapon이 잡아둔 무기별 크기를 지우면 안 된다.
  weapon.scale.multiplyScalar(1 / handScale)

  const restAim = WEAPON_REST[cls]
  const aimEuler = new THREE.Euler()
  const aimQuat = new THREE.Quaternion()
  const handQuat = new THREE.Quaternion()
  const groupQuat = new THREE.Quaternion()

  const poses = POSES[cls]
  let actionKind: CharacterAction | null = null
  let actionStart = -99
  let lastTime = -1
  const hips0 = j.hips.position.y

  const rig: CharacterRig = {
    group,

    playAction(kind, time) {
      actionKind = kind
      actionStart = time
    },

    update(time, speed) {
      const dt = lastTime < 0 ? 1 / 60 : Math.min(0.1, Math.max(0, time - lastTime))
      lastTime = time

      const mv = Math.min(speed / 10, 1)
      // 걸음 위상. 속도가 오르면 보폭이 빨라진다.
      const gait = time * (3.1 + mv * 7.5)
      const sw = Math.sin(gait)
      const sw2 = Math.sin(gait * 2)

      // --- 시전 강도 ---
      let env = 0
      let p = ZERO
      if (actionKind) {
        const t = (time - actionStart) / ACTION_DURATION[actionKind]
        if (t >= 1) actionKind = null
        else {
          p = poses[actionKind]
          // 크고 느린 동작은 종 모양으로, 짧고 반복되는 건 스냅으로.
          env = actionKind === 'r' || actionKind === 'e' ? bell(t) : snap(t)
        }
      }

      // --- 상하 바운스 + 호흡 ---
      // 발이 땅을 두 번 딛는 동안 골반이 한 번 오르내린다(2배 주파수).
      const breath = Math.sin(time * 1.5) * 0.004
      j.hips.position.y = hips0 + sw2 * (0.006 + mv * 0.022) + breath + p.lift * env

      // --- 골반과 어깨를 반대로 ---
      const sway = sw * mv * 0.15
      set(j.hips, -sw * mv * 0.04 + p.hips[0] * env, sway + p.hips[1] * env, p.hips[2] * env)
      set(
        j.spine,
        p.spine[0] * env + mv * 0.06,
        -sway * 0.7 + p.spine[1] * env,
        p.spine[2] * env,
      )
      set(j.chest, p.chest[0] * env, -sway * 0.3 + p.chest[1] * env, p.chest[2] * env)
      // 머리는 몸통의 비틀림을 되돌려 시선을 진행 방향에 둔다
      const spineY = -sway * 0.7 + p.spine[1] * env
      set(
        j.head,
        Math.sin(time * 0.9) * 0.025 + p.head[0] * env,
        -spineY * 0.5 + p.head[1] * env,
        p.head[2] * env,
      )

      // --- 팔 ---
      // z로 내리고(먼저 적용), x로 앞뒤 스윙(나중에 적용). 순서가 반대면
      // T포즈에서 위아래로 퍼덕인다.
      for (let i = 0; i < 2; i++) {
        const side: Side = i === 0 ? 1 : -1
        const ap = i === 0 ? p.armL : p.armR
        // 팔은 같은 쪽 다리와 반대로 흔든다
        const swing = sw * side * mv * 0.42
        // z는 **내린 각도**다 — 0이 수평(T포즈), 양수가 아래. 그래서 들어올림은
        // 빼기로 들어간다. raise 1.31이면 수평, 2.2면 머리 위로 넘어간다.
        const down = REST.armDown - ap[2] * env
        set(
          j.upperArm[i]!,
          REST.armForward + swing - ap[0] * env,
          -side * ap[1] * env,
          -side * down,
        )
        set(j.lowerArm[i]!, 0, -side * (REST.elbow + ap[3] * env), 0)
      }

      // --- 다리 ---
      for (let i = 0; i < 2; i++) {
        const side: Side = i === 0 ? 1 : -1
        const swing = -sw * side * mv * 0.62
        set(j.upperLeg[i]!, swing, 0, -side * REST.legSplay)
        // 무릎은 뒤로만 굽는다. 앞으로 굽으면 즉시 부자연스러워 보인다.
        const knee = Math.max(0, sw * side) * mv * 0.9
        set(j.lowerLeg[i]!, knee, 0, 0)
        set(j.foot[i]!, -knee * 0.45, 0, 0)
      }

      // 스프링본(머리카락·치마·리본)과 MToon 갱신. 손으로 짠 관성 코드가
      // 하던 일을 규격이 대신한다. 정규화 본 → raw 본 복사도 여기서 일어나므로
      // 무기 방향은 반드시 이 뒤에 잡아야 한 프레임 늦지 않는다.
      vrm.update(dt)

      // --- 무기 방향 ---
      // 손 본의 월드 회전을 상쇄하고 캐릭터 공간 방향을 그대로 씌운다.
      if (rawHand) {
        // 렌더러가 월드 행렬을 갱신하기 전이라 손의 최신 회전을 직접 구한다.
        rawHand.updateWorldMatrix(true, false)
        rawHand.getWorldQuaternion(handQuat)
        group.getWorldQuaternion(groupQuat)
        aimEuler.set(
          restAim[0] + p.aim[0] * env,
          restAim[1] + p.aim[1] * env,
          restAim[2] + p.aim[2] * env,
        )
        aimQuat.setFromEuler(aimEuler)
        weapon.quaternion.copy(handQuat).invert().multiply(groupQuat).multiply(aimQuat)
      }
    },

    dispose() {
      // VRM은 캐시에 남아 다음 판에서 재사용된다. 무기만 정리한다.
      orient.remove(vrm.scene)
      if (rawHand) rawHand.remove(weapon)
      weapon.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else if (mat) (mat as THREE.Material).dispose()
      })
    },
  }

  rig.update(0, 0)
  return rig
}
