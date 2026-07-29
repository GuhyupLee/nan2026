import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm'
import {
  VRMAnimationLoaderPlugin,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation'
import { playerActionDuration } from '../sim/action-timing.ts'
import type { PlayerClass } from '../sim/types.ts'
import { CLASS_COLORS } from './palette.ts'
import { CHARACTER_HEIGHT, type CharacterAction, type CharacterRig } from './rig.ts'
import {
  VrmAnimationController,
  canStartVrmAction,
} from './vrm-animation.ts'

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

type NavigatorWithMobileHint = Navigator & {
  userAgentData?: { mobile?: boolean }
}

/**
 * 모바일에서는 VRM 파일 다운로드·파싱·스프링본 갱신을 전부 건너뛴다.
 *
 * UA Client Hints를 우선하고, iPadOS의 데스크톱 UA와 coarse pointer를 보완한다.
 * 터치 노트북은 보통 기본 포인터가 fine이라 불필요하게 경량 모드로 내려가지 않는다.
 */
function detectMobileDevice(): boolean {
  const nav = navigator as NavigatorWithMobileHint
  if (nav.userAgentData?.mobile === true) return true
  if (/Android|iPhone|iPad|iPod|Mobile|IEMobile|Opera Mini/i.test(nav.userAgent)) return true
  if (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1) return true
  return nav.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches
}

function devForcesProceduralModel(): boolean {
  return (
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get('model') === 'procedural'
  )
}

const vrmModelsEnabled =
  !devForcesProceduralModel() && !detectMobileDevice()

/** 현재 기기에서 VRM 모델을 사용해도 되는지 알려준다. */
export function shouldUseVrmModels(): boolean {
  return vrmModelsEnabled
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
    // 평타: **모션이 거의 없다.**
    //
    // 일현의 평타는 초당 3~4회 나간다. 그때마다 팔을 휘두르면 화면이
    // 지저분해지고, 무엇보다 마법사가 활을 쏘는 것처럼 보인다. 이 캐릭터는
    // 지팡이 보주가 알아서 쏘는 쪽이 문법에 맞다 — 그래서 몸은 표적 쪽으로
    // 살짝 돌아보기만 하고, 발사는 보주(`orbPulse`)가 담당한다.
    // 지팡이가 아주 조금 뒤로 밀리는 반동만 남겨 발사감을 준다.
    attack: {
      hips: [0, -0.04, 0],
      spine: [0.01, -0.09, 0.02],
      chest: [0, -0.06, 0],
      head: [0.01, 0.1, 0],
      armR: [0.04, 0.02, 0.06, 0.03],
      armL: [0.02, 0, 0.03, 0.04],
      aim: [0, 0, -0.07],
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
    // Q 삼중 굴절: 몸을 열고 양팔로 세 갈래 렌즈를 펼친다.
    q: {
      hips: [0, -0.05, 0],
      spine: [-0.12, 0, 0.04],
      chest: [-0.08, 0, 0],
      head: [-0.06, 0, 0],
      armR: [0.55, 0.35, 1.35, 0.55],
      armL: [-0.55, -0.35, 1.35, 0.55],
      aim: [0, 0, 0.15],
      lift: 0.04,
    },
    // W 광도약: 상체를 전방으로 싣고 착지 때 양팔로 균형을 잡는다.
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
      armR: [0.15, 0.30, 1.90, 0.80],
      armL: [0.40, 0.35, 1.05, 1.30],
      aim: [0, 0, -0.4],
      lift: 0.05,
    },
    // R 종막: 궁극기. 가장 크게 젖혔다가 내리꽂는다.
    r: {
      hips: [0.12, -0.16, 0],
      spine: [-0.4, -0.24, 0.1],
      chest: [-0.24, -0.12, 0.06],
      head: [-0.3, 0.2, 0],
      armR: [0.10, 0.25, 2.30, 0.35],
      armL: [0.35, 0.30, 1.00, 1.35],
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
      // 칼이 가슴 높이로 지나가야 한다. 어깨 높이로 올리면 VRoid 의상의 큰
      // 소매가 얼굴을 통째로 덮어, 캐릭터를 보여주는 컷에서 얼굴이 사라진다.
      armR: [0.02, 0.20, 0.92, 0.30],
      armL: [-0.40, -0.20, 0.85, 0.45],
      aim: [0, 0, 0.35],
      lift: 0.03,
    },
    // R 월륜: 궁극기. 위로 솟았다가 내리찍는다.
    r: {
      hips: [-0.2, 0.3, 0],
      spine: [-0.42, -0.5, 0.18],
      chest: [-0.24, -0.26, 0.1],
      head: [-0.34, 0.34, 0],
      armR: [0.05, 0.15, 2.25, 0.30],
      armL: [0.30, 0.25, 1.15, 1.20],
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

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 감속. 예비동작처럼 부드럽게 도착해야 하는 구간. */
function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t)
}

/** 가속. 타격처럼 뒤로 갈수록 빨라져야 하는 구간. */
function easeIn(t: number): number {
  return t * t
}

/**
 * 동작 타이밍.
 *
 * 처음에는 액션마다 목표 포즈 하나를 두고 종 모양 곡선으로 기울였다 돌아왔다.
 * 그래서 전부 "포즈를 취했다 푸는" 것처럼 보였다 — 예비동작이 없으면 타격에
 * 무게가 안 실린다. 실제 모션은 반대로 감았다가 튀어나간다.
 *
 * 그래서 강도 곡선의 치역을 음수까지 넓혔다. 같은 포즈 표에 **음수**를 곱하면
 * 그게 곧 반대 방향 예비동작이다 — 감는 포즈를 따로 14개 더 쓰지 않아도 된다.
 *
 *   0 → −wind → +1 → hold → −overshoot → 0
 *   (감기)   (타격)  (버팀)   (되돌림 오버슛)
 */
interface Timing {
  /** 감는 깊이. 타격 포즈의 몇 배로 반대로 감을지. */
  wind: number
  /** 감기가 끝나는 시점(0~1). */
  tWind: number
  /** 타격이 정점에 닿는 시점. tWind와 가까울수록 빠르게 꽂힌다. */
  tStrike: number
  /** 정점을 버티는 끝 시점. 무거운 기술일수록 길다. */
  tHold: number
  /** 되돌아올 때 0을 지나쳐 반대로 흔들리는 양. */
  overshoot: number
}

const TIMING: Record<CharacterAction, Timing> = {
  // 평타는 초당 3~4회 나간다. 감기가 길면 답답해서 얕고 짧게.
  attack: { wind: 0.3, tWind: 0.22, tStrike: 0.42, tHold: 0.5, overshoot: 0.1 },
  empowered: { wind: 0.42, tWind: 0.26, tStrike: 0.46, tHold: 0.56, overshoot: 0.14 },
  q: { wind: 0.35, tWind: 0.24, tStrike: 0.44, tHold: 0.54, overshoot: 0.12 },
  // 이동기는 즉발로 느껴져야 한다. 감기를 거의 없앤다 —
  // 여기서 0.4초를 끌면 조작이 안 먹은 것처럼 읽힌다.
  w: { wind: 0.14, tWind: 0.1, tStrike: 0.26, tHold: 0.42, overshoot: 0.08 },
  e: { wind: 0.45, tWind: 0.3, tStrike: 0.52, tHold: 0.66, overshoot: 0.12 },
  // 궁극기가 가장 깊게 감고 가장 오래 버틴다.
  r: { wind: 0.55, tWind: 0.34, tStrike: 0.58, tHold: 0.72, overshoot: 0.16 },
  // 궁극 후속타는 이미 움직이는 중이라 감을 시간이 없다.
  ult: { wind: 0.18, tWind: 0.14, tStrike: 0.32, tHold: 0.44, overshoot: 0.1 },
}

/** 진행도 t(0~1)를 강도로 바꾼다. 음수 구간이 예비동작이다. */
function envelope(t: number, k: Timing): number {
  const x = clamp01(t)
  if (x < k.tWind) return lerp(0, -k.wind, easeOut(x / k.tWind))
  if (x < k.tStrike) {
    return lerp(-k.wind, 1, easeIn((x - k.tWind) / (k.tStrike - k.tWind)))
  }
  if (x < k.tHold) return 1
  const u = (x - k.tHold) / (1 - k.tHold)
  // 1 → −overshoot → 0. 되돌림에 반동을 남겨야 동작이 끊기지 않는다.
  return u < 0.65
    ? lerp(1, -k.overshoot, easeOut(u / 0.65))
    : lerp(-k.overshoot, 0, (u - 0.65) / 0.35)
}

// ---------------------------------------------------------------------------
// 로딩
// ---------------------------------------------------------------------------

const loader = new GLTFLoader()
loader.register((parser) => new VRMLoaderPlugin(parser))
const animationLoader = new GLTFLoader()
animationLoader.register((parser) => new VRMAnimationLoaderPlugin(parser))

const pending = new Map<PlayerClass, Promise<VRM | null>>()
const ready = new Map<PlayerClass, VRM>()
const activeRigCount = new Map<PlayerClass, number>()
let previewClass: PlayerClass | null = null
let selectedClass: PlayerClass | null = null
let animationPending: Promise<readonly VRMAnimation[] | null> | null = null
let animationLibrary: readonly VRMAnimation[] | null = null

async function loadAnimationLibrary(): Promise<readonly VRMAnimation[] | null> {
  const url = `${import.meta.env.BASE_URL}animations/myeongwol-combat.vrma`
  try {
    const gltf = await animationLoader.loadAsync(url)
    const animations = gltf.userData.vrmAnimations as VRMAnimation[] | undefined
    if (!animations?.length) throw new Error('VRMA 파일에 재생 가능한 클립이 없습니다.')
    animationLibrary = animations
    return animations
  } catch (error) {
    console.warn('[vrma] 전투 모션 로드 실패, 절차식 모션으로 대체합니다.', error)
    return null
  }
}

function ensureAnimationLibrary(): Promise<readonly VRMAnimation[] | null> {
  if (!animationPending) animationPending = loadAnimationLibrary()
  return animationPending
}

function shouldRetainVrm(cls: PlayerClass): boolean {
  return (
    cls === previewClass ||
    cls === selectedClass ||
    (activeRigCount.get(cls) ?? 0) > 0
  )
}

function disposeUnusedVrm(cls: PlayerClass): void {
  if (shouldRetainVrm(cls)) return
  const vrm = ready.get(cls)
  if (!vrm) return
  ready.delete(cls)
  VRMUtils.deepDispose(vrm.scene)
}

function disposeAllUnusedVrms(): void {
  for (const cls of ready.keys()) disposeUnusedVrm(cls)
}

/** 클래스별 다운로드 진행률 0..1. 로딩 화면이 폴링해 바를 채운다. */
const loadProgress = new Map<PlayerClass, number>()

export function getVrmLoadProgress(cls: PlayerClass): number {
  if (ready.has(cls)) return 1
  return loadProgress.get(cls) ?? 0
}

async function load(cls: PlayerClass): Promise<VRM | null> {
  const url = `${import.meta.env.BASE_URL}${MODEL_URL[cls]}`
  // 이전 성공/실패가 남긴 값에서 시작하면 바가 100%에서 뒤로 점프한다.
  loadProgress.set(cls, 0)
  try {
    const gltf = await loader.loadAsync(url, (event) => {
      // 파싱 시간이 남아 있으므로 다운로드만으로 100%를 선언하지 않는다.
      if (event.lengthComputable && event.total > 0) {
        loadProgress.set(cls, Math.min(0.96, event.loaded / event.total))
      }
    })
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

    // 큰 모델을 파싱하는 동안 포인터가 다른 카드로 옮겨갈 수 있다.
    // 현재 리그가 쓰지도 않는 낡은 결과라면 캐시에 남기지 않는다.
    if (!shouldRetainVrm(cls)) {
      VRMUtils.deepDispose(vrm.scene)
      return null
    }

    ready.set(cls, vrm)
    loadProgress.set(cls, 1)
    return vrm
  } catch (err) {
    // 파일이 없는 건 정상 경로다 — 프로시저럴 모델로 조용히 폴백한다.
    console.warn(`[vrm] ${url} 로드 실패, 프로시저럴 모델로 폴백`, err)
    return null
  }
}

function requestVrm(cls: PlayerClass): Promise<VRM | null> {
  const cached = ready.get(cls)
  if (cached) return Promise.resolve(cached)

  const activeRequest = pending.get(cls)
  if (activeRequest) return activeRequest

  let request: Promise<VRM | null>
  request = load(cls).finally(() => {
    if (pending.get(cls) === request) pending.delete(cls)
  })
  pending.set(cls, request)
  return request
}

/** 현재 미리 보고 있는 카드의 모델 하나만 백그라운드에서 준비한다. */
export function preloadVrm(cls: PlayerClass): void {
  if (!vrmModelsEnabled) return
  previewClass = cls
  disposeAllUnusedVrms()
  void ensureAnimationLibrary()
  void requestVrm(cls)
}

/** 해당 클래스의 VRM이 준비될 때까지 기다린다. 실패하면 false. */
export async function ensureVrm(cls: PlayerClass): Promise<boolean> {
  if (!vrmModelsEnabled) return false
  selectedClass = cls
  previewClass = cls
  disposeAllUnusedVrms()
  const [vrm] = await Promise.all([requestVrm(cls), ensureAnimationLibrary()])
  return vrm !== null && ready.get(cls) === vrm
}

export function hasVrm(cls: PlayerClass): boolean {
  return vrmModelsEnabled && ready.has(cls)
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
interface Weapon {
  group: THREE.Group
  /**
   * 지팡이 보주와 그 궤도 링. 원거리 평타는 캐릭터가 팔을 휘두르는 게 아니라
   * **보주가 알아서 쏜다** — 그래서 발사 순간 여기만 반응하면 된다.
   * 근접에는 없다.
   */
  orb: THREE.Mesh | null
  rings: THREE.Mesh[]
  /** 무기 로컬 기준 발사점(보주 중심). 렌더러가 빔 시작점을 여기로 옮긴다. */
  muzzle: THREE.Vector3
  /** 궤적 리본이 따라갈 두 점. 무기 그룹의 자식이라 손을 따라 자동으로 움직인다. */
  base: THREE.Object3D
  tip: THREE.Object3D
}

/** 무기 로컬 y 두 지점에 빈 앵커를 심는다. 메시가 아니라 그리는 비용이 없다. */
function bladeAnchors(g: THREE.Group, baseY: number, tipY: number): {
  base: THREE.Object3D
  tip: THREE.Object3D
} {
  const base = new THREE.Object3D()
  base.position.set(0, baseY, 0)
  const tip = new THREE.Object3D()
  tip.position.set(0, tipY, 0)
  g.add(base, tip)
  return { base, tip }
}

function buildWeapon(cls: PlayerClass): Weapon {
  const g = new THREE.Group()
  const accent = glow(CLASS_COLORS[cls])

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
    // 츠바(0.09)에서 칼끝(1.13)까지가 날이다. 리본은 이 구간만 그린다 —
    // 자루까지 포함하면 손 주위에서 띠가 뭉친다.
    const katana = bladeAnchors(g, 0.09, 1.13)
    return {
      group: g,
      orb: null,
      rings: [],
      muzzle: new THREE.Vector3(0, 1.06, 0.04),
      base: katana.base,
      tip: katana.tip,
    }
  }

  // 그립이 원점이고 y+가 지팡이 끝이다. 손 높이(≈0.99)에서 보주가 머리 위로
  // 오도록 전체를 내려 잡았다 — 처음에는 보주가 화면 밖으로 나갔다.
  const gold = metal(0xe0bc6a, 0.3)
  const ORB_Y = 0.75
  mesh(g, new THREE.CylinderGeometry(0.017, 0.017, 1.24, 12), gold, [0, 0.17, 0])
  mesh(g, new THREE.TorusGeometry(0.058, 0.012, 8, 20), gold, [0, 0.65, 0], [Math.PI / 2, 0, 0])
  const orb = mesh(g, new THREE.OctahedronGeometry(0.09, 1), accent, [0, ORB_Y, 0])
  const rings = [
    mesh(g, new THREE.TorusGeometry(0.125, 0.01, 8, 24), accent, [0, ORB_Y, 0], [0.5, 0.35, 0]),
    mesh(g, new THREE.TorusGeometry(0.16, 0.008, 8, 28), accent, [0, ORB_Y, 0], [-0.4, -0.2, 0.3]),
  ]
  // 지팡이는 보주만 궤적을 남긴다. 봉 전체가 띠를 그리면 마법사가 아니라
  // 창을 휘두르는 것으로 보인다. 두 앵커를 보주 앞뒤로 짧게 잡았다.
  const wand = bladeAnchors(g, ORB_Y - 0.1, ORB_Y + 0.1)
  return {
    group: g,
    orb,
    rings,
    muzzle: new THREE.Vector3(0, ORB_Y, 0),
    base: wand.base,
    tip: wand.tip,
  }
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
 * 선택 중이거나 같은 클래스의 리그가 사용 중인 VRM은 판을 넘어 재사용한다.
 * 다른 클래스로 교체하면 리그를 먼저 분리한 뒤 참조 수가 0인 모델만 폐기한다.
 * `dispose`가 무기와 참조 수를 함께 정리해야 다음 판 재사용과 메모리 회수가
 * 둘 다 안전하게 성립한다.
 */
export function createVrmRig(cls: PlayerClass): CharacterRig | null {
  if (!vrmModelsEnabled) return null
  const vrm = ready.get(cls)
  if (!vrm) return null

  const humanoid = vrm.humanoid
  // 같은 VRM 인스턴스를 다음 판에도 재사용한다. 이전 Mixer/절차식 모션의
  // 마지막 프레임을 새 클립의 기준 자세로 저장하지 않도록 먼저 T포즈로 되돌린다.
  humanoid.resetNormalizedPose()
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
  const wep = buildWeapon(cls)
  const weapon = wep.group
  const rawHand = humanoid.getRawBoneNode('rightHand')
  if (rawHand) {
    // 위치와 방향 모두 raw 손 본을 따라간다. 아래에서 휴식 자세의 로컬 그립만
    // 한 번 맞추고, 전투 중 회전은 VRMA 손목 트랙에 맡긴다.
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
  if (rawHand) {
    // 휴식 자세에서 손→무기 로컬 그립을 한 번만 계산한다. 이후에는 raw hand의
    // 자식으로 그대로 두어 VRMA의 손목 회전이 검과 지팡이에 온전히 전달된다.
    vrm.update(0)
    group.updateWorldMatrix(true, true)
    const handWorld = rawHand.getWorldQuaternion(new THREE.Quaternion())
    const characterWorld = group.getWorldQuaternion(new THREE.Quaternion())
    const restQuaternion = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(...restAim),
    )
    weapon.quaternion
      .copy(handWorld)
      .invert()
      .multiply(characterWorld)
      .multiply(restQuaternion)
  }

  const poses = POSES[cls]
  const animation = VrmAnimationController.create(vrm, cls, animationLibrary)
  let actionKind: CharacterAction | null = null
  let actionStart = -99
  let lastTime = -1
  /** 선회 뱅킹의 현재 값과 직전 프레임 방위. 각속도를 재려면 둘 다 필요하다. */
  let bank = 0
  let lastYaw = 0
  /** 머리 요가 몸통을 지연해 따라오게 하는 필터 상태. */
  let headYaw = 0
  /** 보주가 마지막으로 발사한 시각과 그 세기. 원거리 평타 연출의 전부다. */
  let orbFiredAt = -99
  let orbPower = 1
  let disposed = false
  const hips0 = j.hips.position.y
  const orbMat = wep.orb ? (wep.orb.material as THREE.MeshStandardMaterial) : null
  const orbEmissive0 = orbMat ? orbMat.emissiveIntensity : 0

  const rig: CharacterRig = {
    group,
    source: 'vrm',

    playAction(kind, time, startedAt = time) {
      if (animation) {
        if (!animation.playAction(kind, time, startedAt)) return false
      } else {
        const progress = actionKind
          ? (time - actionStart) / playerActionDuration(cls, actionKind)
          : 1
        const newerPrimarySkill =
          (kind === 'q' || kind === 'w' || kind === 'e' || kind === 'r') &&
          startedAt > actionStart + 1e-6
        if (
          !newerPrimarySkill &&
          !canStartVrmAction(actionKind, progress, kind)
        ) {
          return false
        }
      }
      actionKind = kind
      actionStart = startedAt
      // 원거리 평타는 몸이 아니라 보주가 쏜다. 발사 이벤트를 여기서 받아
      // 보주만 반응시킨다.
      if (wep.orb && (kind === 'attack' || kind === 'empowered')) {
        orbFiredAt = startedAt
        orbPower = kind === 'empowered' ? 1.6 : 1
      }
      return true
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
      // env는 −wind에서 +1 사이를 오간다. 음수 구간이 예비동작이라, 같은 포즈에
      // 음수를 곱하는 것만으로 반대로 감는 동작이 나온다.
      let env = 0
      let p = ZERO
      if (actionKind) {
        const t =
          (time - actionStart) / playerActionDuration(cls, actionKind)
        if (t >= 1) actionKind = null
        else {
          p = poses[actionKind]
          env = envelope(t, TIMING[actionKind])
        }
      }

      // --- 선회 뱅킹 ---
      // 방향을 틀 때 오토바이처럼 안쪽으로 기운다. 쿼터뷰에서 이게 없으면
      // 캐릭터가 제자리에서 홱홱 도는 팽이로 보인다.
      if (!animation) {
      const yaw = group.rotation.y
      let dYaw = yaw - lastYaw
      // −π~π로 감아 한 바퀴 경계에서 튀지 않게 한다
      while (dYaw > Math.PI) dYaw -= Math.PI * 2
      while (dYaw < -Math.PI) dYaw += Math.PI * 2
      lastYaw = yaw
      const turnRate = dt > 0 ? dYaw / dt : 0
      // 1차 필터로 완만하게 따라가야 뱅킹이 덜덜거리지 않는다
      bank += (Math.max(-1, Math.min(1, turnRate * 0.16)) * mv * 0.26 - bank) * Math.min(1, dt * 9)

      // --- 무게중심 이동 ---
      // 멈춰 있을 때 호흡만 하면 마네킹이다. 호흡(1.5Hz)과 어긋나는 주기로
      // 체중을 좌우로 옮겨야 서 있는 사람으로 읽힌다.
      const still = 1 - mv
      const shift = Math.sin(time * 0.62) * still
      const breath = Math.sin(time * 1.5) * 0.004

      // --- 상하 바운스 ---
      // 발이 땅을 두 번 딛는 동안 골반이 한 번 오르내린다(2배 주파수).
      // 감는 동안(env<0) 살짝 주저앉아야 다음 타격이 무거워 보인다.
      j.hips.position.y =
        hips0 + sw2 * (0.006 + mv * 0.022) + breath + Math.max(-0.05, p.lift * env)

      // --- 골반과 어깨를 반대로 ---
      const sway = sw * mv * 0.15
      set(
        j.hips,
        -sw * mv * 0.04 + p.hips[0] * env,
        sway + p.hips[1] * env,
        shift * 0.035 + bank * 0.5 + p.hips[2] * env,
      )
      const spineY = -sway * 0.7 + p.spine[1] * env
      set(j.spine, p.spine[0] * env + mv * 0.06, spineY, -shift * 0.02 + bank + p.spine[2] * env)
      set(j.chest, p.chest[0] * env, -sway * 0.3 + p.chest[1] * env, bank * 0.4 + p.chest[2] * env)

      // --- 머리 ---
      // 머리는 몸통을 몇 프레임 늦게 따라간다. 이 지연 하나가 목이 있는 것처럼
      // 보이게 한다 — 같이 움직이면 머리가 몸통에 용접된 것처럼 읽힌다.
      const headTargetY = -spineY * 0.5 + p.head[1] * env
      headYaw += (headTargetY - headYaw) * Math.min(1, dt * 13)
      set(
        j.head,
        Math.sin(time * 0.9) * 0.025 + p.head[0] * env,
        headYaw,
        shift * 0.03 - bank * 0.35 + p.head[2] * env,
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
        //
        // 들어올림과 팔꿈치는 절대각이라 env가 음수일 때 그대로 곱하면
        // 어깨가 등 뒤로 꺾이고 팔꿈치가 반대로 굽는다. 예비동작으로 팔을
        // 뒤로 빼는 건 맞지만 관절 가동범위 안에서만 해야 한다.
        const down = REST.armDown - Math.max(-0.4, ap[2] * env)
        const elbow = Math.max(0.02, REST.elbow + ap[3] * env)
        set(
          j.upperArm[i]!,
          REST.armForward + swing - ap[0] * env - bank * side * 0.25,
          -side * ap[1] * env,
          -side * down,
        )
        set(j.lowerArm[i]!, 0, -side * elbow, 0)
      }

      // --- 다리 ---
      // 시전 중에 다리가 대기 자세로 남아 있으면 상체만 격렬하고 하체는
      // 가만한, 발이 땅에 안 붙은 그림이 된다. 강도만큼 자세를 낮추고
      // 오른발을 내디뎌 몸을 받친다.
      const stance = Math.abs(env)
      for (let i = 0; i < 2; i++) {
        const side: Side = i === 0 ? 1 : -1
        const swing = -sw * side * mv * 0.62
        // 오른발(side −1)이 앞, 왼발이 뒤. 무기를 오른손에 들었으므로
        // 같은 쪽 발이 앞으로 나가야 체중이 칼을 따라간다.
        const step = -side * stance * 0.3
        set(
          j.upperLeg[i]!,
          swing + step,
          0,
          -side * (REST.legSplay + stance * 0.09),
        )
        // 무릎은 뒤로만 굽는다. 앞으로 굽으면 즉시 부자연스러워 보인다.
        // 시전 중에는 양 무릎을 함께 굽혀 자세를 낮춘다 — 무게중심이
        // 내려가야 큰 동작이 버티는 것처럼 보인다.
        const knee = Math.max(0, sw * side) * mv * 0.9 + stance * 0.24
        set(j.lowerLeg[i]!, knee, 0, 0)
        set(j.foot[i]!, -knee * 0.45, 0, 0)
      }

      // --- 지팡이 보주 ---
      // 원거리 평타의 발사감을 여기서만 만든다. 캐릭터가 팔을 휘두르지
      // 않으므로 이 반응이 유일한 "쏘았다" 신호다. 그래서 확실히 보여야 한다.
      } else {
        // VRMA 클립을 먼저 합성한 뒤 vrm.update로 스프링본을 갱신한다.
        // 절차식 걷기 회전은 이 분기에서 실행하지 않아 공격 모션과 경쟁하지 않는다.
        animation.update(dt, time, speed)
      }

      if (wep.orb && orbMat) {
        // 링은 항상 천천히 돈다. 멈춰 있으면 보주가 죽은 장식으로 보인다.
        for (let i = 0; i < wep.rings.length; i++) {
          const r = wep.rings[i]!
          r.rotation.y = time * (0.9 + i * 0.55) * (i % 2 === 0 ? 1 : -1)
          r.rotation.x = 0.5 - i * 0.9 + Math.sin(time * 0.7 + i) * 0.12
        }
        // 발사: 0.18초 동안 부풀었다 수축한다. 수축이 팽창보다 길어야
        // "터져 나갔다"로 읽힌다 — 대칭이면 그냥 깜빡이는 전구다.
        const ft = (time - orbFiredAt) / 0.18
        const kick = ft >= 0 && ft < 1 ? (ft < 0.25 ? ft / 0.25 : 1 - (ft - 0.25) / 0.75) : 0
        const k = kick * orbPower
        wep.orb.scale.setScalar(1 + k * 0.55)
        orbMat.emissiveIntensity = orbEmissive0 * (1 + k * 2.4)
        // 상시 숨쉬기. 대기 중에도 보주가 살아 있어야 한다.
        wep.orb.rotation.y = time * 0.8
        wep.orb.rotation.x = time * 0.45
      }

      // 스프링본(머리카락·치마·리본), MToon, 정규화 본 → raw 본 복사를
      // 갱신한다. 무기는 raw hand의 자식이라 별도 역보정 없이 함께 움직인다.
      vrm.update(dt)
    },

    blade: { base: wep.base, tip: wep.tip },

    muzzleWorld(out) {
      if (!wep.orb) return false
      wep.orb.getWorldPosition(out)
      return true
    },

    dispose() {
      if (disposed) return
      disposed = true
      animation?.dispose()
      // 같은 클래스를 이어서 쓰면 VRM은 캐시에 남는다. 클래스가 바뀌었다면
      // 리그에서 분리한 뒤 아래 disposeUnusedVrm에서 안전하게 폐기한다.
      orient.remove(vrm.scene)
      if (rawHand) rawHand.remove(weapon)
      weapon.traverse((o) => {
        const m = o as THREE.Mesh
        m.geometry?.dispose()
        const mat = m.material
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
        else if (mat) (mat as THREE.Material).dispose()
      })
      const nextCount = Math.max(0, (activeRigCount.get(cls) ?? 1) - 1)
      if (nextCount === 0) activeRigCount.delete(cls)
      else activeRigCount.set(cls, nextCount)
      disposeUnusedVrm(cls)
    },
  }

  rig.update(0, 0)
  activeRigCount.set(cls, (activeRigCount.get(cls) ?? 0) + 1)
  return rig
}
