import { emitActionStart } from './actions.ts'
import { DT } from './constants.ts'
import { damageEnemy } from './damage.ts'
import {
  ENEMY_TYPES,
  MAX_ENEMIES,
  TYPE_BOSS,
  TYPE_ELITE,
  type EnemyPool,
} from './enemies.ts'
import { MARK_DURATION, tryEmpoweredAttack } from './kits.ts'
import { upgradeTraitToken } from './progression.ts'
import type { SpatialHash } from './spatial.ts'
import { skillDamageMul } from './skills.ts'
import { effectiveBasicAttackDamage, effectiveAtkInterval } from './stats.ts'
import { applyMark, applyPull, isMarked } from './status.ts'
import type { TracerEvent, World } from './types.ts'

const ATTACK_WIDTH = 0.35
const CONE_HALF = 0.96
const BIG_TARGET_DISCOUNT = 0.72
const RANGED_CLUSTER_RADIUS = 2.6
const RANGED_CLUSTER_RADIUS_SQ = RANGED_CLUSTER_RADIUS * RANGED_CLUSTER_RADIUS
const RANGED_CLUSTER_MAX_NEIGHBORS = 4
const RANGED_CLUSTER_SCORE_WEIGHT = 0.22
// 원거리 평타는 "가까운 적"이라는 기대를 먼저 지킨다. 다만 가장 가까운
// 적보다 실제 거리 기준 30% 안쪽이면, 관통 효율이 높은 밀집 방향을 고른다.
const RANGED_CLUSTER_DISTANCE_WINDOW = 1.3 * 1.3
const hitBuf: number[] = []
const splitHitBuf: number[] = []
const clusterBuf = new Int32Array(MAX_ENEMIES)

function hasTrait(world: World, trait: string): boolean {
  return world.upgradesTaken.has(upgradeTraitToken(trait))
}

function hasSkillTrait(world: World, slot: 'q' | 'w' | 'e' | 'r', trait: string): boolean {
  return world.skills[slot].branch === trait || hasTrait(world, trait)
}

function basicDamage(world: World): number {
  return (
    effectiveBasicAttackDamage(world.stats) *
    (world.time < world.player.utilityPowerUntil ? 1.25 : 1)
  )
}

function damageWithExecution(world: World, index: number, amount: number): boolean {
  const pool = world.enemies
  const type = pool.type[index]!
  const ordinary = type !== TYPE_BOSS && type !== TYPE_ELITE
  const executes =
    ordinary &&
    hasTrait(world, 'decapitation') &&
    pool.hp[index]! <= pool.maxHp[index]! * 0.18
  const killed = damageEnemy(
    world,
    index,
    executes ? pool.hp[index]! : amount,
  )
  if (!killed || !executes || !hasTrait(world, 'execution-spread')) return killed

  const x = pool.x[index]!
  const y = pool.y[index]!
  const radiusSquared = 3.2 * 3.2
  for (let i = 0; i < pool.count; i += 1) {
    if (i === index || pool.hp[i]! <= 0) continue
    const otherType = pool.type[i]!
    if (otherType === TYPE_BOSS || otherType === TYPE_ELITE) continue
    const dx = pool.x[i]! - x
    const dy = pool.y[i]! - y
    if (dx * dx + dy * dy > radiusSquared) continue
    if (pool.hp[i]! > pool.maxHp[i]! * 0.3) continue
    damageEnemy(world, i, pool.hp[i]!)
  }
  if (world.rings.length < 32) {
    world.rings.push({ x, y, radius: 3.2, kind: 3 })
  }
  return killed
}

/**
 * 원거리 평타가 고립된 한 마리보다 가까운 무리를 향하게 할 밀집도다.
 *
 * 공간 해시 질의 결과는 현재 좌표로 다시 좁히며, 버퍼와 결과를 모두 재사용해
 * 자동 공격·표적 링이 갱신될 때 쓰레기 객체를 만들지 않는다.
 */
function nearbyEnemyCount(
  pool: EnemyPool,
  hash: SpatialHash,
  source: number,
): number {
  const x = pool.x[source]!
  const y = pool.y[source]!
  const count = hash.query(x, y, RANGED_CLUSTER_RADIUS, clusterBuf)
  let nearby = 0

  for (let k = 0; k < count; k++) {
    const i = clusterBuf[k]!
    if (i === source || i >= pool.count || pool.hp[i]! <= 0) continue
    const dx = pool.x[i]! - x
    const dy = pool.y[i]! - y
    if (dx * dx + dy * dy > RANGED_CLUSTER_RADIUS_SQ) continue
    nearby += 1
    if (nearby >= RANGED_CLUSTER_MAX_NEIGHBORS) break
  }

  return nearby
}

