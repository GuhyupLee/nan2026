import * as THREE from 'three'

import type { PlayerClass } from '../sim/types.ts'
import {
  type BodyPalette,
  type BodyRig,
  RIG,
  add,
  buildBody,
  glow,
  group,
  metalMat,
  solid,
} from './body.ts'
import { createVrmRig } from './vrm-rig.ts'

export type { CharacterAction, CharacterRig } from './rig.ts'
import type { CharacterAction, CharacterRig } from './rig.ts'

/**
 * 플레이어 캐릭터 — 코드로 만든 애니메풍 모델. 에셋 파일 0개.
 *
 * 골격은 body.ts가 만들고 여기서는 머리카락·의상·무기만 얹는다.
 * 정면은 +X다. sim의 facing과 같은 규약이고 리그를 Y축으로 -facing 돌리면 맞는다.
 *
 * 애니메이션 원칙:
 * - 걸을 때 골반과 어깨를 **반대로** 돌린다. 이 반대 위상 하나가 걸음을
 *   "인형이 미끄러지는 것"에서 "사람이 걷는 것"으로 바꾼다.
 * - 머리카락·치마는 위상을 늦춰 따라온다. 관성이 보이면 속도가 보인다.
 * - 시전 모션은 yaw·pitch·roll을 전부 쓴다. 한 축만 쓰면 2D 그림처럼 납작하다.
 *
 * VRM 파일이 있으면 그쪽이 우선이고 이건 폴백이다. 지우지 않는 이유는
 * 리포를 클론한 사람(심사자 포함)이 모델 파일 없이도 게임을 돌릴 수 있어야
 * 하고, 40MB를 못 받는 환경에서도 화면이 비지 않아야 하기 때문이다.
 */

