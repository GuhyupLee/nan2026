import * as THREE from 'three'

import { ENEMY_TYPES, MAX_ENEMIES, type EnemyPool } from '../sim/enemies.ts'
import type { TracerEvent, World } from '../sim/types.ts'
import { lerp } from '../sim/vec.ts'

/**
 * 적 렌더링 — 종류별 InstancedMesh 하나씩.
 *
 * 적은 스킨드 메시로 만들지 않는다. 애니메이션이 붙은 스킨드 메시는
 * 인스턴싱으로 묶을 수 없어서 수백 마리를 개별 드로우콜로 그리게 되고,
 * 그 순간 프레임이 죽는다. 대신 비스킨드 저폴리를 쓰고 회전·스케일 펄스로
 * 생동감을 준다. 원작 뱀파이어 서바이버즈도 적은 2프레임 스프라이트다.
 *
 * 종류 3개 = 드로우콜 3회. 마릿수가 늘어도 늘지 않는다.
 */

/** 적 색상. 플레이어 팔레트(시안/크림슨)와 충돌하지 않게 고른다. */
const ENEMY_COLORS = [
  0x9b6cf5, // 워커 — 보라
  0xc8f04a, // 러셔 — 산성 연두. 빠른 놈은 눈에 확 띄어야 피할 수 있다
  0xff7a3c, // 브루트 — 주황. 크고 무겁다
]

