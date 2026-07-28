import {
  BOSS_PHASE_TWO_TRANSITION_DURATION,
  BOSS_MAX_HP,
  TYPE_BOSS,
  TYPE_ELITE,
  bossCycleIndex,
  bossPhaseAt,
} from './enemies.ts'
import { applyImpulse } from './status.ts'
import type { BossHazard, World } from './types.ts'

/** 최대 체력의 절반인 이 체력에 처음 닿는 타격이 2페이즈를 연다. */
export const BOSS_PHASE_TWO_THRESHOLD = BOSS_MAX_HP / 2
/** 전환 충격이 잡몹을 밀어내 보스 패턴을 읽을 공간. */
export const BOSS_PHASE_TWO_KNOCKBACK_RADIUS = 8.5
export const BOSS_PHASE_TWO_KNOCKBACK_IMPULSE = 32

/** 2페이즈 매 주기 시작에 현재 위치와 예측 위치에 놓는 2원 장판. */
export const BOSS_PHASE_ZONE_RADIUS = 3.5
export const BOSS_PHASE_ZONE_WARNING_DURATION = 1.1
export const BOSS_PHASE_ZONE_DAMAGE = 24
export const BOSS_PHASE_ZONE_PREDICTION_SECONDS = 0.65

/** 돌진이 끝난 자리를 잠시 뒤 다시 위험하게 만드는 종점 폭발. */
export const BOSS_RECOVER_BLAST_RADIUS = 2.2
export const BOSS_RECOVER_BLAST_WARNING_DURATION = 0.7
export const BOSS_RECOVER_BLAST_DAMAGE = 16

const MAX_HOSTILE_HAZARDS = 8

export { BOSS_PHASE_TWO_TRANSITION_DURATION } from './enemies.ts'

function findBoss(world: World): number {
  for (let i = 0; i < world.enemies.count; i += 1) {
    if (
      world.enemies.type[i] === TYPE_BOSS &&
      world.enemies.hp[i]! > 0
    ) {
      return i
    }
  }
  return -1
}

function clampHazardCenter(
  world: World,
  x: number,
  y: number,
  radius: number,
): { x: number; y: number } {
  const limit = Math.max(0, world.arenaRadius - radius)
  const distance = Math.hypot(x, y)
  if (distance <= limit || distance <= 1e-9) return { x, y }
  const scale = limit / distance
  return { x: x * scale, y: y * scale }
}

function pushHazard(world: World, hazard: BossHazard): void {
  if (world.hostileHazards.length >= MAX_HOSTILE_HAZARDS) return
  world.hostileHazards.push(hazard)
}

function nextVolley(world: World): number {
  const volley = world.boss.nextHazardVolley
  world.boss.nextHazardVolley += 1
  return volley
}

/**
 * 50% 게이트를 연다. damageEnemy만 호출해 체력 clamp와 같은 트랜잭션에서
 * 실행하며, false 반환은 이미 전환한 보스라는 뜻이다.
 */
export function triggerBossPhaseTwo(
  world: World,
  bossIndex: number,
): boolean {
  const boss = world.boss
  if (
    boss.phaseTwoAt >= 0 ||
    world.enemies.type[bossIndex] !== TYPE_BOSS ||
    world.enemies.hp[bossIndex]! <= 0
  ) {
    return false
  }

  boss.phaseTwoAt = world.time
  boss.invulnerableUntil =
    world.time + BOSS_PHASE_TWO_TRANSITION_DURATION
  boss.hazardCycle = -1
  boss.recoverBlastCycle = -1
  boss.nextHazardVolley = 0
  boss.lastHazardHitVolley = -1
  world.hostileHazards.length = 0

  const pool = world.enemies
  const bx = pool.x[bossIndex]!
  const by = pool.y[bossIndex]!
  if (world.rings.length < 32) {
    world.rings.push({
      x: bx,
      y: by,
      radius: BOSS_PHASE_TWO_KNOCKBACK_RADIUS,
      kind: 5,
    })
  }
  const radiusSq =
    BOSS_PHASE_TWO_KNOCKBACK_RADIUS *
    BOSS_PHASE_TWO_KNOCKBACK_RADIUS
  for (let i = 0; i < pool.count; i += 1) {
    const type = pool.type[i]!
    if (i === bossIndex || type === TYPE_BOSS || type === TYPE_ELITE) {
      continue
    }
    let dx = pool.x[i]! - bx
    let dy = pool.y[i]! - by
    const distanceSq = dx * dx + dy * dy
    if (distanceSq > radiusSq) continue
    if (distanceSq <= 1e-9) {
      const angle = i * 2.399963229728653
      dx = Math.cos(angle)
      dy = Math.sin(angle)
    }
    applyImpulse(
      pool,
      i,
      dx,
      dy,
      BOSS_PHASE_TWO_KNOCKBACK_IMPULSE,
    )
  }

  // 1페이즈에서 고정한 돌진 방향과 주기 번호가 reset된 0주기로 새어들지 않는다.
  pool.vx[bossIndex] = 0
  pool.vy[bossIndex] = 0
  pool.pushVx[bossIndex] = 0
  pool.pushVy[bossIndex] = 0
  pool.bossChargeDirX[bossIndex] = 0
  pool.bossChargeDirY[bossIndex] = 0
  pool.bossChargeCycle[bossIndex] = -1
  return true
}

