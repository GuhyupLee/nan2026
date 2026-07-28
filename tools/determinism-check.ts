import assert from 'node:assert/strict'
import { triggerBossPhaseTwo } from '../src/sim/boss.ts'
import { DT } from '../src/sim/constants.ts'
import {
  BOSS_MAX_HP,
  spawnBoss,
} from '../src/sim/enemies.ts'
import { pendingReward } from '../src/sim/progression.ts'
import {
  SKILL_D,
  SKILL_E,
  SKILL_F,
  SKILL_Q,
  SKILL_R,
  SKILL_W,
} from '../src/sim/skills.ts'
import {
  createInput,
  type Input,
  type PlayerClass,
  type World,
} from '../src/sim/types.ts'
import {
  createWorld,
  drainEvents,
  resolveRewardChoice,
  stepWorld,
} from '../src/sim/world.ts'
import {
  applyLevelUpCard,
  buildLevelUpCards,
} from '../src/ui/levelup.ts'

type StableValue =
  | null
  | boolean
  | number
  | string
  | StableValue[]
  | { [key: string]: StableValue }

type NumericView =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array

interface EventFrame {
  tick: number
  deaths: StableValue[]
  tracers: StableValue[]
  rings: StableValue[]
  casts: StableValue[]
  attacks: StableValue[]
  actionStarts: StableValue[]
  damageFeedback: StableValue[]
}

interface Scenario {
  name: string
  seed: number
  playerClass: PlayerClass
  totalTicks: number
  checkpoints: readonly number[]
  setup(world: World): void
  inputAt(tick: number): Input
  verifyCoverage(runner: Runner): void
}

interface Runner {
  chunkSize: number
  world: World
  initialRng: {
    simulation: number
    choice: number
    pickup: number
  }
  eventStream: EventFrame[]
  checkpoints: Map<number, StableValue>
  choicesResolved: number
  resolvedRewardKinds: Record<string, number>
}

const CHUNK_SIZES = [1, 3, 8] as const
const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

/**
 * These fields exist only to interpolate or decorate a rendered frame. They
 * cannot affect a later authoritative step, so including them would turn this
 * into a renderer snapshot rather than a simulation determinism regression.
 */
const RENDER_ONLY_POOL_FIELDS = new Set([
  'prevX',
  'prevY',
  'flash',
  'hpVisibleUntil',
])

function stable(value: unknown): StableValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'number:NaN'
    if (value === Number.POSITIVE_INFINITY) return 'number:+Infinity'
    if (value === Number.NEGATIVE_INFINITY) return 'number:-Infinity'
    if (Object.is(value, -0)) return 'number:-0'
    return value
  }
  if (Array.isArray(value)) return value.map(stable)
  if (value instanceof Set) {
    return [...value].map(stable).sort((a, b) => {
      const left = JSON.stringify(a)
      const right = JSON.stringify(b)
      return compareText(left, right)
    })
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
    return Array.from(value as NumericView, stable)
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => typeof entry !== 'function')
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, entry]) => [key, stable(entry)]),
    )
  }
  throw new TypeError(`unsupported deterministic value: ${typeof value}`)
}

function activePool(
  pool: object,
  count: number,
  renderOnly = RENDER_ONLY_POOL_FIELDS,
): StableValue {
  const arrays: Record<string, StableValue> = {}
  const scalars: Record<string, StableValue> = {}

  for (const [key, value] of Object.entries(pool).sort(([left], [right]) =>
    compareText(left, right),
  )) {
    if (key === 'views' || renderOnly.has(key)) continue
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      const view = value as NumericView
      const active = view.subarray(0, count)
      const bytes = new Uint8Array(
        active.buffer,
        active.byteOffset,
        active.byteLength,
      )
      arrays[key] = {
        type: view.constructor.name,
        length: active.length,
        bytes: stable(bytes),
      }
    } else if (key !== 'count' && typeof value !== 'function') {
      scalars[key] = stable(value)
    }
  }

  return { count, arrays, scalars }
}