/** 종류별 지오메트리. 실루엣만으로 위협을 구분할 수 있어야 한다. */
function enemyGeometry(type: number, radius: number): THREE.BufferGeometry {
  switch (type) {
    case 1: {
      // 러셔: 뾰족한 다이아몬드 — 속도감
      const g = new THREE.OctahedronGeometry(radius, 0)
      g.scale(0.8, 1.5, 0.8)
      return g
    }
    case 2: {
      // 브루트: 각진 덩어리 — 무게감
      const g = new THREE.DodecahedronGeometry(radius, 0)
      g.scale(1, 0.85, 1)
      return g
    }
    default: {
      // 워커: 둥근 저폴리 — 가장 흔하므로 가장 조용한 형태
      const g = new THREE.IcosahedronGeometry(radius, 0)
      g.scale(1, 1.15, 1)
      return g
    }
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
const MAX_TRACERS = 48
const MAX_PROJECTILES = 32
const MAX_SLASHES = 24
const MAX_RINGS = 24
const RING_DURATION = 0.42
const MAX_FIELD_DISCS = 24
const MAX_FIELD_EDGES = 24
const MAX_PILLARS = 12
const BLAST_WARNING_DURATION = 0.3

/** 지면 원형 연출 하나. 점멸·회복이 쓰고, 앞으로 스킬들이 공유한다. */
interface Ring {
  x: number
  y: number
  radius: number
  kind: number
  t: number
}

type TracerStyle = 'projectile' | 'slash' | 'beam'

/** 시뮬의 한 틱 이벤트를 짧게 유지하는 렌더 전용 궤적. */
interface TracerFx extends TracerEvent {
  style: TracerStyle
  /** 진행도 0..1 */
  t: number
  duration: number
}

/** 0=점멸/시안, 1=회복/초록, 2=폭발·궁극/금백, 3=참격/크림슨. */
const RING_COLORS = [0x8fe6ff, 0x7df0a0, 0xffe6a3, 0xff4164]
/** TracerEvent.kind와 같은 순서. */
const TRACER_COLORS = [0x69d9ff, 0x4dd0ff, 0xffd978, 0xff3158]
const TRACER_CORE_COLORS = [0xf4fdff, 0xdcf9ff, 0xffffff, 0xffc0cc]
const ZONE_COLORS = [0x4dd0ff, 0x865cff]

export class EnemyRenderer {
  private readonly batches: TypeBatch[] = []
  private readonly pops: Pop[] = []
  private readonly rings: Ring[] = []
  private readonly tracers: TracerFx[] = []
  private readonly popMesh: THREE.InstancedMesh
  private readonly tracerMesh: THREE.InstancedMesh
  private readonly tracerCoreMesh: THREE.InstancedMesh
  private readonly projectileMesh: THREE.InstancedMesh
  private readonly slashMesh: THREE.InstancedMesh
  private readonly ringMesh: THREE.InstancedMesh
  private readonly fieldDiscMesh: THREE.InstancedMesh
  private readonly fieldEdgeMesh: THREE.InstancedMesh
  private readonly pillarMesh: THREE.InstancedMesh

  private readonly m = new THREE.Matrix4()
  private readonly q = new THREE.Quaternion()
  private readonly pos = new THREE.Vector3()
  private readonly scl = new THREE.Vector3()
  private readonly axisY = new THREE.Vector3(0, 1, 0)
  private readonly color = new THREE.Color()
  private readonly white = new THREE.Color(0xffffff)

  constructor(scene: THREE.Scene) {
    for (let t = 0; t < ENEMY_TYPES.length; t++) {
      const def = ENEMY_TYPES[t]!
      const mat = new THREE.MeshStandardMaterial({
        color: 0xffffff, // 인스턴스 컬러가 곱해지므로 흰색을 깔아둔다
        roughness: 0.55,
        metalness: 0.1,
        emissive: ENEMY_COLORS[t]!,
        emissiveIntensity: 0.22,
      })
      const mesh = new THREE.InstancedMesh(enemyGeometry(t, def.radius), mat, MAX_ENEMIES)
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

    // 광선·광탄 꼬리 — WebGL 선은 굵기가 사실상 1px이라 얇은 박스를 쓴다.
    // 바깥 광과 흰 코어를 따로 인스턴싱하면 종류별 색을 유지하면서도
    // 드로우콜은 마릿수와 무관하게 두 번으로 고정된다.
    this.tracerMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.06, 0.18),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      MAX_TRACERS,
    )
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.tracerMesh.count = 0
    this.tracerMesh.frustumCulled = false
    scene.add(this.tracerMesh)

    this.tracerCoreMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.035, 0.065),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      MAX_TRACERS,
    )
    this.tracerCoreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.tracerCoreMesh.count = 0
    this.tracerCoreMesh.frustumCulled = false
    scene.add(this.tracerCoreMesh)

    // 원거리 평타의 머리. 꼬리와 분리해야 선 전체가 동시에 켜지지 않고
    // 실제로 날아가는 광탄처럼 읽힌다.
    this.projectileMesh = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.18, 0),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      MAX_PROJECTILES,
    )
    this.projectileMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.projectileMesh.count = 0
    this.projectileMesh.frustumCulled = false
    scene.add(this.projectileMesh)

    // 근거리 평타의 초승달 검호. +X를 정면으로 만든 뒤 Y축 회전으로 방향을 맞춘다.
    const slashGeo = new THREE.RingGeometry(0.58, 1, 24, 1, -0.92, 1.84)
    slashGeo.rotateX(-Math.PI / 2)
    this.slashMesh = new THREE.InstancedMesh(
      slashGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      MAX_SLASHES,
    )
    this.slashMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.slashMesh.count = 0
    this.slashMesh.frustumCulled = false
    scene.add(this.slashMesh)

    // 지면 링 — 바닥 평면의 변화가 쿼터뷰에서 가장 잘 읽힌다.
    // 반지름 1의 얇은 링을 스케일해 재사용한다.
    const ringGeo = new THREE.RingGeometry(0.86, 1, 32)
    ringGeo.rotateX(-Math.PI / 2)
    this.ringMesh = new THREE.InstancedMesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      MAX_RINGS,
    )
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.ringMesh.count = 0
    this.ringMesh.frustumCulled = false
    scene.add(this.ringMesh)

    // 지속 장판과 지연 폭발 예고. 면/테두리를 나누면 희미한 영역을
    // 유지하면서 위험 반경은 또렷하게 읽힌다.
    const fieldDiscGeo = new THREE.CircleGeometry(1, 32)
    fieldDiscGeo.rotateX(-Math.PI / 2)
    this.fieldDiscMesh = new THREE.InstancedMesh(
      fieldDiscGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      MAX_FIELD_DISCS,
    )
    this.fieldDiscMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.fieldDiscMesh.count = 0
    this.fieldDiscMesh.frustumCulled = false
    scene.add(this.fieldDiscMesh)

    const fieldEdgeGeo = new THREE.RingGeometry(0.91, 1, 32)
    fieldEdgeGeo.rotateX(-Math.PI / 2)
    this.fieldEdgeMesh = new THREE.InstancedMesh(
      fieldEdgeGeo,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      MAX_FIELD_EDGES,
    )
    this.fieldEdgeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.fieldEdgeMesh.count = 0
    this.fieldEdgeMesh.frustumCulled = false
    scene.add(this.fieldEdgeMesh)

    // 원거리 W의 빛기둥. 열린 원통이라 내부 캐릭터와 적을 가리지 않는다.
    this.pillarMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 24, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      MAX_PILLARS,
    )
    this.pillarMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.pillarMesh.count = 0
    this.pillarMesh.frustumCulled = false
    scene.add(this.pillarMesh)
  }

  /**
   * @param alpha 마지막 틱 이후 경과 비율. 위치 보간에 쓴다.
   * @param dt    실제 경과 시간(초). 팝 수명에 쓴다.
   */
  update(world: World, alpha: number, dt: number): void {
    this.drawEnemies(world.enemies, alpha)
    this.drawPops(world, dt)
    this.drawFields(world)
    this.drawTracers(world, dt)
    this.drawRings(world, dt)
  }

  /** 지속 장판과 아직 터지지 않은 폭발의 위험 반경. */
  private drawFields(world: World): void {
    let discN = 0
    let edgeN = 0
    let pillarN = 0

    for (const z of world.zones) {
      const remain = Math.max(0, z.expireAt - world.time)
      const fade = Math.min(1, remain / 0.35)
      const pulse = 0.82 + Math.sin(world.time * 5.5 + z.x * 0.17 + z.y * 0.11) * 0.18
      const color = ZONE_COLORS[z.kind] ?? ZONE_COLORS[0]!

      if (discN < MAX_FIELD_DISCS) {
        this.pos.set(z.x, 0.035, z.y)
        this.q.identity()
        this.scl.set(z.radius, 1, z.radius)
        this.m.compose(this.pos, this.q, this.scl)
        this.fieldDiscMesh.setMatrixAt(discN, this.m)
        this.color.set(color).multiplyScalar(fade * pulse)
        this.fieldDiscMesh.setColorAt(discN, this.color)
        discN++
      }

      if (edgeN < MAX_FIELD_EDGES) {
        const edgePulse = 0.985 + Math.sin(world.time * 4.2 + z.y) * 0.015
        this.pos.set(z.x, 0.055, z.y)
        this.q.identity()
        this.scl.set(z.radius * edgePulse, 1, z.radius * edgePulse)
        this.m.compose(this.pos, this.q, this.scl)
        this.fieldEdgeMesh.setMatrixAt(edgeN, this.m)
        this.color.set(color).multiplyScalar(fade)
        this.fieldEdgeMesh.setColorAt(edgeN, this.color)
        edgeN++
      }

      // kind 0은 빛기둥. 낮은 불투명도의 열린 원통이라 영역만 강조한다.
      if (z.kind === 0 && pillarN < MAX_PILLARS) {
        const breathe = 0.96 + Math.sin(world.time * 3.8 + z.x) * 0.04
        this.pos.set(z.x, 1.8, z.y)
        this.q.identity()
        this.scl.set(z.radius * breathe, 3.6, z.radius * breathe)
        this.m.compose(this.pos, this.q, this.scl)
        this.pillarMesh.setMatrixAt(pillarN, this.m)
        this.color.set(color).multiplyScalar(fade * 0.72)
        this.pillarMesh.setColorAt(pillarN, this.color)
        pillarN++
      }
    }

    // 폭발 시점으로 수렴하는 링. 정확한 피격 반경은 희미한 원판으로 남긴다.
    for (const b of world.blasts) {
      const remain = Math.max(0, b.fireAt - world.time)
      const progress = 1 - THREE.MathUtils.clamp(remain / BLAST_WARNING_DURATION, 0, 1)
      const color = b.kind === 1 ? RING_COLORS[3]! : RING_COLORS[0]!

      if (discN < MAX_FIELD_DISCS) {
        this.pos.set(b.x, 0.04, b.y)
        this.q.identity()
        this.scl.set(b.radius, 1, b.radius)
        this.m.compose(this.pos, this.q, this.scl)
        this.fieldDiscMesh.setMatrixAt(discN, this.m)
        this.color.set(color).multiplyScalar(0.5 + progress * 0.5)
        this.fieldDiscMesh.setColorAt(discN, this.color)
        discN++
      }

      if (edgeN < MAX_FIELD_EDGES) {
        const converge = b.radius * (1 - progress * 0.72)
        this.pos.set(b.x, 0.065, b.y)
        this.q.identity()
        this.scl.set(converge, 1, converge)
        this.m.compose(this.pos, this.q, this.scl)
        this.fieldEdgeMesh.setMatrixAt(edgeN, this.m)
        this.color.set(color).lerp(this.white, progress * 0.55)
        this.fieldEdgeMesh.setColorAt(edgeN, this.color)
        edgeN++
      }
    }

    this.commitInstances(this.fieldDiscMesh, discN)
    this.commitInstances(this.fieldEdgeMesh, edgeN)
    this.commitInstances(this.pillarMesh, pillarN)
  }

  private drawRings(world: World, dt: number): void {
    for (const r of world.rings) {
      if (this.rings.length >= MAX_RINGS) break
      this.rings.push({ x: r.x, y: r.y, radius: r.radius, kind: r.kind, t: 0 })
    }

    let n = 0
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!
      r.t += dt / RING_DURATION
      if (r.t >= 1) {
        this.rings.splice(i, 1)
        continue
      }
      if (n >= MAX_RINGS) continue

      // 빠르게 퍼졌다가 서서히 사라진다 — ease-out
      const grow = 1 - (1 - r.t) * (1 - r.t)
      const s = 0.3 + r.radius * grow
      this.pos.set(r.x, 0.06, r.y)
      this.q.identity()
      this.scl.set(s, 1, s)
      this.m.compose(this.pos, this.q, this.scl)
      this.ringMesh.setMatrixAt(n, this.m)
      this.color.set(RING_COLORS[r.kind] ?? RING_COLORS[0]!).multiplyScalar(1 - r.t)
      this.ringMesh.setColorAt(n, this.color)
      n++
    }

    this.ringMesh.count = n
    this.ringMesh.instanceMatrix.needsUpdate = true
    if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true
  }

  private drawEnemies(pool: EnemyPool, alpha: number): void {
    const counts = [0, 0, 0]

    for (let i = 0; i < pool.count; i++) {
      const t = pool.type[i]!
      const batch = this.batches[t]
      if (!batch) continue
      const slot = counts[t]!

      const x = lerp(pool.prevX[i]!, pool.x[i]!, alpha)
      const z = lerp(pool.prevY[i]!, pool.y[i]!, alpha)

      // 진행 방향을 보게 회전시키면 무리가 흐르는 것처럼 보인다.
      const ang = Math.atan2(pool.vy[i]!, pool.vx[i]!)
      this.q.setFromAxisAngle(this.axisY, -ang)

      const def = ENEMY_TYPES[t]!
      this.pos.set(x, def.radius * 0.95, z)
      this.scl.set(1, 1, 1)
      this.m.compose(this.pos, this.q, this.scl)
      batch.mesh.setMatrixAt(slot, this.m)

      // 피격 점멸: 흰색으로 튀었다가 원색으로 돌아온다
      const f = pool.flash[i]!
      if (f > 0) {
        this.color.copy(batch.baseColor).lerp(this.white, Math.min(1, f / 0.08))
      } else {
        this.color.copy(batch.baseColor)
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

  private drawTracers(world: World, dt: number): void {
    this.captureTracers(world)

    let outerN = 0
    let coreN = 0
    let projectileN = 0
    let slashN = 0

    // 최신 이펙트를 먼저 채운다. 상한에 닿아도 방금 쓴 스킬이 빠지지 않는다.
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i]!
      const t = THREE.MathUtils.clamp(tr.t, 0, 1)
      const dx = tr.x1 - tr.x0
      const dz = tr.y1 - tr.y0
      const len = Math.hypot(dx, dz)
      if (len < 1e-4) {
        this.tracers.splice(i, 1)
        continue
      }

      if (tr.style === 'projectile') {
        const headT = Math.min(1, t * 1.12)
        const hx = tr.x0 + dx * headT
        const hz = tr.y0 + dz * headT
        const travelled = len * headT
        const tailLength = Math.min(2.2 + tr.width * 0.28, travelled)
        const tailT = tailLength / len
        const tx = tr.x0 + dx * Math.max(0, headT - tailT)
        const tz = tr.y0 + dz * Math.max(0, headT - tailT)
        const fade = 1 - THREE.MathUtils.smoothstep(t, 0.72, 1)

        if (tailLength > 0.03 && outerN < MAX_TRACERS) {
          this.setLineAt(this.tracerMesh, outerN, tx, tz, hx, hz, 0.88, 1.05)
          this.color.set(TRACER_COLORS[0]!).multiplyScalar(fade * 0.9)
          this.tracerMesh.setColorAt(outerN, this.color)
          outerN++
        }
        if (tailLength > 0.03 && coreN < MAX_TRACERS) {
          this.setLineAt(this.tracerCoreMesh, coreN, tx, tz, hx, hz, 0.88, 0.72)
          this.color.set(TRACER_CORE_COLORS[0]!).multiplyScalar(fade)
          this.tracerCoreMesh.setColorAt(coreN, this.color)
          coreN++
        }
        if (projectileN < MAX_PROJECTILES) {
          const pulse = (0.92 + Math.sin(t * Math.PI * 8) * 0.12) * (0.9 + tr.width * 0.08)
          this.pos.set(hx, 0.88, hz)
          this.q.setFromAxisAngle(this.axisY, t * Math.PI * 10)
          this.scl.set(pulse * 1.25, pulse, pulse)
          this.m.compose(this.pos, this.q, this.scl)
          this.projectileMesh.setMatrixAt(projectileN, this.m)
          this.color
            .set(TRACER_COLORS[0]!)
            .lerp(this.white, 0.62)
            .multiplyScalar(fade)
          this.projectileMesh.setColorAt(projectileN, this.color)
          projectileN++
        }
      } else if (tr.style === 'slash') {
        if (slashN < MAX_SLASHES) {
          const nx = dx / len
          const nz = dz / len
          const angle = Math.atan2(dz, dx)
          const sweep = 0.45 - t * 0.9
          const reach = 1.35 + Math.min(tr.width, 2) * 0.12
          const scale = 1.2 + Math.min(tr.width, 2) * 0.22 + Math.sin(t * Math.PI) * 0.32
          const fade = (1 - t) * (0.72 + Math.sin(t * Math.PI) * 0.28)

          this.pos.set(tr.x0 + nx * reach, 0.16, tr.y0 + nz * reach)
          this.q.setFromAxisAngle(this.axisY, -angle + sweep)
          this.scl.set(scale, 1, scale)
          this.m.compose(this.pos, this.q, this.scl)
          this.slashMesh.setMatrixAt(slashN, this.m)
          this.color
            .set(TRACER_COLORS[3]!)
            .lerp(this.white, (1 - t) * 0.28)
            .multiplyScalar(fade)
          this.slashMesh.setColorAt(slashN, this.color)
          slashN++
        }
      } else {
        const kind = THREE.MathUtils.clamp(Math.trunc(tr.kind), 1, 3)
        const fade = (1 - t) * (1 - t)
        const pulse = 1 + Math.sin(t * Math.PI) * (kind === 2 ? 0.28 : 0.12)
        const outerWidth = Math.max(0.8, tr.width) * pulse
        const coreWidth = Math.max(0.62, tr.width * 0.58) * pulse

        if (outerN < MAX_TRACERS) {
          this.setLineAt(
            this.tracerMesh,
            outerN,
            tr.x0,
            tr.y0,
            tr.x1,
            tr.y1,
            kind === 2 ? 1.02 : 0.86,
            outerWidth,
          )
          this.color.set(TRACER_COLORS[kind]!).multiplyScalar(fade)
          this.tracerMesh.setColorAt(outerN, this.color)
          outerN++
        }
        if (coreN < MAX_TRACERS) {
          this.setLineAt(
            this.tracerCoreMesh,
            coreN,
            tr.x0,
            tr.y0,
            tr.x1,
            tr.y1,
            kind === 2 ? 1.02 : 0.86,
            coreWidth,
          )
          this.color.set(TRACER_CORE_COLORS[kind]!).multiplyScalar(fade)
          this.tracerCoreMesh.setColorAt(coreN, this.color)
          coreN++
        }
      }

      // 최소 한 프레임은 그린 뒤 수명을 진행한다.
      tr.t += dt / tr.duration
      if (tr.t >= 1) this.tracers.splice(i, 1)
    }

    this.commitInstances(this.tracerMesh, outerN)
    this.commitInstances(this.tracerCoreMesh, coreN)
    this.commitInstances(this.projectileMesh, projectileN)
    this.commitInstances(this.slashMesh, slashN)
  }

  private captureTracers(world: World): void {
    for (const tr of world.tracers) {
      const len = Math.hypot(tr.x1 - tr.x0, tr.y1 - tr.y0)
      if (len < 1e-4) continue

      let style: TracerStyle = 'beam'
      let duration = tr.kind === 2 ? 0.24 : tr.kind === 3 ? 0.17 : 0.15
      if (tr.kind === 0) {
        if (world.playerClass === 'melee') {
          style = 'slash'
          duration = 0.2
        } else {
          style = 'projectile'
          duration = THREE.MathUtils.clamp(len / 85, 0.1, 0.22)
        }
      }

      if (this.tracers.length >= MAX_TRACERS) this.tracers.shift()
      this.tracers.push({ ...tr, style, duration, t: 0 })
    }
  }

  /** +X 길이 1인 박스를 XZ 선분에 맞춰 배치한다. */
  private setLineAt(
    mesh: THREE.InstancedMesh,
    index: number,
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    height: number,
    thickness: number,
  ): void {
    const dx = x1 - x0
    const dz = z1 - z0
    const len = Math.hypot(dx, dz)
    this.pos.set(x0 + dx * 0.5, height, z0 + dz * 0.5)
    this.q.setFromAxisAngle(this.axisY, -Math.atan2(dz, dx))
    this.scl.set(len, thickness, thickness)
    this.m.compose(this.pos, this.q, this.scl)
    mesh.setMatrixAt(index, this.m)
  }

  private commitInstances(mesh: THREE.InstancedMesh, count: number): void {
    mesh.count = count
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }

  private disposeMesh(mesh: THREE.InstancedMesh): void {
    mesh.geometry.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) material.dispose()
  }

  dispose(): void {
    for (const b of this.batches) this.disposeMesh(b.mesh)
    this.disposeMesh(this.popMesh)
    this.disposeMesh(this.tracerMesh)
    this.disposeMesh(this.tracerCoreMesh)
    this.disposeMesh(this.projectileMesh)
    this.disposeMesh(this.slashMesh)
    this.disposeMesh(this.ringMesh)
    this.disposeMesh(this.fieldDiscMesh)
    this.disposeMesh(this.fieldEdgeMesh)
    this.disposeMesh(this.pillarMesh)
  }
}