function schedulePhaseZones(world: World, cycle: number): void {
  const boss = world.boss
  if (cycle <= boss.hazardCycle) return
  boss.hazardCycle = cycle

  const p = world.player
  const current = clampHazardCenter(
    world,
    p.pos.x,
    p.pos.y,
    BOSS_PHASE_ZONE_RADIUS,
  )
  const predicted = clampHazardCenter(
    world,
    p.pos.x + p.vel.x * BOSS_PHASE_ZONE_PREDICTION_SECONDS,
    p.pos.y + p.vel.y * BOSS_PHASE_ZONE_PREDICTION_SECONDS,
    BOSS_PHASE_ZONE_RADIUS,
  )
  const volley = nextVolley(world)
  const detonateAt = world.time + BOSS_PHASE_ZONE_WARNING_DURATION

  pushHazard(world, {
    kind: 'phase-zone',
    x: current.x,
    y: current.y,
    radius: BOSS_PHASE_ZONE_RADIUS,
    damage: BOSS_PHASE_ZONE_DAMAGE,
    telegraphAt: world.time,
    detonateAt,
    volley,
  })
  pushHazard(world, {
    kind: 'phase-zone',
    x: predicted.x,
    y: predicted.y,
    radius: BOSS_PHASE_ZONE_RADIUS,
    damage: BOSS_PHASE_ZONE_DAMAGE,
    telegraphAt: world.time,
    detonateAt,
    volley,
  })
}

function scheduleRecoverBlast(
  world: World,
  bossIndex: number,
  cycle: number,
): void {
  const boss = world.boss
  if (cycle <= boss.recoverBlastCycle) return
  boss.recoverBlastCycle = cycle
  const center = clampHazardCenter(
    world,
    world.enemies.x[bossIndex]!,
    world.enemies.y[bossIndex]!,
    BOSS_RECOVER_BLAST_RADIUS,
  )
  pushHazard(world, {
    kind: 'charge-end',
    x: center.x,
    y: center.y,
    radius: BOSS_RECOVER_BLAST_RADIUS,
    damage: BOSS_RECOVER_BLAST_DAMAGE,
    telegraphAt: world.time,
    detonateAt: world.time + BOSS_RECOVER_BLAST_WARNING_DURATION,
    volley: nextVolley(world),
  })
}

function detonateHazards(world: World): number {
  let rawDamage = 0
  const px = world.player.pos.x
  const py = world.player.pos.y

  for (let i = world.hostileHazards.length - 1; i >= 0; i -= 1) {
    const hazard = world.hostileHazards[i]!
    if (world.time + 1e-9 < hazard.detonateAt) continue

    let firstInVolley = true
    for (let j = 0; j < i; j += 1) {
      const sibling = world.hostileHazards[j]!
      if (
        sibling.volley === hazard.volley &&
        world.time + 1e-9 >= sibling.detonateAt
      ) {
        firstInVolley = false
        break
      }
    }
    if (firstInVolley) world.boss.hazardDetonations += 1

    const dx = px - hazard.x
    const dy = py - hazard.y
    if (
      dx * dx + dy * dy <= hazard.radius * hazard.radius &&
      world.boss.lastHazardHitVolley !== hazard.volley
    ) {
      rawDamage += hazard.damage
      world.boss.lastHazardHitVolley = hazard.volley
    }

    const last = world.hostileHazards.pop()!
    if (i < world.hostileHazards.length) {
      world.hostileHazards[i] = last
    }
  }
  return rawDamage
}

/**
 * 2페이즈 패턴을 예약하고 이번 틱에 발화한 원시 플레이어 피해를 반환한다.
 * 방어 배수·무적·일회성 생존기는 world의 기존 플레이어 피해 관문이 적용한다.
 */
export function stepBossEncounter(world: World): number {
  const boss = world.boss
  if (!boss.active) {
    world.hostileHazards.length = 0
    return 0
  }

  const bossIndex = findBoss(world)
  if (bossIndex < 0 || boss.phaseTwoAt < 0) {
    return detonateHazards(world)
  }

  const phase = bossPhaseAt(
    world.time,
    boss.spawnedAt,
    boss.phaseTwoAt,
  )
  if (phase !== 'transition') {
    const cycle = bossCycleIndex(
      world.time,
      boss.spawnedAt,
      boss.phaseTwoAt,
    )
    schedulePhaseZones(world, cycle)
    if (phase === 'recover') {
      scheduleRecoverBlast(world, bossIndex, cycle)
    }
  }

  return detonateHazards(world)
}
