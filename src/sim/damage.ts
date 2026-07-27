import { ENEMY_TYPES, removeEnemy, TYPE_BOSS } from './enemies.ts'
import { grantXp } from './world.ts'
import type { World } from './types.ts'

/**
 * 피해 단일 관문.
 *
 * 히트 플래시 · 사망 판정 · XP 지급 · 사망 이벤트 · 슬롯 회수가 전부
 * 여기 한 곳에 모인다. 스킬 8개가 각자 처리하면 반드시 하나가 빠진다.
 *
 * **사망해도 즉시 제거하지 않는다.** 질의 콜백이 도는 중에 swap-remove가
 * 일어나면 아직 방문하지 않은 적이 이미 처리한 인덱스로 옮겨와서
 * 중복 타격되거나 누락된다. 대신 hp<=0으로 표시만 하고 틱 끝에서 쓸어담는다.
 */

/**
 * 적에게 피해를 준다.
 * @returns 이번 타격으로 죽었으면 true
 */
export function damageEnemy(world: World, i: number, amount: number): boolean {
  const pool = world.enemies
  // 이미 죽어 스윕을 기다리는 적은 다시 때리지 않는다 — XP 중복 지급 방지.
  if (pool.hp[i]! <= 0) return false

  pool.hp[i] = pool.hp[i]! - amount
  pool.flash[i] = 0.08
  const isBoss = pool.type[i] === TYPE_BOSS
  if (isBoss) world.boss.hp = Math.max(0, pool.hp[i]!)

  if (pool.hp[i]! > 0) return false

  // 사망 처리는 여기서 한 번만 일어난다.
  const def = ENEMY_TYPES[pool.type[i]!]!
  world.kills += 1
  grantXp(world, def.xp)

  // 점등된 적이 죽으면 빛이 돌아온다 — 원거리의 지속 회복.
  const heal = world.stats.markKillHeal
  if (heal > 0 && pool.markExpire[i]! > world.time) {
    world.player.hp = Math.min(world.stats.maxHp, world.player.hp + heal)
  }

  if (world.deaths.length < 128) {
    world.deaths.push({ x: pool.x[i]!, y: pool.y[i]!, type: pool.type[i]! })
  }
  if (isBoss) {
    world.boss.active = false
    world.boss.hp = 0
    world.outcome = 'victory'
  }
  return true
}

/**
 * 죽은 적을 실제로 제거한다. 틱 끝에서 한 번만 부른다.
 *
 * 뒤에서부터 훑어야 swap-remove가 아직 검사하지 않은 인덱스를 건드리지 않는다.
 */
export function sweepDead(world: World): void {
  const pool = world.enemies
  for (let i = pool.count - 1; i >= 0; i--) {
    if (pool.hp[i]! <= 0) removeEnemy(pool, i)
  }
}
