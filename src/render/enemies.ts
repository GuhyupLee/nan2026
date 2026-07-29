import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'

import {
  BOSS_INTRO_DURATION,
  ENEMY_TYPES,
  MAX_ENEMIES,
  TYPE_BOSS,
  TYPE_BRUTE,
  TYPE_ELITE,
  TYPE_RUSHER,
  TYPE_WALKER,
  bossPhaseAt,
} from '../sim/enemies.ts'
import type { World } from '../sim/types.ts'
import { lerp } from '../sim/vec.ts'

/**
 * 적 렌더링 — 종류별 InstancedMesh 하나씩.
 *
 * 적은 스킨드 메시로 만들지 않는다. 애니메이션이 붙은 스킨드 메시는
 * 인스턴싱으로 묶을 수 없어서 수백 마리를 개별 드로우콜로 그리게 되고,
 * 그 순간 프레임이 죽는다. 대신 비스킨드 저폴리를 쓰고 회전·스케일 펄스로
 * 생동감을 준다. 원작 뱀파이어 서바이버즈도 적은 2프레임 스프라이트다.
 *
 * 잡몹 3종 + 정예 + 보스 = 드로우콜 5회. 마릿수가 늘어도 늘지 않는다.
 */

/** 적 색상. 플레이어 팔레트(시안/크림슨)와 충돌하지 않게 고른다. */
const ENEMY_COLORS = [
  0x8c70d1, // 워커 — 저채도 보라
  0xb8dc4f, // 러셔 — 산성 연두. 빠른 놈은 눈에 확 띄어야 피할 수 있다
  0xd4753e, // 브루트 — 주황. 크고 무겁다
  0xc04496, // 보스 — 짙은 마젠타. 플레이어 팔레트보다 어둡게 둔다
  0xd6ad58, // 정예 — 전리품과 같은 금색. 화면 속 목표물로 즉시 읽힌다
]

const PART_LIGHT = 0xf1eee7
const PART_BODY = 0xb7bdc4
const PART_ARMOR = 0x77838e
const PART_DARK = 0x313944
const PART_VOID = 0x171b27
const PART_SIGIL = 0xffe5a3

type Tuple3 = readonly [x: number, y: number, z: number]

interface EnemyPart {
  geometry: THREE.BufferGeometry
  color: number
  position?: Tuple3
  rotation?: Tuple3
  scale?: Tuple3
  /** 원뿔처럼 기본 +Y축을 지정 방향으로 돌릴 부품. */
  direction?: Tuple3
}

function part(
  geometry: THREE.BufferGeometry,
  color: number,
  position: Tuple3 = [0, 0, 0],
  scale: Tuple3 = [1, 1, 1],
  rotation: Tuple3 = [0, 0, 0],
): EnemyPart {
  return { geometry, color, position, scale, rotation }
}

function directedPart(
  geometry: THREE.BufferGeometry,
  color: number,
  position: Tuple3,
  direction: Tuple3,
  scale: Tuple3 = [1, 1, 1],
): EnemyPart {
  return { geometry, color, position, direction, scale }
}

function bakePart(def: EnemyPart): THREE.BufferGeometry {
  const source = def.geometry
  const geometry = source.index ? source.toNonIndexed() : source.clone()
  source.dispose()

  // 텍스처를 쓰지 않으므로 UV를 버려 정점 대역폭을 줄이고 모든 부품의
  // attribute 구성을 같게 만든다.
  geometry.deleteAttribute('uv')
  geometry.deleteAttribute('uv1')

  const position = new THREE.Vector3(...(def.position ?? [0, 0, 0]))
  const scale = new THREE.Vector3(...(def.scale ?? [1, 1, 1]))
  const quaternion = new THREE.Quaternion()
  if (def.direction) {
    quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(...def.direction).normalize(),
    )
  } else {
    quaternion.setFromEuler(new THREE.Euler(...(def.rotation ?? [0, 0, 0])))
  }
  geometry.applyMatrix4(new THREE.Matrix4().compose(position, quaternion, scale))

  const vertexColor = new THREE.Color(def.color)
  const vertexCount = geometry.getAttribute('position').count
  const colors = new Float32Array(vertexCount * 3)
  for (let i = 0; i < vertexCount; i++) {
    const offset = i * 3
    colors[offset] = vertexColor.r
    colors[offset + 1] = vertexColor.g
    colors[offset + 2] = vertexColor.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  return geometry
}

