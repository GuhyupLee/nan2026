import assert from 'node:assert/strict'
import { InputState, applyPointerMove } from '../src/input.ts'
import {
  PLAYER_ACTION_BUFFER_WINDOW,
} from '../src/sim/actions.ts'
import {
  MELEE_W_DASH_END,
  MELEE_W_PREPARE_END,
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

type StubListener = (event: Record<string, unknown>) => void

class StubEventTarget {
  private readonly listeners = new Map<string, StubListener[]>()

  addEventListener(type: string, listener: StubListener): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: StubListener): void {
    const listeners = this.listeners.get(type)
    if (!listeners) return
    const index = listeners.indexOf(listener)
    if (index >= 0) listeners.splice(index, 1)
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    event.type ??= type
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }
}

class StubNode extends StubEventTarget {
  readonly children: StubNode[] = []

  appendChild(child: StubNode): StubNode {
    this.children.push(child)
    return child
  }

  contains(target: StubNode): boolean {
    return target === this || this.children.some((child) => child.contains(target))
  }
}

class StubElement extends StubNode {
  className = ''
  isContentEditable = false
  readonly dataset: Record<string, string> = {}
  readonly style = {
    touchAction: '',
    left: '',
    top: '',
    setProperty: (_name: string, _value: string): void => {},
  }
  private readonly capturedPointers = new Set<number>()

  constructor(readonly tagName = 'DIV') {
    super()
  }

  setAttribute(_name: string, _value: string): void {}