export function pickAutoAttackTarget(
  pool: EnemyPool,
  hash: SpatialHash,
  px: number,
  py: number,
  aimX: number,
  aimY: number,
  range: number,
  preferCluster = false,
): number {
  let ax = aimX - px
  let ay = aimY - py
  const al = Math.hypot(ax, ay)
  if (al > 1e-6) {
    ax /= al
    ay /= al
  } else {
    ax = 1
    ay = 0
  }

  let nearestConeScore = Infinity
  let nearestScore = Infinity
  let nearestDistanceSq = Infinity
  const r2 = range * range
  const cosCone = Math.cos(CONE_HALF)

  // 먼저 기존 규칙의 최근접 점수를 구한다. 군집 보정은 이 점수와 가까운
  // 후보끼리만 경쟁시켜, 먼 대군이 바로 옆 위협이나 보스 조준을 빼앗지 않는다.
  for (let i = 0; i < pool.count; i++) {
    if (pool.hp[i]! <= 0) continue

    const dx = pool.x[i]! - px
    const dy = pool.y[i]! - py
    const d2 = dx * dx + dy * dy
    if (d2 > r2) continue
    if (d2 < nearestDistanceSq) nearestDistanceSq = d2

    const big = ENEMY_TYPES[pool.type[i]!]!.radius >= 0.6
    const score = big ? d2 * BIG_TARGET_DISCOUNT : d2
    if (score < nearestScore) nearestScore = score

    const d = Math.sqrt(d2)
    if (d > 1e-6 && (dx / d) * ax + (dy / d) * ay < cosCone) continue
    if (score < nearestConeScore) nearestConeScore = score
  }

  // 원거리 평타는 완전 자동 조준이다. 커서는 QWER 방향을 정하지만 평타의
  // 가까운 위협 탐색을 가두지 않는다. 근접 평타만 기존 조준 cone을 지킨다.
  const useCone = !preferCluster && Number.isFinite(nearestConeScore)
  const baseLimit = preferCluster
    ? nearestDistanceSq * RANGED_CLUSTER_DISTANCE_WINDOW
    : useCone
      ? nearestConeScore
      : nearestScore
  let target = -1
  let targetScore = Infinity

  for (let i = 0; i < pool.count; i++) {
    if (pool.hp[i]! <= 0) continue

    const dx = pool.x[i]! - px
    const dy = pool.y[i]! - py
    const d2 = dx * dx + dy * dy
    if (d2 > r2) continue

    if (useCone) {
      const d = Math.sqrt(d2)
      if (d > 1e-6 && (dx / d) * ax + (dy / d) * ay < cosCone) continue
    }

    const big = ENEMY_TYPES[pool.type[i]!]!.radius >= 0.6
    let score = big ? d2 * BIG_TARGET_DISCOUNT : d2
    if ((preferCluster ? d2 : score) > baseLimit) continue
    if (preferCluster) {
      score /= 1 + nearbyEnemyCount(pool, hash, i) * RANGED_CLUSTER_SCORE_WEIGHT
    }
    if (score < targetScore) {
      targetScore = score
      target = i
    }
  }

  return target
}

function distSqToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax
  const aby = by - ay
  const len2 = abx * abx + aby * aby
  let t = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const cx = ax + abx * t - px
  const cy = ay + aby * t - py
  return cx * cx + cy * cy
}

