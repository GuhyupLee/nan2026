import * as THREE from 'three'

/**
 * 애니메풍 여성 캐릭터 공용 골격.
 *
 * 두 클래스가 이 골격을 공유하고 머리카락·의상·무기만 갈아 끼운다.
 *
 * 이 파일은 두 가지를 동시에 고친다.
 *
 * 1) **비율.** 처음에는 머리:몸이 1:7이라 성인 남성 비율이었고, 파츠를
 *    아무리 늘려도 미소녀로 안 읽혔다. 애니메 비율은 1:5.5~6이다 —
 *    머리를 키우고, 어깨를 좁히고, 허리를 넣고, 다리를 길게 뽑는다.
 *
 * 2) **곡면 품질.** 세그먼트를 6~10으로 아껴 팔다리가 각지고 몸통은
 *    원기둥을 쌓은 티가 났다. 아낄 이유가 없었다 — 적은 InstancedMesh로
 *    수백 마리를 1드로우콜에 그리지만 플레이어는 딱 하나다. 폴리곤을
 *    20배 써도 프레임에 영향이 없다.
 *    몸통은 단면 곡선을 회전시킨 LatheGeometry라 이음매가 없다.
 *
 * 실루엣 신호 우선순위(멀리서부터 사라지는 역순):
 *   1. 머리 크기와 헤어 볼륨
 *   2. 어깨-허리-엉덩이 곡선
 *   3. 다리 길이와 니하이 경계선
 *   4. 눈
 */

/** 전체 신장. sim의 PLAYER_RADIUS와 맞물리므로 바꾸려면 같이 봐야 한다. */
export const HEIGHT = 1.75

/** 주요 관절 높이. 애니메 비율 — 다리가 신장의 절반을 넘는다. */
export const RIG = {
  ankle: 0.09,
  knee: 0.5,
  hip: 0.92,
  waist: 1.06,
  chest: 1.22,
  shoulder: 1.32,
  neck: 1.4,
  head: 1.55,
  /** 머리 반지름. 신장 대비 크게 잡는 것이 애니메 비율의 핵심이다. */
  headR: 0.165,
} as const

/** 회전체 분할 수. 이 값 하나가 "각진 장난감"과 "곡면 캐릭터"를 가른다. */
const LATHE_SEG = 28
const LIMB_SEG = 18

export interface BodyPalette {
  cloth: number
  cloth2: number
  accent: number
  metal: number
  hair: number
  boot: number
}

export const SKIN = 0xf7dccb

export function solid(color: number, rough = 0.62): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.04 })
}

export function glow(color: number, intensity = 0.55): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0.1,
  })
}

export function metalMat(color: number, rough = 0.22): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0.85 })
}

export interface PartOpts {
  pos?: [number, number, number]
  rot?: [number, number, number]
  scale?: [number, number, number]
}

export function add(
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

export function group(parent: THREE.Object3D, pos: [number, number, number]): THREE.Group {
  const g = new THREE.Group()
  g.position.set(...pos)
  parent.add(g)
  return g
}

/**
 * 단면 곡선을 회전시켜 이음매 없는 몸통을 만든다.
 *
 * @param profile [반지름, 높이] 점들. 아래에서 위로.
 * @param yOffset 회전체를 만든 뒤 통째로 내릴 높이(부모 기준 0에 맞추려고).
 */
function lathe(profile: [number, number][], yOffset: number): THREE.BufferGeometry {
  const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y - yOffset))
  const g = new THREE.LatheGeometry(pts, LATHE_SEG)
  g.computeVertexNormals()
  return g
}

/** 매끄러운 사지. 캡슐은 끝이 둥글어 관절 이음매가 자연스럽다. */
function limbGeo(rTop: number, rBottom: number, len: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rTop, rBottom, len, LIMB_SEG, 1, false)
  g.computeVertexNormals()
  return g
}

export interface Limb {
  pivot: THREE.Group
  lower: THREE.Group
  tip: THREE.Group
}

export interface BodyRig {
  root: THREE.Group
  hips: THREE.Group
  torso: THREE.Group
  chest: THREE.Group
  neck: THREE.Group
  head: THREE.Group
  arms: [Limb, Limb]
  legs: [Limb, Limb]
  hairChain: THREE.Group[]
  skirt: THREE.Group | null
}

/**
 * 큰 애니메 눈.
 *
 * 눈은 미소녀 인상의 8할이다. 이전에는 3×4.2mm짜리 검은 상자 두 개였고
 * 그 크기에서는 얼굴이 아니라 바이저로 읽혔다. 머리 반지름의 40%까지 키우고
 * 흰자·홍채·동공·하이라이트로 쌓으면 저폴리에서도 확실히 눈으로 읽힌다.
 * 홍채를 클래스 강조색으로 칠하면 정체성이 얼굴에서도 드러난다.
 */
