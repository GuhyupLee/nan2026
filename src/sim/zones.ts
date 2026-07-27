import { DT } from './constants.ts'
import { damageEnemy } from './damage.ts'
import { queryCircle } from './query.ts'
import { applyImpulse, applyMark, applySlow, newHitToken } from './status.ts'
import type { World } from './types.ts'

/**
 * 지속 장판과 지연 폭발.
 *
 * 스킬 여러 개가 같은 구조를 쓴다 — 일현 W(빛기둥 3초) / E(0.3초 뒤 폭발 +
 * 둔화 장판 3초) / 월아 E(0.3초 뒤 참격). 각자 구현하면 세 번 짜고 세 번 틀린다.
 *
 * 지연이 있는 이유는 연출이 아니라 가독성이다. 즉발이면 250마리 화면에서
 * "무엇이 일어났는지" 읽을 시간이 없다. 0.3초는 눈이 따라올 수 있는 최소치다.
 */

export interface Zone {
  /** 렌더 구분용. 0=빛기둥(시안) 1=둔화장판(보라) */
  kind: number
  x: number
  y: number
  radius: number
  expireAt: number
  /** 다음 피해 시각. */
  nextTickAt: number
  tickInterval: number
  /** 한 틱당 피해. */
  tickDamage: number
  /** 바깥으로 밀어내는 반경속도(초당). 0이면 밀지 않는다. */
  pushSpeed: number
  /** 둔화 배수. 1이면 둔화 없음. */
  slowMul: number
  slowDuration: number
  markDuration: number
}

export interface PendingBlast {
  /** 렌더 구분용. 0=폭발(시안) 1=참격(크림슨) */
  kind: number
  x: number
  y: number
  radius: number
  damage: number
  /** 바깥 방향 임펄스 크기. */
  impulse: number
  markDuration: number
  slowMul: number
  slowDuration: number
  fireAt: number
}

const MAX_ZONES = 12
const MAX_BLASTS = 12

export function pushZone(world: World, z: Zone): void {
  if (world.zones.length < MAX_ZONES) world.zones.push(z)
}

export function pushBlast(world: World, b: PendingBlast): void {
  if (world.blasts.length < MAX_BLASTS) world.blasts.push(b)
}

/** 장판과 지연 폭발을 한 틱 진행시킨다. */
export function stepZones(world: World, now = world.time): void {
  const pool = world.enemies
  const hash = world.enemyHash

  // --- 지연 폭발 ---
  for (let i = world.blasts.length - 1; i >= 0; i--) {
    const b = world.blasts[i]!
    if (now < b.fireAt) continue
    world.blasts.splice(i, 1)

    queryCircle(pool, hash, b.x, b.y, b.radius, (j) => {
      if (b.markDuration > 0) applyMark(pool, j, now, b.markDuration)
      if (b.slowMul < 1) applySlow(pool, j, now, b.slowDuration, b.slowMul)
      if (b.impulse > 0) {
        applyImpulse(pool, j, pool.x[j]! - b.x, pool.y[j]! - b.y, b.impulse)
      }
      damageEnemy(world, j, b.damage)
    })

    if (world.rings.length < 32) {
      world.rings.push({ x: b.x, y: b.y, radius: b.radius, kind: b.kind === 1 ? 3 : 2 })
    }
  }

  // --- 지속 장판 ---
  for (let i = world.zones.length - 1; i >= 0; i--) {
    const z = world.zones[i]!
    if (now >= z.expireAt) {
      world.zones.splice(i, 1)
      continue
    }

    // 밀어냄은 매 틱 적용해야 벽처럼 작동한다.
    if (z.pushSpeed > 0) {
      queryCircle(pool, hash, z.x, z.y, z.radius, (j) => {
        const dx = pool.x[j]! - z.x
        const dy = pool.y[j]! - z.y
        const d = Math.hypot(dx, dy)
        if (d < 1e-4) return
        // 반경속도를 그대로 위치에 더한다. 임펄스로 주면 감쇠 때문에
        // "밀어내는 벽"이 아니라 "한 번 튕기는 것"이 된다.
        const step = z.pushSpeed * DT
        pool.x[j] = pool.x[j]! + (dx / d) * step
        pool.y[j] = pool.y[j]! + (dy / d) * step
      })
    }

    if (now < z.nextTickAt) continue
    z.nextTickAt = now + z.tickInterval

    const token = newHitToken()
    void token
    queryCircle(pool, hash, z.x, z.y, z.radius, (j) => {
      if (z.markDuration > 0) applyMark(pool, j, now, z.markDuration)
      if (z.slowMul < 1) applySlow(pool, j, now, z.slowDuration, z.slowMul)
      if (z.tickDamage > 0) damageEnemy(world, j, z.tickDamage)
    })
  }
}
