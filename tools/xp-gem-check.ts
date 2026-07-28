import assert from 'node:assert/strict'
import { DT } from '../src/sim/constants.ts'
import { damageEnemy, sweepDead } from '../src/sim/damage.ts'
import { ENEMY_TYPES, TYPE_WALKER, spawnEnemy } from '../src/sim/enemies.ts'
import { RANGED_XP_GAIN_MULTIPLIER } from '../src/sim/progression.ts'
import { createInput } from '../src/sim/types.ts'
import { createWorld, stepWorld } from '../src/sim/world.ts'
import {
  MAX_XP_GEMS,
  XP_GEM_ATTRACT_SPEED,
  XP_GEM_MAGNET_RADIUS,
  createXpGemPool,
  dropXpGem,
  resetXpGemPool,
  stepXpGems,
  type XpGemPool,
} from '../src/sim/xp-gems.ts'

function approximatelyEqual(actual: number, expected: number, label: string): void {
  assert.ok(
    Math.abs(actual - expected) <= 1e-6,
    `${label}: expected ${expected}, got ${actual}`,
  )
}

function totalValue(pool: XpGemPool): number {
  let total = 0
  for (let i = 0; i < pool.count; i += 1) total += pool.value[i]!
  return total
}

// Drop state is complete enough for immediate renderer interpolation.
{
  const pool = createXpGemPool(4)
  assert.equal(dropXpGem(pool, 3, -2, 4), true)
  assert.equal(pool.count, 1)
  assert.equal(pool.x[0], 3)
  assert.equal(pool.y[0], -2)
  assert.equal(pool.prevX[0], 3)
  assert.equal(pool.prevY[0], -2)
  assert.equal(pool.value[0], 4)
  assert.equal(pool.attracted[0], 0)
  assert.equal(dropXpGem(pool, 0, 0, 0), false)
  assert.equal(pool.count, 1)
}

// A nearby gem latches, moves at the fixed speed, and keeps chasing after the
// player leaves the original magnet radius.
{
  const pool = createXpGemPool()
  dropXpGem(pool, 5, 0, 2)
  const collectedFirst = stepXpGems(pool, 0, 0, 0.1)
  assert.equal(collectedFirst, 0)
  assert.equal(pool.count, 1)
  assert.equal(pool.attracted[0], 1)
  assert.equal(pool.prevX[0], 5)
  approximatelyEqual(
    pool.x[0]!,
    5 - XP_GEM_ATTRACT_SPEED * 0.1,
    'attraction displacement',
  )

  const beforeLatchChase = pool.x[0]!
  const collectedSecond = stepXpGems(pool, 100, 0, 0.1)
  assert.equal(collectedSecond, 0)
  assert.ok(pool.x[0]! > beforeLatchChase, 'latched gem keeps chasing outside radius')

  const outside = createXpGemPool()
  dropXpGem(outside, XP_GEM_MAGNET_RADIUS + 1, 0, 1)
  stepXpGems(outside, 0, 0, 0.1)
  assert.equal(outside.x[0], XP_GEM_MAGNET_RADIUS + 1)
  assert.equal(outside.attracted[0], 0)
}

// Pickup consumes the gem exactly once and returns its raw XP.
{
  const pool = createXpGemPool()
  dropXpGem(pool, 0.5, 0, 2.5)
  assert.equal(stepXpGems(pool, 0, 0, DT), 2.5)
  assert.equal(pool.count, 0)
  assert.equal(stepXpGems(pool, 0, 0, DT), 0)
}

// Capacity overflow preserves XP and resolves nearest/equal-distance choices
// deterministically.
{
  const pool = createXpGemPool(3)
  dropXpGem(pool, -4, 0, 1)
  dropXpGem(pool, 0, 0, 2)
  dropXpGem(pool, 4, 0, 3)
  dropXpGem(pool, 3.9, 0, 7)
  assert.equal(pool.count, 3)
  assert.equal(pool.value[2], 10)
  assert.equal(totalValue(pool), 13)

  const tied = createXpGemPool(2)
  dropXpGem(tied, -1, 0, 1)
  dropXpGem(tied, 1, 0, 2)
  dropXpGem(tied, 0, 0, 5)
  assert.equal(tied.value[0], 6)
  assert.equal(tied.value[1], 2)

  const defaultPool = createXpGemPool()
  for (let i = 0; i < MAX_XP_GEMS + 40; i += 1) {
    dropXpGem(defaultPool, i % 23, Math.floor(i / 23), 1)
  }
  assert.equal(defaultPool.count, MAX_XP_GEMS)
  assert.equal(totalValue(defaultPool), MAX_XP_GEMS + 40)
}

