/**
 * Maximum number of XP gems kept in the simulation.
 *
 * The fixed-capacity structure keeps the hot update loop allocation-free. When
 * the pool is full, new XP is merged into the nearest existing gem instead of
 * being discarded.
 */
export const MAX_XP_GEMS = 384

/** Distance at which a gem is collected immediately. */
export const XP_GEM_PICKUP_RADIUS = 1.2
/** Distance at which a gem starts following the player. */
export const XP_GEM_MAGNET_RADIUS = 16
/** Movement speed of an attracted gem in world units per second. */
export const XP_GEM_ATTRACT_SPEED = 24
/** Off-route XP eventually comes home so kiting never deletes progression. */
export const XP_GEM_STALE_ATTRACT_AFTER = 20

/**
 * Renderer-facing XP gem state.
 *
 * Only entries in [0, count) are active. prevX/prevY support interpolated
 * rendering without coupling the simulation to Three.js.
 */
export interface XpGemPool {
  count: number
  x: Float32Array
  y: Float32Array
  prevX: Float32Array
  prevY: Float32Array
  value: Float32Array
  attracted: Uint8Array
  /** Seconds since drop; used only for the forgiving stale-gem latch. */
  age: Float32Array
}

export function createXpGemPool(capacity = MAX_XP_GEMS): XpGemPool {
  const size = Math.max(1, Math.floor(capacity))
  return {
    count: 0,
    x: new Float32Array(size),
    y: new Float32Array(size),
    prevX: new Float32Array(size),
    prevY: new Float32Array(size),
    value: new Float32Array(size),
    attracted: new Uint8Array(size),
    age: new Float32Array(size),
  }
}

/**
 * Clears a pool for a new run while retaining all backing arrays.
 */
export function resetXpGemPool(pool: XpGemPool): void {
  pool.count = 0
  pool.x.fill(0)
  pool.y.fill(0)
  pool.prevX.fill(0)
  pool.prevY.fill(0)
  pool.value.fill(0)
  pool.attracted.fill(0)
  pool.age.fill(0)
}

/**
 * Drops one XP gem. Returns false only for invalid or non-positive XP.
 *
 * Overflow is deliberately lossless: the new value is merged into the nearest
 * live gem. Strictly-better distance comparison makes equal-distance ties pick
 * the earliest slot, so identical inputs always produce identical state.
 */
export function dropXpGem(
  pool: XpGemPool,
  x: number,
  y: number,
  value: number,
): boolean {
  if (
    !(value > 0) ||
    !Number.isFinite(value) ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  ) {
    return false
  }

  if (pool.count < pool.x.length) {
    const i = pool.count
    pool.count += 1
    pool.x[i] = x
    pool.y[i] = y
    pool.prevX[i] = x
    pool.prevY[i] = y
    pool.value[i] = value
    pool.attracted[i] = 0
    pool.age[i] = 0
    return true
  }

  let nearest = 0
  let nearestDistanceSquared = Number.POSITIVE_INFINITY
  for (let i = 0; i < pool.count; i += 1) {
    const dx = pool.x[i]! - x
    const dy = pool.y[i]! - y
    const distanceSquared = dx * dx + dy * dy
    if (distanceSquared < nearestDistanceSquared) {
      nearest = i
      nearestDistanceSquared = distanceSquared
    }
  }
  pool.value[nearest] = pool.value[nearest]! + value
  return true
}

/**
 * Advances attraction and returns the raw XP collected this tick.
 *
 * Once attracted, a gem remains locked to the player. The loop uses only
 * scalar locals and swap-removal, so it creates no garbage during fixed ticks.
 */
export function stepXpGems(
  pool: XpGemPool,
  playerX: number,
  playerY: number,
  dt: number,
  forceAttract = false,
): number {
  const pickupRadiusSquared = XP_GEM_PICKUP_RADIUS * XP_GEM_PICKUP_RADIUS
  const magnetRadiusSquared = XP_GEM_MAGNET_RADIUS * XP_GEM_MAGNET_RADIUS
  const elapsed = Number.isFinite(dt) && dt > 0 ? dt : 0
  const travel = XP_GEM_ATTRACT_SPEED * elapsed
  let collected = 0

  for (let i = pool.count - 1; i >= 0; i -= 1) {
    const x = pool.x[i]!
    const y = pool.y[i]!
    pool.prevX[i] = x
    pool.prevY[i] = y
    pool.age[i] = pool.age[i]! + elapsed

    const dx = playerX - x
    const dy = playerY - y
    const distanceSquared = dx * dx + dy * dy
    if (distanceSquared <= pickupRadiusSquared) {
      collected += pool.value[i]!
      removeXpGem(pool, i)
      continue
    }

    if (
      pool.attracted[i] === 0 &&
      (forceAttract ||
        pool.age[i]! >= XP_GEM_STALE_ATTRACT_AFTER ||
        distanceSquared <= magnetRadiusSquared)
    ) {
      pool.attracted[i] = 1
    }
    if (pool.attracted[i] === 0 || travel <= 0) continue

    const distance = Math.sqrt(distanceSquared)
    if (distance <= travel + XP_GEM_PICKUP_RADIUS) {
      collected += pool.value[i]!
      removeXpGem(pool, i)
      continue
    }

    const scale = travel / distance
    pool.x[i] = x + dx * scale
    pool.y[i] = y + dy * scale
  }

  return collected
}

function removeXpGem(pool: XpGemPool, index: number): void {
  const last = pool.count - 1
  if (index !== last) {
    pool.x[index] = pool.x[last]!
    pool.y[index] = pool.y[last]!
    pool.prevX[index] = pool.prevX[last]!
    pool.prevY[index] = pool.prevY[last]!
    pool.value[index] = pool.value[last]!
    pool.attracted[index] = pool.attracted[last]!
    pool.age[index] = pool.age[last]!
  }
  pool.count = last
}
