import assert from 'node:assert/strict'

import { ARENA_RADIUS, PLAYER_RADIUS } from '../src/sim/constants.ts'
import { damageEnemy } from '../src/sim/damage.ts'
import {
  ENEMY_TYPES,
  MAX_ENEMIES,
  MIN_ENEMY_SPAWN_DISTANCE,
  TYPE_RUSHER,
  TYPE_WALKER,
  enemyHealthMultiplier,
  removeEnemy,
  spawnEnemy,
  spawnEnemyAtAngle,
} from '../src/sim/enemies.ts'
import {
  SURGE_BEATS,
  SURGE_CONTACT_DAMAGE_SCALE,
  SURGE_HEALTH_SCALE,
  SURGE_WARNING_DURATION,
  SURGE_XP_SCALE,
  stepSurgeBeats,
  surgeAngle,
} from '../src/sim/surges.ts'
import { createWorld } from '../src/sim/world.ts'

const EPSILON = 1e-5

function setBeatTime(
  world: ReturnType<typeof createWorld>,
  seconds: number,
): void {
  world.time = seconds
  world.tick = Math.round(seconds * 60)
}

// Warning and spawn thresholds are exact, one-shot, and do not consume the
// normal spawn RNG stream.
{
  const world = createWorld(0x12345678)
  world.spawnEnabled = false
  const first = SURGE_BEATS[0]!
  const rngBefore = world.rng.state()

  setBeatTime(world, first.at - SURGE_WARNING_DURATION - 0.02)
  stepSurgeBeats(world)
  assert.equal(world.surgeWarningIndex, 0)
  assert.equal(world.surgeBeatIndex, 0)
  assert.equal(world.enemies.count, 0)

  setBeatTime(world, first.at - SURGE_WARNING_DURATION)
  stepSurgeBeats(world)
  assert.equal(world.surgeWarningIndex, 1)
  assert.equal(world.surgeBeatIndex, 0)
  assert.ok(world.rings.some((ring) => ring.kind === 4))

  const ringCount = world.rings.length
  stepSurgeBeats(world)
  assert.equal(world.surgeWarningIndex, 1)
  assert.equal(world.rings.length, ringCount)

  setBeatTime(world, first.at)
  stepSurgeBeats(world)
  assert.equal(world.surgeBeatIndex, 1)
  assert.equal(world.enemies.count, first.count)
  assert.equal(world.surgeStartedAt, first.at)
  assert.equal(world.rng.state(), rngBefore)

  stepSurgeBeats(world)
  assert.equal(world.surgeBeatIndex, 1)
  assert.equal(world.enemies.count, first.count)
}

