import assert from 'node:assert/strict'
import {
  BATTLEFIELD_BOMB_MAX_KILLS,
  BATTLEFIELD_HEAL_AMOUNT,
  BATTLEFIELD_MAGNET_DURATION,
  BATTLEFIELD_MAGNET_MAX_REMAINING,
  BATTLEFIELD_PICKUP_DROP_COOLDOWN,
  BATTLEFIELD_PICKUP_INITIAL_DELAY,
  BATTLEFIELD_PICKUP_LIFETIME,
  MAX_BATTLEFIELD_PICKUPS,
  PICKUP_BOMB,
  PICKUP_HEAL,
  PICKUP_MAGNET,
  collectedBattlefieldPickupCount,
  createBattlefieldPickupPool,
  dropBattlefieldPickup,
  nonBombKillTotal,
  resetBattlefieldPickupPool,
  stepBattlefieldPickups,
  tryDropBattlefieldPickup,
  type BattlefieldPickupKind,
} from '../src/sim/battlefield-pickups.ts'
import { damageEnemy, sweepDead } from '../src/sim/damage.ts'
import {
  TYPE_BOSS,
  TYPE_BRUTE,
  TYPE_ELITE,
  TYPE_RUSHER,
  TYPE_WALKER,
  spawnEnemy,
} from '../src/sim/enemies.ts'
import { createRng, type Rng } from '../src/sim/rng.ts'
import { createInput, type World } from '../src/sim/types.ts'
import { createWorld, stepWorld } from '../src/sim/world.ts'
import { dropXpGem } from '../src/sim/xp-gems.ts'

function sequenceRng(values: readonly number[]): Rng {
  let index = 0
  return {
    next() {
      const value = values[index]
      index += 1
      return value ?? 0
    },
    state() {
      return index
    },
  }
}

function addEnemy(
  world: World,
  type: number,
  x: number,
  y: number,
): number {
  spawnEnemy(world.enemies, world.rng, world.player.pos.x, world.player.pos.y, type)
  const index = world.enemies.count - 1
  world.enemies.x[index] = x
  world.enemies.y[index] = y
  world.enemies.prevX[index] = x
  world.enemies.prevY[index] = y
  return index
}

// Fixed storage, complete renderer state, invalid-input rejection, and
// deterministic oldest replacement at capacity.
{
  const pool = createBattlefieldPickupPool(2)
  assert.equal(dropBattlefieldPickup(pool, 1, 2, PICKUP_HEAL, 1), true)
  assert.equal(dropBattlefieldPickup(pool, 3, 4, PICKUP_MAGNET, 2), true)
  assert.equal(pool.count, 2)
  assert.deepEqual(Array.from(pool.x), [1, 3])
  assert.deepEqual(Array.from(pool.y), [2, 4])
  assert.deepEqual(Array.from(pool.kind), [PICKUP_HEAL, PICKUP_MAGNET])
  assert.deepEqual(Array.from(pool.spawnedAt), [1, 2])

  assert.equal(dropBattlefieldPickup(pool, 5, 6, PICKUP_BOMB, 3), true)
  assert.equal(pool.count, 2)
  assert.deepEqual(Array.from(pool.x), [5, 3])
  assert.deepEqual(Array.from(pool.kind), [PICKUP_BOMB, PICKUP_MAGNET])
  assert.deepEqual(Array.from(pool.spawnedAt), [3, 2])

  assert.equal(
    dropBattlefieldPickup(
      pool,
      Number.NaN,
      0,
      99 as BattlefieldPickupKind,
      4,
    ),
    false,
  )
  assert.equal(pool.count, 2)
}