function addAnimeFace(head: THREE.Object3D, p: BodyPalette, lashTilt: number): void {
  const r = RIG.headR
  const whiteMat = new THREE.MeshStandardMaterial({
    color: 0xfdfdff,
    roughness: 0.22,
    emissive: 0xffffff,
    emissiveIntensity: 0.14,
  })
  const irisMat = glow(p.accent, 0.85)
  const pupilMat = solid(0x1a1620, 0.3)
  const lashMat = solid(0x241f2a, 0.35)
  const hlMat = new THREE.MeshBasicMaterial({ color: 0xffffff })

  // 눈은 얼굴 "표면에 붙어" 있어야 한다. 구를 그대로 얹으면 튀어나와
  // 곤충 눈이 된다 — X를 강하게 눌러 납작하게 만들고 머리에 파묻는다.
  const whiteGeo = new THREE.SphereGeometry(0.052, 20, 16)
  const irisGeo = new THREE.SphereGeometry(0.036, 18, 14)
  const pupilGeo = new THREE.SphereGeometry(0.018, 14, 10)
  const lashGeo = new THREE.BoxGeometry(0.016, 0.016, 0.1)
  const hlGeo = new THREE.SphereGeometry(0.011, 10, 8)
  const hl2Geo = new THREE.SphereGeometry(0.006, 8, 6)

  const FLAT = 0.3 // X 방향 납작함. 이 값이 곤충 눈과 애니메 눈을 가른다.

  // 눈이 앉을 x를 머리 표면에서 역산한다. 눈대중으로 잡았더니 구 안쪽에
  // 파묻혀 얼굴이 통째로 비어 보였다.
  //   머리 = SphereGeometry(r) scale [0.95, 1.07, 0.9]
  //   (x/(r*0.95))^2 + (z/(r*0.9))^2 = 1  →  z=0.058 에서 x ≈ 0.144
  const eyeZ = 0.058
  const surfaceX =
    r * 0.95 * Math.sqrt(Math.max(0, 1 - (eyeZ / (r * 0.9)) ** 2))

  for (const side of [1, -1]) {
    // 눈 간격도 좁힌다. 옆으로 벌어지면 얼굴이 아니라 고글이 된다.
    const z = side * eyeZ
    add(head, whiteGeo, whiteMat, { pos: [surfaceX - 0.008, 0.005, z], scale: [FLAT, 1.05, 0.82] })
    add(head, irisGeo, irisMat, { pos: [surfaceX - 0.001, -0.004, z], scale: [FLAT, 1.15, 0.95] })
    add(head, pupilGeo, pupilMat, { pos: [surfaceX + 0.003, -0.006, z], scale: [FLAT, 1.2, 1] })
    add(head, hlGeo, hlMat, { pos: [surfaceX + 0.007, 0.022, z + side * 0.012], scale: [FLAT, 1, 1] })
    add(head, hl2Geo, hlMat, {
      pos: [surfaceX + 0.007, -0.026, z - side * 0.013],
      scale: [FLAT, 1, 1],
    })
    // 윗속눈썹 — 눈매 각도가 두 캐릭터의 인상을 가른다
    add(head, lashGeo, lashMat, {
      pos: [surfaceX + 0.002, 0.043, z],
      rot: [0, 0, side * lashTilt],
    })
  }

  const browMat = solid(p.hair, 0.5)
  const browGeo = new THREE.BoxGeometry(0.012, 0.011, 0.062)
  for (const side of [1, -1]) {
    add(head, browGeo, browMat, {
      pos: [surfaceX - 0.006, 0.087, side * eyeZ],
      rot: [0, 0, side * lashTilt * 0.7],
    })
  }
}

export function blobShadow(parent: THREE.Object3D, radius: number): void {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 28),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    }),
  )
  m.rotation.x = -Math.PI / 2
  m.position.y = 0.03
  parent.add(m)
}

/**
 * 공용 여성 골격.
 * @param bootTop 니하이 상단 높이. 피부와 부츠의 경계선이 다리를 길어 보이게 한다.
 */
