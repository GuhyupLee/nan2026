import {
  BOSS_PHASE_TWO_TRANSITION_DURATION,
  BOSS_MAX_HP,
  TYPE_BOSS,
  TYPE_ELITE,
  bossCycleIndex,
  bossPhaseAt,
} from './enemies.ts'
import { difficultyRules } from './difficulty.ts'
import { applyImpulse } from './status.ts'
import type { BossHazard, World } from './types.ts'

/** 최대 체력의 절반인 이 체력에 처음 닿는 타격이 2페이즈를 연다. */
export const BOSS_PHASE_TWO_THRESHOLD = BOSS_MAX_HP / 2
/** 기본 HP 기준의 3페이즈 문턱. 실제 만월 문턱은 world.boss.maxHp에서 계산한다. */
export const BOSS_PHASE_THREE_THRESHOLD = BOSS_MAX_HP / 3
/** 전환 충격이 잡몹을 밀어내 보스 패턴을 읽을 공간. */
export const BOSS_PHASE_TWO_KNOCKBACK_RADIUS = 8.5
export const BOSS_PHASE_TWO_KNOCKBACK_IMPULSE = 32

/** 2페이즈 압박 펄스마다 현재 위치와 예측 위치에 놓는 2원 장판. */
export const BOSS_PHASE_ZONE_RADIUS = 3.5
export const BOSS_PHASE_ZONE_WARNING_DURATION = 1.1
// 24에서 올렸다. 초반 XP를 웨이브 리듬에 맞춰 재조정하면서 첫 강화가
// 빨라졌고, 그 복리로 원거리 보스 승률이 19/24까지 되돌아갔다(상한 18).
// 성장 계약은 이제 맞으므로 그쪽을 다시 건드리지 않고, 원거리가 카이팅으로
// 남기던 여유(최저 체력 58%)를 장판 쪽에서 거둬들인다.
export const BOSS_PHASE_ZONE_DAMAGE = 29
export const BOSS_PHASE_ZONE_PREDICTION_SECONDS = 0.65
/** 돌진 사이에도 공간을 계속 바꾸는 2페이즈 장판 주기. */
export const BOSS_PHASE_ZONE_INTERVAL = 2.2
/** 만월 3페이즈는 더 짧은 예고 뒤 세 갈래 안전지대를 요구한다. */
export const BOSS_PHASE_THREE_ZONE_RADIUS = 3.15
export const BOSS_PHASE_THREE_ZONE_WARNING_DURATION = 0.85
export const BOSS_PHASE_THREE_ZONE_DAMAGE = 36
export const BOSS_PHASE_THREE_ZONE_PREDICTION_SECONDS = 0.8
export const BOSS_PHASE_THREE_ZONE_FORK_DISTANCE = 4.4
export const BOSS_PHASE_THREE_ZONE_INTERVAL = 1.45

/** 2페이즈 문턱에서 보스 주변을 비우게 하는 확장 충격파. */
export const BOSS_PHASE_SHOCKWAVE_INNER_RADIUS = 5.5
export const BOSS_PHASE_SHOCKWAVE_INNER_WARNING_DURATION = 0.45
export const BOSS_PHASE_SHOCKWAVE_INNER_DAMAGE = 80
export const BOSS_PHASE_SHOCKWAVE_RADIUS = 9
export const BOSS_PHASE_SHOCKWAVE_WARNING_DURATION = 0.9
export const BOSS_PHASE_SHOCKWAVE_DAMAGE = 28

/** 돌진이 끝난 자리를 잠시 뒤 다시 위험하게 만드는 종점 폭발. */
export const BOSS_RECOVER_BLAST_RADIUS = 2.2
export const BOSS_RECOVER_BLAST_WARNING_DURATION = 0.7
export const BOSS_RECOVER_BLAST_DAMAGE = 16
/** 돌진 궤적 뒤에 세 구간으로 남아 직선 왕복을 막는 장판. */
export const BOSS_CHARGE_TRAIL_RADIUS = 2
export const BOSS_CHARGE_TRAIL_WARNING_DURATION = 0.95
export const BOSS_CHARGE_TRAIL_DAMAGE = 24
export const BOSS_CHARGE_TRAIL_SPACING = 3.2
export const BOSS_CHARGE_TRAIL_COUNT = 3

const MAX_HOSTILE_HAZARDS = 8
const MAX_PHASE_THREE_HOSTILE_HAZARDS = 12

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
  const max =
    world.boss.phaseThreeAt >= 0
      ? MAX_PHASE_THREE_HOSTILE_HAZARDS
      : MAX_HOSTILE_HAZARDS
  if (world.hostileHazards.length >= max) return
  world.hostileHazards.push(hazard)
}