function mergeEnemyParts(name: string, parts: readonly EnemyPart[]): THREE.BufferGeometry {
  const baked = parts.map(bakePart)
  const merged = mergeGeometries(baked, false)
  for (const geometry of baked) geometry.dispose()
  if (!merged) throw new Error(`${name} 적 지오메트리를 병합하지 못했습니다.`)
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  merged.name = `enemy-${name}-merged`
  merged.userData.partCount = parts.length
  merged.userData.triangles = merged.getAttribute('position').count / 3
  return merged
}

function walkerGeometry(radius: number): THREE.BufferGeometry {
  const r = radius
  return mergeEnemyParts('walker', [
    // 웅크린 흉곽과 작은 가면.
    part(new THREE.DodecahedronGeometry(r * 0.56, 0), PART_BODY, [0, 0.02 * r, 0], [0.82, 1.08, 0.66]),
    part(new THREE.OctahedronGeometry(r * 0.31, 0), PART_LIGHT, [0.2 * r, 0.68 * r, 0], [0.9, 0.82, 0.82]),
    directedPart(
      new THREE.ConeGeometry(r * 0.13, r * 0.42, 4),
      PART_SIGIL,
      [0.43 * r, 0.68 * r, 0],
      [1, 0, 0],
    ),
    // 앞으로 늘어진 양팔과 검은 발톱.
    part(new THREE.BoxGeometry(r * 0.68, r * 0.15, r * 0.18), PART_ARMOR, [0.08 * r, -0.07 * r, 0.5 * r], [1, 1, 1], [0, -0.16, -0.08]),
    part(new THREE.BoxGeometry(r * 0.68, r * 0.15, r * 0.18), PART_ARMOR, [0.08 * r, -0.07 * r, -0.5 * r], [1, 1, 1], [0, 0.16, 0.08]),
    directedPart(new THREE.ConeGeometry(r * 0.12, r * 0.4, 4), PART_DARK, [0.5 * r, -0.1 * r, 0.54 * r], [1, 0, 0]),
    directedPart(new THREE.ConeGeometry(r * 0.12, r * 0.4, 4), PART_DARK, [0.5 * r, -0.1 * r, -0.54 * r], [1, 0, 0]),
    part(new THREE.BoxGeometry(r * 0.24, r * 0.52, r * 0.22), PART_DARK, [-0.12 * r, -0.55 * r, 0.22 * r]),
    part(new THREE.BoxGeometry(r * 0.24, r * 0.52, r * 0.22), PART_DARK, [-0.12 * r, -0.55 * r, -0.22 * r]),
  ])
}

function rusherGeometry(radius: number): THREE.BufferGeometry {
  const r = radius
  return mergeEnemyParts('rusher', [
    // 낮고 긴 관통체. +X가 진행 방향이다.
    directedPart(new THREE.ConeGeometry(r * 0.5, r * 1.9, 5), PART_LIGHT, [0.08 * r, 0, 0], [1, 0, 0]),
    part(new THREE.OctahedronGeometry(r * 0.44, 0), PART_BODY, [-0.5 * r, 0.02 * r, 0], [0.88, 0.54, 0.72]),
    directedPart(new THREE.ConeGeometry(r * 0.18, r * 0.72, 4), PART_DARK, [-0.82 * r, 0, 0], [-1, 0, 0]),
    // 옆으로 벌어진 칼날은 빠른 충돌 폭을 미리 보여준다.
    part(new THREE.BoxGeometry(r * 0.92, r * 0.1, r * 0.17), PART_ARMOR, [0.02 * r, -0.16 * r, 0.43 * r], [1, 1, 1], [0, -0.32, 0]),
    part(new THREE.BoxGeometry(r * 0.92, r * 0.1, r * 0.17), PART_ARMOR, [0.02 * r, -0.16 * r, -0.43 * r], [1, 1, 1], [0, 0.32, 0]),
    part(new THREE.TetrahedronGeometry(r * 0.28, 0), PART_SIGIL, [-0.16 * r, 0.38 * r, 0], [0.62, 1.18, 0.5]),
  ])
}