function resolveSplitRay(
  world: World,
  tracers: TracerEvent[],
  angle: number,
  excluded: ReadonlySet<number>,
  damaged: Set<number>,
  damageMultiplier: number,
  pullX?: number,
  pullY?: number,
): void {
  const p = world.player
  const pool = world.enemies
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const ex = p.pos.x + dx * world.stats.atkRange
  const ey = p.pos.y + dy * world.stats.atkRange
  splitHitBuf.length = 0
  for (let i = 0; i < pool.count; i++) {
    if (pool.hp[i]! <= 0 || excluded.has(i) || damaged.has(i)) continue
    const radius = ENEMY_TYPES[pool.type[i]!]!.radius + 0.28
    if (
      distSqToSegment(
        pool.x[i]!,
        pool.y[i]!,
        p.pos.x,
        p.pos.y,
        ex,
        ey,
      ) > radius * radius
    ) {
      continue
    }
    splitHitBuf.push(i)
  }

  if (tracers.length < 64) {
    tracers.push({
      x0: p.pos.x,
      y0: p.pos.y,
      x1: ex,
      y1: ey,
      width: 0.65,
      kind: 0,
    })
  }
  splitHitBuf.sort((a, b) => {
    const adx = pool.x[a]! - p.pos.x
    const ady = pool.y[a]! - p.pos.y
    const bdx = pool.x[b]! - p.pos.x
    const bdy = pool.y[b]! - p.pos.y
    return adx * adx + ady * ady - (bdx * bdx + bdy * bdy)
  })

  const base = basicDamage(world) * damageMultiplier
  const hitCount = Math.min(splitHitBuf.length, world.stats.atkPierce)
  for (let k = 0; k < hitCount; k += 1) {
    const target = splitHitBuf[k]!
    damaged.add(target)
    const damage = isMarked(pool, target, world.time)
      ? base + world.stats.markBonus * damageMultiplier
      : base
    damageEnemy(world, target, damage)
    if (world.time < world.player.rangedVolleyUntil) {
      applyMark(pool, target, world.time, MARK_DURATION)
    }
    if (pullX !== undefined && pullY !== undefined) {
      applyPull(pool, target, world.time, pullX, pullY, 0.45, 8, 0.7)
    }
  }
}

function resolveAuxiliaryRay(
  world: World,
  tracers: TracerEvent[],
  angle: number,
  excluded: ReadonlySet<number>,
): boolean {
  const p = world.player
  const pool = world.enemies
  let rayAngle = angle

  if (hasTrait(world, 'auxiliary-tracking')) {
    let target = -1
    let distance = Number.POSITIVE_INFINITY
    for (let i = 0; i < pool.count; i += 1) {
      if (pool.hp[i]! <= 0 || excluded.has(i)) continue
      const dx = pool.x[i]! - p.pos.x
      const dy = pool.y[i]! - p.pos.y
      const d2 = dx * dx + dy * dy
      if (d2 <= world.stats.atkRange ** 2 && d2 < distance) {
        target = i
        distance = d2
      }
    }
    if (target >= 0) {
      rayAngle = Math.atan2(
        pool.y[target]! - p.pos.y,
        pool.x[target]! - p.pos.x,
      )
    }
  }

  const dx = Math.cos(rayAngle)
  const dy = Math.sin(rayAngle)
  const ex = p.pos.x + dx * world.stats.atkRange
  const ey = p.pos.y + dy * world.stats.atkRange
  let target = -1
  let distance = Number.POSITIVE_INFINITY
  for (let i = 0; i < pool.count; i += 1) {
    if (pool.hp[i]! <= 0 || excluded.has(i)) continue
    const radius = ENEMY_TYPES[pool.type[i]!]!.radius + 0.24
    if (
      distSqToSegment(pool.x[i]!, pool.y[i]!, p.pos.x, p.pos.y, ex, ey) >
      radius * radius
    ) {
      continue
    }
    const d2 = (pool.x[i]! - p.pos.x) ** 2 + (pool.y[i]! - p.pos.y) ** 2
    if (d2 < distance) {
      target = i
      distance = d2
    }
  }
  if (tracers.length < 64) {
    tracers.push({
      x0: p.pos.x,
      y0: p.pos.y,
      x1: ex,
      y1: ey,
      width: 0.55,
      kind: 0,
    })
  }
  if (target < 0) return false
  return damageWithExecution(world, target, basicDamage(world) * 0.4)
}

function resolveBackstrike(
  world: World,
  tracers: TracerEvent[],
  angle: number,
): boolean {
  const p = world.player
  const pool = world.enemies
  const backAngle = angle + Math.PI
  const dx = Math.cos(backAngle)
  const dy = Math.sin(backAngle)
  const reach = Math.min(world.stats.atkRange, 4.2)
  const ex = p.pos.x + dx * reach
  const ey = p.pos.y + dy * reach
  let target = -1
  let distance = Number.POSITIVE_INFINITY
  for (let i = 0; i < pool.count; i += 1) {
    if (pool.hp[i]! <= 0) continue
    const radius = ENEMY_TYPES[pool.type[i]!]!.radius + ATTACK_WIDTH
    if (
      distSqToSegment(pool.x[i]!, pool.y[i]!, p.pos.x, p.pos.y, ex, ey) >
      radius * radius
    ) {
      continue
    }
    const d2 = (pool.x[i]! - p.pos.x) ** 2 + (pool.y[i]! - p.pos.y) ** 2
    if (d2 < distance) {
      target = i
      distance = d2
    }
  }
  if (tracers.length < 64) {
    tracers.push({
      x0: p.pos.x,
      y0: p.pos.y,
      x1: ex,
      y1: ey,
      width: 0.75,
      kind: 3,
    })
  }
  if (target < 0) return false
  const multiplier = hasTrait(world, 'backstrike-focus') ? 0.75 : 0.5
  return damageWithExecution(world, target, basicDamage(world) * multiplier)
}