// Reset retains the allocated storage but clears every observable state field.
{
  const pool = createXpGemPool(4)
  const xStorage = pool.x
  const attractedStorage = pool.attracted
  dropXpGem(pool, 5, 0, 3)
  stepXpGems(pool, 0, 0, 0)
  assert.equal(pool.attracted[0], 1)

  resetXpGemPool(pool)
  assert.equal(pool.count, 0)
  assert.strictEqual(pool.x, xStorage)
  assert.strictEqual(pool.attracted, attractedStorage)
  assert.deepEqual(Array.from(pool.x), [0, 0, 0, 0])
  assert.deepEqual(Array.from(pool.value), [0, 0, 0, 0])
  assert.deepEqual(Array.from(pool.attracted), [0, 0, 0, 0])

  dropXpGem(pool, -3, 2, 6)
  assert.equal(pool.count, 1)
  assert.equal(pool.prevX[0], -3)
  assert.equal(pool.prevY[0], 2)
  assert.equal(pool.value[0], 6)
  assert.equal(pool.attracted[0], 0)
}

// Enemy death creates a world drop instead of granting XP. Collection applies
// the class multiplier through the normal progression gateway.
{
  const world = createWorld(1234, 'ranged')
  world.spawnEnabled = false
  spawnEnemy(world.enemies, world.rng, 0, 0, TYPE_WALKER)
  const enemyIndex = world.enemies.count - 1
  world.enemies.x[enemyIndex] = 0.5
  world.enemies.y[enemyIndex] = 0
  world.enemies.prevX[enemyIndex] = 0.5
  world.enemies.prevY[enemyIndex] = 0

  damageEnemy(world, enemyIndex, world.enemies.hp[enemyIndex]!)
  assert.equal(world.progression.totalXp, 0)
  assert.equal(world.xpGems.count, 1)
  assert.equal(world.xpGems.value[0], ENEMY_TYPES[TYPE_WALKER]!.xp)
  sweepDead(world)

  stepWorld(world, createInput())
  assert.equal(world.xpGems.count, 0)
  approximatelyEqual(
    world.progression.totalXp,
    ENEMY_TYPES[TYPE_WALKER]!.xp * RANGED_XP_GAIN_MULTIPLIER,
    'collected world XP',
  )
}

// Identical drop and movement streams remain byte-for-byte deterministic, and
// stepping never replaces the fixed backing arrays.
{
  const a = createXpGemPool(8)
  const b = createXpGemPool(8)
  const aX = a.x
  const aValue = a.value

  for (let i = 0; i < 20; i += 1) {
    const x = ((i * 17) % 19) - 9
    const y = ((i * 11) % 13) - 6
    const value = (i % 4) + 1
    dropXpGem(a, x, y, value)
    dropXpGem(b, x, y, value)
  }

  for (let tick = 0; tick < 45; tick += 1) {
    const playerX = Math.sin(tick * 0.17) * 12
    const playerY = Math.cos(tick * 0.11) * 8
    assert.equal(
      stepXpGems(a, playerX, playerY, DT),
      stepXpGems(b, playerX, playerY, DT),
    )
  }

  assert.strictEqual(a.x, aX)
  assert.strictEqual(a.value, aValue)
  assert.equal(a.count, b.count)
  assert.deepEqual(a.x, b.x)
  assert.deepEqual(a.y, b.y)
  assert.deepEqual(a.prevX, b.prevX)
  assert.deepEqual(a.prevY, b.prevY)
  assert.deepEqual(a.value, b.value)
  assert.deepEqual(a.attracted, b.attracted)
}

console.log('xp-gem-check: ok')
