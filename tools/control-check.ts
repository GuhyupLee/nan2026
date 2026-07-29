import assert from 'node:assert/strict'
import { applyPointerMove, type InputState } from '../src/input.ts'
import {
  PLAYER_ACTION_BUFFER_WINDOW,
} from '../src/sim/actions.ts'
import {
  RANGED_W_DASH_END,
  RANGED_W_DASH_START,
} from '../src/sim/action-timing.ts'
import { DT } from '../src/sim/constants.ts'
import {
  TYPE_WALKER,
  rebuildEnemyHash,
  spawnEnemy,
} from '../src/sim/enemies.ts'
import { castSkill } from '../src/sim/kits.ts'
import { SKILL_BIT, unlockSkill } from '../src/sim/skills.ts'
import {
  resolveTargeting,
  type TargetingSolution,
} from '../src/sim/targeting.ts'
import {
  createInput,
  type Input,
  type World,
} from '../src/sim/types.ts'
import { createWorld, stepWorld } from '../src/sim/world.ts'

const EPSILON = 1e-6

function approx(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `${message}: expected ${expected}, received ${actual}`,
  )
}

function solution(): TargetingSolution {
  return {
    x: 0,
    y: 0,
    angle: 0,
    distance: 0,
    snapped: false,
  }
}

function idleAt(x = 10, y = 0): Input {
  const input = createInput()
  input.aim.x = x
  input.aim.y = y
  return input
}

function addTarget(
  world: World,
  x: number,
  y: number,
  hp = 10_000,
): number {
  spawnEnemy(
    world.enemies,
    world.rng,
    world.player.pos.x,
    world.player.pos.y,
    TYPE_WALKER,
  )
  const index = world.enemies.count - 1
  world.enemies.x[index] = x
  world.enemies.y[index] = y
  world.enemies.prevX[index] = x
  world.enemies.prevY[index] = y
  world.enemies.hp[index] = hp
  world.enemies.maxHp[index] = hp
  world.enemies.rootUntil[index] = Number.POSITIVE_INFINITY
  return index
}

function stepUntil(
  world: World,
  predicate: () => boolean,
  input = idleAt(),
  maxTicks = 240,
): void {
  for (let tick = 0; tick < maxTicks && !predicate(); tick += 1) {
    stepWorld(world, input)
  }
  assert.ok(predicate(), `condition was not met within ${maxTicks} ticks`)
}

// Targeting contracts: ranged Q is self-cast, while ranged W travels toward
// the cursor and its destination never escapes the arena.
{
  const world = createWorld(9_001, 'ranged')
  world.spawnEnabled = false
  world.player.pos.x = 2
  world.player.pos.y = -3

  const q = resolveTargeting(world, 'q', solution(), 99, 99)
  approx(q.x, 2, 'ranged Q targets the player x')
  approx(q.y, -3, 'ranged Q targets the player y')
  approx(q.distance, 0, 'ranged Q has no ground-target distance')

  world.player.pos.x = 0
  world.player.pos.y = 0
  const forward = resolveTargeting(world, 'w', solution(), 0, 20)
  approx(forward.x, 0, 'ranged W preserves cursor x direction')
  approx(forward.y, 8, 'ranged W advances toward the cursor')
  approx(forward.angle, Math.PI / 2, 'ranged W faces toward the cursor')

  const limit = world.arenaRadius - world.stats.radius
  world.player.pos.x = limit - 0.5
  world.player.pos.y = 0
  const clamped = resolveTargeting(world, 'w', solution(), limit + 100, 0)
  approx(clamped.x, limit, 'ranged W clamps to the arena boundary')
  approx(clamped.y, 0, 'ranged W boundary clamp preserves its axis')
  assert.ok(clamped.distance > 0, 'ranged W still moves toward an outward cursor')
}

// Aim assist is deliberately weak and optional: the same point cast remains
// literal while disabled, then snaps to a nearby valid enemy while enabled.
{
  const world = createWorld(9_002, 'ranged')
  world.spawnEnabled = false
  const target = addTarget(world, 10, 1.2)
  rebuildEnemyHash(world.enemies, world.enemyHash)

  world.aimAssistEnabled = false
  const literal = resolveTargeting(world, 'e', solution(), 10, 0)
  approx(literal.x, 10, 'aim assist off keeps raw point x')
  approx(literal.y, 0, 'aim assist off keeps raw point y')
  assert.equal(literal.snapped, false)

  world.aimAssistEnabled = true
  const assisted = resolveTargeting(world, 'e', solution(), 10, 0)
  approx(assisted.x, world.enemies.x[target]!, 'aim assist snaps point x')
  approx(assisted.y, world.enemies.y[target]!, 'aim assist snaps point y')
  assert.equal(assisted.snapped, true)
}