function resolveAutoAttack(
  world: World,
  pool: EnemyPool,
  tracers: TracerEvent[],
  angle: number,
  empowered: boolean,
): void {
  if (empowered && tryEmpoweredAttack(world, angle)) return

  const p = world.player
  const s = world.stats
  const qVolleyActive =
    world.playerClass === 'ranged' && world.time < p.rangedVolleyUntil
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)

  if (world.playerAction?.source !== 'skill') {
    emitActionStart(world, 'attack', angle)
  }
  if (world.attacks.length < 16) {
    world.attacks.push({
      angle,
      kind:
        world.playerClass === 'melee'
          ? 'melee'
          : qVolleyActive
            ? 'empowered'
            : 'ranged',
    })
  }

  const ex = p.pos.x + dx * s.atkRange
  const ey = p.pos.y + dy * s.atkRange
  if (tracers.length < 64) {
    tracers.push({ x0: p.pos.x, y0: p.pos.y, x1: ex, y1: ey, width: 1, kind: 0 })
  }

  hitBuf.length = 0
  for (let i = 0; i < pool.count; i++) {
    if (pool.hp[i]! <= 0) continue
    const radius = ENEMY_TYPES[pool.type[i]!]!.radius + ATTACK_WIDTH
    if (
      distSqToSegment(pool.x[i]!, pool.y[i]!, p.pos.x, p.pos.y, ex, ey) <=
      radius * radius
    ) {
      hitBuf.push(i)
    }
  }

  hitBuf.sort((a, b) => {
    const da = (pool.x[a]! - p.pos.x) ** 2 + (pool.y[a]! - p.pos.y) ** 2
    const db = (pool.x[b]! - p.pos.x) ** 2 + (pool.y[b]! - p.pos.y) ** 2
    return da - db
  })

  const base = basicDamage(world)
  const doubleStrike = p.doubleAttackReady > 0
  if (doubleStrike) p.doubleAttackReady -= 1
  const count = Math.min(hitBuf.length, s.atkPierce)
  const pierceAmplification = hasTrait(world, 'pierce-amplification')
  const primaryTargets = new Set<number>()
  let primaryKill = false
  for (let k = 0; k < count; k++) {
    const i = hitBuf[k]!
    primaryTargets.add(i)
    const markedDamage = isMarked(pool, i, world.time)
      ? base + s.markBonus
      : base
    const damage =
      markedDamage * (pierceAmplification ? 1 + k * 0.12 : 1)
    if (
      damageWithExecution(world, i, damage * (doubleStrike ? 2 : 1))
    ) {
      primaryKill = true
    }
    if (qVolleyActive) applyMark(pool, i, world.time, MARK_DURATION)
  }

  if (hasTrait(world, 'interference-burst') && count > 0) {
    const source = hitBuf[count - 1]!
    const x = pool.x[source]!
    const y = pool.y[source]!
    const supernova = hasTrait(world, 'supernova-chain')
    const radius = supernova ? 3.2 : 2.2
    const radiusSquared = radius * radius
    const burstDamage = base * (supernova ? 0.8 : 0.45)
    for (let i = 0; i < pool.count; i += 1) {
      if (pool.hp[i]! <= 0 || primaryTargets.has(i)) continue
      const ox = pool.x[i]! - x
      const oy = pool.y[i]! - y
      if (ox * ox + oy * oy <= radiusSquared) {
        damageWithExecution(world, i, burstDamage)
      }
    }
    if (world.rings.length < 32) {
      world.rings.push({ x, y, radius, kind: supernova ? 3 : 0 })
    }
  }

  if (hasTrait(world, 'auxiliary-beam')) {
    const offset = hasTrait(world, 'auxiliary-focus') ? 0.12 : 0.26
    resolveAuxiliaryRay(world, tracers, angle + offset, primaryTargets)
    if (hasTrait(world, 'supernova-chain')) {
      resolveAuxiliaryRay(world, tracers, angle - offset, primaryTargets)
    }
  }

  let backKill = false
  if (hasTrait(world, 'backstrike')) {
    backKill = resolveBackstrike(world, tracers, angle)
  }
  if (
    primaryKill &&
    backKill &&
    hasTrait(world, 'dual-kill-gauge')
  ) {
    p.gauge = Math.min(100, p.gauge + 8)
  }

  if (hasTrait(world, 'horizon-focus') && count > 0) {
    const focusSource = hitBuf[0]!
    const sourceDistance = Math.hypot(
      pool.x[focusSource]! - p.pos.x,
      pool.y[focusSource]! - p.pos.y,
    )
    if (sourceDistance >= s.atkRange * 0.65) {
      const focusX = pool.x[focusSource]! + dx * 2.2
      const focusY = pool.y[focusSource]! + dy * 2.2
      const focusRadius = 2.2
      const focusDamage = base * 0.4
      for (let i = 0; i < pool.count; i++) {
        if (pool.hp[i]! <= 0 || primaryTargets.has(i)) continue
        const ox = pool.x[i]! - focusX
        const oy = pool.y[i]! - focusY
        if (ox * ox + oy * oy <= focusRadius * focusRadius) {
          damageEnemy(world, i, focusDamage)
        }
      }
      if (world.rings.length < 32) {
        world.rings.push({
          x: focusX,
          y: focusY,
          radius: focusRadius,
          kind: 0,
        })
      }
    }
  }

  const splitRefraction = hasTrait(world, 'split-refraction')
  if (splitRefraction) {
    world.basicAttackSequence += 1
  }
  const passiveSplit =
    splitRefraction && world.basicAttackSequence % 3 === 0
  if (qVolleyActive || passiveSplit) {
    const splitTargets = new Set<number>()
    const qRankMultiplier = qVolleyActive
      ? skillDamageMul(world.skills, 'q')
      : 1
    const splitMultiplier =
      (qVolleyActive ? 0.3 : 0.5) *
      qRankMultiplier *
      (qVolleyActive && splitRefraction ? 1.25 : 1)
    const singularity =
      qVolleyActive &&
      hasSkillTrait(world, 'q', 'singularity-interference') &&
      count > 0
    const pullTarget = singularity ? hitBuf[0]! : -1
    const pullX = pullTarget >= 0 ? pool.x[pullTarget]! : undefined
    const pullY = pullTarget >= 0 ? pool.y[pullTarget]! : undefined
    resolveSplitRay(
      world,
      tracers,
      angle + 0.24,
      primaryTargets,
      splitTargets,
      splitMultiplier,
      pullX,
      pullY,
    )
    resolveSplitRay(
      world,
      tracers,
      angle - 0.24,
      primaryTargets,
      splitTargets,
      splitMultiplier,
      pullX,
      pullY,
    )
  }
}

