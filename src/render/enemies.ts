import * as THREE from 'three'

import { ENEMY_TYPES, MAX_ENEMIES, type EnemyPool } from '../sim/enemies.ts'
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

export class EnemyRenderer {
  private readonly batches: TypeBatch[] = []
  private readonly pops: Pop[] = []
  private readonly popMesh: THREE.InstancedMesh
  private readonly tracerMesh: THREE.InstancedMesh

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

    // 자동 공격 예광선 — 얇은 박스. WebGL의 선 굵기는 1px에 묶여 있어
    // 라인으로 그리면 이 카메라 거리에서 거의 안 보인다.
    this.tracerMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.05, 0.14),
      new THREE.MeshBasicMaterial({
        color: 0xbfe9ff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      MAX_TRACERS,
    )
    this.tracerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.tracerMesh.count = 0
    this.tracerMesh.frustumCulled = false
    scene.add(this.tracerMesh)
  }

  /**
   * @param alpha 마지막 틱 이후 경과 비율. 위치 보간에 쓴다.
   * @param dt    실제 경과 시간(초). 팝 수명에 쓴다.
   */
  update(world: World, alpha: number, dt: number): void {
    this.drawEnemies(world.enemies, alpha)
    this.drawPops(world, dt)
    this.drawTracers(world)
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

  private drawTracers(world: World): void {
    let n = 0
    for (const tr of world.tracers) {
      if (n >= MAX_TRACERS) break
      const dx = tr.x1 - tr.x0
      const dz = tr.y1 - tr.y0
      const len = Math.hypot(dx, dz)
      if (len < 1e-4) continue

      this.pos.set(tr.x0 + dx * 0.5, 0.85, tr.y0 + dz * 0.5)
      this.q.setFromAxisAngle(this.axisY, -Math.atan2(dz, dx))
      this.scl.set(len, 1, 1)
      this.m.compose(this.pos, this.q, this.scl)
      this.tracerMesh.setMatrixAt(n, this.m)
      n++
    }
    this.tracerMesh.count = n
    this.tracerMesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    for (const b of this.batches) {
      b.mesh.geometry.dispose()
      ;(b.mesh.material as THREE.Material).dispose()
    }
    this.popMesh.geometry.dispose()
    ;(this.popMesh.material as THREE.Material).dispose()
    this.tracerMesh.geometry.dispose()
    ;(this.tracerMesh.material as THREE.Material).dispose()
  }
}
