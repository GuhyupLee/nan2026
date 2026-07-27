import * as THREE from 'three'

import type { PlayerClass } from '../sim/types.ts'

export type CharacterAction = 'attack' | 'empowered' | 'ult' | 'q' | 'w' | 'e' | 'r'

/**
 * 플레이어 캐릭터 — 코드로 만든 저폴리 모델.
 *
 * 에셋 파일이 0개다. 대신 파츠를 30개 규모로 쪼갠다. 쿼터뷰에서 캐릭터는
 * 세로 60~80px이지만, 이터널 리턴 수준의 인상을 내려면 최소한
 * 사지 분리 · 갑옷 조각 · 무기 디테일이 실루엣에 드러나야 한다.
 * 파츠가 적으면 "덩어리"로 보이고, 파츠가 나뉘면 같은 폴리곤 수로도
 * 훨씬 정교해 보인다.
 *
 * 얼굴 디테일만은 2D 초상이 담당한다(캐릭터 선택·레벨업·결과 화면).
 *
 * 정면은 +X다. sim의 facing 각도와 같은 규약이고, 리그를 Y축으로 -facing만큼
 * 돌리면 맞는다(renderer.ts 참조).
 */

export interface CharacterRig {
  group: THREE.Group
  /**
   * @param time  경과 시간(초). 절차적 애니메이션의 위상.
   * @param speed 현재 이동 속력(월드 단위/초). 0이면 대기 자세.
   */
  update(time: number, speed: number): void
  /** 평타·스킬이 실제로 발동한 프레임에 한 번 호출한다. */
  playAction(action: CharacterAction, time: number): void
  dispose(): void
}

/** 팔레트는 art-src/README.md 의 클래스 컬러 언어와 같은 값이다. */
const PALETTE = {
  ranged: {
    cloth: 0xf4f8fd, // 아이보리 로브
    cloth2: 0xd7e3f2, // 그림자 진 천
    accent: 0x4dd0ff, // 시안
    metal: 0xd9b45a, // 골드
    hair: 0xe2edf8, // 은발
    boot: 0x8fa8c4,
  },
  // 근딜은 순수 흑색으로 가면 어두운 아레나 배경에 형체가 묻힌다.
  // 실루엣이 읽히도록 명도를 한 단 올리고 밝은 트림을 섞는다.
  melee: {
    cloth: 0x2e3542, // 짙은 남회색 기모노
    cloth2: 0x49546a, // 밝은 천 — 명도 대비용
    accent: 0xe04156, // 크림슨
    metal: 0xdbe3ec, // 실버(칼날)
    hair: 0x1c2029, // 흑발
    boot: 0x3d4658,
  },
} as const

const SKIN = 0xf2d6c2
const EYE = 0x2b2f3a

// 두 캐릭터 모두 신장 약 1.75로 맞춰져 있다. 플레이어 반지름 0.55와
// 맞물리는 값이라 스케일을 바꾸려면 sim의 PLAYER_RADIUS도 같이 봐야 한다.

function solid(color: number, rough = 0.65): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.05 })
}

/**
 * 발광 재질. 작은 화면에서 강조색이 묻히지 않게 한다 —
 * 저폴리에서 가독성을 사는 가장 싼 방법이다.
 */
function glow(color: number, intensity = 0.55): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0.1,
  })
}

function metalMat(color: number, rough = 0.25): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.85 })
}

interface PartOpts {
  pos?: [number, number, number]
  rot?: [number, number, number]
  scale?: [number, number, number]
}

function add(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  opts: PartOpts = {},
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat)
  if (opts.pos) m.position.set(...opts.pos)
  if (opts.rot) m.rotation.set(...opts.rot)
  if (opts.scale) m.scale.set(...opts.scale)
  m.castShadow = true
  parent.add(m)
  return m
}

function group(parent: THREE.Object3D, pos: [number, number, number]): THREE.Group {
  const g = new THREE.Group()
  g.position.set(...pos)
  parent.add(g)
  return g
}

/** 접지감을 주는 가짜 그림자. 실제 그림자가 약한 각도에서도 바닥에 붙어 보인다. */
function blobShadow(parent: THREE.Object3D, radius: number): void {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 20),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    }),
  )
  m.rotation.x = -Math.PI / 2
  m.position.y = 0.03
  parent.add(m)
}