/** 평타는 즉시 판정한다. 스킬 모션 중에는 판정만 유지하고 평타 모션은 생략한다. */
export function stepAutoAttack(
  world: World,
  pool: EnemyPool,
  hash: SpatialHash,
  tracers: TracerEvent[],
): number {
  const p = world.player
  const s = world.stats
  p.attackCooldown -= DT

  if (
    p.attackCooldown > 0 ||
    pool.count === 0 ||
    world.ult.active
  ) {
    return 0
  }

  // 틱 맨 앞의 해시는 이후 적 이동·신규 스폰을 아직 반영하지 않는다.
  // 군집 점수를 쓰는 원거리만 발사 직전에 갱신해 실제 화면의 무리를 센다.
  // 보스전에도 소환물이 플레이어를 둘러싸므로 원거리의 가까운 밀집 우선은
  // 계속 유지한다. 큰 적 거리 보정 덕분에 가까운 보스는 그대로 우선된다.
  const preferCluster = world.playerClass === 'ranged'
  if (preferCluster) hash.rebuild(pool.count, pool.x, pool.y)

  const target = pickAutoAttackTarget(
    pool,
    hash,
    p.pos.x,
    p.pos.y,
    world.lastAim.x,
    world.lastAim.y,
    s.atkRange,
    preferCluster,
  )
  if (target < 0) return 0

  const targetX = pool.x[target]!
  const targetY = pool.y[target]!
  const dx = targetX - p.pos.x
  const dy = targetY - p.pos.y
  const angle = dx * dx + dy * dy > 1e-8 ? Math.atan2(dy, dx) : p.facing

  p.attackCooldown =
    effectiveAtkInterval(s) *
    (world.time < p.pickupHasteUntil ? 0.65 : 1)
  resolveAutoAttack(
    world,
    pool,
    tracers,
    angle,
    world.playerClass === 'melee' && p.empowered,
  )
  return 0
}