function authoritativeState(world: World): StableValue {
  const {
    prevPos: _playerPrevPos,
    prevFacing: _playerPrevFacing,
    ...player
  } = world.player

  return stable({
    seed: world.seed,
    tick: world.tick,
    time: world.time,
    rng: {
      simulation: world.rng.state(),
      choice: world.choiceRng.state(),
      pickup: world.pickupRng.state(),
    },
    arenaRadius: world.arenaRadius,
    playerClass: world.playerClass,
    runConfig: world.runConfig,
    metaAwardedKills: world.metaAwardedKills,
    metaAwardedMoonlight: world.metaAwardedMoonlight,
    metaVictoryAwarded: world.metaVictoryAwarded,
    stats: world.stats,
    player,
    playerAction: world.playerAction,
    bufferedSkill: world.bufferedSkill,
    basicAttackSequence: world.basicAttackSequence,
    kills: world.kills,
    progression: world.progression,
    reward: {
      pending: pendingReward(world.progression),
      pendingRelicChoices: world.pendingRelicChoices,
      relicsClaimed: world.relicsClaimed,
      relicDrops: world.relicDrops.map(
        ({ prevX: _prevX, prevY: _prevY, ...relic }) => relic,
      ),
    },
    skills: world.skills,
    upgradesTaken: world.upgradesTaken,
    lastAim: world.lastAim,
    enemies: activePool(world.enemies, world.enemies.count),
    xpGems: activePool(world.xpGems, world.xpGems.count),
    battlefieldPickups: activePool(
      world.battlefieldPickups,
      world.battlefieldPickups.count,
      new Set(),
    ),
    boss: world.boss,
    hostileHazards: world.hostileHazards,
    beats: {
      elite: world.eliteBeatIndex,
      surge: world.surgeBeatIndex,
      surgeWarning: world.surgeWarningIndex,
      surgeStartedAt: world.surgeStartedAt,
    },
    spawnEnabled: world.spawnEnabled,
    zones: world.zones,
    blasts: world.blasts,
    ult: world.ult,
    awaitingChoice: world.awaitingChoice,
    outcome: world.outcome,
  })
}

function captureAndDrainEvents(world: World): EventFrame | null {
  const hasEvents =
    world.deaths.length > 0 ||
    world.tracers.length > 0 ||
    world.rings.length > 0 ||
    world.casts.length > 0 ||
    world.attacks.length > 0 ||
    world.actionStarts.length > 0 ||
    world.damageFeedback.length > 0
  if (!hasEvents) {
    drainEvents(world)
    return null
  }

  const frame: EventFrame = {
    tick: world.tick,
    deaths: world.deaths.map(stable),
    tracers: world.tracers.map(stable),
    rings: world.rings.map(stable),
    casts: world.casts.map(stable),
    attacks: world.attacks.map(stable),
    actionStarts: world.actionStarts.map(stable),
    damageFeedback: world.damageFeedback.map(stable),
  }
  drainEvents(world)
  return frame
}

function createRunner(scenario: Scenario, chunkSize: number): Runner {
  const world = createWorld(scenario.seed, scenario.playerClass)
  world.stats.damageTakenMul = 0
  scenario.setup(world)
  return {
    chunkSize,
    world,
    initialRng: {
      simulation: world.rng.state(),
      choice: world.choiceRng.state(),
      pickup: world.pickupRng.state(),
    },
    eventStream: [],
    checkpoints: new Map(),
    choicesResolved: 0,
    resolvedRewardKinds: {},
  }
}

/**
 * Mirrors the runtime reward path without a DOM: build the same deterministic
 * card offer, accept its first card, then let World consume the pending reward.
 * Upgrade and relic offers roll through choiceRng inside buildLevelUpCards.
 */
function resolveFirstChoice(world: World): string {
  const reward =
    world.pendingRelicChoices > 0
      ? 'relic'
      : pendingReward(world.progression)
  assert.ok(reward, 'awaiting choice has an authoritative pending reward')
  const cards = buildLevelUpCards(world)
  assert.ok(cards.length > 0, 'pending reward always produces an applicable card')
  applyLevelUpCard(world, cards[0]!)
  resolveRewardChoice(world)
  return reward
}

function advanceOneTick(
  scenario: Scenario,
  runner: Runner,
  checkpointSet: ReadonlySet<number>,
): void {
  while (runner.world.awaitingChoice) {
    const reward = resolveFirstChoice(runner.world)
    runner.choicesResolved += 1
    runner.resolvedRewardKinds[reward] =
      (runner.resolvedRewardKinds[reward] ?? 0) + 1
  }

  const tick = runner.world.tick
  assert.ok(tick < scenario.totalTicks, `${scenario.name} does not overrun`)
  stepWorld(runner.world, scenario.inputAt(tick))
  assert.equal(
    runner.world.tick,
    tick + 1,
    `${scenario.name} advances authoritative tick ${tick}`,
  )

  const events = captureAndDrainEvents(runner.world)
  if (events) runner.eventStream.push(events)
  if (checkpointSet.has(runner.world.tick)) {
    runner.checkpoints.set(
      runner.world.tick,
      authoritativeState(runner.world),
    )
  }
}