// Every authored formation keeps its identity, reward/threat contract, safe player
// distance, arena bound, and unique coordinates across seeds and rim positions.
{
  const reachableRadius = ARENA_RADIUS - PLAYER_RADIUS
  const positions: Array<readonly [number, number]> = [[0, 0]]
  for (let direction = 0; direction < 64; direction += 1) {
    const angle = (direction / 64) * Math.PI * 2
    positions.push([
      Math.cos(angle) * reachableRadius,
      Math.sin(angle) * reachableRadius,
    ])
  }

  for (let seed = 0; seed < 256; seed += 1) {
    for (let beatIndex = 0; beatIndex < SURGE_BEATS.length; beatIndex += 1) {
      const beat = SURGE_BEATS[beatIndex]!
      for (const [px, py] of positions) {
        const world = createWorld(seed)
        world.spawnEnabled = false
        world.player.pos.x = px
        world.player.pos.y = py
        world.player.prevPos.x = px
        world.player.prevPos.y = py
        world.surgeBeatIndex = beatIndex
        world.surgeWarningIndex = beatIndex
        setBeatTime(world, beat.at)
        const rngBefore = world.rng.state()

        stepSurgeBeats(world)

        assert.equal(
          world.surgeBeatIndex,
          beatIndex + 1,
          `beat ${beatIndex} seed ${seed}: formation retry at ${px},${py}`,
        )
        assert.equal(world.enemies.count, beat.count)
        assert.equal(world.rng.state(), rngBefore)
        const expectedType = beatIndex === 1 ? TYPE_RUSHER : TYPE_WALKER
        const seen = new Set<string>()
        for (let i = 0; i < world.enemies.count; i += 1) {
          assert.equal(world.enemies.type[i], expectedType)
          assert.ok(
            Math.abs(world.enemies.xpScale[i]! - SURGE_XP_SCALE) < EPSILON,
          )
          assert.ok(
            Math.abs(
              world.enemies.contactDamageScale[i]! -
                SURGE_CONTACT_DAMAGE_SCALE,
            ) < EPSILON,
          )
          assert.ok(
            Math.abs(
              world.enemies.maxHp[i]! -
                ENEMY_TYPES[expectedType]!.hp *
                  SURGE_HEALTH_SCALE *
                  enemyHealthMultiplier(beat.at),
            ) < EPSILON,
          )

          const x = world.enemies.x[i]!
          const y = world.enemies.y[i]!
          const playerDistance = Math.hypot(x - px, y - py)
          const arenaLimit =
            ARENA_RADIUS - ENEMY_TYPES[expectedType]!.radius - 0.5
          assert.ok(
            playerDistance + EPSILON >= MIN_ENEMY_SPAWN_DISTANCE,
            `beat ${beatIndex} seed ${seed}: unsafe ${playerDistance}`,
          )
          assert.ok(
            Math.hypot(x, y) <= arenaLimit + EPSILON,
            `beat ${beatIndex} seed ${seed}: outside arena`,
          )

          const key = `${x.toFixed(5)},${y.toFixed(5)}`
          assert.ok(
            !seen.has(key),
            `beat ${beatIndex} seed ${seed}: duplicate ${key}`,
          )
          seen.add(key)

          for (let j = 0; j < i; j += 1) {
            const bodyDistance = Math.hypot(
              x - world.enemies.x[j]!,
              y - world.enemies.y[j]!,
            )
            const minimumBodyDistance =
              ENEMY_TYPES[expectedType]!.radius +
              ENEMY_TYPES[world.enemies.type[j]!]!.radius
            assert.ok(
              bodyDistance + EPSILON >= minimumBodyDistance,
              `beat ${beatIndex} seed ${seed}: body overlap ` +
                `${j}/${i} at ${bodyDistance}`,
            )
          }
        }
      }
    }
  }
}

// A full pool cannot produce a partial formation. Once room is available the
// whole beat retries atomically.
{
  const world = createWorld(77)
  world.spawnEnabled = false
  const beat = SURGE_BEATS[0]!
  world.enemies.count = MAX_ENEMIES - beat.count + 1
  setBeatTime(world, beat.at)
  stepSurgeBeats(world)
  assert.equal(world.surgeBeatIndex, 0)
  assert.equal(world.enemies.count, MAX_ENEMIES - beat.count + 1)

  world.enemies.count = 0
  stepSurgeBeats(world)
  assert.equal(world.surgeBeatIndex, 1)
  assert.equal(world.enemies.count, beat.count)
}

// Normal enemies retain full XP, surge enemies drop reduced XP, and swap-remove
// carries the per-instance multiplier with the rest of the SoA slot.
{
  const world = createWorld(91)
  world.spawnEnabled = false
  spawnEnemy(
    world.enemies,
    world.rng,
    world.player.pos.x,
    world.player.pos.y,
    TYPE_WALKER,
    0,
  )
  assert.equal(world.enemies.xpScale[0], 1)

  assert.equal(
    spawnEnemyAtAngle(
      world.enemies,
      0,
      0,
      TYPE_WALKER,
      0,
      surgeAngle(world.seed, 0),
      14,
      SURGE_XP_SCALE,
      SURGE_HEALTH_SCALE,
      SURGE_CONTACT_DAMAGE_SCALE,
    ),
    true,
  )
  assert.ok(Math.abs(world.enemies.xpScale[1]! - SURGE_XP_SCALE) < EPSILON)
  assert.ok(
    Math.abs(
      world.enemies.contactDamageScale[1]! - SURGE_CONTACT_DAMAGE_SCALE,
    ) < EPSILON,
  )
  removeEnemy(world.enemies, 0)
  assert.ok(Math.abs(world.enemies.xpScale[0]! - SURGE_XP_SCALE) < EPSILON)
  assert.ok(
    Math.abs(
      world.enemies.contactDamageScale[0]! - SURGE_CONTACT_DAMAGE_SCALE,
    ) < EPSILON,
  )

  damageEnemy(world, 0, world.enemies.hp[0]!)
  assert.equal(world.xpGems.count, 1)
  assert.ok(
    Math.abs(
      world.xpGems.value[0]! -
        ENEMY_TYPES[TYPE_WALKER]!.xp * SURGE_XP_SCALE,
    ) < EPSILON,
  )
}

console.log('surge-check: ok')