// Opening delay, failed rolls, kind weights, and the hard successful-drop
// cooldown consume RNG only when their respective gates are reached.
{
  const pool = createBattlefieldPickupPool()
  const rng = sequenceRng([
    0,
    0.1, // heal
    0.99, // failed eligible roll
    0,
    0.65, // magnet
    0,
    0.95, // bomb
  ])

  assert.equal(
    tryDropBattlefieldPickup(
      pool,
      rng,
      BATTLEFIELD_PICKUP_INITIAL_DELAY - 0.01,
      0,
      0,
    ),
    -1,
  )
  assert.equal(rng.state(), 0)

  assert.equal(
    tryDropBattlefieldPickup(
      pool,
      rng,
      BATTLEFIELD_PICKUP_INITIAL_DELAY,
      1,
      0,
    ),
    PICKUP_HEAL,
  )
  const secondGate =
    BATTLEFIELD_PICKUP_INITIAL_DELAY + BATTLEFIELD_PICKUP_DROP_COOLDOWN
  assert.equal(pool.nextDropAt, secondGate)
  assert.equal(
    tryDropBattlefieldPickup(pool, rng, secondGate - 0.01, 2, 0),
    -1,
  )
  assert.equal(rng.state(), 2)

  assert.equal(tryDropBattlefieldPickup(pool, rng, secondGate, 2, 0), -1)
  assert.equal(pool.nextDropAt, secondGate)
  assert.equal(rng.state(), 3)

  assert.equal(
    tryDropBattlefieldPickup(pool, rng, secondGate + 0.01, 3, 0),
    PICKUP_MAGNET,
  )
  const thirdGate =
    secondGate + 0.01 + BATTLEFIELD_PICKUP_DROP_COOLDOWN
  assert.equal(
    tryDropBattlefieldPickup(pool, rng, thirdGate, 4, 0),
    PICKUP_BOMB,
  )
  assert.deepEqual(
    Array.from(pool.kind.subarray(0, pool.count)),
    [PICKUP_HEAL, PICKUP_MAGNET, PICKUP_BOMB],
  )
}

// Collection packs every kind without allocating and expiry removes untouched
// drops. Backing arrays remain stable.
{
  const pool = createBattlefieldPickupPool(4)
  const xStorage = pool.x
  const kindStorage = pool.kind
  dropBattlefieldPickup(pool, 0, 0, PICKUP_HEAL, 0)
  dropBattlefieldPickup(pool, 0.5, 0, PICKUP_MAGNET, 0)
  dropBattlefieldPickup(pool, 0, 0.5, PICKUP_BOMB, 0)

  const collected = stepBattlefieldPickups(pool, 0, 0, 0)
  assert.equal(collectedBattlefieldPickupCount(collected, PICKUP_HEAL), 1)
  assert.equal(collectedBattlefieldPickupCount(collected, PICKUP_MAGNET), 1)
  assert.equal(collectedBattlefieldPickupCount(collected, PICKUP_BOMB), 1)
  assert.equal(pool.count, 0)
  assert.strictEqual(pool.x, xStorage)
  assert.strictEqual(pool.kind, kindStorage)

  dropBattlefieldPickup(pool, 10, 10, PICKUP_HEAL, 0)
  assert.equal(
    stepBattlefieldPickups(pool, 0, 0, BATTLEFIELD_PICKUP_LIFETIME),
    0,
  )
  assert.equal(pool.count, 0)
}

// Reset reuses storage and clears scheduler/effect state.
{
  const pool = createBattlefieldPickupPool(3)
  const xStorage = pool.x
  dropBattlefieldPickup(pool, 1, 1, PICKUP_BOMB, 10)
  pool.nextDropAt = 100
  pool.magnetUntil = 80
  pool.healActivations = 2
  pool.magnetActivations = 3
  pool.bombActivations = 4
  pool.bombKills = 5

  resetBattlefieldPickupPool(pool)
  assert.strictEqual(pool.x, xStorage)
  assert.equal(pool.count, 0)
  assert.equal(pool.nextDropAt, BATTLEFIELD_PICKUP_INITIAL_DELAY)
  assert.equal(pool.magnetUntil, -1)
  assert.equal(pool.healActivations, 0)
  assert.equal(pool.magnetActivations, 0)
  assert.equal(pool.bombActivations, 0)
  assert.equal(pool.bombKills, 0)
  assert.deepEqual(Array.from(pool.x), [0, 0, 0])
}