function bruteGeometry(radius: number): THREE.BufferGeometry {
  const r = radius
  return mergeEnemyParts('brute', [
    // 넓은 흉갑과 양쪽 견갑이 충돌 반경보다 먼저 읽히는 중장 실루엣.
    part(new THREE.BoxGeometry(r * 1.2, r * 1.15, r * 1.16), PART_BODY, [-0.08 * r, 0, 0]),
    part(new THREE.DodecahedronGeometry(r * 0.48, 0), PART_ARMOR, [0, 0.34 * r, 0.67 * r], [0.9, 0.9, 1]),
    part(new THREE.DodecahedronGeometry(r * 0.48, 0), PART_ARMOR, [0, 0.34 * r, -0.67 * r], [0.9, 0.9, 1]),
    part(new THREE.BoxGeometry(r * 0.5, r * 0.5, r * 0.48), PART_DARK, [0.5 * r, -0.28 * r, 0.76 * r]),
    part(new THREE.BoxGeometry(r * 0.5, r * 0.5, r * 0.48), PART_DARK, [0.5 * r, -0.28 * r, -0.76 * r]),
    part(new THREE.BoxGeometry(r * 0.48, r * 0.44, r * 0.52), PART_LIGHT, [0.25 * r, 0.72 * r, 0]),
    directedPart(new THREE.ConeGeometry(r * 0.1, r * 0.48, 5), PART_SIGIL, [0.7 * r, 0.5 * r, 0.3 * r], [1, 0, 0]),
    directedPart(new THREE.ConeGeometry(r * 0.1, r * 0.48, 5), PART_SIGIL, [0.7 * r, 0.5 * r, -0.3 * r], [1, 0, 0]),
    part(new THREE.BoxGeometry(r * 0.38, r * 0.5, r * 0.42), PART_DARK, [-0.22 * r, -0.63 * r, 0.3 * r]),
    part(new THREE.BoxGeometry(r * 0.38, r * 0.5, r * 0.42), PART_DARK, [-0.22 * r, -0.63 * r, -0.3 * r]),
  ])
}

function eliteGeometry(radius: number): THREE.BufferGeometry {
  const r = radius
  return mergeEnemyParts('elite', [
    part(new THREE.CylinderGeometry(r * 0.42, r * 0.56, r * 1.55, 6, 1), PART_BODY, [-0.08 * r, -0.02 * r, 0]),
    part(new THREE.OctahedronGeometry(r * 0.34, 0), PART_LIGHT, [0.12 * r, 0.76 * r, 0], [0.8, 1, 0.76]),
    part(new THREE.TorusGeometry(r * 0.62, r * 0.055, 4, 12), PART_ARMOR, [-0.12 * r, 0.43 * r, 0]),
    // 쌍검과 세 갈래 왕관.
    part(new THREE.ConeGeometry(r * 0.2, r * 1.25, 5), PART_DARK, [-0.05 * r, 0.15 * r, 0.68 * r]),
    part(new THREE.ConeGeometry(r * 0.2, r * 1.25, 5), PART_DARK, [-0.05 * r, 0.15 * r, -0.68 * r]),
    part(new THREE.ConeGeometry(r * 0.12, r * 0.58, 4), PART_SIGIL, [0, 1.14 * r, 0]),
    part(new THREE.ConeGeometry(r * 0.1, r * 0.5, 4), PART_SIGIL, [0, 1.05 * r, 0.28 * r], [1, 1, 1], [0.18, 0, 0]),
    part(new THREE.ConeGeometry(r * 0.1, r * 0.5, 4), PART_SIGIL, [0, 1.05 * r, -0.28 * r], [1, 1, 1], [-0.18, 0, 0]),
    directedPart(new THREE.ConeGeometry(r * 0.13, r * 0.52, 5), PART_SIGIL, [0.46 * r, 0.72 * r, 0], [1, 0, 0]),
  ])
}

