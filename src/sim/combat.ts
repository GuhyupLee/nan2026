import { emitActionStart } from './actions.ts'
import { DT } from './constants.ts'
import { damageEnemy } from './damage.ts'
import { ENEMY_TYPES, type EnemyPool } from './enemies.ts'
import { tryEmpoweredAttack } from './kits.ts'
import { upgradeTraitToken } from './progression.ts'
import type { SpatialHash } from './spatial.ts'
import { effectiveAtkDamage, effectiveAtkInterval } from './stats.ts'
import { isMarked } from './status.ts'
import type { TracerEvent, World } from './types.ts'

const ATTACK_WIDTH = 0.35
const CONE_HALF = 0.96
const BIG_TARGET_DISCOUNT = 0.72
const hitBuf: number[] = []

function hasTrait(world: World, trait: string): boolean {
  return world.upgradesTaken.has(upgradeTraitToken(trait))
}

function pickTarget(
  pool: EnemyPool,
  px: number,
  py: number,
  aimX: number,
  aimY: number,
  range: number,
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

  let inCone = -1
  let coneScore = Infinity
  let anyNear = -1
  let anyScore = Infinity
  const r2 = range * range
  const cosCone = Math.cos(CONE_HALF)

  for (let i = 0; i < pool.count; i++) {
    if (pool.hp[i]! <= 0) continue

    const dx = pool.x[i]! - px
    const dy = pool.y[i]! - py
    const d2 = dx * dx + dy * dy
    if (d2 > r2) continue

    const big = ENEMY_TYPES[pool.type[i]!]!.radius >= 0.6
    const score = big ? d2 * BIG_TARGET_DISCOUNT : d2
    if (score < anyScore) {
      anyScore = score
      anyNear = i
    }

    const d = Math.sqrt(d2)
    if (d > 1e-6 && (dx / d) * ax + (dy / d) * ay < cosCone) continue
    if (score < coneScore) {
      coneScore = score
      inCone = i
    }
  }

  return inCone >= 0 ? inCone : anyNear
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
): void {
  const p = world.player
  const pool = world.enemies
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const ex = p.pos.x + dx * world.stats.atkRange
  const ey = p.pos.y + dy * world.stats.atkRange
  let target = -1
  let targetDistance = Number.POSITIVE_INFINITY

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
    const distance =
      (pool.x[i]! - p.pos.x) ** 2 + (pool.y[i]! - p.pos.y) ** 2
    if (distance < targetDistance) {
      target = i
      targetDistance = distance
    }
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
  if (target < 0) return

  damaged.add(target)
  const base = effectiveAtkDamage(world.stats) * 0.5
  const damage = isMarked(pool, target, world.time)
    ? base + world.stats.markBonus * 0.5
    : base
  damageEnemy(world, target, damage)
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
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)

  if (world.playerAction?.source !== 'skill') {
    emitActionStart(world, 'attack', angle)
  }
  if (world.attacks.length < 16) {
    world.attacks.push({
      angle,
      kind: world.playerClass === 'melee' ? 'melee' : 'ranged',
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

  const base = effectiveAtkDamage(s)
  const count = Math.min(hitBuf.length, s.atkPierce)
  const pierceAmplification = hasTrait(world, 'pierce-amplification')
  const primaryTargets = new Set<number>()
  for (let k = 0; k < count; k++) {
    const i = hitBuf[k]!
    primaryTargets.add(i)
    const markedDamage = isMarked(pool, i, world.time)
      ? base + s.markBonus
      : base
    const damage =
      markedDamage * (pierceAmplification ? 1 + k * 0.12 : 1)
    damageEnemy(world, i, damage)
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

  if (hasTrait(world, 'split-refraction')) {
    world.basicAttackSequence += 1
    if (world.basicAttackSequence % 3 === 0) {
      const splitTargets = new Set<number>()
      resolveSplitRay(
        world,
        tracers,
        angle + 0.24,
        primaryTargets,
        splitTargets,
      )
      resolveSplitRay(
        world,
        tracers,
        angle - 0.24,
        primaryTargets,
        splitTargets,
      )
    }
  }
}

/** 평타는 즉시 판정한다. 스킬 모션 중에는 판정만 유지하고 평타 모션은 생략한다. */
export function stepAutoAttack(
  world: World,
  pool: EnemyPool,
  _hash: SpatialHash,
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

  const target = pickTarget(
    pool,
    p.pos.x,
    p.pos.y,
    world.lastAim.x,
    world.lastAim.y,
    s.atkRange,
  )
  if (target < 0) return 0

  const targetX = pool.x[target]!
  const targetY = pool.y[target]!
  const dx = targetX - p.pos.x
  const dy = targetY - p.pos.y
  const angle = dx * dx + dy * dy > 1e-8 ? Math.atan2(dy, dx) : p.facing

  p.attackCooldown = effectiveAtkInterval(s)
  resolveAutoAttack(
    world,
    pool,
    tracers,
    angle,
    world.playerClass === 'melee' && p.empowered,
  )
  return 0
}