// Healing stacks but never exceeds the current maximum HP.
{
  const world = createWorld(101, 'ranged')
  world.spawnEnabled = false
  world.player.hp = 10
  dropBattlefieldPickup(world.battlefieldPickups, 0, 0, PICKUP_HEAL, 0)
  stepWorld(world, createInput())
  assert.equal(world.player.hp, 10 + BATTLEFIELD_HEAL_AMOUNT)
  assert.equal(world.battlefieldPickups.healActivations, 1)

  world.player.hp = world.stats.maxHp - 5
  dropBattlefieldPickup(
    world.battlefieldPickups,
    world.player.pos.x,
    world.player.pos.y,
    PICKUP_HEAL,
    world.time,
  )
  dropBattlefieldPickup(
    world.battlefieldPickups,
    world.player.pos.x,
    world.player.pos.y,
    PICKUP_HEAL,
    world.time,
  )
  stepWorld(world, createInput())
  assert.equal(world.player.hp, world.stats.maxHp)
  assert.equal(world.battlefieldPickups.healActivations, 3)
}

// Magnet collection pulls existing and newly dropped XP from beyond the normal
// radius, while stacked duration is explicitly capped.
{
  const world = createWorld(202, 'ranged')
  world.spawnEnabled = false
  dropXpGem(world.xpGems, 20, 0, 3)
  dropBattlefieldPickup(world.battlefieldPickups, 0, 0, PICKUP_MAGNET, 0)
  dropBattlefieldPickup(world.battlefieldPickups, 0.2, 0, PICKUP_MAGNET, 0)

  stepWorld(world, createInput())
  assert.equal(world.battlefieldPickups.magnetActivations, 2)
  assert.equal(
    world.battlefieldPickups.magnetUntil,
    BATTLEFIELD_MAGNET_MAX_REMAINING,
  )
  assert.equal(world.xpGems.attracted[0], 1)
  assert.ok(world.xpGems.x[0]! < 20)

  dropXpGem(world.xpGems, -20, 0, 4)
  stepWorld(world, createInput())
  assert.equal(world.xpGems.attracted[1], 1)
  assert.ok(world.xpGems.x[1]! > -20)
  assert.ok(
    world.battlefieldPickups.magnetUntil - world.time <=
      BATTLEFIELD_MAGNET_MAX_REMAINING,
  )
  assert.ok(
    world.battlefieldPickups.magnetUntil - world.time >=
      BATTLEFIELD_MAGNET_DURATION,
  )
}

// Bombs clear ordinary enemies through the normal damage gateway, grant their
// XP, suppress recursive utility drops, and leave elite/relic/boss paths alone.
{
  const world = createWorld(303, 'ranged')
  world.spawnEnabled = false
  world.player.invulnUntil = Number.POSITIVE_INFINITY
  addEnemy(world, TYPE_WALKER, 10, 0)
  addEnemy(world, TYPE_RUSHER, 11, 0)
  addEnemy(world, TYPE_BRUTE, 12, 0)
  const elite = addEnemy(world, TYPE_ELITE, 20, 0)
  const boss = addEnemy(world, TYPE_BOSS, 22, 0)
  const eliteHp = world.enemies.hp[elite]!
  const bossHp = world.enemies.hp[boss]!

  world.battlefieldPickups.nextDropAt = 0
  world.pickupRng = sequenceRng([0, 0.1])
  dropBattlefieldPickup(world.battlefieldPickups, 0, 0, PICKUP_BOMB, 0)
  stepWorld(world, createInput())

  assert.equal(world.kills, 3)
  assert.equal(world.xpGems.count, 3)
  assert.equal(world.battlefieldPickups.count, 0)
  assert.equal(world.battlefieldPickups.bombActivations, 1)
  assert.equal(world.battlefieldPickups.bombKills, 3)
  assert.equal(
    nonBombKillTotal(
      world.kills,
      world.battlefieldPickups.bombKills,
    ),
    0,
  )
  assert.equal(world.pickupRng.state(), 0)
  assert.equal(world.enemies.count, 2)
  assert.deepEqual(
    Array.from(world.enemies.type.subarray(0, world.enemies.count)).sort(),
    [TYPE_BOSS, TYPE_ELITE].sort(),
  )
  const remainingElite = Array.from(
    world.enemies.type.subarray(0, world.enemies.count),
  ).indexOf(TYPE_ELITE)
  const remainingBoss = Array.from(
    world.enemies.type.subarray(0, world.enemies.count),
  ).indexOf(TYPE_BOSS)
  assert.equal(world.enemies.hp[remainingElite], eliteHp)
  assert.equal(world.enemies.hp[remainingBoss], bossHp)
  assert.equal(world.relicDrops.length, 0)
  assert.equal(world.outcome, 'alive')
}