/**
 * 눈 두 점.
 *
 * 이 거리에서 얼굴을 비워두면 마네킹으로 보인다. 눈 두 개만 찍어도
 * 뇌가 즉시 얼굴로 읽는다 — 저폴리에서 인상을 사는 가장 싼 방법이다.
 * 코·입은 오히려 지저분해지므로 넣지 않는다.
 * @param tilt 눈매 각도. 양수는 날카롭게, 0은 순하게.
 */
function addFace(head: THREE.Object3D, r: number, tilt = 0): void {
  const eye = new THREE.MeshStandardMaterial({ color: EYE, roughness: 0.4 })
  const geo = new THREE.BoxGeometry(0.03, 0.042, 0.052)
  for (const side of [1, -1]) {
    add(head, geo, eye, {
      pos: [r * 0.94, 0.012, side * 0.055],
      rot: [0, 0, side * tilt],
    })
  }
}

/** 사지 한 벌. 어깨/골반 피벗에서 회전시켜 스윙을 만든다. */
interface Limb {
  pivot: THREE.Group
  lower: THREE.Group
}

const ACTION_DURATION: Record<CharacterAction, number> = {
  attack: 0.24,
  empowered: 0.42,
  ult: 0.3,
  q: 0.34,
  w: 0.4,
  e: 0.55,
  r: 0.82,
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function smooth(n: number): number {
  const t = clamp01(n)
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// 루멘 — 빛의 마법사
// ---------------------------------------------------------------------------

function createLumen(): CharacterRig {
  const p = PALETTE.ranged
  const root = new THREE.Group()

  const cloth = solid(p.cloth, 0.75)
  const cloth2 = solid(p.cloth2, 0.8)
  const accent = glow(p.accent, 1.4)
  const gold = metalMat(p.metal, 0.3)
  const hairMat = solid(p.hair, 0.55)
  const skin = solid(SKIN, 0.8)
  const boot = solid(p.boot, 0.6)

  // ---- 하체: 로브 안쪽 다리 ----
  const hips = group(root, [0, 0.78, 0])

  const legs: Limb[] = []
  for (const side of [1, -1]) {
    const pivot = group(hips, [0, 0, side * 0.11])
    add(pivot, new THREE.CapsuleGeometry(0.075, 0.24, 3, 6), cloth2, { pos: [0, -0.16, 0] })
    const lower = group(pivot, [0, -0.32, 0])
    add(lower, new THREE.CapsuleGeometry(0.066, 0.22, 3, 6), cloth2, { pos: [0, -0.14, 0] })
    // 부츠
    add(lower, new THREE.BoxGeometry(0.17, 0.13, 0.11), boot, { pos: [0.02, -0.31, 0] })
    add(lower, new THREE.CylinderGeometry(0.078, 0.07, 0.14, 6), boot, { pos: [0, -0.22, 0] })
    legs.push({ pivot, lower })
  }

  // ---- 로브 스커트 ----
  // 짧고 좁게. 넓게 퍼뜨리면 다리를 삼켜 전등갓처럼 보인다.
  // 다리가 보여야 걷는 게 읽히고, 실루엣이 사람으로 남는다.
  const skirt = group(root, [0, 0.78, 0])
  add(skirt, new THREE.CylinderGeometry(0.19, 0.27, 0.42, 8, 1, true), cloth, {
    pos: [0, -0.2, 0],
  })
  // 앞뒤로 늘어지는 천자락 — 좁은 스커트에 흐름을 준다
  for (const [ang, len] of [
    [0, 0.62],
    [Math.PI, 0.7],
  ] as const) {
    add(skirt, new THREE.BoxGeometry(0.025, len, 0.22), cloth2, {
      pos: [Math.cos(ang) * 0.2, -0.36, Math.sin(ang) * 0.2],
      rot: [0, -ang, 0],
    })
  }
  // 옆트임 천 2장
  for (const side of [1, -1]) {
    add(skirt, new THREE.BoxGeometry(0.16, 0.5, 0.02), cloth, {
      pos: [0, -0.3, side * 0.24],
    })
  }
  // 밑단 시안 띠
  add(skirt, new THREE.TorusGeometry(0.265, 0.022, 6, 10), accent, {
    pos: [0, -0.4, 0],
    rot: [Math.PI / 2, 0, 0],
  })

  // ---- 허리 ----
  add(root, new THREE.CylinderGeometry(0.19, 0.21, 0.1, 8), gold, { pos: [0, 0.79, 0] })
  add(root, new THREE.OctahedronGeometry(0.055), accent, { pos: [0.2, 0.79, 0] })

  // ---- 상체 ----
  const torso = group(root, [0, 0.84, 0])
  add(torso, new THREE.CapsuleGeometry(0.165, 0.24, 4, 8), cloth, { pos: [0, 0.15, 0] })
  // 가슴 판 — 정면 식별
  add(torso, new THREE.BoxGeometry(0.09, 0.24, 0.2), cloth2, { pos: [0.11, 0.16, 0] })
  add(torso, new THREE.OctahedronGeometry(0.06), gold, { pos: [0.16, 0.22, 0] })

  // 어깨 견장 2개
  for (const side of [1, -1]) {
    const sh = group(torso, [0, 0.3, side * 0.2])
    add(sh, new THREE.SphereGeometry(0.1, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), cloth, {})
    add(sh, new THREE.TorusGeometry(0.1, 0.018, 5, 8), gold, { rot: [Math.PI / 2, 0, 0] })
  }

  // 뒤로 흐르는 망토
  const cape = group(torso, [-0.14, 0.28, 0])
  add(cape, new THREE.BoxGeometry(0.04, 0.78, 0.36), cloth2, { pos: [0, -0.36, 0] })

  // ---- 팔 ----
  const arms: Limb[] = []
  for (const side of [1, -1]) {
    const pivot = group(torso, [0, 0.28, side * 0.21])
    add(pivot, new THREE.CapsuleGeometry(0.058, 0.17, 3, 6), cloth, { pos: [0, -0.12, 0] })
    const lower = group(pivot, [0, -0.24, 0])
    add(lower, new THREE.CapsuleGeometry(0.05, 0.16, 3, 6), cloth2, { pos: [0, -0.11, 0] })
    // 소매 끝단
    add(lower, new THREE.CylinderGeometry(0.08, 0.055, 0.12, 6), cloth, { pos: [0, -0.06, 0] })
    add(lower, new THREE.SphereGeometry(0.045, 6, 5), skin, { pos: [0, -0.23, 0] })
    arms.push({ pivot, lower })
  }

  // ---- 목 + 머리 ----
  add(torso, new THREE.CylinderGeometry(0.055, 0.06, 0.07, 6), skin, { pos: [0, 0.32, 0] })
  const head = group(torso, [0, 0.47, 0])
  add(head, new THREE.IcosahedronGeometry(0.135, 1), skin)
  addFace(head, 0.135, 0.12)
  // 앞머리
  add(head, new THREE.BoxGeometry(0.24, 0.13, 0.27), hairMat, { pos: [0.02, 0.09, 0] })
  // 옆머리 2가닥
  for (const side of [1, -1]) {
    add(head, new THREE.BoxGeometry(0.1, 0.3, 0.06), hairMat, {
      pos: [0.03, -0.06, side * 0.13],
      rot: [side * 0.1, 0, 0],
    })
  }
  // 뒷머리
  add(head, new THREE.SphereGeometry(0.15, 8, 6), hairMat, {
    pos: [-0.04, 0.02, 0],
    scale: [1, 1, 1.02],
  })
  const backHair = group(head, [-0.11, -0.02, 0])
  add(backHair, new THREE.ConeGeometry(0.12, 0.46, 6), hairMat, {
    pos: [0, -0.2, 0],
    rot: [0, 0, -0.14],
  })
  // 머리 장식
  add(head, new THREE.OctahedronGeometry(0.042), accent, { pos: [0.04, 0.13, 0.12] })

  // ---- 지팡이 ----
  const staff = group(root, [0.16, 0.95, 0.3])
  staff.rotation.z = 0.12
  add(staff, new THREE.CylinderGeometry(0.019, 0.019, 1.2, 6), gold, { pos: [0, 0.1, 0] })
  add(staff, new THREE.TorusGeometry(0.06, 0.014, 5, 8), gold, {
    pos: [0, 0.6, 0],
    rot: [Math.PI / 2, 0, 0],
  })
  add(staff, new THREE.OctahedronGeometry(0.1), accent, { pos: [0, 0.74, 0] })
  add(staff, new THREE.TorusGeometry(0.13, 0.012, 5, 12), accent, {
    pos: [0, 0.74, 0],
    rot: [0, 0, 0.5],
  })

  // ---- 궤도 프리즘 3개: 식별의 핵심 ----
  const prisms: THREE.Mesh[] = []
  const prismGeo = new THREE.OctahedronGeometry(0.075)
  for (let i = 0; i < 3; i++) prisms.push(add(root, prismGeo, accent))

  blobShadow(root, 0.52)

  let action: CharacterAction | null = null
  let actionStartedAt = -Infinity

  const rig: CharacterRig = {
    group: root,
    update(time, speed) {
      const mv = Math.min(speed / 10, 1)
      const gait = time * (2.4 + mv * 7)
      const swing = Math.sin(gait)
      let phase = action === null ? 1 : (time - actionStartedAt) / ACTION_DURATION[action]
      if (phase >= 1) {
        action = null
        phase = 1
      }
      const motion = action === null ? 0 : Math.sin(clamp01(phase) * Math.PI)

      const bob = Math.sin(gait * 2) * (0.012 + mv * 0.022)
      torso.position.y = 0.84 + bob
      hips.position.y = 0.78 + bob * 0.6
      skirt.position.y = 0.76 + bob * 0.5
      skirt.rotation.z = -mv * 0.08
      skirt.rotation.y = 0
      torso.rotation.x = 0
      torso.rotation.z = -mv * 0.14
      torso.rotation.y = swing * mv * 0.1

      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? 1 : -1
        legs[i]!.pivot.rotation.x = 0
        legs[i]!.pivot.rotation.y = 0
        legs[i]!.pivot.rotation.z = swing * s * mv * 0.55
        legs[i]!.lower.rotation.x = 0
        legs[i]!.lower.rotation.y = 0
        legs[i]!.lower.rotation.z = Math.max(0, -swing * s) * mv * 0.5
        // 지팡이를 든 팔은 덜 흔들린다
        arms[i]!.pivot.rotation.x = 0
        arms[i]!.pivot.rotation.y = 0
        arms[i]!.pivot.rotation.z = -swing * s * mv * (i === 0 ? 0.18 : 0.45)
        arms[i]!.lower.rotation.x = 0
        arms[i]!.lower.rotation.y = 0
        arms[i]!.lower.rotation.z = Math.max(0, swing * s) * mv * 0.28
      }

      cape.rotation.z = -mv * 0.35 + Math.sin(time * 2.1) * 0.06

      staff.position.set(0.16, 0.95 + bob, 0.3)
      staff.rotation.set(0, 0, 0.12 - mv * 0.14)
      staff.scale.setScalar(1)

      let prismRadiusMul = 1
      let prismScale = 1

      if (action === 'attack') {
        // 지팡이를 앞으로 튕기고 든 팔이 뒤따른다. 짧아도 발사 타이밍이 또렷하다.
        torso.rotation.z -= motion * 0.18
        arms[0]!.pivot.rotation.z -= motion * 0.95
        arms[0]!.lower.rotation.z += motion * 0.52
        staff.rotation.z -= motion * 1.05
        staff.position.x += motion * 0.28
        staff.position.z -= motion * 0.08
        prismRadiusMul = 1 - motion * 0.2
        prismScale = 1 + motion * 0.45
      } else if (action === 'q') {
        // 섬광: 전신과 프리즘이 한 선으로 모여 지팡이 끝에서 뻗는다.
        torso.rotation.z -= motion * 0.28
        arms[0]!.pivot.rotation.z -= motion * 1.25
        arms[0]!.lower.rotation.z += motion * 0.7
        staff.rotation.z -= motion * 1.3
        staff.position.x += motion * 0.4
        prismRadiusMul = 1 - motion * 0.58
        prismScale = 1 + motion * 0.7
      } else if (action === 'w') {
        // 굴절: 빛을 앞에 남기고 몸은 뒤로 빠지는 반동.
        torso.rotation.z += motion * 0.42
        arms[0]!.pivot.rotation.z += motion * 0.72
        arms[1]!.pivot.rotation.z -= motion * 0.45
        staff.rotation.z += motion * 0.9
        staff.position.x -= motion * 0.24
        prismRadiusMul = 1 + motion * 0.35
      } else if (action === 'e') {
        // 분광: 지팡이와 프리즘을 머리 위로 감아 올린 뒤 투척한다.
        const throwArc = Math.sin(clamp01(phase * 1.15) * Math.PI)
        torso.rotation.y += motion * 0.38
        arms[0]!.pivot.rotation.z -= throwArc * 1.45
        arms[0]!.lower.rotation.z += throwArc * 0.85
        staff.rotation.x += throwArc * 0.9
        staff.rotation.z -= throwArc * 0.7
        staff.position.y += throwArc * 0.34
        prismRadiusMul = 1 - throwArc * 0.48
        prismScale = 1 + throwArc * 0.55
      } else if (action === 'r') {
        // 일현: 전반에는 프리즘을 압축해 충전하고 후반에는 한 번에 펼친다.
        const charge =
          phase < 0.58 ? smooth(phase / 0.58) : 1 - smooth((phase - 0.58) / 0.42)
        torso.rotation.z -= charge * 0.32
        arms[0]!.pivot.rotation.z -= charge * 1.4
        arms[0]!.lower.rotation.z += charge * 0.82
        arms[1]!.pivot.rotation.z += charge * 0.65
        staff.rotation.z -= charge * 1.35
        staff.position.x += charge * 0.42
        staff.scale.setScalar(1 + charge * 0.14)
        prismRadiusMul = 1 - charge * 0.72
        prismScale = 1 + charge * 1.05
      }

      // 프리즘 궤도: 서로 120도 간격, 높이가 어긋나 평면으로 안 보인다
      for (let i = 0; i < prisms.length; i++) {
        const a = time * 1.25 + (i * Math.PI * 2) / 3
        const r = (0.6 + Math.sin(time * 1.7 + i) * 0.06) * prismRadiusMul
        prisms[i]!.position.set(
          Math.cos(a) * r,
          1.12 + Math.sin(time * 2 + i * 2) * 0.13,
          Math.sin(a) * r,
        )
        prisms[i]!.rotation.set(time * 1.6 + i, time * 1.1, 0)
        prisms[i]!.scale.setScalar(prismScale)
      }
    },
    playAction(next, time) {
      action = next
      actionStartedAt = time
    },
    dispose() {
      disposeTree(root)
    },
  }

  rig.update(0, 0)
  return rig
}

// ---------------------------------------------------------------------------
// 월아 — 초승달의 검사
// ---------------------------------------------------------------------------

function createWola(): CharacterRig {
  const p = PALETTE.melee
  const root = new THREE.Group()

  const cloth = solid(p.cloth, 0.8)
  const cloth2 = solid(p.cloth2, 0.75)
  const accent = glow(p.accent, 1.25)
  const blade = metalMat(p.metal, 0.18)
  const hairMat = solid(p.hair, 0.65)
  const skin = solid(SKIN, 0.8)
  const boot = solid(p.boot, 0.6)

  // ---- 다리 + 하카마 ----
  const hips = group(root, [0, 0.8, 0])
  const legs: Limb[] = []
  for (const side of [1, -1]) {
    const pivot = group(hips, [0, 0, side * 0.12])
    // 하카마는 통이 넓다 — 원기둥으로 부풀린다
    add(pivot, new THREE.CylinderGeometry(0.13, 0.16, 0.4, 6), cloth, { pos: [0, -0.19, 0] })
    const lower = group(pivot, [0, -0.4, 0])
    add(lower, new THREE.CylinderGeometry(0.115, 0.075, 0.26, 6), cloth, { pos: [0, -0.12, 0] })
    // 정강이 보호대
    add(lower, new THREE.BoxGeometry(0.11, 0.16, 0.1), cloth2, { pos: [0.04, -0.2, 0] })
    // 타비
    add(lower, new THREE.BoxGeometry(0.19, 0.09, 0.1), boot, { pos: [0.03, -0.33, 0] })
    legs.push({ pivot, lower })
  }
  // 하카마 앞뒤 주름 패널
  for (const ang of [0, Math.PI]) {
    add(hips, new THREE.BoxGeometry(0.03, 0.5, 0.34), cloth, {
      pos: [Math.cos(ang) * 0.19, -0.24, 0],
      rot: [0, -ang, 0],
    })
  }

  // ---- 오비(허리띠) + 매듭 ----
  add(root, new THREE.CylinderGeometry(0.19, 0.21, 0.15, 8), accent, { pos: [0, 0.85, 0] })
  add(root, new THREE.BoxGeometry(0.1, 0.13, 0.13), accent, { pos: [-0.2, 0.85, 0] })
  add(root, new THREE.BoxGeometry(0.03, 0.28, 0.06), accent, { pos: [-0.24, 0.72, 0.05] })

  // ---- 상체: 앞으로 기운 전투 자세 ----
  const torso = group(root, [0, 0.9, 0])
  torso.rotation.z = -0.11
  add(torso, new THREE.CapsuleGeometry(0.175, 0.22, 4, 8), cloth, { pos: [0, 0.15, 0] })
  // 기모노 V 깃
  for (const side of [1, -1]) {
    add(torso, new THREE.BoxGeometry(0.12, 0.3, 0.05), cloth2, {
      pos: [0.11, 0.2, side * 0.08],
      rot: [side * 0.42, 0, 0],
    })
  }
  add(torso, new THREE.BoxGeometry(0.04, 0.16, 0.14), accent, { pos: [0.14, 0.1, 0] })

  // 어깨 갑옷(소데) — 각진 판 3겹
  for (const side of [1, -1]) {
    const sh = group(torso, [0, 0.29, side * 0.21])
    for (let i = 0; i < 3; i++) {
      add(sh, new THREE.BoxGeometry(0.24 - i * 0.02, 0.05, 0.16), i === 0 ? accent : cloth2, {
        pos: [0, -i * 0.055, side * i * 0.012],
        rot: [side * 0.16, 0, 0],
      })
    }
  }

  // ---- 팔 ----
  const arms: Limb[] = []
  for (const side of [1, -1]) {
    const pivot = group(torso, [0, 0.26, side * 0.22])
    add(pivot, new THREE.CapsuleGeometry(0.06, 0.16, 3, 6), cloth, { pos: [0, -0.12, 0] })
    const lower = group(pivot, [0, -0.23, 0])
    add(lower, new THREE.CapsuleGeometry(0.052, 0.15, 3, 6), cloth, { pos: [0, -0.1, 0] })
    // 손목 보호대
    add(lower, new THREE.CylinderGeometry(0.056, 0.05, 0.09, 6), cloth2, { pos: [0, -0.18, 0] })
    add(lower, new THREE.SphereGeometry(0.045, 6, 5), skin, { pos: [0, -0.24, 0] })
    arms.push({ pivot, lower })
  }

  // ---- 목 + 머리 ----
  add(torso, new THREE.CylinderGeometry(0.052, 0.058, 0.07, 6), skin, { pos: [0, 0.31, 0] })
  const head = group(torso, [0, 0.45, 0])
  add(head, new THREE.IcosahedronGeometry(0.132, 1), skin)
  // 근딜은 눈매를 세워 날카롭게 — 원딜의 순한 눈매와 대비된다
  addFace(head, 0.132, 0.34)
  add(head, new THREE.BoxGeometry(0.23, 0.12, 0.26), hairMat, { pos: [0.02, 0.09, 0] })
  for (const side of [1, -1]) {
    add(head, new THREE.BoxGeometry(0.09, 0.24, 0.055), hairMat, {
      pos: [0.04, -0.04, side * 0.12],
    })
  }
  add(head, new THREE.SphereGeometry(0.145, 8, 6), hairMat, { pos: [-0.03, 0.02, 0] })
  // 이마 띠
  add(head, new THREE.BoxGeometry(0.02, 0.04, 0.24), accent, { pos: [0.12, 0.06, 0] })

  // 포니테일: 3마디로 나눠 관성이 눈에 보이게 한다
  const tail1 = group(head, [-0.13, 0.08, 0])
  add(tail1, new THREE.CylinderGeometry(0.058, 0.048, 0.24, 6), hairMat, { pos: [0, -0.11, 0] })
  const tail2 = group(tail1, [0, -0.22, 0])
  add(tail2, new THREE.CylinderGeometry(0.048, 0.034, 0.22, 6), hairMat, { pos: [0, -0.1, 0] })
  const tail3 = group(tail2, [0, -0.2, 0])
  add(tail3, new THREE.ConeGeometry(0.034, 0.24, 5), hairMat, { pos: [0, -0.11, 0] })
  add(tail1, new THREE.TorusGeometry(0.055, 0.014, 5, 8), accent, { rot: [Math.PI / 2, 0, 0] })

  // ---- 카타나(등에 사선) ----
  const katana = group(root, [-0.13, 1.0, -0.2])
  katana.rotation.set(0, 0.25, -0.68)
  add(katana, new THREE.BoxGeometry(0.038, 1.0, 0.012), blade, { pos: [0, 0.56, 0] })
  // 칼끝 사선
  add(katana, new THREE.ConeGeometry(0.026, 0.14, 4), blade, { pos: [0, 1.11, 0] })
  add(katana, new THREE.CylinderGeometry(0.08, 0.08, 0.018, 8), accent, { pos: [0, 0.04, 0] })
  add(katana, new THREE.BoxGeometry(0.042, 0.26, 0.042), cloth2, { pos: [0, -0.11, 0] })
  add(katana, new THREE.SphereGeometry(0.03, 6, 5), accent, { pos: [0, -0.25, 0] })

  // 공격 중 손에 잡히는 별도 검. 평소에는 숨겨 두고 등에 찬 검과 교대한다.
  // 같은 검을 순간이동시키면 발도 시작 프레임에 등에서 손까지 가로지르는 선이 보인다.
  const drawnKatana = group(root, [0.1, 0.9, -0.16])
  add(drawnKatana, new THREE.BoxGeometry(0.042, 1.04, 0.016), blade, {
    pos: [0, 0.56, 0],
  })
  add(drawnKatana, new THREE.ConeGeometry(0.03, 0.15, 4), blade, { pos: [0, 1.12, 0] })
  add(drawnKatana, new THREE.CylinderGeometry(0.085, 0.085, 0.02, 8), accent, {
    pos: [0, 0.04, 0],
  })
  add(drawnKatana, new THREE.BoxGeometry(0.046, 0.28, 0.046), cloth2, {
    pos: [0, -0.12, 0],
  })
  drawnKatana.visible = false

  // ---- 칼집(허리) ----
  const saya = group(root, [-0.05, 0.82, 0.19])
  saya.rotation.set(0, 0, -0.42)
  add(saya, new THREE.CylinderGeometry(0.033, 0.028, 0.86, 6), cloth2, { pos: [0, -0.3, 0] })

  blobShadow(root, 0.48)

  let action: CharacterAction | null = null
  let actionStartedAt = -Infinity
  let ultSide = 1

  const rig: CharacterRig = {
    group: root,
    update(time, speed) {
      const mv = Math.min(speed / 10, 1)
      const gait = time * (2.8 + mv * 8)
      const swing = Math.sin(gait)
      let phase = action === null ? 1 : (time - actionStartedAt) / ACTION_DURATION[action]
      if (phase >= 1) {
        action = null
        phase = 1
      }
      const motion = action === null ? 0 : Math.sin(clamp01(phase) * Math.PI)

      const bob = Math.sin(gait * 2) * (0.014 + mv * 0.026)
      torso.position.y = 0.9 + bob
      hips.position.y = 0.8 + bob * 0.6
      torso.rotation.x = 0
      torso.rotation.z = -0.11 - mv * 0.2
      torso.rotation.y = swing * mv * 0.14

      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? 1 : -1
        legs[i]!.pivot.rotation.x = 0
        legs[i]!.pivot.rotation.y = 0
        legs[i]!.pivot.rotation.z = swing * s * mv * 0.7
        legs[i]!.lower.rotation.x = 0
        legs[i]!.lower.rotation.y = 0
        legs[i]!.lower.rotation.z = Math.max(0, -swing * s) * mv * 0.65
        arms[i]!.pivot.rotation.x = 0
        arms[i]!.pivot.rotation.y = 0
        arms[i]!.pivot.rotation.z = -swing * s * mv * 0.5
        arms[i]!.lower.rotation.x = 0
        arms[i]!.lower.rotation.y = 0
        arms[i]!.lower.rotation.z = Math.max(0, swing * s) * mv * 0.35
      }

      // 포니테일이 관성으로 뒤에 끌린다 — 속도가 눈에 보이게 하는 장치.
      // 마디마다 위상을 늦춰 채찍처럼 흐르게 한다.
      const lag = -mv * 0.34
      tail1.rotation.z = lag + Math.sin(time * 3.0) * 0.08
      tail2.rotation.z = lag * 0.8 + Math.sin(time * 3.0 - 0.5) * 0.1
      tail3.rotation.z = lag * 0.6 + Math.sin(time * 3.0 - 1.0) * 0.12
      tail1.rotation.y = Math.sin(time * 2.2) * 0.1

      katana.visible = action === null
      katana.rotation.z = -0.68 - mv * 0.1
      katana.position.y = 1.0 + bob
      saya.position.y = 0.82 + bob * 0.7

      drawnKatana.visible = action !== null
      drawnKatana.position.set(0.1, 0.9 + bob, -0.16)
      drawnKatana.rotation.set(0, 0.22, -1.18)
      drawnKatana.scale.setScalar(1)

      if (action === 'attack') {
        const slash = smooth((phase - 0.08) / 0.68)
        torso.rotation.y += (slash - 0.5) * 0.75
        torso.rotation.z -= motion * 0.2
        arms[0]!.pivot.rotation.z -= motion * 1.2
        arms[1]!.pivot.rotation.z -= motion * 0.82
        arms[0]!.lower.rotation.z += motion * 0.5
        drawnKatana.rotation.z = -1.55 + slash * 2.45
        drawnKatana.rotation.y = 0.55 - slash * 0.9
        drawnKatana.position.x += motion * 0.28
      } else if (action === 'empowered') {
        // 월참: 보통 베기보다 크게 몸을 열고 반원 전체를 훑는다.
        const slash = smooth((phase - 0.06) / 0.76)
        torso.rotation.y += (slash - 0.5) * 1.6
        torso.rotation.z -= motion * 0.32
        arms[0]!.pivot.rotation.z -= motion * 1.45
        arms[1]!.pivot.rotation.z -= motion * 1.05
        drawnKatana.rotation.z = -1.75 + slash * 2.9
        drawnKatana.rotation.y = 0.75 - slash * 1.35
        drawnKatana.position.x += motion * 0.4
        drawnKatana.scale.setScalar(1 + motion * 0.18)
      } else if (action === 'q') {
        // 인월참: 칼을 수평에 가깝게 눕혀 칼끝으로 당겨 온다.
        const thrust = Math.sin(clamp01(phase * 1.25) * Math.PI)
        torso.rotation.z -= thrust * 0.3
        arms[0]!.pivot.rotation.z -= thrust * 1.2
        arms[1]!.pivot.rotation.z -= thrust * 0.92
        drawnKatana.rotation.z = -1.48
        drawnKatana.rotation.y = 0.08
        drawnKatana.position.x += thrust * 0.52
      } else if (action === 'w') {
        // 이합참: 낮은 발도 자세에서 이동 방향을 가로지른다.
        const slash = smooth((phase - 0.04) / 0.7)
        torso.rotation.z -= motion * 0.48
        torso.rotation.y += (slash - 0.5) * 0.9
        arms[0]!.pivot.rotation.z -= motion * 1.35
        arms[1]!.pivot.rotation.z -= motion * 0.9
        drawnKatana.rotation.z = -1.7 + slash * 2.7
        drawnKatana.position.y -= motion * 0.2
        drawnKatana.position.x += motion * 0.42
      } else if (action === 'e') {
        // 월륜: 전신과 검이 한 바퀴 반을 돌며 원형 판정과 같은 실루엣을 만든다.
        const spin = smooth(phase) * Math.PI * 3
        torso.rotation.y += spin
        torso.rotation.z -= motion * 0.25
        arms[0]!.pivot.rotation.z -= 1.0 + motion * 0.55
        arms[1]!.pivot.rotation.z -= 0.72 + motion * 0.45
        drawnKatana.rotation.z = -1.28 + Math.sin(spin) * 0.32
        drawnKatana.rotation.y = spin
        drawnKatana.position.x += motion * 0.38
      } else if (action === 'r') {
        // 만월난무 시작: 칼을 낮춰 사라지기 직전의 정지 프레임을 만든다.
        const charge =
          phase < 0.6 ? smooth(phase / 0.6) : 1 - smooth((phase - 0.6) / 0.4)
        torso.rotation.z -= charge * 0.5
        torso.rotation.y -= charge * 0.7
        arms[0]!.pivot.rotation.z -= charge * 1.15
        arms[1]!.pivot.rotation.z -= charge * 0.85
        drawnKatana.rotation.z = -1.82 + charge * 0.28
        drawnKatana.position.y -= charge * 0.3
      } else if (action === 'ult') {
        // 후속 6타는 좌우를 번갈아 베어 같은 자리에서 떨리는 모션을 피한다.
        const slash = smooth((phase - 0.02) / 0.72)
        torso.rotation.y += ultSide * (slash - 0.5) * 1.5
        torso.rotation.z -= motion * 0.36
        arms[0]!.pivot.rotation.z -= motion * 1.5
        arms[1]!.pivot.rotation.z -= motion
        drawnKatana.rotation.z =
          ultSide > 0 ? -1.7 + slash * 2.7 : 1.05 - slash * 2.7
        drawnKatana.rotation.y = ultSide * (0.65 - slash * 1.1)
        drawnKatana.position.x += motion * 0.46
      }
    },
    playAction(next, time) {
      action = next
      actionStartedAt = time
      if (next === 'ult') ultSide *= -1
    },
    dispose() {
      disposeTree(root)
    },
  }

  rig.update(0, 0)
  return rig
}

// ---------------------------------------------------------------------------

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
  return cls === 'melee' ? createWola() : createLumen()
}