function nextVolley(world: World): number {
  const volley = world.boss.nextHazardVolley
  world.boss.nextHazardVolley += 1
  return volley
}

export function bossPhaseTwoThreshold(world: World): number {
  return (
    world.boss.maxHp *
    difficultyRules(world.runConfig.difficulty).bossPhaseTwoRatio
  )
}

export function bossPhaseThreeThreshold(world: World): number | null {
  const ratio =
    difficultyRules(world.runConfig.difficulty).bossPhaseThreeRatio
  return ratio === null ? null : world.boss.maxHp * ratio
}

function triggerBossTransition(
  world: World,
  bossIndex: number,
  stage: 2 | 3,
): boolean {
  const boss = world.boss
  if (
    (stage === 2
      ? boss.phaseTwoAt >= 0
      : boss.phaseTwoAt < 0 || boss.phaseThreeAt >= 0) ||
    world.enemies.type[bossIndex] !== TYPE_BOSS ||
    world.enemies.hp[bossIndex]! <= 0
  ) {
    return false
  }

  if (stage === 2) boss.phaseTwoAt = world.time
  else boss.phaseThreeAt = world.time
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
  const phaseThree = stage === 3
  pushHazard(world, {
    kind: 'phase-shockwave',
    x: bx,
    y: by,
    radius: phaseThree ? 6.2 : BOSS_PHASE_SHOCKWAVE_INNER_RADIUS,
    damage: phaseThree ? 90 : BOSS_PHASE_SHOCKWAVE_INNER_DAMAGE,
    telegraphAt: world.time,
    detonateAt:
      world.time + BOSS_PHASE_SHOCKWAVE_INNER_WARNING_DURATION,
    volley: nextVolley(world),
  })
  pushHazard(world, {
    kind: 'phase-shockwave',
    x: bx,
    y: by,
    radius: phaseThree ? 10.5 : BOSS_PHASE_SHOCKWAVE_RADIUS,
    damage: phaseThree ? 34 : BOSS_PHASE_SHOCKWAVE_DAMAGE,
    telegraphAt: world.time,
    detonateAt: world.time + BOSS_PHASE_SHOCKWAVE_WARNING_DURATION,
    volley: nextVolley(world),
  })
  if (phaseThree) {
    pushHazard(world, {
      kind: 'phase-shockwave',
      x: bx,
      y: by,
      radius: 14,
      damage: 38,
      telegraphAt: world.time,
      detonateAt: world.time + 1.15,
      volley: nextVolley(world),
    })
  }
  if (world.rings.length < 32) {
    world.rings.push({
      x: bx,
      y: by,
      radius: phaseThree ? 10.5 : BOSS_PHASE_TWO_KNOCKBACK_RADIUS,
      kind: 5,
    })
  }
  const knockbackRadius = phaseThree
    ? 10.5
    : BOSS_PHASE_TWO_KNOCKBACK_RADIUS
  const radiusSq = knockbackRadius * knockbackRadius
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

/**
 * 첫 체력 게이트를 연다. damageEnemy만 호출해 체력 clamp와 같은 트랜잭션에서
 * 실행하며, false 반환은 이미 전환한 보스라는 뜻이다.
 */
export function triggerBossPhaseTwo(
  world: World,
  bossIndex: number,
): boolean {
  return triggerBossTransition(world, bossIndex, 2)
}

/** 만월의 마지막 체력 게이트를 연다. */
export function triggerBossPhaseThree(
  world: World,
  bossIndex: number,
): boolean {
  return triggerBossTransition(world, bossIndex, 3)
}

function schedulePhaseZones(
  world: World,
  bossIndex: number,
  cycle: number,
  stage: 2 | 3,
): void {
  const boss = world.boss
  if (cycle <= boss.hazardCycle) return
  boss.hazardCycle = cycle

  const p = world.player
  const phaseThree = stage === 3
  const radius = phaseThree
    ? BOSS_PHASE_THREE_ZONE_RADIUS
    : BOSS_PHASE_ZONE_RADIUS
  const predictionSeconds = phaseThree
    ? BOSS_PHASE_THREE_ZONE_PREDICTION_SECONDS
    : BOSS_PHASE_ZONE_PREDICTION_SECONDS
  const current = clampHazardCenter(
    world,
    p.pos.x,
    p.pos.y,
    radius,
  )
  const predicted = clampHazardCenter(
    world,
    p.pos.x + p.vel.x * predictionSeconds,
    p.pos.y + p.vel.y * predictionSeconds,
    radius,
  )
  const volley = nextVolley(world)
  const warning = phaseThree
    ? BOSS_PHASE_THREE_ZONE_WARNING_DURATION
    : BOSS_PHASE_ZONE_WARNING_DURATION
  const damage = phaseThree
    ? BOSS_PHASE_THREE_ZONE_DAMAGE
    : BOSS_PHASE_ZONE_DAMAGE
  const detonateAt = world.time + warning

  pushHazard(world, {
    kind: 'phase-zone',
    x: current.x,
    y: current.y,
    radius,
    damage,
    telegraphAt: world.time,
    detonateAt,
    volley,
  })
  if (!phaseThree) {
    pushHazard(world, {
      kind: 'phase-zone',
      x: predicted.x,
      y: predicted.y,
      radius,
      damage,
      telegraphAt: world.time,
      detonateAt,
      volley,
    })
    return
  }

  let dirX = p.vel.x
  let dirY = p.vel.y
  let directionLength = Math.hypot(dirX, dirY)
  if (directionLength <= 1e-6) {
    dirX = p.pos.x - world.enemies.x[bossIndex]!
    dirY = p.pos.y - world.enemies.y[bossIndex]!
    directionLength = Math.hypot(dirX, dirY)
  }
  if (directionLength <= 1e-6) {
    dirX = 1
    dirY = 0
    directionLength = 1
  }
  const sideX = -dirY / directionLength
  const sideY = dirX / directionLength
  for (const side of [-1, 1] as const) {
    const fork = clampHazardCenter(
      world,
      predicted.x + sideX * BOSS_PHASE_THREE_ZONE_FORK_DISTANCE * side,
      predicted.y + sideY * BOSS_PHASE_THREE_ZONE_FORK_DISTANCE * side,
      radius,
    )
    pushHazard(world, {
      kind: 'phase-zone',
      x: fork.x,
      y: fork.y,
      radius,
      damage,
      telegraphAt: world.time,
      detonateAt,
      volley,
    })
  }
}

function phaseZonePulse(world: World, stage: 2 | 3): number {
  const phaseStartedAt =
    stage === 3 ? world.boss.phaseThreeAt : world.boss.phaseTwoAt
  const interval =
    stage === 3
      ? BOSS_PHASE_THREE_ZONE_INTERVAL
      : BOSS_PHASE_ZONE_INTERVAL
  const startedAt =
    phaseStartedAt + BOSS_PHASE_TWO_TRANSITION_DURATION
  return Math.max(
    0,
    Math.floor(
      (world.time - startedAt + 1e-9) / interval,
    ),
  )
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

  const trailVolley = nextVolley(world)
  let dirX = world.enemies.bossChargeDirX[bossIndex]!
  let dirY = world.enemies.bossChargeDirY[bossIndex]!
  const directionLength = Math.hypot(dirX, dirY)
  if (directionLength > 1e-6) {
    dirX /= directionLength
    dirY /= directionLength
    for (let step = 1; step <= BOSS_CHARGE_TRAIL_COUNT; step += 1) {
      const trail = clampHazardCenter(
        world,
        world.enemies.x[bossIndex]! -
          dirX * BOSS_CHARGE_TRAIL_SPACING * step,
        world.enemies.y[bossIndex]! -
          dirY * BOSS_CHARGE_TRAIL_SPACING * step,
        BOSS_CHARGE_TRAIL_RADIUS,
      )
      pushHazard(world, {
        kind: 'charge-trail',
        x: trail.x,
        y: trail.y,
        radius: BOSS_CHARGE_TRAIL_RADIUS,
        damage: BOSS_CHARGE_TRAIL_DAMAGE,
        telegraphAt: world.time,
        detonateAt: world.time + BOSS_CHARGE_TRAIL_WARNING_DURATION,
        volley: trailVolley,
      })
    }
  }
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
    boss.phaseThreeAt,
  )
  if (phase !== 'transition') {
    const stage = boss.phaseThreeAt >= 0 ? 3 : 2
    const cycle = bossCycleIndex(
      world.time,
      boss.spawnedAt,
      boss.phaseTwoAt,
      boss.phaseThreeAt,
    )
    schedulePhaseZones(
      world,
      bossIndex,
      phaseZonePulse(world, stage),
      stage,
    )
    if (phase === 'recover') {
      scheduleRecoverBlast(world, bossIndex, cycle)
    }
  }

  return detonateHazards(world)
}