// One bomb activation has a strict work/kill cap.
{
  const world = createWorld(404, 'melee')
  world.spawnEnabled = false
  world.player.invulnUntil = Number.POSITIVE_INFINITY
  for (let i = 0; i < BATTLEFIELD_BOMB_MAX_KILLS + 5; i += 1) {
    addEnemy(world, TYPE_WALKER, 10, i * 0.01)
  }
  dropBattlefieldPickup(world.battlefieldPickups, 0, 0, PICKUP_BOMB, 0)
  stepWorld(world, createInput())
  assert.equal(world.kills, BATTLEFIELD_BOMB_MAX_KILLS)
  assert.equal(world.battlefieldPickups.bombKills, BATTLEFIELD_BOMB_MAX_KILLS)
  assert.equal(world.enemies.count, 5)
}

// 한 고정 틱에 폭탄 상한과 일반 평타 처치가 함께 일어나도 직접 처치 하나는
// cadence 누적값에 남는다. 렌더 프레임 단위 합산으로도 출처가 섞이지 않는다.
{
  const world = createWorld(405, 'ranged')
  world.spawnEnabled = false
  world.player.invulnUntil = Number.POSITIVE_INFINITY
  const directTarget = addEnemy(world, TYPE_WALKER, 1, 0)
  world.enemies.hp[directTarget] = 1
  world.enemies.maxHp[directTarget] = 1
  for (let i = 0; i < BATTLEFIELD_BOMB_MAX_KILLS; i += 1) {
    addEnemy(world, TYPE_WALKER, 10, i * 0.01)
  }
  dropBattlefieldPickup(world.battlefieldPickups, 0, 0, PICKUP_BOMB, 0)

  stepWorld(world, createInput())

  assert.equal(world.kills, BATTLEFIELD_BOMB_MAX_KILLS + 1)
  assert.equal(world.battlefieldPickups.bombKills, BATTLEFIELD_BOMB_MAX_KILLS)
  assert.equal(
    nonBombKillTotal(
      world.kills,
      world.battlefieldPickups.bombKills,
    ),
    1,
  )
}

