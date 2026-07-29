import { MAX_ENEMIES } from './enemies.ts'
import type { SkillId } from './skills.ts'
import type { PlayerClass, World } from './types.ts'

export type TargetingShape =
  | 'point'
  | 'line'
  | 'dash'
  | 'retreat'
  | 'self'
  | 'auto'

export interface TargetingSpec {
  shape: TargetingShape
  range: number
  width: number
  endpointRadius: number
  assist: 'none' | 'point' | 'direction'
}

export interface TargetingSolution {
  x: number
  y: number
  angle: number
  distance: number
  snapped: boolean
}

type CoreSkill = Exclude<SkillId, 'd' | 'f'>

const CORE_SPECS: Readonly<
  Record<PlayerClass, Readonly<Record<CoreSkill, TargetingSpec>>>
> = {
  ranged: {
    q: {
      shape: 'self',
      range: 0,
      width: 0,
      endpointRadius: 0,
      assist: 'none',
    },
    w: {
      shape: 'dash',
      range: 8,
      width: 1.1,
      endpointRadius: 1.25,
      assist: 'none',
    },
    e: {
      shape: 'point',
      range: 14,
      width: 0,
      endpointRadius: 6,
      assist: 'point',
    },
    r: {
      shape: 'line',
      range: 60,
      width: 5.5,
      endpointRadius: 0.5,
      assist: 'direction',
    },
  },
  melee: {
    q: {
      shape: 'line',
      range: 5.5,
      width: 3.6,
      endpointRadius: 0.65,
      assist: 'direction',
    },
    w: {
      shape: 'dash',
      range: 7,
      width: 4.6,
      endpointRadius: 3.5,
      assist: 'none',
    },
    e: {
      shape: 'self',
      range: 9,
      width: 0,
      endpointRadius: 0,
      assist: 'none',
    },
    r: {
      shape: 'auto',
      range: 13,
      width: 0,
      endpointRadius: 0,
      assist: 'none',
    },
  },
}

const HEAL_SPEC: TargetingSpec = {
  shape: 'self',
  range: 3.2,
  width: 0,
  endpointRadius: 0,
  assist: 'none',
}

const FLASH_SPEC: TargetingSpec = {
  shape: 'dash',
  range: 8,
  width: 1,
  endpointRadius: 1.1,
  assist: 'none',
}

const POINT_SNAP_RADIUS = 2.4
const POINT_NEIGHBOR_CAP = 8
const DIRECTION_SNAP_COS = Math.cos((8 * Math.PI) / 180)
const candidateBuffer = new Int32Array(MAX_ENEMIES)
const neighborBuffer = new Int32Array(MAX_ENEMIES)

function travelToArenaBoundary(
  x: number,
  y: number,
  directionX: number,
  directionY: number,
  radius: number,
): number {
  const along = x * directionX + y * directionY
  const discriminant =
    along * along + radius * radius - (x * x + y * y)
  if (discriminant <= 0) return 0
  return Math.max(0, -along + Math.sqrt(discriminant))
}

export function getTargetingSpec(
  playerClass: PlayerClass,
  skill: SkillId,
): TargetingSpec {
  if (skill === 'd') return HEAL_SPEC
  if (skill === 'f') return FLASH_SPEC
  return CORE_SPECS[playerClass][skill]
}

export function getTargetingRange(world: World, skill: SkillId): number {
  return skill === 'f'
    ? world.stats.flashRange
    : getTargetingSpec(world.playerClass, skill).range
}

function pointAssist(
  world: World,
  targetX: number,
  targetY: number,
  range: number,
  effectRadius: number,
): number {
  const pool = world.enemies
  const candidates = world.enemyHash.query(
    targetX,
    targetY,
    POINT_SNAP_RADIUS,
    candidateBuffer,
  )
  const snapRadiusSquared = POINT_SNAP_RADIUS * POINT_SNAP_RADIUS
  const rangeSquared = range * range
  const neighborRadius = Math.max(2.2, effectRadius * 0.7)
  const neighborRadiusSquared = neighborRadius * neighborRadius
  let best = -1
  let bestScore = Number.POSITIVE_INFINITY

  for (let c = 0; c < candidates; c += 1) {
    const i = candidateBuffer[c]!
    if (i >= pool.count || pool.hp[i]! <= 0) continue
    const offsetX = pool.x[i]! - targetX
    const offsetY = pool.y[i]! - targetY
    const offsetSquared = offsetX * offsetX + offsetY * offsetY
    if (offsetSquared > snapRadiusSquared) continue

    const playerX = pool.x[i]! - world.player.pos.x
    const playerY = pool.y[i]! - world.player.pos.y
    if (playerX * playerX + playerY * playerY > rangeSquared) continue

    const neighbors = world.enemyHash.query(
      pool.x[i]!,
      pool.y[i]!,
      neighborRadius,
      neighborBuffer,
    )
    let nearby = 0
    for (let n = 0; n < neighbors; n += 1) {
      const other = neighborBuffer[n]!
      if (other >= pool.count || pool.hp[other]! <= 0) continue
      const dx = pool.x[other]! - pool.x[i]!
      const dy = pool.y[other]! - pool.y[i]!
      if (dx * dx + dy * dy > neighborRadiusSquared) continue
      nearby += 1
      if (nearby >= POINT_NEIGHBOR_CAP) break
    }

    const score = offsetSquared - Math.max(0, nearby - 1) * 0.24
    if (score < bestScore) {
      best = i
      bestScore = score
    }
  }

  return best
}