function bossGeometry(radius: number): THREE.BufferGeometry {
  const r = radius
  const parts: EnemyPart[] = [
    part(new THREE.DodecahedronGeometry(r * 0.62, 0), PART_BODY, [0, 0.03 * r, 0], [0.84, 1.12, 0.84]),
    part(new THREE.OctahedronGeometry(r * 0.35, 0), PART_SIGIL, [0.24 * r, 0.08 * r, 0], [0.84, 1.1, 0.84]),
    part(new THREE.TorusGeometry(r * 0.88, r * 0.075, 4, 16), PART_ARMOR, [0, 0.16 * r, 0], [1, 1.08, 1], [0.18, 0.42, 0.12]),
    part(new THREE.TorusGeometry(r * 0.66, r * 0.055, 4, 14), PART_VOID, [0, 0.12 * r, 0], [1, 1.12, 1], [-0.28, -0.35, 0.22]),
  ]

  // 여섯 균열창과 네 왕관 가시. 규칙적인 링보다 공격적인 비대칭
  // 다중 실루엣을 만들되 모두 같은 버퍼로 병합된다.
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + 0.18
    parts.push(
      directedPart(
        new THREE.ConeGeometry(r * 0.11, r * (i % 2 === 0 ? 0.86 : 0.66), 5),
        i % 2 === 0 ? PART_LIGHT : PART_DARK,
        [Math.cos(angle) * r * 0.72, -0.02 * r, Math.sin(angle) * r * 0.72],
        [Math.cos(angle), i % 2 === 0 ? 0.18 : -0.08, Math.sin(angle)],
      ),
    )
  }
  for (let i = 0; i < 4; i++) {
    const z = (i - 1.5) * r * 0.24
    parts.push(
      part(
        new THREE.ConeGeometry(r * (0.13 - Math.abs(i - 1.5) * 0.015), r * 0.72, 5),
        i === 1 || i === 2 ? PART_SIGIL : PART_ARMOR,
        [-0.12 * r, 0.92 * r, z],
        [1, 1, 1],
        [0, 0, (i - 1.5) * -0.13],
      ),
    )
  }
  return mergeEnemyParts('boss', parts)
}

/** 종류별 지오메트리. 실루엣만으로 위협을 구분할 수 있어야 한다. */
function enemyGeometry(type: number, radius: number): THREE.BufferGeometry {
  switch (type) {
    case TYPE_RUSHER:
      return rusherGeometry(radius)
    case TYPE_BRUTE:
      return bruteGeometry(radius)
    case TYPE_BOSS:
      return bossGeometry(radius)
    case TYPE_ELITE:
      return eliteGeometry(radius)
    case TYPE_WALKER:
    default:
      return walkerGeometry(radius)
  }
}

interface TypeBatch {
  mesh: THREE.InstancedMesh
  baseColor: THREE.Color
}

/** 사망 팝 하나. */
interface Pop {
  x: number
  y: number
  type: number
  /** 진행도 0..1 */
  t: number
}

const POP_DURATION = 0.16
const MAX_POPS = 64

/** 지면 원형 연출 하나. 점멸·회복이 쓰고, 앞으로 스킬들이 공유한다. */


/** 시뮬의 한 틱 이벤트를 짧게 유지하는 렌더 전용 궤적. */

/** 0=점멸/시안, 1=회복/초록, 2=폭발·궁극/금백, 3=참격/크림슨. */
/** TracerEvent.kind와 같은 순서. */