export function buildBody(p: BodyPalette, lashTilt: number, bootTop = 0.66): BodyRig {
  const root = new THREE.Group()

  const skin = solid(SKIN, 0.5)
  const cloth = solid(p.cloth, 0.68)
  const cloth2 = solid(p.cloth2, 0.66)
  const boot = solid(p.boot, 0.45)
  const trim = glow(p.accent, 0.5)

  // ---- 골반 ----
  const hips = group(root, [0, RIG.hip, 0])

  // ---- 다리 ----
  const legs: Limb[] = []
  const thighLen = RIG.hip - RIG.knee
  const shinLen = RIG.knee - RIG.ankle
  for (const side of [1, -1]) {
    const pivot = group(hips, [0, 0, side * 0.087])
    add(pivot, limbGeo(0.086, 0.061, thighLen), skin, { pos: [0, -thighLen / 2, 0] })
    // 무릎 — 구를 끼워 관절 이음매를 감춘다
    add(pivot, new THREE.SphereGeometry(0.061, LIMB_SEG, 12), skin, { pos: [0, -thighLen, 0] })

    const lower = group(pivot, [0, -thighLen, 0])
    add(lower, limbGeo(0.058, 0.04, shinLen), skin, { pos: [0, -shinLen / 2, 0] })

    // 니하이 — 발목부터 허벅지까지 한 덩어리
    add(lower, limbGeo(0.076, 0.049, bootTop), boot, {
      pos: [0, -shinLen + bootTop / 2 - 0.02, 0],
    })
    add(lower, new THREE.TorusGeometry(0.0765, 0.012, 8, 24), trim, {
      pos: [0, -shinLen + bootTop - 0.02, 0],
      rot: [Math.PI / 2, 0, 0],
    })

    const tip = group(lower, [0, -shinLen, 0])
    // 발 — 앞이 뾰족한 부츠
    add(tip, new THREE.CylinderGeometry(0.05, 0.055, 0.075, LIMB_SEG), boot, { pos: [0, -0.03, 0] })
    add(tip, new THREE.SphereGeometry(0.055, 14, 10), boot, {
      pos: [0.045, -0.045, 0],
      scale: [1.5, 0.55, 0.85],
    })
    legs.push({ pivot, lower, tip })
  }

  // ---- 몸통: 단면 회전체 두 개. 허리 벨트가 이음매를 가린다 ----
  // 아래쪽 — 엉덩이에서 허리로 좁아진다
  add(
    hips,
    lathe(
      [
        [0.118, 0.78],
        [0.146, 0.84],
        [0.157, 0.9],
        [0.152, 0.96],
        [0.132, 1.02],
        [0.118, 1.07],
      ],
      RIG.hip,
    ),
    cloth,
  )

  const torso = group(root, [0, RIG.waist, 0])
  // 위쪽 — 허리에서 가슴으로 넓어졌다가 어깨로 좁아진다
  add(
    torso,
    lathe(
      [
        [0.117, 1.04],
        [0.113, 1.09],
        [0.128, 1.15],
        [0.146, 1.22],
        [0.147, 1.27],
        [0.133, 1.32],
        [0.1, 1.37],
      ],
      RIG.waist,
    ),
    cloth,
  )

  const chest = group(torso, [0, RIG.chest - RIG.waist, 0])
  for (const side of [1, -1]) {
    add(chest, new THREE.SphereGeometry(0.075, 18, 14), cloth, {
      pos: [0.058, -0.005, side * 0.056],
      scale: [0.86, 0.82, 1],
    })
  }

  // 허리 벨트 — 잘록한 지점을 강조하고 회전체 이음매를 덮는다
  add(torso, new THREE.CylinderGeometry(0.121, 0.121, 0.06, LATHE_SEG), cloth2, {
    pos: [0, 0.015, 0],
  })
  add(torso, new THREE.TorusGeometry(0.122, 0.013, 8, 28), trim, {
    pos: [0, 0.043, 0],
    rot: [Math.PI / 2, 0, 0],
  })

  // ---- 팔 ----
  const arms: Limb[] = []
  const upperLen = 0.25
  const foreLen = 0.23
  for (const side of [1, -1]) {
    const pivot = group(chest, [0, RIG.shoulder - RIG.chest - 0.015, side * 0.135])
    add(pivot, new THREE.SphereGeometry(0.058, 16, 12), cloth, {})
    add(pivot, limbGeo(0.043, 0.033, upperLen), skin, { pos: [0, -upperLen / 2 - 0.02, 0] })
    add(pivot, new THREE.SphereGeometry(0.034, 14, 10), skin, { pos: [0, -upperLen - 0.02, 0] })

    const lower = group(pivot, [0, -upperLen - 0.02, 0])
    add(lower, limbGeo(0.033, 0.026, foreLen), skin, { pos: [0, -foreLen / 2, 0] })

    const tip = group(lower, [0, -foreLen, 0])
    add(tip, new THREE.SphereGeometry(0.04, 14, 10), skin, { scale: [0.85, 1.1, 0.7] })
    arms.push({ pivot, lower, tip })
  }

  // ---- 목 + 머리 ----
  const neck = group(chest, [0, RIG.neck - RIG.chest, 0])
  add(neck, limbGeo(0.042, 0.052, 0.09), skin, { pos: [0, -0.02, 0] })

  const head = group(neck, [0, RIG.head - RIG.neck, 0])
  // 머리는 회전체 하나로 만든다. 구 두 개를 겹쳐 턱을 만들었더니
  // 교차선이 얼굴을 가로지르는 톱니 이음매로 드러났다.
  // 위는 둥글고 아래로 갈수록 좁아지는 계란형 단면.
  add(
    head,
    lathe(
      [
        [0.0, -0.2],
        [0.052, -0.185],
        [0.086, -0.155],
        [0.113, -0.11],
        [0.132, -0.055],
        [0.142, 0.005],
        [0.145, 0.06],
        [0.138, 0.115],
        [0.115, 0.16],
        [0.07, 0.192],
        [0.0, 0.205],
      ],
      0,
    ),
    skin,
    { scale: [1.02, 1, 0.98] },
  )
  addAnimeFace(head, p, lashTilt)

  blobShadow(root, 0.46)

  return {
    root,
    hips,
    torso,
    chest,
    neck,
    head,
    arms: [arms[0]!, arms[1]!],
    legs: [legs[0]!, legs[1]!],
    hairChain: [],
    skirt: null,
  }
}