function directionAssist(
  world: World,
  directionX: number,
  directionY: number,
  range: number,
): number {
  const pool = world.enemies
  const rangeSquared = range * range
  let best = -1
  let bestScore = Number.POSITIVE_INFINITY

  for (let i = 0; i < pool.count; i += 1) {
    if (pool.hp[i]! <= 0) continue
    const dx = pool.x[i]! - world.player.pos.x
    const dy = pool.y[i]! - world.player.pos.y
    const distanceSquared = dx * dx + dy * dy
    if (distanceSquared <= 1e-8 || distanceSquared > rangeSquared) continue
    const distance = Math.sqrt(distanceSquared)
    const dot = (dx * directionX + dy * directionY) / distance
    if (dot < DIRECTION_SNAP_COS) continue
    const score = (1 - dot) * 100 + distance * 0.001
    if (score < bestScore) {
      best = i
      bestScore = score
    }
  }

  return best
}

export function resolveTargeting(
  world: World,
  skill: SkillId,
  out: TargetingSolution,
  rawX = world.lastAim.x,
  rawY = world.lastAim.y,
): TargetingSolution {
  const spec = getTargetingSpec(world.playerClass, skill)
  const range = getTargetingRange(world, skill)
  const player = world.player

  if (spec.shape === 'self' || spec.shape === 'auto') {
    out.x = player.pos.x
    out.y = player.pos.y
    out.angle = player.facing
    out.distance = 0
    out.snapped = false
    return out
  }

  let dx = rawX - player.pos.x
  let dy = rawY - player.pos.y
  let rawDistance = Math.hypot(dx, dy)
  if (rawDistance < 1e-5) {
    dx = Math.cos(player.facing)
    dy = Math.sin(player.facing)
    rawDistance = range
  } else {
    dx /= rawDistance
    dy /= rawDistance
  }

  if (
    spec.shape === 'dash' &&
    world.playerClass === 'melee' &&
    skill === 'w' &&
    Math.hypot(player.vel.x, player.vel.y) >= 0.5
  ) {
    const speed = Math.hypot(player.vel.x, player.vel.y)
    dx = player.vel.x / speed
    dy = player.vel.y / speed
  }

  let distance =
    skill === 'w' &&
    (spec.shape === 'dash' || spec.shape === 'retreat')
      ? range
      : Math.min(rawDistance, range)
  let targetX = player.pos.x + dx * distance
  let targetY = player.pos.y + dy * distance
  if (spec.shape === 'dash' || spec.shape === 'retreat') {
    const limit = world.arenaRadius - world.stats.radius
    distance = Math.min(
      distance,
      travelToArenaBoundary(
        player.pos.x,
        player.pos.y,
        dx,
        dy,
        limit,
      ),
    )
    targetX = player.pos.x + dx * distance
    targetY = player.pos.y + dy * distance
  }
  let snapped = false

  if (world.aimAssistEnabled && spec.assist === 'point') {
    const target = pointAssist(
      world,
      targetX,
      targetY,
      range,
      spec.endpointRadius,
    )
    if (target >= 0) {
      targetX = world.enemies.x[target]!
      targetY = world.enemies.y[target]!
      const targetDx = targetX - player.pos.x
      const targetDy = targetY - player.pos.y
      distance = Math.hypot(targetDx, targetDy)
      dx = distance > 1e-5 ? targetDx / distance : dx
      dy = distance > 1e-5 ? targetDy / distance : dy
      snapped = true
    }
  } else if (world.aimAssistEnabled && spec.assist === 'direction') {
    const target = directionAssist(world, dx, dy, range)
    if (target >= 0) {
      const targetDx = world.enemies.x[target]! - player.pos.x
      const targetDy = world.enemies.y[target]! - player.pos.y
      const targetDistance = Math.hypot(targetDx, targetDy)
      if (targetDistance > 1e-5) {
        dx = targetDx / targetDistance
        dy = targetDy / targetDistance
        distance = Math.min(rawDistance, range)
        targetX = player.pos.x + dx * distance
        targetY = player.pos.y + dy * distance
        snapped = true
      }
    }
  }

  out.x = targetX
  out.y = targetY
  out.angle = Math.atan2(dy, dx)
  out.distance = distance
  out.snapped = snapped
  return out
}
