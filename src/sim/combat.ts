import { emitActionStart } from './actions.ts'
import { DT } from './constants.ts'
import { damageEnemy } from './damage.ts'
import { ENEMY_TYPES, type EnemyPool } from './enemies.ts'
import { tryEmpoweredAttack } from './kits.ts'
import type { SpatialHash } from './spatial.ts'
import { effectiveAtkDamage, effectiveAtkInterval } from './stats.ts'
import { isMarked } from './status.ts'
import type { TracerEvent, World } from './types.ts'

const ATTACK_WIDTH = 0.35
const CONE_HALF = 0.96
const BIG_TARGET_DISCOUNT = 0.72
const hitBuf: number[] = []

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
  for (let k = 0; k < count; k++) {
    const i = hitBuf[k]!
    const damage = isMarked(pool, i, world.time) ? base + s.markBonus : base
    damageEnemy(world, i, damage)
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