const PALETTE: Record<PlayerClass, BodyPalette> = {
  ranged: {
    cloth: 0xf6faff,
    cloth2: 0xcfdff2,
    accent: 0x4dd0ff,
    metal: 0xe0bc6a,
    hair: 0xdcebfa,
    boot: 0xbcd2e8,
  },
  melee: {
    cloth: 0x39414f,
    cloth2: 0x5d6a80,
    accent: 0xff5a6e,
    metal: 0xdbe3ec,
    hair: 0x1b1f28,
    boot: 0x39404f,
  },
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

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** 0에서 올라갔다 내려오는 종. 시전 모션의 강도 곡선. */
function bell(t: number): number {
  const x = clamp01(t)
  return Math.sin(x * Math.PI)
}

/** 빠르게 치솟고 천천히 풀린다. 타격 모션에 쓴다. */
function snap(t: number): number {
  const x = clamp01(t)
  return x < 0.25 ? x / 0.25 : 1 - (x - 0.25) / 0.75
}

// ---------------------------------------------------------------------------
// 머리카락
// ---------------------------------------------------------------------------

/**
 * 마디로 나뉜 머리 다발.
 *
 * 한 덩어리로 만들면 헬멧처럼 보인다. 마디로 쪼개고 위상을 늦춰 흔들면
 * 같은 폴리곤으로도 흐르는 머리카락이 된다.
 */
function hairStrand(
  parent: THREE.Object3D,
  mat: THREE.Material,
  segments: number,
  startR: number,
  segLen: number,
  taper: number,
): THREE.Group[] {
  const chain: THREE.Group[] = []
  let node = parent
  let r = startR
  for (let i = 0; i < segments; i++) {
    const g = group(node, [0, i === 0 ? 0 : -segLen, 0])
    const rNext = r * taper
    add(g, new THREE.CylinderGeometry(r, rNext, segLen, 12), mat, { pos: [0, -segLen / 2, 0] })
    // 마디 이음매를 구로 덮어 끊겨 보이지 않게 한다
    add(g, new THREE.SphereGeometry(rNext, 12, 8), mat, { pos: [0, -segLen, 0] })
    chain.push(g)
    node = g
    r = rNext
  }
  return chain
}

// ---------------------------------------------------------------------------
// 일현 (日弦) — 빛의 마법사
// ---------------------------------------------------------------------------

function buildLumen(): { body: BodyRig; extras: { prisms: THREE.Mesh[]; staff: THREE.Group } } {
  const p = PALETTE.ranged
  // 순한 눈매
  const body = buildBody(p, 0.1, 0.62)
  const hairMat = solid(p.hair, 0.45)
  const cloth = solid(p.cloth, 0.66)
  const cloth2 = solid(p.cloth2, 0.66)
  const gold = metalMat(p.metal, 0.3)
  const accent = glow(p.accent, 0.6)

  const head = body.head
  const r = RIG.headR

  // ---- 앞머리: 가운데 가르마 + 좌우 흐름 ----
  // 앞머리 캡. 온전한 구로 만들면 얼굴까지 덮어 이목구비가 사라진다.
  // thetaLength를 잘라 정수리에서 눈 위까지만 덮는다.
  add(head, new THREE.SphereGeometry(r * 1.07, 30, 16, 0, Math.PI * 2, 0, Math.PI * 0.54), hairMat, {
    pos: [-0.006, 0.012, 0],
    scale: [1, 1.02, 1.03],
  })
  for (const side of [1, -1]) {
    add(head, new THREE.BoxGeometry(0.11, 0.15, 0.055), hairMat, {
      pos: [r * 0.72, 0.085, side * 0.088],
      rot: [side * 0.22, 0, -0.32],
    })
  }
  // 아호게 — 정수리에서 튀어나온 한 가닥. 애니메 기호로 즉시 읽힌다.
  const ahoge = group(head, [-0.02, r * 0.95, 0])
  add(ahoge, new THREE.CylinderGeometry(0.011, 0.004, 0.17, 8), hairMat, {
    pos: [0, 0.08, 0],
    rot: [0, 0, -0.5],
  })

  // ---- 옆머리 두 갈래 ----
  const sideLocks: THREE.Group[][] = []
  for (const side of [1, -1]) {
    const anchor = group(head, [r * 0.12, -0.01, side * 0.125])
    // z 양수는 가닥 끝을 얼굴 앞(+X)으로 민다. 음수로 돌려 귀 뒤로 흘린다.
    anchor.rotation.set(side * 0.1, 0, -0.22)
    sideLocks.push(hairStrand(anchor, hairMat, 3, 0.03, 0.13, 0.8))
  }

  // ---- 뒷머리: 길게 흐르는 본체 ----
  add(head, new THREE.SphereGeometry(r * 1.0, 24, 18), hairMat, {
    pos: [-0.075, 0.0, 0],
    scale: [0.95, 1.08, 1.02],
  })
  const backAnchor = group(head, [-r * 0.7, 0.02, 0])
  const backHair = hairStrand(backAnchor, hairMat, 5, 0.105, 0.19, 0.86)

  // ---- 의상: 짧게 퍼지는 스커트 ----
  const skirt = group(body.hips, [0, 0.02, 0])
  add(skirt, new THREE.CylinderGeometry(0.155, 0.225, 0.22, 24, 1, true), cloth, {
    pos: [0, -0.1, 0],
  })
  add(skirt, new THREE.TorusGeometry(0.225, 0.012, 8, 26), accent, {
    pos: [0, -0.21, 0],
    rot: [Math.PI / 2, 0, 0],
  })
  // 앞뒤로 늘어지는 천자락
  for (const ang of [0, Math.PI]) {
    add(skirt, new THREE.BoxGeometry(0.028, 0.42, 0.17), cloth2, {
      pos: [Math.cos(ang) * 0.16, -0.26, Math.sin(ang) * 0.16],
      rot: [0, -ang, 0],
    })
  }

  // ---- 가슴 장식과 어깨 케이프 ----
  add(body.chest, new THREE.OctahedronGeometry(0.05), accent, { pos: [0.135, 0.02, 0] })
  add(body.chest, new THREE.TorusGeometry(0.05, 0.012, 8, 16), gold, {
    pos: [0.135, 0.02, 0],
    rot: [0, Math.PI / 2, 0],
  })
  const cape = group(body.chest, [-0.1, 0.12, 0])
  add(cape, new THREE.BoxGeometry(0.03, 0.62, 0.3), cloth2, { pos: [0, -0.3, 0] })

  // 디태치드 슬리브 — 팔과 분리된 소매. 어깨를 좁아 보이게 한다.
  for (let i = 0; i < 2; i++) {
    const arm = body.arms[i]!
    add(arm.lower, new THREE.CylinderGeometry(0.05, 0.085, 0.16, 16, 1, true), cloth, {
      pos: [0, -0.2, 0],
    })
    add(arm.lower, new THREE.TorusGeometry(0.05, 0.01, 6, 16), gold, { pos: [0, -0.12, 0], rot: [Math.PI / 2, 0, 0] })
  }

  // ---- 지팡이 ----
  const staff = group(body.root, [0.17, 1.0, 0.3])
  staff.rotation.z = 0.1
  add(staff, new THREE.CylinderGeometry(0.018, 0.018, 1.25, 12), gold, { pos: [0, 0.08, 0] })
  add(staff, new THREE.TorusGeometry(0.062, 0.013, 8, 20), gold, {
    pos: [0, 0.6, 0],
    rot: [Math.PI / 2, 0, 0],
  })
  add(staff, new THREE.OctahedronGeometry(0.095, 1), accent, { pos: [0, 0.74, 0] })
  add(staff, new THREE.TorusGeometry(0.13, 0.011, 8, 24), accent, {
    pos: [0, 0.74, 0],
    rot: [0, 0, 0.5],
  })

  // ---- 궤도 프리즘: 멀리서도 이 캐릭터를 식별하는 신호 ----
  const prisms: THREE.Mesh[] = []
  const prismGeo = new THREE.OctahedronGeometry(0.07, 1)
  for (let i = 0; i < 3; i++) prisms.push(add(body.root, prismGeo, accent))

  body.hairChain = [...backHair, ...sideLocks[0]!, ...sideLocks[1]!, ahoge]
  body.skirt = skirt
  return { body, extras: { prisms, staff } }
}

// ---------------------------------------------------------------------------
// 월아 (月牙) — 초승달의 검사
// ---------------------------------------------------------------------------

function buildWola(): { body: BodyRig; extras: { katana: THREE.Group; saya: THREE.Group } } {
  const p = PALETTE.melee
  // 세운 눈매 — 원거리의 순한 눈매와 대비된다
  const body = buildBody(p, 0.34, 0.58)
  const hairMat = solid(p.hair, 0.5)
  const cloth = solid(p.cloth, 0.7)
  const cloth2 = solid(p.cloth2, 0.66)
  const blade = metalMat(p.metal, 0.16)
  const accent = glow(p.accent, 0.5)

  const head = body.head
  const r = RIG.headR

  // ---- 앞머리: 눈을 살짝 덮는 갈래 ----
  // 앞머리 캡. 온전한 구로 만들면 얼굴까지 덮어 이목구비가 사라진다.
  // thetaLength를 잘라 정수리에서 눈 위까지만 덮는다.
  add(head, new THREE.SphereGeometry(r * 1.07, 30, 16, 0, Math.PI * 2, 0, Math.PI * 0.54), hairMat, {
    pos: [-0.004, 0.014, 0],
    scale: [1, 1.02, 1.02],
  })
  for (const side of [1, -1]) {
    add(head, new THREE.BoxGeometry(0.1, 0.17, 0.05), hairMat, {
      pos: [r * 0.74, 0.07, side * 0.082],
      rot: [side * 0.3, 0, -0.24],
    })
  }
  // 옆머리 — 턱선까지 내려오는 짧은 갈래
  const sideLocks: THREE.Group[][] = []
  for (const side of [1, -1]) {
    const anchor = group(head, [r * 0.16, -0.02, side * 0.122])
    anchor.rotation.set(side * 0.08, 0, -0.18)
    sideLocks.push(hairStrand(anchor, hairMat, 2, 0.028, 0.115, 0.76))
  }

  // ---- 높은 포니테일: 이 캐릭터의 실루엣 그 자체 ----
  const tailAnchor = group(head, [-r * 0.5, r * 0.68, 0])
  tailAnchor.rotation.z = -0.55
  add(tailAnchor, new THREE.SphereGeometry(0.055, 14, 10), hairMat, {})
  add(tailAnchor, new THREE.TorusGeometry(0.052, 0.014, 8, 16), accent, {
    rot: [Math.PI / 2, 0, 0],
  })
  const tail = hairStrand(tailAnchor, hairMat, 5, 0.052, 0.2, 0.87)

  // ---- 의상: 짧은 기모노 + 오비 ----
  for (const side of [1, -1]) {
    add(body.chest, new THREE.BoxGeometry(0.1, 0.3, 0.045), cloth2, {
      pos: [0.1, 0.02, side * 0.075],
      rot: [side * 0.45, 0, 0],
    })
  }
  add(body.torso, new THREE.CylinderGeometry(0.132, 0.132, 0.13, 24), accent, { pos: [0, 0.0, 0] })
  add(body.torso, new THREE.BoxGeometry(0.09, 0.11, 0.12), accent, { pos: [-0.14, 0.0, 0] })
  add(body.torso, new THREE.BoxGeometry(0.025, 0.32, 0.05), accent, { pos: [-0.17, -0.16, 0.04] })

  // 어깨 갑옷(소데) — 각진 판을 겹친다
  for (const side of [1, -1]) {
    const sh = body.arms[side === 1 ? 0 : 1]!.pivot
    for (let i = 0; i < 3; i++) {
      add(sh, new THREE.BoxGeometry(0.19 - i * 0.02, 0.045, 0.15), i === 0 ? accent : cloth2, {
        pos: [0, 0.03 - i * 0.05, 0],
        rot: [side * 0.14, 0, 0],
      })
    }
  }

  // 하카마 숏 — 다리 위쪽을 덮는 짧은 통
  const skirt = group(body.hips, [0, 0.0, 0])
  add(skirt, new THREE.CylinderGeometry(0.155, 0.22, 0.24, 22, 1, true), cloth, {
    pos: [0, -0.13, 0],
  })
  for (const ang of [0, Math.PI]) {
    add(skirt, new THREE.BoxGeometry(0.03, 0.34, 0.2), cloth, {
      pos: [Math.cos(ang) * 0.16, -0.24, Math.sin(ang) * 0.16],
      rot: [0, -ang, 0],
    })
  }

  // ---- 카타나: 등에 사선 ----
  const katana = group(body.root, [-0.14, 1.06, -0.2])
  katana.rotation.set(0, 0.22, -0.66)
  add(katana, new THREE.BoxGeometry(0.034, 1.02, 0.011), blade, { pos: [0, 0.56, 0] })
  add(katana, new THREE.ConeGeometry(0.024, 0.15, 4), blade, { pos: [0, 1.13, 0] })
  add(katana, new THREE.CylinderGeometry(0.075, 0.075, 0.016, 16), accent, { pos: [0, 0.04, 0] })
  add(katana, new THREE.CylinderGeometry(0.023, 0.023, 0.26, 12), cloth2, { pos: [0, -0.11, 0] })
  add(katana, new THREE.SphereGeometry(0.028, 12, 8), accent, { pos: [0, -0.25, 0] })

  // ---- 칼집 ----
  const saya = group(body.root, [-0.04, 0.95, 0.19])
  saya.rotation.set(0, 0, -0.4)
  add(saya, new THREE.CylinderGeometry(0.03, 0.026, 0.9, 14), cloth2, { pos: [0, -0.32, 0] })
  add(saya, new THREE.TorusGeometry(0.031, 0.008, 6, 14), accent, {
    pos: [0, -0.08, 0],
    rot: [Math.PI / 2, 0, 0],
  })

  body.hairChain = [...tail, ...sideLocks[0]!, ...sideLocks[1]!]
  body.skirt = skirt
  return { body, extras: { katana, saya } }
}

// ---------------------------------------------------------------------------
// 애니메이션
// ---------------------------------------------------------------------------

interface ActionState {
  kind: CharacterAction | null
  start: number
}

/**
 * 시전 포즈. 세 축을 전부 쓴다.
 *
 * 한 축만 쓰면 옆에서 봐도 앞에서 봐도 같은 그림이라 납작해 보인다.
 * yaw(비틀기) + pitch(앞뒤) + roll(좌우 기울기)을 섞어야 입체가 산다.
 */
interface Pose {
  /** 상체 비틀기 / 앞뒤 / 좌우. */
  torso: [number, number, number]
  hips: [number, number, number]
  /** 주무기 팔(0번)의 어깨 [yaw, roll, pitch]와 팔꿈치. */
  armA: [number, number, number, number]
  /** 반대 팔. */
  armB: [number, number, number, number]
  head: [number, number, number]
  /** 무기 그룹의 추가 회전. */
  weapon: [number, number, number]
  /** 위로 뜨는 양. */
  lift: number
}

const ZERO: Pose = {
  torso: [0, 0, 0],
  hips: [0, 0, 0],
  armA: [0, 0, 0, 0],
  armB: [0, 0, 0, 0],
  head: [0, 0, 0],
  weapon: [0, 0, 0],
  lift: 0,
}

/** 액션별 최대 진폭 포즈. 실제로는 envelope를 곱해 적용한다. */
const POSES: Record<CharacterAction, Pose> = {
  // 앞으로 찌른다 — 상체를 비틀고(Y) 앞으로 기울이며(Z) 팔을 뻗는다
  q: {
    torso: [0.5, -0.22, 0.08],
    hips: [-0.26, 0, 0],
    armA: [0.3, -0.5, -1.5, -0.15],
    armB: [-0.2, 0.4, 0.7, -0.5],
    head: [0.16, -0.08, 0],
    weapon: [0, -0.5, 0.3],
    lift: 0.02,
  },
  // 물러난다 — 옆으로 기울고(X) 회전하며(Y) 뒤로 젖힌다(Z)
  w: {
    torso: [-0.7, 0.4, -0.45],
    hips: [0.4, 0.1, 0.2],
    armA: [-0.4, 0.9, 0.5, -0.3],
    armB: [0.4, -1.0, 0.4, -0.6],
    head: [-0.3, 0.12, -0.2],
    weapon: [0.4, 0.3, -0.5],
    lift: 0.1,
  },
  // 위로 들었다 내리친다 — 큰 pitch에 약간의 yaw
  e: {
    torso: [0.24, 0.5, 0],
    hips: [-0.14, -0.1, 0],
    armA: [0, -0.35, -2.5, -0.2],
    armB: [0, 0.35, -2.3, -0.2],
    head: [0, 0.3, 0],
    weapon: [0, -1.9, 0],
    lift: 0.06,
  },
  // 궁극기 — 몸을 젖히고 팔을 벌리고 천천히 돈다. 가장 큰 모션.
  r: {
    torso: [1.1, -0.55, 0.3],
    hips: [-0.5, 0.2, -0.15],
    armA: [0.6, -1.5, -2.0, 0],
    armB: [-0.6, 1.5, -2.0, 0],
    head: [0, -0.5, 0],
    weapon: [0.6, -1.2, 0.8],
    lift: 0.16,
  },
  attack: {
    torso: [0.2, -0.06, 0],
    hips: [-0.1, 0, 0],
    armA: [0.1, -0.2, -0.85, -0.3],
    armB: [0, 0.15, 0.3, -0.35],
    head: [0.06, 0, 0],
    weapon: [0, -0.2, 0],
    lift: 0,
  },
  // 회전 베기 — yaw를 크게 쓴다
  empowered: {
    torso: [1.9, -0.15, 0.1],
    hips: [1.2, 0, 0],
    armA: [0.2, -1.2, -1.2, 0],
    armB: [0, 0.6, 0.5, -0.5],
    head: [0.5, 0, 0],
    weapon: [0, -0.9, 0.4],
    lift: 0.04,
  },
  ult: {
    torso: [0.6, -0.4, 0.2],
    hips: [-0.3, 0.1, 0],
    armA: [0.3, -0.8, -1.7, 0],
    armB: [-0.3, 0.8, -1.5, 0],
    head: [0, -0.3, 0],
    weapon: [0.3, -0.8, 0.5],
    lift: 0.12,
  },
}

function makeRig(
  body: BodyRig,
  weapon: THREE.Group | null,
  onUpdate: ((time: number, moving: number, gait: number) => void) | null,
  baseWeaponRot: THREE.Euler | null,
): CharacterRig {
  const action: ActionState = { kind: null, start: -99 }
  const [armA, armB] = body.arms
  const [legA, legB] = body.legs

  const rig: CharacterRig = {
    group: body.root,
    source: 'procedural',

    playAction(kind, time) {
      action.kind = kind
      action.start = time
    },

    update(time, speed) {
      const mv = Math.min(speed / 10, 1)
      // 걸음 위상. 속도가 오르면 보폭이 빨라진다.
      const gait = time * (3.1 + mv * 7.5)
      const sw = Math.sin(gait)
      const sw2 = Math.sin(gait * 2)

      // --- 시전 포즈 강도 ---
      let env = 0
      let pose = ZERO
      if (action.kind) {
        const dur = ACTION_DURATION[action.kind]
        const t = (time - action.start) / dur
        if (t >= 1) action.kind = null
        else {
          pose = POSES[action.kind]
          // 궁극기는 종 모양(천천히 크게), 나머지는 스냅(빠르게 치고 풀림)
          env = action.kind === 'r' || action.kind === 'e' ? bell(t) : snap(t)
        }
      }

      // --- 상하 바운스 + 호흡 ---
      const breath = Math.sin(time * 1.5) * 0.006
      const bounce = sw2 * (0.008 + mv * 0.026) + breath + pose.lift * env
      body.root.position.y = bounce

      // --- 골반과 어깨를 반대로 ---
      // 이 반대 위상 하나가 "인형이 미끄러진다"를 "사람이 걷는다"로 바꾼다.
      const hipSway = sw * mv * 0.16
      body.hips.rotation.y = hipSway + pose.hips[0] * env
      body.hips.rotation.z = pose.hips[1] * env
      body.hips.rotation.x = -sw * mv * 0.05 + pose.hips[2] * env

      body.torso.rotation.y = -hipSway * 0.75 + pose.torso[0] * env
      body.torso.rotation.z = -mv * 0.17 + pose.torso[1] * env
      body.torso.rotation.x = pose.torso[2] * env
      // 호흡 — 가슴이 미세하게 부푼다
      const b = 1 + Math.sin(time * 1.5) * 0.012
      body.chest.scale.set(b, 1, b)

      // 머리는 몸의 비틀림을 되돌려 시선을 앞에 둔다
      body.head.rotation.y = -body.torso.rotation.y * 0.45 + pose.head[0] * env
      body.head.rotation.z = pose.head[1] * env - mv * 0.05
      body.head.rotation.x = Math.sin(time * 0.9) * 0.03 + pose.head[2] * env

      // --- 사지 ---
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? 1 : -1
        const leg = i === 0 ? legA : legB
        leg.pivot.rotation.z = sw * s * mv * 0.72
        leg.pivot.rotation.x = -s * mv * 0.04
        // 무릎은 뒤로만 굽는다
        leg.lower.rotation.z = Math.max(0, -sw * s) * mv * 0.85
        leg.tip.rotation.z = -leg.lower.rotation.z * 0.4
      }

      const arm = [armA, armB]
      const armPose = [pose.armA, pose.armB]
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? 1 : -1
        const ap = armPose[i]!
        const a = arm[i]!
        // 대기 중에도 팔이 몸에서 살짝 떨어져 있어야 자연스럽다
        a.pivot.rotation.y = ap[0]! * env
        a.pivot.rotation.x = s * (0.13 + mv * 0.05) + ap[1]! * env
        a.pivot.rotation.z = -sw * s * mv * 0.5 + ap[2]! * env
        a.lower.rotation.z = -0.12 - Math.max(0, sw * s) * mv * 0.45 + ap[3]! * env
      }

      // --- 머리카락: 마디마다 위상을 늦춰 흐르게 한다 ---
      const lag = -mv * 0.3 - env * 0.25
      for (let i = 0; i < body.hairChain.length; i++) {
        const g = body.hairChain[i]!
        const phase = time * 2.6 - i * 0.45
        g.rotation.z = lag * (0.4 + i * 0.12) + Math.sin(phase) * (0.035 + i * 0.012)
        g.rotation.x = Math.sin(phase * 0.8 + 1.2) * (0.03 + i * 0.014) - hipSway * 0.15
      }

      // --- 치마: 회전과 이동에 따라 뒤로 눕고 좌우로 쓸린다 ---
      if (body.skirt) {
        body.skirt.rotation.z = -mv * 0.14 - env * 0.1
        body.skirt.rotation.y = sw * mv * 0.12
      }

      // --- 무기 ---
      if (weapon && baseWeaponRot) {
        weapon.rotation.set(
          baseWeaponRot.x + pose.weapon[0]! * env,
          baseWeaponRot.y + pose.weapon[1]! * env,
          baseWeaponRot.z + pose.weapon[2]! * env,
        )
        weapon.position.y = weapon.userData.baseY + bounce
      }

      onUpdate?.(time, mv, gait)
    },

    dispose() {
      disposeTree(body.root)
    },
  }

  rig.update(0, 0)
  return rig
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (m.geometry) m.geometry.dispose()
    const mat = m.material
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose())
    else if (mat) (mat as THREE.Material).dispose()
  })
}