function firstDifference(
  expected: StableValue,
  actual: StableValue,
  path = '$',
): string | null {
  if (Object.is(expected, actual)) return null
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object'
  ) {
    return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return `${path}: expected ${Array.isArray(expected) ? 'array' : 'object'}, got ${
        Array.isArray(actual) ? 'array' : 'object'
      }`
    }
    if (expected.length !== actual.length) {
      return `${path}.length: expected ${expected.length}, got ${actual.length}`
    }
    for (let index = 0; index < expected.length; index += 1) {
      const difference = firstDifference(
        expected[index]!,
        actual[index]!,
        `${path}[${index}]`,
      )
      if (difference) return difference
    }
    return null
  }

  const expectedObject = expected as Record<string, StableValue>
  const actualObject = actual as Record<string, StableValue>
  const expectedKeys = Object.keys(expectedObject).sort()
  const actualKeys = Object.keys(actualObject).sort()
  if (JSON.stringify(expectedKeys) !== JSON.stringify(actualKeys)) {
    return `${path} keys: expected ${JSON.stringify(expectedKeys)}, got ${JSON.stringify(actualKeys)}`
  }
  for (const key of expectedKeys) {
    const difference = firstDifference(
      expectedObject[key]!,
      actualObject[key]!,
      `${path}.${key}`,
    )
    if (difference) return difference
  }
  return null
}

function assertEquivalent(
  scenario: Scenario,
  subject: string,
  expected: StableValue,
  actual: StableValue,
  expectedChunk: number,
  actualChunk: number,
): void {
  const expectedRepresentation = JSON.stringify(expected)
  const actualRepresentation = JSON.stringify(actual)
  if (expectedRepresentation === actualRepresentation) return
  const difference =
    firstDifference(expected, actual) ?? 'representations differ at an unknown path'
  assert.fail(
    `${scenario.name} ${subject} diverged between ${expectedChunk}-tick and ${actualChunk}-tick stepping: ${difference}`,
  )
}

function runScenario(scenario: Scenario): Runner[] {
  const checkpointSet = new Set([
    ...scenario.checkpoints,
    scenario.totalTicks,
  ])
  const runners = CHUNK_SIZES.map((chunkSize) =>
    createRunner(scenario, chunkSize),
  )

  let turn = 0
  while (runners.some(({ world }) => world.tick < scenario.totalTicks)) {
    const runner = runners[turn % runners.length]!
    turn += 1
    const remaining = scenario.totalTicks - runner.world.tick
    const ticks = Math.min(runner.chunkSize, remaining)
    for (let index = 0; index < ticks; index += 1) {
      advanceOneTick(scenario, runner, checkpointSet)
    }
  }

  const baseline = runners[0]!
  for (const runner of runners.slice(1)) {
    for (const checkpoint of checkpointSet) {
      assertEquivalent(
        scenario,
        `checkpoint ${checkpoint}`,
        baseline.checkpoints.get(checkpoint)!,
        runner.checkpoints.get(checkpoint)!,
        baseline.chunkSize,
        runner.chunkSize,
      )
    }
    assertEquivalent(
      scenario,
      'accumulated event stream',
      stable(baseline.eventStream),
      stable(runner.eventStream),
      baseline.chunkSize,
      runner.chunkSize,
    )
    assert.equal(
      runner.choicesResolved,
      baseline.choicesResolved,
      `${scenario.name} reward resolution count`,
    )
    assert.deepEqual(
      runner.resolvedRewardKinds,
      baseline.resolvedRewardKinds,
      `${scenario.name} reward-kind resolution counts`,
    )
  }

  scenario.verifyCoverage(baseline)
  console.log(
    `  ok  ${scenario.name}: ${scenario.totalTicks} ticks, ${baseline.eventStream.length} event frames`,
  )
  return runners
}

function scriptedInput(
  tick: number,
  includeCombatSkills: boolean,
): Input {
  const input = createInput()
  const movePhase = tick / 173
  const aimPhase = tick / 127
  input.move.x = Math.cos(movePhase)
  input.move.y = Math.sin(movePhase * 0.73)
  input.aim.x = Math.cos(aimPhase) * 17
  input.aim.y = Math.sin(aimPhase * 1.13) * 17

  let pressed = 0
  if (includeCombatSkills) {
    if (tick % 211 === 17) pressed |= SKILL_Q
    if (tick % 607 === 43) pressed |= SKILL_W
    if (tick % 823 === 71) pressed |= SKILL_E
    if (tick % 2_197 === 101) pressed |= SKILL_R
  }
  if (tick % 2_503 === 137) pressed |= SKILL_D
  if (tick % 2_111 === 163) pressed |= SKILL_F
  input.skillsPressed = pressed
  return input
}