  getBoundingClientRect(): DOMRect {
    return {
      left: 0,
      top: 0,
      right: 1_000,
      bottom: 800,
      width: 1_000,
      height: 800,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointers.add(pointerId)
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.capturedPointers.has(pointerId)
  }

  releasePointerCapture(pointerId: number): void {
    this.capturedPointers.delete(pointerId)
  }

  remove(): void {}
}

const inputWindow = new StubEventTarget()
const storedInputSettings = new Map<string, string>()
Object.assign(globalThis, {
  Node: StubNode,
  HTMLElement: StubElement,
  document: {
    createElement: (tagName: string) => new StubElement(tagName.toUpperCase()),
  },
  localStorage: {
    getItem: (key: string) => storedInputSettings.get(key) ?? null,
    setItem: (key: string, value: string) => storedInputSettings.set(key, value),
  },
  window: inputWindow,
})

function pointerEvent(
  target: StubNode,
  overrides: Partial<{
    pointerId: number
    pointerType: string
    button: number
    buttons: number
    clientX: number
    clientY: number
  }> = {},
): Record<string, unknown> {
  return {
    target,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: 0,
    clientX: 0,
    clientY: 0,
    preventDefault: () => {},
    stopImmediatePropagation: () => {},
    ...overrides,
  }
}

function keyEvent(
  code: string,
  overrides: Partial<{
    repeat: boolean
    defaultPrevented: boolean
    ctrlKey: boolean
    metaKey: boolean
    altKey: boolean
  }> = {},
): Record<string, unknown> {
  return {
    code,
    target: null,
    repeat: false,
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: () => {},
    stopImmediatePropagation: () => {},
    ...overrides,
  }
}

function createInputHarness(): {
  input: InputState
  surface: StubElement
  hud: StubElement
} {
  const surface = new StubElement()
  const hud = new StubElement()
  return {
    input: new InputState(surface as unknown as HTMLElement),
    surface,
    hud,
  }
}

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

// InputState is DOM-backed, so these checks use only the event surface methods
// it actually touches. They reproduce the main loop's sample -> screenToGround
// -> applyPointerMove order with screen coordinates standing in for ground
// coordinates.
for (const mode of ['instant', 'release'] as const) {
  for (const [code, slot] of [
    ['KeyQ', 'q'],
    ['KeyW', 'w'],
    ['KeyE', 'e'],
    ['KeyR', 'r'],
  ] as const) {
    const { input, surface } = createInputHarness()
    input.setCastMode(mode)
    inputWindow.dispatch(
      'pointermove',
      pointerEvent(surface, { clientX: 640, clientY: 260 }),
    )

    inputWindow.dispatch('keydown', keyEvent(code))
    inputWindow.dispatch('keyup', keyEvent(code))
    surface.dispatch(
      'pointerdown',
      pointerEvent(surface, {
        pointerId: 11,
        buttons: 1,
        clientX: 780,
        clientY: 220,
      }),
    )

    const sampled = createInput()
    input.sample(sampled)
    assert.equal(
      sampled.skillsPressed,
      SKILL_BIT[slot],
      `${mode} keyboard ${slot.toUpperCase()} remains queued`,
    )
    approx(input.pointerX, 780, `${mode} keyboard ${slot.toUpperCase()} click x`)
    approx(input.pointerY, 220, `${mode} keyboard ${slot.toUpperCase()} click y`)
    assert.equal(input.pointerHeld, true)
    input.dispose()
  }
}

// SkillBar calls these handlers in pointerdown -> pointermove -> pointerup
// order. Its HUD coordinate may aim the skill, but it must never replace the
// last battlefield pointer used by the next ordinary movement/aim tick.
for (const mode of ['instant', 'release'] as const) {
  const { input, surface } = createInputHarness()
  input.setCastMode(mode)
  inputWindow.dispatch(
    'pointermove',
    pointerEvent(surface, { clientX: 660, clientY: 240 }),
  )

  input.startSkill('w')
  input.setSkillPointerAim(120, 740)
  input.releaseSkill('w')

  approx(input.pointerX, 660, `${mode} skillbar cast preserves battlefield x`)
  approx(input.pointerY, 240, `${mode} skillbar cast preserves battlefield y`)

  const castSample = createInput()
  input.sample(castSample)
  assert.equal(castSample.skillsPressed, SKILL_BIT.w)
  assert.equal(
    input.hasSkillPointerAim,
    mode === 'release',
    `${mode} skillbar cast exposes only a release-drag skill aim`,
  )
  if (mode === 'release') {
    approx(input.sampledSkillPointerX, 120, 'release skillbar keeps cast-only x')
    approx(input.sampledSkillPointerY, 740, 'release skillbar keeps cast-only y')
    assert.equal(castSample.aimedSkillSlot, 'w')
  } else {
    assert.equal(castSample.aimedSkillSlot, undefined)
  }

  surface.dispatch(
    'pointerdown',
    pointerEvent(surface, {
      pointerId: 12,
      buttons: 1,
      clientX: 820,
      clientY: 200,
    }),
  )
  approx(input.pointerX, 820, `${mode} post-skill canvas click x`)
  approx(input.pointerY, 200, `${mode} post-skill canvas click y`)
  assert.equal(input.pointerHeld, true)
  const postCastSample = createInput()
  input.sample(postCastSample)
  assert.equal(
    input.hasSkillPointerAim,
    false,
    `${mode} skillbar aim expires after the cast sample`,
  )
  assert.equal(postCastSample.skillsPressed, 0)
  input.dispose()
}

// 실제 브라우저 이벤트 순서에서 스킬바 E의 드래그 조준과 같은 샘플에 들어온
// 키보드 Q를 구분한다. 조준 없는 Q keyup이 E의 pending aim을 지우면 안 된다.
{
  const { input } = createInputHarness()
  input.setCastMode('release')
  input.startSkill('e')
  input.setSkillPointerAim(180, 720)
  input.releaseSkill('e')
  inputWindow.dispatch('keydown', keyEvent('KeyQ'))
  inputWindow.dispatch('keyup', keyEvent('KeyQ'))

  const sampled = createInput()
  input.sample(sampled)
  assert.deepEqual(sampled.skillSequence, ['e', 'q'])
  assert.equal(sampled.aimedSkillSlot, 'e')
  approx(input.sampledSkillPointerX, 180, 'mixed input keeps skillbar E aim x')
  approx(input.sampledSkillPointerY, 720, 'mixed input keeps skillbar E aim y')
  input.dispose()
}

// The simulation receives the skillbar target separately: a skill can cast to
// the drag coordinate while the same tick's held movement and persistent
// battlefield aim continue toward the canvas coordinate.
{
  const world = createWorld(9_000, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(world.skills, 'e', 1)
  const splitAim = idleAt(0, 20)
  splitAim.skillAim = { x: 20, y: 0 }
  splitAim.move.y = 1
  splitAim.skillsPressed = SKILL_BIT.e
  splitAim.skillSequence = ['e']
  stepWorld(world, splitAim)

  approx(world.lastAim.x, 0, 'skill-only aim does not replace battlefield x')
  approx(world.lastAim.y, 20, 'skill-only aim does not replace battlefield y')
  approx(world.playerAction?.targetX ?? -1, 14, 'E uses skill-only target x')
  approx(world.playerAction?.targetY ?? -1, 0, 'E uses skill-only target y')
  assert.ok(world.player.pos.y > 0, 'same-tick held movement still uses canvas aim')
}

// 브라우저가 aimedSkillSlot을 제공하면 그 슬롯만 잠긴다. 같은 틱의 키보드
// 스킬은 버퍼에 들어가도 lockedAim 없이 현재 전장 조준을 계속 따른다.
{
  const world = createWorld(9_015, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(world.skills, 'e', 1)
  unlockSkill(world.skills, 'q', 1)
  const mixed = idleAt(0, 20)
  mixed.skillAim = { x: 20, y: 0 }
  mixed.aimedSkillSlot = 'e'
  mixed.skillsPressed = SKILL_BIT.e | SKILL_BIT.q
  mixed.skillSequence = ['e', 'q']

  stepWorld(world, mixed)

  assert.equal(world.playerAction?.slot, 'e')
  assert.equal(world.playerAction?.aimLocked, true)
  assert.equal(world.bufferedSkill?.slot, 'q')
  assert.equal(
    world.bufferedSkill?.lockedAim,
    null,
    'same-tick keyboard Q remains live-targeted',
  )
  stepUntil(
    world,
    () => world.playerAction?.slot === 'q',
    idleAt(0, 20),
  )
  assert.equal(world.playerAction?.aimLocked, false)
}

// A skillbar drag is an explicit target commitment. It must survive both the
// windup retarget pass and the final impact retarget pass, while ordinary
// keyboard/hover casts keep following the live battlefield pointer.
{
  const locked = createWorld(9_010, 'ranged')
  locked.spawnEnabled = false
  locked.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(locked.skills, 'e', 1)
  const dragCast = idleAt(0, 20)
  dragCast.skillAim = { x: 20, y: 0 }
  dragCast.skillsPressed = SKILL_BIT.e
  dragCast.skillSequence = ['e']
  stepWorld(locked, dragCast)
  assert.equal(locked.playerAction?.aimLocked, true)
  stepUntil(
    locked,
    () => locked.casts.some((event) => event.slot === 'e'),
    idleAt(0, 20),
  )
  const lockedCast = locked.casts.find((event) => event.slot === 'e')!
  approx(lockedCast.targetX, 14, 'drag-targeted E keeps locked impact x')
  approx(lockedCast.targetY, 0, 'drag-targeted E keeps locked impact y')

  const live = createWorld(9_011, 'ranged')
  live.spawnEnabled = false
  live.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(live.skills, 'e', 1)
  live.lastAim.x = 20
  live.lastAim.y = 0
  assert.equal(castSkill(live, 'e'), true)
  assert.equal(live.playerAction?.aimLocked, false)
  stepUntil(
    live,
    () => live.casts.some((event) => event.slot === 'e'),
    idleAt(0, 20),
  )
  const liveCast = live.casts.find((event) => event.slot === 'e')!
  approx(liveCast.targetX, 0, 'keyboard E follows live impact x')
  approx(liveCast.targetY, 14, 'keyboard E follows live impact y')
}

// A drag target queued during another action must be copied into the buffer.
// The main loop reuses its skillAim object, so retaining only the reference or
// only the slot would make the eventual cast follow the battlefield pointer.
{
  const world = createWorld(9_012, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(world.skills, 'q', 1)
  unlockSkill(world.skills, 'e', 1)
  world.lastAim.x = 10
  assert.equal(castSkill(world, 'q'), true)
  stepUntil(
    world,
    () =>
      world.playerAction !== null &&
      world.playerAction.endAt - world.time <=
        PLAYER_ACTION_BUFFER_WINDOW - DT,
  )

  const buffered = idleAt(0, 20)
  buffered.skillAim = { x: 20, y: 0 }
  buffered.skillsPressed = SKILL_BIT.e
  buffered.skillSequence = ['e']
  stepWorld(world, buffered)
  approx(world.bufferedSkill?.lockedAim?.x ?? -1, 20, 'buffer copies drag x')
  approx(world.bufferedSkill?.lockedAim?.y ?? -1, 0, 'buffer copies drag y')
  buffered.skillAim.x = -20
  buffered.skillAim.y = -20

  stepUntil(
    world,
    () => world.casts.some((event) => event.slot === 'e'),
    idleAt(0, 20),
  )
  const cast = world.casts.find((event) => event.slot === 'e')!
  approx(cast.targetX, 14, 'buffered drag E keeps locked impact x')
  approx(cast.targetY, 0, 'buffered drag E keeps locked impact y')
}

// Keyboard casting while a mouse move is already held must not drop movement
// ownership in either casting mode.
for (const mode of ['instant', 'release'] as const) {
  const { input, surface } = createInputHarness()
  input.setCastMode(mode)
  surface.dispatch(
    'pointerdown',
    pointerEvent(surface, {
      pointerId: 13,
      buttons: 1,
      clientX: 760,
      clientY: 300,
    }),
  )
  inputWindow.dispatch('keydown', keyEvent('KeyE'))
  inputWindow.dispatch('keyup', keyEvent('KeyE'))

  const sampled = createInput()
  input.sample(sampled)
  sampled.aim.x = input.pointerX
  sampled.aim.y = input.pointerY
  applyPointerMove(input, sampled, { x: 0, y: 0 })
  assert.equal(sampled.skillsPressed, SKILL_BIT.e)
  assert.ok(
    Math.hypot(sampled.move.x, sampled.move.y) > 0,
    `${mode} held mouse keeps moving through a skill cast`,
  )
  input.dispose()
}

// HUD hover remains isolated from battlefield aim, and a drag that starts on
// HUD never acquires movement merely by crossing the game surface.
{
  const { input, surface, hud } = createInputHarness()
  inputWindow.dispatch(
    'pointermove',
    pointerEvent(surface, { clientX: 620, clientY: 280 }),
  )
  inputWindow.dispatch(
    'pointermove',
    pointerEvent(hud, { clientX: 100, clientY: 760 }),
  )
  approx(input.pointerX, 620, 'HUD hover preserves battlefield pointer x')
  approx(input.pointerY, 280, 'HUD hover preserves battlefield pointer y')

  inputWindow.dispatch(
    'pointermove',
    pointerEvent(surface, {
      pointerId: 14,
      buttons: 1,
      clientX: 500,
      clientY: 400,
    }),
  )
  assert.equal(input.pointerHeld, false, 'HUD drag never owns movement')
  const dragSample = idleAt(500, 400)
  applyPointerMove(input, dragSample, { x: 0, y: 0 })
  approx(Math.hypot(dragSample.move.x, dragSample.move.y), 0, 'HUD drag cannot move')
  input.dispose()
}

// Releasing a battlefield click keeps its movement anchor active while subsequent
// hover updates remain available for independent aiming. Keyboard movement and
// a center stop both cancel the locked direction.
{
  const { input, surface } = createInputHarness()
  surface.dispatch(
    'pointerdown',
    pointerEvent(surface, {
      pointerId: 15,
      buttons: 1,
      clientX: 800,
      clientY: 200,
    }),
  )
  inputWindow.dispatch(
    'pointerup',
    pointerEvent(surface, {
      pointerId: 15,
      button: 0,
      buttons: 0,
      clientX: 800,
      clientY: 200,
    }),
  )
  assert.equal(input.pointerHeld, true, 'click release keeps direction active')

  inputWindow.dispatch(
    'pointermove',
    pointerEvent(surface, {
      pointerId: 16,
      buttons: 0,
      clientX: 300,
      clientY: 600,
    }),
  )
  approx(input.pointerX, 300, 'hover continues updating aim x')
  approx(input.pointerY, 600, 'hover continues updating aim y')
  approx(input.movementPointerX, 800, 'hover preserves movement anchor x')
  approx(input.movementPointerY, 200, 'hover preserves movement anchor y')

  const moving = idleAt(300, 600)
  applyPointerMove(input, moving, { x: 0, y: 0 }, { x: 8, y: 0 })
  approx(moving.move.x, 1, 'locked click keeps moving in its direction')
  approx(moving.move.y, 0, 'locked click preserves movement direction')

  inputWindow.dispatch('keydown', keyEvent('ArrowUp'))
  assert.equal(input.pointerHeld, false, 'keyboard movement cancels direction lock')
  inputWindow.dispatch('keyup', keyEvent('ArrowUp'))

  surface.dispatch(
    'pointerdown',
    pointerEvent(surface, {
      pointerId: 17,
      buttons: 1,
      clientX: 800,
      clientY: 200,
    }),
  )
  inputWindow.dispatch(
    'pointerup',
    pointerEvent(surface, {
      pointerId: 17,
      button: 0,
      buttons: 0,
      clientX: 800,
      clientY: 200,
    }),
  )
  const arrived = idleAt(300, 600)
  applyPointerMove(input, arrived, { x: 7.7, y: 0 }, { x: 8, y: 0 })
  approx(Math.hypot(arrived.move.x, arrived.move.y), 0, 'center click stops movement')
  assert.equal(input.pointerHeld, false, 'center click clears locked direction')
  input.dispose()
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
    completePointerMove: () => {},
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

// The floating touch stick is genuinely analog between its 8 px deadzone and
// 32 px edge. Aim remains a unit direction so micro-movement does not shorten
// the world-space skill/attack aim distance.
{
  const { input, surface } = createInputHarness()
  surface.dispatch(
    'pointerdown',
    pointerEvent(surface, {
      pointerId: 18,
      pointerType: 'touch',
      buttons: 1,
      clientX: 100,
      clientY: 100,
    }),
  )

  const deadzone = idleAt()
  inputWindow.dispatch(
    'pointermove',
    pointerEvent(surface, {
      pointerId: 18,
      pointerType: 'touch',
      buttons: 1,
      clientX: 108,
      clientY: 100,
    }),
  )
  assert.equal(input.applyTouchMove(deadzone, { x: 0, y: 0 }), true)
  approx(Math.hypot(deadzone.move.x, deadzone.move.y), 0, 'touch deadzone stops')

  const middle = idleAt()
  inputWindow.dispatch(
    'pointermove',
    pointerEvent(surface, {
      pointerId: 18,
      pointerType: 'touch',
      buttons: 1,
      clientX: 116,
      clientY: 100,
    }),
  )
  input.applyTouchMove(middle, { x: 0, y: 0 })
  approx(
    Math.hypot(middle.move.x, middle.move.y),
    7 / 27,
    'touch midpoint uses smoothstep magnitude',
  )
  approx(middle.aim.x, 12, 'touch midpoint keeps full aim distance')
  approx(middle.aim.y, 0, 'touch midpoint keeps aim direction')

  const edge = idleAt()
  inputWindow.dispatch(
    'pointermove',
    pointerEvent(surface, {
      pointerId: 18,
      pointerType: 'touch',
      buttons: 1,
      clientX: 140,
      clientY: 100,
    }),
  )
  input.applyTouchMove(edge, { x: 0, y: 0 })
  approx(Math.hypot(edge.move.x, edge.move.y), 1, 'touch edge reaches full speed')
  input.dispose()
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

// F has a separate execution path from QWER. A near-ready buffered flash must
// use the copied skillbar target rather than the live battlefield hover.
{
  const world = createWorld(9_014, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  world.skills.f.cooldown = 0.1
  const flash = idleAt(20, 0)
  flash.skillAim = { x: 0, y: 20 }
  flash.skillsPressed = SKILL_BIT.f
  flash.skillSequence = ['f']
  stepWorld(world, flash)
  approx(world.bufferedSkill?.lockedAim?.x ?? -1, 0, 'buffered F copies drag x')
  approx(world.bufferedSkill?.lockedAim?.y ?? -1, 20, 'buffered F copies drag y')

  stepUntil(world, () => world.player.pos.y > 0, idleAt(20, 0), 30)
  approx(world.player.pos.x, 0, 'buffered F ignores later hover x')
  approx(world.player.pos.y, 8, 'buffered F lands toward locked y')
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

// Melee W remains vulnerable during its authored preparation, then carries
// invulnerability from the first movement sample through the locked recovery.
// Ranged W keeps its separate residual-guard rule above.
{
  const world = createWorld(9_013, 'melee')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(world.skills, 'w', 1)
  world.lastAim.x = 20
  world.lastAim.y = 0
  assert.equal(castSkill(world, 'w'), true)

  const action = world.playerAction!
  stepWorld(world, idleAt(20, 0))
  assert.ok(
    world.time < action.startedAt + MELEE_W_PREPARE_END,
    'melee W probe remains in prepare',
  )
  assert.ok(
    world.player.invulnUntil < world.time,
    'melee W prepare does not grant invulnerability early',
  )

  stepUntil(world, () => world.player.pos.x > 0, idleAt(20, 0))
  approx(
    world.player.invulnUntil,
    action.endAt,
    'melee W dash extends invulnerability through recovery',
  )
  stepUntil(
    world,
    () => world.time >= action.startedAt + MELEE_W_DASH_END + DT,
    idleAt(20, 0),
  )
  assert.equal(world.playerAction, action, 'melee W recovery still owns the action')
  assert.ok(
    world.player.invulnUntil > world.time,
    'melee W remains invulnerable after movement ends',
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
  'control-check: targeting, locked aim, analog touch, FIFO, buffer, flash guards, dash immunity, W→F origin, Q volley, and deferred Q cooldown ok',
)