export class EnemyRenderer {
  private readonly batches: TypeBatch[] = []
  private readonly pops: Pop[] = []
  private readonly popMesh: THREE.InstancedMesh
  private readonly relicMesh: THREE.InstancedMesh

  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly pos = new THREE.Vector3()
  private readonly scl = new THREE.Vector3()
  private readonly axisY = new THREE.Vector3(0, 1, 0)
  private readonly color = new THREE.Color()
  private readonly white = new THREE.Color(0xffffff)
  private readonly phaseTwoColor = new THREE.Color(0xff4f86)
  private readonly phaseThreeColor = new THREE.Color(0xe8d7ff)

  constructor(scene: THREE.Scene) {
    for (let t = 0; t < ENEMY_TYPES.length; t++) {
      const def = ENEMY_TYPES[t]!
      const isBoss = t === TYPE_BOSS
      const isElite = t === TYPE_ELITE
      const isBrute = t === TYPE_BRUTE
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, // 인스턴스 컬러가 곱해지므로 흰색을 깔아둔다
        vertexColors: true,
        flatShading: true,
        roughness: isBoss ? 0.4 : isElite ? 0.48 : isBrute ? 0.66 : 0.6,
        metalness: isBoss ? 0.38 : isElite ? 0.26 : isBrute ? 0.14 : 0.08,
        emissive: ENEMY_COLORS[t]!,
        // 스킬 이펙트보다 낮은 발광. 어두운 바닥에서 타입색만 잃지 않는 값이다.
        emissiveIntensity: isBoss ? 0.3 : isElite ? 0.2 : t === TYPE_RUSHER ? 0.13 : 0.1,
      })
      const mesh = new THREE.InstancedMesh(enemyGeometry(t, def.radius), mat, MAX_ENEMIES)
      mesh.name = `enemy-batch-${def.id}`
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
      mesh.castShadow = true
      mesh.frustumCulled = false // 인스턴스 바운딩이 매 프레임 바뀌므로 직접 관리
      scene.add(mesh)
      this.batches.push({ mesh, baseColor: new THREE.Color(ENEMY_COLORS[t]!) })
    }

    // 사망 팝 — 터지듯 커졌다 사라지는 껍데기
    this.popMesh = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, depthWrite: false }),
      MAX_POPS,
    )
    this.popMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.popMesh.count = 0
    this.popMesh.frustumCulled = false
    scene.add(this.popMesh)

    // 월식 인장은 최대 세 개뿐이다. 금빛 코어가 공중에서 회전하며 0.8초 뒤
    // 플레이어에게 날아오므로, 사망 팝과 섞여도 전리품으로 구분된다.
    this.relicMesh = new THREE.InstancedMesh(
      new THREE.TorusKnotGeometry(0.24, 0.065, 48, 7, 2, 3),
      new THREE.MeshStandardMaterial({
        color: 0xffe3a1,
        roughness: 0.22,
        metalness: 0.82,
        emissive: 0xd58c32,
        emissiveIntensity: 1.15,
      }),
      3,
    )
    this.relicMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.relicMesh.count = 0
    this.relicMesh.castShadow = true
    this.relicMesh.frustumCulled = false
    scene.add(this.relicMesh)
  }

  /**
   * @param alpha 마지막 틱 이후 경과 비율. 위치 보간에 쓴다.
   * @param dt    실제 경과 시간(초). 팝 수명에 쓴다.
   */
  /**
   * 적과 사망 연출만 그린다.
   *
   * 예광선·참격·링·장판·폭발 예고는 전부 `skillfx.ts`가 가져갔다. 여기서
   * 단색 박스와 링을 스케일하는 방식으로는 감쇠 그라디언트도 소프트 엣지도
   * 만들 수 없어서, 아무리 밝게 해도 빛이 아니라 "색칠한 판"으로 보였다.
   */
  update(world: World, alpha: number, dt: number): void {
    this.drawEnemies(world, alpha)
    this.drawPops(world, dt)
    this.drawRelics(world, alpha)
  }

  private drawEnemies(world: World, alpha: number): void {
    const pool = world.enemies
    const counts = new Array<number>(this.batches.length).fill(0)

    for (let i = 0; i < pool.count; i++) {
      const t = pool.type[i]!
      const batch = this.batches[t]
      if (!batch) continue
      const slot = counts[t]!

      const x = lerp(pool.prevX[i]!, pool.x[i]!, alpha)
      const z = lerp(pool.prevY[i]!, pool.y[i]!, alpha)

      const def = ENEMY_TYPES[t]!
      const isBoss = t === TYPE_BOSS
      const ang = Math.atan2(pool.vy[i]!, pool.vx[i]!)

      if (isBoss) {
        // 일정한 자전 위에 돌진 직전의 빠른 떨림을 더한다. 월드 시간을 써서
        // 프레임률과 무관하고, 피격 플래시와 겹쳐도 실루엣이 무너지지 않는다.
        const phase = bossPhaseAt(
          world.time,
          world.boss.spawnedAt,
          world.boss.phaseTwoAt,
          world.boss.phaseThreeAt,
        )
        const transitioning = phase === 'transition'
        const charging = phase === 'windup' || phase === 'charge'
        const spin = world.time * (transitioning ? 4.6 : charging ? 2.8 : 1.15)
        const pulse =
          1 +
          Math.sin(world.time * (transitioning ? 13 : charging ? 8.5 : 3.8)) *
            (transitioning ? 0.14 : charging ? 0.1 : 0.055)
        this.q.setFromAxisAngle(this.axisY, spin)
        if (phase === 'arrival') {
          const t = Math.max(
            0,
            Math.min(1, (world.time - world.boss.spawnedAt) / BOSS_INTRO_DURATION),
          )
          const emerge = 1 - (1 - t) ** 3
          const scale = (0.12 + emerge * 0.88) * pulse
          this.pos.set(x, def.radius * (1.55 - emerge * 0.67), z)
          this.scl.set(scale, scale * (0.7 + emerge * 0.3), scale)
        } else {
          this.pos.set(x, def.radius * 0.88, z)
          this.scl.set(pulse, 1 / pulse, pulse)
        }
      } else {
        // 리깅 없이 instance matrix만으로 역할별 보행 리듬을 준다.
        // 마릿수가 늘어도 지오메트리·드로우콜·객체 할당은 그대로다.
        const motionSeed = i * 0.73
        if (t === TYPE_RUSHER) {
          const stride = Math.sin(world.time * 12 + motionSeed)
          this.q.setFromAxisAngle(this.axisY, -ang)
          this.pos.set(x, def.radius * (0.58 + Math.abs(stride) * 0.035), z)
          this.scl.set(1.06 + stride * 0.045, 0.94 - stride * 0.025, 0.96)
        } else if (t === TYPE_BRUTE) {
          const stomp = Math.abs(Math.sin(world.time * 3.2 + motionSeed))
          this.q.setFromAxisAngle(this.axisY, -ang)
          this.pos.set(x, def.radius * (0.91 + stomp * 0.025), z)
          this.scl.set(1 + stomp * 0.025, 1 - stomp * 0.035, 1 + stomp * 0.025)
        } else if (t === TYPE_ELITE) {
          const hover = Math.sin(world.time * 3.4 + motionSeed)
          const pulse = 1 + hover * 0.025
          this.q.setFromAxisAngle(this.axisY, world.time * 0.72 + motionSeed * 0.4)
          this.pos.set(x, def.radius * (0.9 + hover * 0.055), z)
          this.scl.set(pulse, 1 / pulse, pulse)
        } else {
          const gait = Math.sin(world.time * 6.2 + motionSeed)
          this.q.setFromAxisAngle(this.axisY, -ang)
          this.pos.set(x, def.radius * (0.87 + Math.abs(gait) * 0.045), z)
          this.scl.set(1 - gait * 0.018, 1 + gait * 0.035, 1)
        }
      }
      this.m.compose(this.pos, this.q, this.scl)
      batch.mesh.setMatrixAt(slot, this.m)

      // 피격 점멸: 흰색으로 튀었다가 원색으로 돌아온다
      const f = pool.flash[i]!
      this.color.copy(batch.baseColor)
      if (isBoss) {
        if (world.boss.phaseThreeAt >= 0) {
          const phaseThreePulse =
            0.42 + (Math.sin(world.time * 8.4) * 0.5 + 0.5) * 0.24
          this.color.lerp(this.phaseThreeColor, phaseThreePulse)
        } else if (world.boss.phaseTwoAt >= 0) {
          const phaseTwoPulse =
            0.28 + (Math.sin(world.time * 5.6) * 0.5 + 0.5) * 0.18
          this.color.lerp(this.phaseTwoColor, phaseTwoPulse)
        }
        const pulseLight = 0.1 + (Math.sin(world.time * 4.4) * 0.5 + 0.5) * 0.12
        this.color.lerp(this.white, pulseLight)
      }
      if (f > 0) {
        this.color.lerp(this.white, Math.min(1, f / 0.08))
      }
      batch.mesh.setColorAt(slot, this.color)

      counts[t] = slot + 1
    }

    for (let t = 0; t < this.batches.length; t++) {
      const b = this.batches[t]!
      b.mesh.count = counts[t]!
      b.mesh.instanceMatrix.needsUpdate = true
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true
    }
  }

  private drawPops(world: World, dt: number): void {
    // 새로 죽은 적을 받아 큐에 넣는다
    for (const d of world.deaths) {
      if (this.pops.length >= MAX_POPS) break
      this.pops.push({ x: d.x, y: d.y, type: d.type, t: 0 })
    }

    let n = 0
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i]!
      p.t += dt / POP_DURATION
      if (p.t >= 1) {
        this.pops.splice(i, 1)
        continue
      }
      if (n >= MAX_POPS) continue

      const def = ENEMY_TYPES[p.type]!
      // 1.0 → 1.5 로 부풀었다가 0으로 꺼진다. 이 팝 하나가 킬 손맛의 바닥을 깐다.
      const grow = 1 + p.t * 0.5
      const fade = 1 - p.t
      const s = def.radius * grow * fade * 1.6
      this.pos.set(p.x, def.radius, p.y)
      this.q.identity()
      this.scl.set(s, s, s)
      this.m.compose(this.pos, this.q, this.scl)
      this.popMesh.setMatrixAt(n, this.m)
      this.color.set(ENEMY_COLORS[p.type]!).lerp(this.white, 0.55)
      this.popMesh.setColorAt(n, this.color)
      n++
    }

    this.popMesh.count = n
    this.popMesh.instanceMatrix.needsUpdate = true
    if (this.popMesh.instanceColor) this.popMesh.instanceColor.needsUpdate = true
  }

  private drawRelics(world: World, alpha: number): void {
    let n = 0
    for (const relic of world.relicDrops) {
      if (n >= 3) break
      const x = lerp(relic.prevX, relic.x, alpha)
      const z = lerp(relic.prevY, relic.y, alpha)
      const age = Math.max(0, world.time - relic.spawnedAt)
      const bob = 0.56 + Math.sin(age * 5.2 + n * 1.7) * 0.08
      const pulse = 1 + Math.sin(age * 7.4) * 0.08
      this.pos.set(x, bob, z)
      this.q.setFromAxisAngle(this.axisY, age * 2.8)
      this.scl.set(pulse, pulse, pulse)
      this.m.compose(this.pos, this.q, this.scl)
      this.relicMesh.setMatrixAt(n, this.m)
      n++
    }
    this.relicMesh.count = n
    this.relicMesh.instanceMatrix.needsUpdate = true
  }


  private disposeMesh(mesh: THREE.InstancedMesh): void {
    mesh.geometry.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) material.dispose()
  }

  dispose(): void {
    for (const b of this.batches) this.disposeMesh(b.mesh)
    this.disposeMesh(this.popMesh)
    this.disposeMesh(this.relicMesh)
  }
}
