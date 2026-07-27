import * as THREE from 'three'

import {
  BOSS_INTRO_DURATION,
  ENEMY_TYPES,
  MAX_ENEMIES,
  TYPE_BOSS,
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
 * 잡몹 3종 + 보스 = 드로우콜 4회. 마릿수가 늘어도 늘지 않는다.
 */

/** 적 색상. 플레이어 팔레트(시안/크림슨)와 충돌하지 않게 고른다. */
const ENEMY_COLORS = [
  0x9b6cf5, // 워커 — 보라
  0xc8f04a, // 러셔 — 산성 연두. 빠른 놈은 눈에 확 띄어야 피할 수 있다
  0xff7a3c, // 브루트 — 주황. 크고 무겁다
  0xf02aff, // 보스 — 네온 마젠타. 플레이어와 잡몹 어느 팔레트에도 속하지 않는다
]

/** 종류별 지오메트리. 실루엣만으로 위협을 구분할 수 있어야 한다. */
function enemyGeometry(type: number, radius: number): THREE.BufferGeometry {
  switch (type) {
    case TYPE_BOSS: {
      // 보스: 속이 뚫린 비대칭 매듭. 다른 적의 닫힌 다면체와 실루엣부터 다르다.
      const g = new THREE.TorusKnotGeometry(radius * 0.7, radius * 0.23, 64, 8, 2, 3)
      g.rotateX(Math.PI * 0.32)
      g.scale(1, 1.12, 1)
      return g
    }
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

/** 지면 원형 연출 하나. 점멸·회복이 쓰고, 앞으로 스킬들이 공유한다. */


/** 시뮬의 한 틱 이벤트를 짧게 유지하는 렌더 전용 궤적. */

/** 0=점멸/시안, 1=회복/초록, 2=폭발·궁극/금백, 3=참격/크림슨. */
/** TracerEvent.kind와 같은 순서. */

export class EnemyRenderer {
  private readonly batches: TypeBatch[] = []
  private readonly pops: Pop[] = []
  private readonly popMesh: THREE.InstancedMesh

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
        roughness: t === TYPE_BOSS ? 0.24 : 0.55,
        metalness: t === TYPE_BOSS ? 0.48 : 0.1,
        emissive: ENEMY_COLORS[t]!,
        emissiveIntensity: t === TYPE_BOSS ? 0.62 : 0.22,
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
        const phase = bossPhaseAt(world.time, world.boss.spawnedAt)
        const charging = phase === 'windup' || phase === 'charge'
        const spin = world.time * (charging ? 2.8 : 1.15)
        const pulse = 1 + Math.sin(world.time * (charging ? 8.5 : 3.8)) * (charging ? 0.1 : 0.055)
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
        // 진행 방향을 보게 회전시키면 무리가 흐르는 것처럼 보인다.
        this.q.setFromAxisAngle(this.axisY, -ang)
        this.pos.set(x, def.radius * 0.95, z)
        this.scl.set(1, 1, 1)
      }
      this.m.compose(this.pos, this.q, this.scl)
      batch.mesh.setMatrixAt(slot, this.m)

      // 피격 점멸: 흰색으로 튀었다가 원색으로 돌아온다
      const f = pool.flash[i]!
      this.color.copy(batch.baseColor)
      if (isBoss) {
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


  private disposeMesh(mesh: THREE.InstancedMesh): void {
    mesh.geometry.dispose()
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const material of materials) material.dispose()
  }

  dispose(): void {
    for (const b of this.batches) this.disposeMesh(b.mesh)
    this.disposeMesh(this.popMesh)
  }
}