const scenarios: Scenario[] = [
  {
    name: 'campaign-stream',
    seed: 0x6e616e26,
    playerClass: 'ranged',
    totalTicks: 150 * Math.round(1 / DT),
    checkpoints: [60, 600, 1_800, 3_600, 7_200],
    setup(world) {
      // A deterministic elite-reward fixture guarantees that the same
      // choiceRng-backed relic burst used by runtime is part of this stream.
      world.pendingRelicChoices = 1
      world.relicsClaimed = 1
      world.awaitingChoice = true
    },
    inputAt: (tick) => scriptedInput(tick, true),
    verifyCoverage({
      world,
      eventStream,
      choicesResolved,
      resolvedRewardKinds,
      initialRng,
    }) {
      assert.ok(world.kills > 0, 'campaign exercises enemy death and swap removal')
      assert.ok(
        world.progression.level > 1,
        'campaign exercises XP and progression',
      )
      assert.ok(world.eliteBeatIndex > 0, 'campaign exercises authored reward beat')
      assert.ok(choicesResolved > 0, 'campaign resolves deterministic rewards')
      assert.ok(
        (resolvedRewardKinds['unlock-choice'] ?? 0) +
          (resolvedRewardKinds['unlock-last'] ?? 0) >
          0,
        'campaign resolves skill unlock cards',
      )
      assert.ok(
        (resolvedRewardKinds['skill-rank'] ?? 0) > 0,
        'campaign resolves skill rank cards',
      )
      assert.ok(
        (resolvedRewardKinds.upgrade ?? 0) > 0,
        'campaign resolves rolled upgrade cards',
      )
      assert.ok(
        (resolvedRewardKinds.relic ?? 0) > 0,
        'campaign resolves rolled elite relic cards',
      )
      assert.ok(
        (['q', 'w', 'e', 'r'] as const).some(
          (id) => world.skills[id].unlocked,
        ),
        'campaign applies skill unlock rewards',
      )
      assert.ok(
        Object.values(world.skills).some(({ rank }) => rank > 0),
        'campaign applies skill rank rewards',
      )
      assert.ok(
        world.upgradesTaken.size > 0,
        'campaign applies rolled upgrade or relic rewards',
      )
      assert.notEqual(
        world.rng.state(),
        initialRng.simulation,
        'campaign consumes simulation RNG',
      )
      assert.notEqual(
        world.choiceRng.state(),
        initialRng.choice,
        'campaign consumes choice RNG through a card roll',
      )
      assert.notEqual(
        world.pickupRng.state(),
        initialRng.pickup,
        'campaign consumes isolated battlefield-pickup RNG',
      )
      assert.ok(
        eventStream.some(({ casts }) => casts.length > 0),
        'campaign accumulates cast events',
      )
      assert.ok(
        eventStream.some(({ deaths }) => deaths.length > 0),
        'campaign accumulates death events',
      )
      assert.ok(
        eventStream.some(({ damageFeedback }) => damageFeedback.length > 0),
        'campaign accumulates damage feedback',
      )
    },
  },
  {
    name: 'boss-phase-two-stream',
    seed: 0x70683226,
    playerClass: 'melee',
    totalTicks: 12 * Math.round(1 / DT),
    checkpoints: [1, 60, 240, 480],
    setup(world) {
      world.spawnEnabled = false
      assert.ok(
        spawnBoss(
          world.enemies,
          world.rng,
          world.player.pos.x,
          world.player.pos.y,
        ),
        'boss fixture spawns',
      )
      const bossIndex = world.enemies.count - 1
      world.boss.spawned = true
      world.boss.spawnedAt = 0
      world.boss.active = true
      world.boss.hp = BOSS_MAX_HP
      world.boss.maxHp = BOSS_MAX_HP
      assert.ok(
        triggerBossPhaseTwo(world, bossIndex),
        'boss fixture enters phase two through the authoritative transition',
      )
    },
    inputAt: (tick) => scriptedInput(tick, false),
    verifyCoverage({ world, eventStream }) {
      assert.ok(world.boss.phaseTwoAt >= 0, 'boss phase-two state is retained')
      assert.ok(
        world.boss.hazardDetonations > 0,
        'boss fixture exercises hostile hazard scheduling and detonation',
      )
      assert.ok(
        eventStream.some(({ rings }) => rings.length > 0),
        'boss transition event is accumulated',
      )
      assert.equal(world.outcome, 'alive', 'boss fixture remains authoritative')
    },
  },
]

console.log('\nauthoritative determinism check\n')
for (const scenario of scenarios) runScenario(scenario)
console.log(
  `Determinism check passed: ${scenarios.length} scenarios across ${CHUNK_SIZES.join('/')} tick chunks`,
)
