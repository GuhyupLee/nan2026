import { tryDropBattlefieldPickup } from './battlefield-pickups.ts'
import { ENEMY_TYPES, removeEnemy, TYPE_BOSS, TYPE_ELITE } from './enemies.ts'
import { dropRelic } from './rewards.ts'
import type { World } from './types.ts'
import { dropXpGem } from './xp-gems.ts'

/** 헤드리스 실행에서 소비자가 없어도 피드백 큐가 자라지 않는 절대 상한. */
export const MAX_DAMAGE_FEEDBACK = 24
/** 나머지 네 칸은 정예·보스 타격을 위해 예약한다. */
const MAX_COMMON_DAMAGE_FEEDBACK = 20
const HP_BAR_REVEAL_DURATION = 0.75

function isImportantEnemyType(type: number): boolean {
  return type === TYPE_BOSS || type === TYPE_ELITE
}

function pushDamageFeedback(
  world: World,
  event: World['damageFeedback'][number],
): void {
  const important = isImportantEnemyType(event.enemyType)
  if (!important) {
    let common = 0
    for (let i = 0; i < world.damageFeedback.length; i++) {
      if (!isImportantEnemyType(world.damageFeedback[i]!.enemyType)) common += 1
    }
    if (
      common >= MAX_COMMON_DAMAGE_FEEDBACK ||
      world.damageFeedback.length >= MAX_DAMAGE_FEEDBACK
    ) {
      return
    }
    world.damageFeedback.push(event)
    return
  }

  if (world.damageFeedback.length < MAX_DAMAGE_FEEDBACK) {
    world.damageFeedback.push(event)
    return
  }

  // 중요 타격이 광역 잡몹 숫자에 밀리지 않게 가장 오래된 일반 타격을 교체한다.
  // 큐가 전부 중요 타격이면 가장 오래된 하나를 교체해 절대 상한을 지킨다.
  let replace = 0
  for (let i = 0; i < world.damageFeedback.length; i++) {
    if (!isImportantEnemyType(world.damageFeedback[i]!.enemyType)) {
      replace = i
      break
    }
  }
  world.damageFeedback[replace] = event
}

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
 * @param allowBattlefieldPickupDrop 폭탄 연쇄 드롭을 막을 때만 false
 * @returns 이번 타격으로 죽었으면 true
 */
export function damageEnemy(
  world: World,
  i: number,
  amount: number,
  allowBattlefieldPickupDrop = true,
): boolean {
  const pool = world.enemies
  // 이미 죽어 스윕을 기다리는 적은 다시 때리지 않는다 — XP 중복 지급 방지.
  if (pool.hp[i]! <= 0) return false
  if (!(amount > 0)) return false

  const hpBefore = pool.hp[i]!
  const applied = Math.min(hpBefore, Math.max(0, amount))
  pool.hp[i] = hpBefore - applied
  pool.flash[i] = 0.08
  pool.hpVisibleUntil[i] = Math.max(
    pool.hpVisibleUntil[i]!,
    world.time + HP_BAR_REVEAL_DURATION,
  )
  const isBoss = pool.type[i] === TYPE_BOSS
  const isElite = pool.type[i] === TYPE_ELITE
  if (isBoss) world.boss.hp = Math.max(0, pool.hp[i]!)

  if (applied > 0) {
    pushDamageFeedback(world, {
      x: pool.x[i]!,
      y: pool.y[i]!,
      amount: applied,
      hpAfter: Math.max(0, pool.hp[i]!),
      maxHp: pool.maxHp[i]!,
      enemyType: pool.type[i]!,
      lethal: pool.hp[i]! <= 0,
    })
  }

  if (pool.hp[i]! > 0) return false

  // 사망 처리는 여기서 한 번만 일어난다.
  const def = ENEMY_TYPES[pool.type[i]!]!
  world.kills += 1
  dropXpGem(world.xpGems, pool.x[i]!, pool.y[i]!, def.xp)
  if (!isBoss && !isElite && allowBattlefieldPickupDrop) {
    tryDropBattlefieldPickup(
      world.battlefieldPickups,
      world.pickupRng,
      world.time,
      pool.x[i]!,
      pool.y[i]!,
    )
  }

  // 점등된 적이 죽으면 빛이 돌아온다 — 원거리의 지속 회복.
  //
  // 예산(토큰 버킷)을 거쳐 나간다. 상한이 없던 시절에는 한 판 3,000킬에
  // 최대 1,800을 회복해 받은 피해 54를 완전히 덮었다. 이제는 초당
  // KILL_HEAL_RATE를 넘길 수 없어서, 몰아서 쓸어담아도 그 순간 예산만큼만
  // 돌아온다.
  const heal = world.stats.markKillHeal
  if (heal > 0 && pool.markExpire[i]! > world.time) {
    // 만피에서 처치했다고 회복 예산을 버리면 정작 얻어맞은 직후 패시브가
    // 비어 있다. 실제로 회복한 양만 예산에서 빼야 "점등 처치 = 빛 회수"가
    // 화면의 체력 변화와 일치한다.
    const missingHp = Math.max(0, world.stats.maxHp - world.player.hp)
    const amount = Math.min(heal, world.player.killHealBudget, missingHp)
    if (amount > 0) {
      world.player.killHealBudget -= amount
      world.player.hp += amount
    }
  }

  if (world.deaths.length < 128) {
    world.deaths.push({ x: pool.x[i]!, y: pool.y[i]!, type: pool.type[i]! })
  }
  if (isElite) dropRelic(world, pool.x[i]!, pool.y[i]!)
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