// Only ordinary direct kills roll utility drops; elite and boss deaths keep
// their authored rewards/outcomes and do not consume pickup RNG.
{
  const ordinary = createWorld(505)
  ordinary.spawnEnabled = false
  ordinary.time = BATTLEFIELD_PICKUP_INITIAL_DELAY
  ordinary.battlefieldPickups.nextDropAt = 0
  ordinary.pickupRng = sequenceRng([0, 0.1])
  const ordinaryIndex = addEnemy(ordinary, TYPE_WALKER, 5, 0)
  damageEnemy(ordinary, ordinaryIndex, ordinary.enemies.hp[ordinaryIndex]!)
  assert.equal(ordinary.battlefieldPickups.count, 1)
  assert.equal(ordinary.battlefieldPickups.kind[0], PICKUP_HEAL)
  assert.equal(ordinary.pickupRng.state(), 2)

  const eliteWorld = createWorld(506)
  eliteWorld.spawnEnabled = false
  eliteWorld.time = BATTLEFIELD_PICKUP_INITIAL_DELAY
  eliteWorld.battlefieldPickups.nextDropAt = 0
  eliteWorld.pickupRng = sequenceRng([0, 0.1])
  const eliteIndex = addEnemy(eliteWorld, TYPE_ELITE, 5, 0)
  damageEnemy(eliteWorld, eliteIndex, eliteWorld.enemies.hp[eliteIndex]!)
  assert.equal(eliteWorld.battlefieldPickups.count, 0)
  assert.equal(eliteWorld.pickupRng.state(), 0)
  assert.equal(eliteWorld.relicDrops.length, 1)

  const bossWorld = createWorld(507)
  bossWorld.spawnEnabled = false
  bossWorld.time = BATTLEFIELD_PICKUP_INITIAL_DELAY
  bossWorld.battlefieldPickups.nextDropAt = 0
  bossWorld.pickupRng = sequenceRng([0, 0.1])
  const bossIndex = addEnemy(bossWorld, TYPE_BOSS, 5, 0)
  while (bossWorld.enemies.hp[bossIndex]! > 0) {
    damageEnemy(bossWorld, bossIndex, bossWorld.enemies.maxHp[bossIndex]!)
  }
  assert.equal(bossWorld.battlefieldPickups.count, 0)
  assert.equal(bossWorld.pickupRng.state(), 0)
  assert.equal(bossWorld.outcome, 'victory')
}

// Dedicated RNG preserves the primary spawn stream, while identical seeds and
// kill streams produce byte-identical pickup state.
{
  const a = createWorld(606)
  const b = createWorld(606)
  a.spawnEnabled = false
  b.spawnEnabled = false

  for (let kill = 0; kill < 220; kill += 1) {
    const time = BATTLEFIELD_PICKUP_INITIAL_DELAY + kill * 0.5
    a.time = time
    b.time = time
    const ax = ((kill * 13) % 21) - 10
    const ay = ((kill * 7) % 17) - 8
    const ai = addEnemy(a, TYPE_WALKER, ax, ay)
    const bi = addEnemy(b, TYPE_WALKER, ax, ay)
    damageEnemy(a, ai, a.enemies.hp[ai]!)
    damageEnemy(b, bi, b.enemies.hp[bi]!)
    sweepDead(a)
    sweepDead(b)
  }

  assert.equal(a.rng.state(), b.rng.state())
  assert.equal(a.pickupRng.state(), b.pickupRng.state())
  assert.equal(a.battlefieldPickups.count, b.battlefieldPickups.count)
  assert.equal(
    a.battlefieldPickups.nextDropAt,
    b.battlefieldPickups.nextDropAt,
  )
  assert.deepEqual(a.battlefieldPickups.x, b.battlefieldPickups.x)
  assert.deepEqual(a.battlefieldPickups.y, b.battlefieldPickups.y)
  assert.deepEqual(a.battlefieldPickups.kind, b.battlefieldPickups.kind)
  assert.deepEqual(
    a.battlefieldPickups.spawnedAt,
    b.battlefieldPickups.spawnedAt,
  )

  const isolated = createWorld(606)
  const primaryState = isolated.rng.state()
  isolated.time = BATTLEFIELD_PICKUP_INITIAL_DELAY
  isolated.battlefieldPickups.nextDropAt = 0
  isolated.pickupRng = createRng(1)
  const index = addEnemy(isolated, TYPE_WALKER, 0, 0)
  const stateAfterSpawn = isolated.rng.state()
  assert.notEqual(stateAfterSpawn, primaryState)
  damageEnemy(isolated, index, isolated.enemies.hp[index]!)
  assert.equal(isolated.rng.state(), stateAfterSpawn)
}

// Public default remains bounded even under direct stress.
{
  const pool = createBattlefieldPickupPool()
  for (let i = 0; i < MAX_BATTLEFIELD_PICKUPS + 20; i += 1) {
    dropBattlefieldPickup(
      pool,
      i,
      -i,
      (i % 3) as BattlefieldPickupKind,
      i,
    )
  }
  assert.equal(pool.count, MAX_BATTLEFIELD_PICKUPS)
}

console.log('battlefield-pickup-check: ok')