// Mouse-to-move eases into its destination instead of crossing it at full
// speed. This exercises the pure movement calculation without constructing DOM.
{
  const pointer = {
    pointerHeld: true,
    applyTouchMove: () => false,
  } as unknown as InputState
  const player = { x: 0, y: 0 }

  const stopped = idleAt(0.4, 0)
  applyPointerMove(pointer, stopped, player)
  approx(Math.hypot(stopped.move.x, stopped.move.y), 0, 'arrival stop radius')

  const eased = idleAt(1.5, 0)
  applyPointerMove(pointer, eased, player)
  const easedMagnitude = Math.hypot(eased.move.x, eased.move.y)
  assert.ok(easedMagnitude > 0 && easedMagnitude < 1, 'arrival zone scales movement')

  const full = idleAt(4, 0)
  applyPointerMove(pointer, full, player)
  approx(Math.hypot(full.move.x, full.move.y), 1, 'far movement remains full speed')
}

// Simultaneous QWER input respects the recorded key order rather than the
// fallback Q-W-E-R bit order.
{
  const world = createWorld(9_003, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(world.skills, 'q', 1)
  unlockSkill(world.skills, 'w', 1)

  const ordered = idleAt(12, 0)
  ordered.skillsPressed = SKILL_BIT.w | SKILL_BIT.q
  ordered.skillSequence = ['w', 'q']
  stepWorld(world, ordered)

  assert.equal(world.actionStarts[0]?.kind, 'w', 'FIFO starts W before Q')
  assert.equal(world.bufferedSkill?.slot, 'q', 'FIFO reserves Q second')
  stepUntil(
    world,
    () => world.actionStarts.some((event) => event.kind === 'q'),
  )
  assert.deepEqual(
    world.actionStarts
      .filter((event) => event.kind === 'w' || event.kind === 'q')
      .map((event) => event.kind),
    ['w', 'q'],
  )
}

// An input in the final recovery window is held until the current action ends,
// then begins on the next available simulation tick.
{
  const world = createWorld(9_004, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(world.skills, 'q', 1)
  unlockSkill(world.skills, 'w', 1)
  world.lastAim.x = 10

  assert.equal(castSkill(world, 'q'), true)
  const qEnd = world.playerAction!.endAt
  stepUntil(
    world,
    () =>
      world.playerAction !== null &&
      world.playerAction.endAt - world.time <=
        PLAYER_ACTION_BUFFER_WINDOW - DT,
  )

  const buffered = idleAt()
  buffered.skillsPressed = SKILL_BIT.w
  buffered.skillSequence = ['w']
  stepWorld(world, buffered)
  assert.equal(world.bufferedSkill?.slot, 'w')
  assert.equal(
    world.actionStarts.some((event) => event.kind === 'w'),
    false,
    'buffered W does not cancel Q recovery',
  )

  stepUntil(
    world,
    () => world.actionStarts.some((event) => event.kind === 'w'),
  )
  const wStart = world.actionStarts.find((event) => event.kind === 'w')!
  assert.ok(wStart.startedAt >= qEnd)
  assert.ok(wStart.startedAt - qEnd <= DT + EPSILON)
}

// Flash at a blocked boundary does not spend its cooldown.
{
  const world = createWorld(9_005, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  const limit = world.arenaRadius - world.stats.radius
  world.player.pos.x = limit
  world.player.prevPos.x = limit
  const input = idleAt(limit + 20, 0)
  input.skillsPressed = SKILL_BIT.f
  input.skillSequence = ['f']

  stepWorld(world, input)
  approx(world.player.pos.x, limit, 'blocked flash keeps player at boundary')
  approx(world.skills.f.cooldown, 0, 'blocked flash preserves cooldown')
}

// The melee ultimate owns movement while active, so F is rejected without
// consuming its cooldown.
{
  const world = createWorld(9_006, 'melee')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(world.skills, 'r', 1)
  world.lastAim.x = 10
  assert.equal(castSkill(world, 'r'), true)
  stepUntil(world, () => world.ult.active)

  const before = world.skills.f.cooldown
  const flash = idleAt(8, 0)
  flash.skillsPressed = SKILL_BIT.f
  flash.skillSequence = ['f']
  stepWorld(world, flash)
  assert.equal(world.ult.active, true, 'melee R remains active')
  approx(world.skills.f.cooldown, before, 'F during melee R preserves cooldown')
}

// Ranged W starts in place, crosses the path over multiple ticks, and reaches
// the cursor-facing destination at the authored dash end.
{
  const world = createWorld(9_007, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(world.skills, 'w', 1)
  world.lastAim.x = 20
  world.lastAim.y = 0
  assert.equal(castSkill(world, 'w'), true)

  const action = world.playerAction!
  const dash = action.skillDash!
  approx(dash.destinationX, 8, 'ranged W destination follows cursor direction')
  approx(world.player.pos.x, 0, 'ranged W does not teleport on cast')
  approx(
    world.player.rangedDashInvulnUntil,
    0.55,
    'ranged W exposes its full guard duration to the HUD',
  )

  stepWorld(world, idleAt(20, 0))
  approx(world.player.pos.x, 0, 'ranged W first tick remains in prepare phase')

  const midpoint =
    action.startedAt + (RANGED_W_DASH_START + RANGED_W_DASH_END) * 0.5
  stepUntil(world, () => world.time >= midpoint)
  assert.ok(
    world.player.pos.x > dash.originX &&
      world.player.pos.x < dash.destinationX,
    'ranged W interpolates through the middle of its path',
  )

  stepUntil(
    world,
    () => world.time >= action.startedAt + RANGED_W_DASH_END,
  )
  approx(
    world.player.pos.x,
    dash.destinationX,
    'ranged W reaches destination x',
  )
  approx(
    world.player.pos.y,
    dash.destinationY,
    'ranged W reaches destination y',
  )
  assert.ok(
    world.player.rangedDashInvulnUntil > world.time,
    'ranged W guard outlasts movement for the residual HUD state',
  )
}

// F may cancel W's remaining movement, but it must not rewrite the authored
// W path. The departure lens and cast FX stay at the original W origin/target.
{
  const world = createWorld(9_008, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(world.skills, 'w', 1)
  world.lastAim.x = 20
  world.lastAim.y = 0
  assert.equal(castSkill(world, 'w'), true)

  const dash = world.playerAction!.skillDash!
  const originX = dash.originX
  const originY = dash.originY
  const destinationX = dash.destinationX
  const destinationY = dash.destinationY
  const flash = idleAt(0, 20)
  flash.skillsPressed = SKILL_BIT.f
  flash.skillSequence = ['f']
  stepWorld(world, flash)

  assert.equal(dash.movementCancelled, true, 'F cancels only W movement')
  approx(dash.originX, originX, 'F preserves W origin x')
  approx(dash.originY, originY, 'F preserves W origin y')
  approx(dash.destinationX, destinationX, 'F preserves W destination x')
  approx(dash.destinationY, destinationY, 'F preserves W destination y')
  approx(world.player.pos.x, 0, 'F keeps its own landing x during W')
  approx(world.player.pos.y, 8, 'F keeps its own landing y during W')

  stepUntil(
    world,
    () => world.casts.some((event) => event.slot === 'w'),
    idleAt(0, 20),
  )
  const zone = world.zones[0]!
  const cast = world.casts.find((event) => event.slot === 'w')!
  approx(zone.x, originX, 'W departure lens keeps original x after F')
  approx(zone.y, originY, 'W departure lens keeps original y after F')
  approx(cast.originX, originX, 'W cast FX keeps original origin x after F')
  approx(cast.originY, originY, 'W cast FX keeps original origin y after F')
  approx(cast.targetX, destinationX, 'W cast FX keeps original target x after F')
  approx(cast.targetY, destinationY, 'W cast FX keeps original target y after F')
  approx(world.player.pos.x, 0, 'W does not overwrite F landing x')
  approx(world.player.pos.y, 8, 'W does not overwrite F landing y')
}

// Q itself is a self-buff. Its next basic attack must resolve a center ray and
// both side rays against three separated targets.
{
  const world = createWorld(9_009, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  const center = addTarget(world, 4, 0)
  const upper = addTarget(world, 6, 1.45)
  const lower = addTarget(world, 6, -1.45)
  unlockSkill(world.skills, 'q', 1)
  world.lastAim.x = 10
  assert.equal(castSkill(world, 'q'), true)
  stepUntil(world, () => world.player.rangedVolleyUntil > world.time)
  const volleyEndsAt = world.player.rangedVolleyUntil
  const deferredCooldown = world.skills.q.maxCooldown
  approx(
    world.skills.q.cooldown,
    deferredCooldown,
    'Q resets a full cooldown when the buff becomes active',
  )

  for (let tick = 0; tick < 90; tick += 1) {
    stepWorld(world, idleAt(10, 0))
  }
  assert.ok(world.time < volleyEndsAt, 'Q remains active during pause probe')
  approx(
    world.skills.q.cooldown,
    deferredCooldown,
    'Q cooldown does not tick while the volley is active',
  )

  world.player.attackCooldown = 0
  stepWorld(world, idleAt(10, 0))
  assert.ok(world.enemies.hp[center]! < 10_000, 'Q center ray hits')
  assert.ok(world.enemies.hp[upper]! < 10_000, 'Q upper side ray hits')
  assert.ok(world.enemies.hp[lower]! < 10_000, 'Q lower side ray hits')
  assert.ok(
    world.tracers.filter((tracer) => tracer.kind === 0).length >= 3,
    'Q empowered basic attack emits three rays',
  )

  world.player.attackCooldown = Number.POSITIVE_INFINITY
  stepUntil(world, () => world.time >= volleyEndsAt, idleAt(10, 0), 480)
  approx(
    world.skills.q.cooldown,
    deferredCooldown,
    'Q keeps its full cooldown through the final active tick',
  )
  stepWorld(world, idleAt(10, 0))
  approx(
    world.skills.q.cooldown,
    deferredCooldown - DT,
    'Q cooldown starts on the first tick after the buff ends',
  )
}

console.log(
  'control-check: targeting, assist, arrival, FIFO, buffer, flash guards, ranged dash, W→F origin, Q volley, and deferred Q cooldown ok',
)