export function createCharacterRig(cls: PlayerClass): CharacterRig {
  // VRoid 모델이 준비돼 있으면 그쪽을 쓴다. 없으면 아래 프로시저럴 모델.
  const vrmRig = createVrmRig(cls)
  if (vrmRig) return vrmRig

  if (cls === 'melee') {
    const { body, extras } = buildWola()
    extras.katana.userData.baseY = extras.katana.position.y
    const baseRot = extras.katana.rotation.clone()
    const sayaBaseY = extras.saya.position.y
    return makeRig(body, extras.katana, (_t, _mv, _gait) => {
      extras.saya.position.y = sayaBaseY + body.root.position.y * 0.6
    }, baseRot)
  }

  const { body, extras } = buildLumen()
  extras.staff.userData.baseY = extras.staff.position.y
  const baseRot = extras.staff.rotation.clone()
  const prismGeoCount = extras.prisms.length

  return makeRig(body, extras.staff, (time) => {
    // 궤도 프리즘 — 서로 120도, 높이가 어긋나 평면으로 안 보인다
    for (let i = 0; i < prismGeoCount; i++) {
      const a = time * 1.2 + (i * Math.PI * 2) / prismGeoCount
      const r = 0.58 + Math.sin(time * 1.6 + i) * 0.06
      extras.prisms[i]!.position.set(
        Math.cos(a) * r,
        1.18 + Math.sin(time * 1.9 + i * 2) * 0.14,
        Math.sin(a) * r,
      )
      extras.prisms[i]!.rotation.set(time * 1.5 + i, time * 1.05, 0)
    }
  }, baseRot)
}
