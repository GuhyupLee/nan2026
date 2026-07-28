import type { Rng } from './rng.ts'

export const MAX_BATTLEFIELD_PICKUPS = 8
export const BATTLEFIELD_PICKUP_RADIUS = 1.35
export const BATTLEFIELD_PICKUP_LIFETIME = 45

/** No utility drops during the opening beat. */
export const BATTLEFIELD_PICKUP_INITIAL_DELAY = 20
/** Hard lower bound between successful drops. */
export const BATTLEFIELD_PICKUP_DROP_COOLDOWN = 26
/** Per eligible ordinary-enemy kill once the cooldown is ready. */
export const BATTLEFIELD_PICKUP_DROP_CHANCE = 0.08

export const BATTLEFIELD_HEAL_AMOUNT = 44
export const BATTLEFIELD_MAGNET_DURATION = 7
export const BATTLEFIELD_MAGNET_MAX_REMAINING = 10
export const BATTLEFIELD_BOMB_MAX_KILLS = 96

export const PICKUP_HEAL = 0
export const PICKUP_MAGNET = 1
export const PICKUP_BOMB = 2
export type BattlefieldPickupKind =
  | typeof PICKUP_HEAL
  | typeof PICKUP_MAGNET
  | typeof PICKUP_BOMB

const HEAL_ROLL_END = 0.5
const MAGNET_ROLL_END = 0.8
const COLLECTED_COUNT_BITS = 4
const COLLECTED_COUNT_MASK = (1 << COLLECTED_COUNT_BITS) - 1

/**
 * Fixed-capacity utility pickup state exposed to the renderer.
 *
 * Only [0, count) is active. The activation counters let a renderer detect
 * one-shot effects without an allocating event queue.
 */
export interface BattlefieldPickupPool {
  count: number
  x: Float32Array
  y: Float32Array
  kind: Uint8Array
  spawnedAt: Float32Array
  nextDropAt: number
  magnetUntil: number
  healActivations: number
  magnetActivations: number
  bombActivations: number
}

export function createBattlefieldPickupPool(
  capacity = MAX_BATTLEFIELD_PICKUPS,
): BattlefieldPickupPool {
  const size = Math.max(1, Math.floor(capacity))
  return {
    count: 0,
    x: new Float32Array(size),
    y: new Float32Array(size),
    kind: new Uint8Array(size),
    spawnedAt: new Float32Array(size),
    nextDropAt: BATTLEFIELD_PICKUP_INITIAL_DELAY,
    magnetUntil: -1,
    healActivations: 0,
    magnetActivations: 0,
    bombActivations: 0,
  }
}

export function resetBattlefieldPickupPool(pool: BattlefieldPickupPool): void {
  pool.count = 0
  pool.x.fill(0)
  pool.y.fill(0)
  pool.kind.fill(0)
  pool.spawnedAt.fill(0)
  pool.nextDropAt = BATTLEFIELD_PICKUP_INITIAL_DELAY
  pool.magnetUntil = -1
  pool.healActivations = 0
  pool.magnetActivations = 0
  pool.bombActivations = 0
}

/**
 * Inserts a pickup without allocating. At capacity the oldest entry is
 * replaced, keeping recent battlefield information deterministic and bounded.
 */
export function dropBattlefieldPickup(
  pool: BattlefieldPickupPool,
  x: number,
  y: number,
  kind: BattlefieldPickupKind,
  time: number,
): boolean {
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(time) ||
    (kind !== PICKUP_HEAL && kind !== PICKUP_MAGNET && kind !== PICKUP_BOMB)
  ) {
    return false
  }

  let index: number
  if (pool.count < pool.x.length) {
    index = pool.count
    pool.count += 1
  } else {
    index = 0
    let oldest = pool.spawnedAt[0]!
    for (let i = 1; i < pool.count; i += 1) {
      const spawnedAt = pool.spawnedAt[i]!
      if (spawnedAt < oldest) {
        index = i
        oldest = spawnedAt
      }
    }
  }

  pool.x[index] = x
  pool.y[index] = y
  pool.kind[index] = kind
  pool.spawnedAt[index] = time
  return true
}

/**
 * Attempts one controlled drop using the world's dedicated pickup RNG stream.
 * Returns the dropped kind, or -1 when the gate or roll rejects the drop.
 */
export function tryDropBattlefieldPickup(
  pool: BattlefieldPickupPool,
  rng: Rng,
  time: number,
  x: number,
  y: number,
): BattlefieldPickupKind | -1 {
  if (time < pool.nextDropAt) return -1
  if (rng.next() >= BATTLEFIELD_PICKUP_DROP_CHANCE) return -1

  const roll = rng.next()
  const kind =
    roll < HEAL_ROLL_END
      ? PICKUP_HEAL
      : roll < MAGNET_ROLL_END
        ? PICKUP_MAGNET
        : PICKUP_BOMB

  if (!dropBattlefieldPickup(pool, x, y, kind, time)) return -1
  pool.nextDropAt = time + BATTLEFIELD_PICKUP_DROP_COOLDOWN
  return kind
}

/**
 * Removes expired/collected pickups and returns packed per-kind counts.
 *
 * Four bits are reserved per kind, which is more than the pool capacity.
 * Returning one scalar keeps the fixed-tick path allocation-free.
 */
export function stepBattlefieldPickups(
  pool: BattlefieldPickupPool,
  playerX: number,
  playerY: number,
  time: number,
): number {
  const pickupRadiusSquared = BATTLEFIELD_PICKUP_RADIUS * BATTLEFIELD_PICKUP_RADIUS
  let collected = 0

  for (let i = pool.count - 1; i >= 0; i -= 1) {
    if (time - pool.spawnedAt[i]! >= BATTLEFIELD_PICKUP_LIFETIME) {
      removeBattlefieldPickup(pool, i)
      continue
    }

    const dx = playerX - pool.x[i]!
    const dy = playerY - pool.y[i]!
    if (dx * dx + dy * dy > pickupRadiusSquared) continue

    collected += 1 << (pool.kind[i]! * COLLECTED_COUNT_BITS)
    removeBattlefieldPickup(pool, i)
  }

  return collected
}

export function collectedBattlefieldPickupCount(
  collected: number,
  kind: BattlefieldPickupKind,
): number {
  return (collected >>> (kind * COLLECTED_COUNT_BITS)) & COLLECTED_COUNT_MASK
}

function removeBattlefieldPickup(
  pool: BattlefieldPickupPool,
  index: number,
): void {
  const last = pool.count - 1
  if (index !== last) {
    pool.x[index] = pool.x[last]!
    pool.y[index] = pool.y[last]!
    pool.kind[index] = pool.kind[last]!
    pool.spawnedAt[index] = pool.spawnedAt[last]!
  }
  pool.count = last
}
