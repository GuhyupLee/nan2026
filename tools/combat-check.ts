import assert from 'node:assert/strict'
import {
  DAMAGE_TRAIT_META,
  getSkillDamageBreakdown,
} from '../src/content/skills.ts'
import { PLAYER_ACTION_BUFFER_WINDOW } from '../src/sim/actions.ts'
import { playerActionTiming } from '../src/sim/action-timing.ts'
import {
  BOSS_PHASE_TWO_KNOCKBACK_RADIUS,
  BOSS_PHASE_SHOCKWAVE_DAMAGE,
  BOSS_PHASE_SHOCKWAVE_INNER_DAMAGE,
  BOSS_PHASE_SHOCKWAVE_INNER_RADIUS,
  BOSS_PHASE_SHOCKWAVE_INNER_WARNING_DURATION,
  BOSS_PHASE_SHOCKWAVE_RADIUS,
  BOSS_PHASE_SHOCKWAVE_WARNING_DURATION,
  BOSS_PHASE_TWO_THRESHOLD,
  BOSS_PHASE_TWO_TRANSITION_DURATION,
  BOSS_CHARGE_TRAIL_COUNT,
  BOSS_CHARGE_TRAIL_DAMAGE,
  BOSS_CHARGE_TRAIL_RADIUS,
  BOSS_CHARGE_TRAIL_SPACING,
  BOSS_CHARGE_TRAIL_WARNING_DURATION,
  BOSS_PHASE_ZONE_DAMAGE,
  BOSS_PHASE_ZONE_PREDICTION_SECONDS,
  BOSS_PHASE_ZONE_RADIUS,
  BOSS_PHASE_ZONE_WARNING_DURATION,
  BOSS_RECOVER_BLAST_DAMAGE,
  BOSS_RECOVER_BLAST_RADIUS,
  BOSS_RECOVER_BLAST_WARNING_DURATION,
  stepBossEncounter,
  triggerBossPhaseTwo,
} from '../src/sim/boss.ts'
import { DT } from '../src/sim/constants.ts'
import {
  BOSS_SINGLE_HIT_DAMAGE_CAP_RATIO,
  damageEnemy,
} from '../src/sim/damage.ts'
import {
  BOSS_CHARGE_AT,
  BOSS_CHARGE_SPEED,
  BOSS_CYCLE_TIME,
  BOSS_INTRO_DURATION,
  BOSS_MAX_HP,
  BOSS_PHASE_TWO_OPENING_CYCLE_AT,
  BOSS_RECOVER_AT,
  BOSS_WINDUP_AT,
  TYPE_BOSS,
  TYPE_BRUTE,
  TYPE_ELITE,
  TYPE_WALKER,
  bossCycleIndex,
  bossCycleTime,
  bossPhaseAt,
  createEnemyHash,
  createEnemyPool,
  rebuildEnemyHash,
  spawnBoss,
  spawnEnemy,
  stepEnemies,
} from '../src/sim/enemies.ts'
import { castSkill } from '../src/sim/kits.ts'
import { upgradeTraitToken } from '../src/sim/progression.ts'
import { createRng } from '../src/sim/rng.ts'
import { SKILL_BIT, unlockSkill, type SkillId } from '../src/sim/skills.ts'
import { createInput, type PlayerClass, type World } from '../src/sim/types.ts'
import { createWorld, stepWorld } from '../src/sim/world.ts'

const QWER = ['q', 'w', 'e', 'r'] as const satisfies readonly SkillId[]

function addTarget(world: World, x: number, y: number, hp = 10_000): number {
  spawnEnemy(
    world.enemies,
    world.rng,
    world.player.pos.x,
    world.player.pos.y,
    TYPE_WALKER,
  )
  const i = world.enemies.count - 1
  world.enemies.x[i] = x
  world.enemies.y[i] = y
  world.enemies.prevX[i] = x
  world.enemies.prevY[i] = y
  world.enemies.hp[i] = hp
  world.enemies.maxHp[i] = hp
  world.enemies.rootUntil[i] = Number.POSITIVE_INFINITY
  return i
}

function fixedInput(x: number, y: number) {
  const input = createInput()
  input.aim.x = x
  input.aim.y = y
  return input
}

function advance(world: World, seconds: number, aimX: number, aimY: number): void {
  const input = fixedInput(aimX, aimY)
  for (let i = 0; i < Math.ceil(seconds / DT); i += 1) {
    stepWorld(world, input)
  }
}

function skillSetup(
  cls: PlayerClass,
  slot: (typeof QWER)[number],
  damageMul: number,
  branch: string | null = null,
): { world: World; target: number; aimX: number; aimY: number } {
  const world = createWorld(3000 + QWER.indexOf(slot), cls)
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  world.stats.atkDamageMul = damageMul

  const aimX = cls === 'melee' && slot !== 'r' ? 10 : 5
  const aimY = 0
  const targetX =
    cls === 'ranged'
      ? slot === 'w'
        ? 4
        : 5
      : slot === 'q'
        ? 3
        : slot === 'w'
          ? 4
          : slot === 'e'
            ? 3
            : 2
  const target = addTarget(world, targetX, 0)
  world.lastAim.x = aimX
  world.lastAim.y = aimY
  unlockSkill(world.skills, slot, 1)
  world.skills[slot].branch = branch
  assert.equal(castSkill(world, slot), true, `${cls} ${slot} starts`)
  return { world, target, aimX, aimY }
}

function skillLoss(
  cls: PlayerClass,
  slot: (typeof QWER)[number],
  damageMul = 1,
  branch: string | null = null,
): number {
  const { world, target, aimX, aimY } = skillSetup(
    cls,
    slot,
    damageMul,
    branch,
  )
  const seconds =
    cls === 'melee' && slot === 'r'
      ? 5.2
      : slot === 'e'
        ? 1.25
        : slot === 'w'
          ? 2
          : 1
  advance(world, seconds, aimX, aimY)
  return 10_000 - world.enemies.hp[target]!
}

{
  for (const cls of ['ranged', 'melee'] as const) {
    for (const slot of QWER) {
      const world = createWorld(4000 + QWER.indexOf(slot), cls)
      world.spawnEnabled = false
      world.player.attackCooldown = Number.POSITIVE_INFINITY
      world.lastAim.x = 8
      world.lastAim.y = 2
      unlockSkill(world.skills, slot, 1)
      assert.equal(castSkill(world, slot), true)
      assert.equal(world.actionStarts.at(-1)?.kind, slot)
      assert.equal(world.casts.length, 0)

      const timing = playerActionTiming(cls, slot)
      const input = fixedInput(-8, -2)
      while (world.time + DT < timing.impact - 1e-9) stepWorld(world, input)
      assert.equal(world.casts.length, 0, `${cls} ${slot} waits for contact`)
      while (world.casts.length === 0) stepWorld(world, input)
      assert.equal(world.casts.length, 1, `${cls} ${slot} emits one contact`)
      assert.ok(world.time + DT >= timing.impact)

      while (world.playerAction) stepWorld(world, input)
      assert.ok(
        world.time <= timing.duration + 2 * DT,
        `${cls} ${slot} releases after recovery`,
      )
    }
  }
}

{
  const world = createWorld(4100, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  const center = addTarget(world, 4, 0)
  const upper = addTarget(world, 6, 1.45)
  const lower = addTarget(world, 6, -1.45)
  world.lastAim.y = 0
  unlockSkill(world.skills, 'q', 1)
  assert.equal(castSkill(world, 'q'), true)

  const input = fixedInput(10, 0)
  while (world.casts.length === 0) stepWorld(world, input)

  assert.equal(world.enemies.hp[center], 10_000)
  assert.equal(world.enemies.hp[upper], 10_000)
  assert.equal(world.enemies.hp[lower], 10_000)
  assert.equal(world.casts[0]?.targetX, world.player.pos.x)
  assert.equal(world.casts[0]?.targetY, world.player.pos.y)
  assert.ok(world.player.rangedVolleyUntil - world.time > 4.9)

  world.player.attackCooldown = 0
  stepWorld(world, input)
  assert.ok(world.enemies.hp[center]! < 10_000)
  assert.ok(world.enemies.hp[upper]! < 10_000)
  assert.ok(world.enemies.hp[lower]! < 10_000)
  assert.ok(world.tracers.filter((tracer) => tracer.kind === 0).length >= 3)
}

{
  const world = createWorld(4200, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  world.lastAim.x = 6
  unlockSkill(world.skills, 'q', 1)
  unlockSkill(world.skills, 'w', 1)
  assert.equal(castSkill(world, 'q'), true)
  const firstEnd = world.playerAction!.endAt

  const idle = fixedInput(6, 0)
  while (
    world.playerAction &&
    world.playerAction.endAt - world.time >
      PLAYER_ACTION_BUFFER_WINDOW - DT
  ) {
    stepWorld(world, idle)
  }

  const buffered = fixedInput(6, 0)
  buffered.skillsPressed = SKILL_BIT.w
  stepWorld(world, buffered)
  while (!world.actionStarts.some((event) => event.kind === 'w')) {
    stepWorld(world, idle)
  }

  const start = world.actionStarts.find((event) => event.kind === 'w')
  assert.ok(start)
  assert.ok(start.startedAt >= firstEnd)
  assert.ok(start.startedAt - firstEnd <= DT + 1e-9)
  assert.equal(
    world.actionStarts.filter((event) => event.kind === 'w').length,
    1,
  )
}

{
  for (const cls of ['ranged', 'melee'] as const) {
    for (const slot of QWER) {
      if (cls === 'ranged' && slot === 'q') continue
      const normal = skillLoss(cls, slot, 1)
      const strengthened = skillLoss(cls, slot, 2)
      assert.ok(normal > 0, `${cls} ${slot} deals damage`)
      assert.ok(
        Math.abs(strengthened - normal * 2) < 0.08,
        `${cls} ${slot} applies atkDamageMul (${normal} -> ${strengthened})`,
      )
    }
  }
}

{
  const { world, target, aimX, aimY } = skillSetup('ranged', 'e', 1)
  while (world.casts.length === 0) stepWorld(world, fixedInput(aimX, aimY))
  const hpAtLaunch = world.enemies.hp[target]
  const blast = world.blasts[0]
  assert.ok(blast)
  assert.ok(blast.fireAt - world.time >= 0.25)
  while (world.time + DT < blast.fireAt - 1e-9) {
    stepWorld(world, fixedInput(aimX, aimY))
  }
  assert.equal(world.enemies.hp[target], hpAtLaunch)
  while (world.enemies.hp[target] === hpAtLaunch) {
    stepWorld(world, fixedInput(aimX, aimY))
  }
  assert.ok(world.enemies.hp[target]! < hpAtLaunch!)
}

{
  const world = createWorld(4250, 'melee')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  const outer = addTarget(world, 8, 0)
  world.lastAim.x = 8
  unlockSkill(world.skills, 'e', 1)
  assert.equal(castSkill(world, 'e'), true)
  while (world.casts.length === 0) stepWorld(world, fixedInput(8, 0))

  const hpAtGather = world.enemies.hp[outer]
  const distanceAtGather = Math.abs(world.enemies.x[outer]!)
  const slash = world.blasts.find((blast) => blast.kind === 1)
  assert.ok(slash)
  assert.ok(slash.fireAt - world.time >= 0.25)

  advance(world, 0.2, 8, 0)
  assert.equal(world.enemies.hp[outer], hpAtGather)
  assert.ok(Math.abs(world.enemies.x[outer]!) < distanceAtGather)

  advance(world, 0.2, 8, 0)
  assert.ok(world.enemies.hp[outer]! < hpAtGather!)
}

{
  const { world, target, aimX, aimY } = skillSetup('ranged', 'w', 1)
  while (world.casts.length === 0) stepWorld(world, fixedInput(aimX, aimY))
  assert.ok(world.enemies.pullUntil[target]! > world.time)
  assert.equal(world.enemies.pullX[target], 0)
  assert.equal(world.zones[0]?.pushSpeed, 0)
  const before = Math.abs(world.enemies.x[target]!)
  advance(world, 0.45, aimX, aimY)
  assert.ok(Math.abs(world.enemies.x[target]!) < before)
}

{
  const branches: ReadonlyArray<
    readonly [PlayerClass, (typeof QWER)[number], string]
  > = [
    ['ranged', 'w', 'double-collapse'],
    ['ranged', 'e', 'afterimage-aperture'],
    ['melee', 'q', 'returning-draw-cut'],
    ['melee', 'w', 'returning-sheath'],
    ['melee', 'e', 'mirror-counter'],
    ['melee', 'r', 'fullmoon-domain'],
    ['ranged', 'w', 'singularity-interference'],
    ['melee', 'r', 'eclipse-sword-domain'],
  ]

  for (const [cls, slot, branch] of branches) {
    const base = skillLoss(cls, slot)
    const awakened = skillLoss(cls, slot, 1, branch)
    assert.ok(
      awakened > base + 0.05,
      `${branch} changes ${cls} ${slot} damage (${base} -> ${awakened})`,
    )
  }

  const world = createWorld(4300, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  const main = addTarget(world, 5, 0)
  const chained = addTarget(world, 5, 6)
  world.lastAim.x = 10
  unlockSkill(world.skills, 'r', 1)
  world.skills.r.branch = 'heliostat-chain'
  assert.equal(castSkill(world, 'r'), true)
  advance(world, 1, 10, 0)
  assert.ok(world.enemies.hp[main]! < 10_000)
  assert.ok(world.enemies.hp[chained]! < 10_000)
  assert.equal(
    world.tracers.filter((tracer) => tracer.kind === 1).length,
    1,
  )
}

{
  const activateVolley = (
    branch: string | null,
    rank = 0,
  ): { world: World; upper: number; lower: number } => {
    const world = createWorld(4310 + rank, 'ranged')
    world.spawnEnabled = false
    world.player.attackCooldown = Number.POSITIVE_INFINITY
    addTarget(world, 4, 0, 1000)
    const upper = addTarget(world, 6, 1.45, 1000)
    const lower = addTarget(world, 6, -1.45, 1000)
    world.lastAim.x = 10
    unlockSkill(world.skills, 'q', 1)
    world.skills.q.branch = branch
    world.skills.q.rank = rank
    assert.equal(castSkill(world, 'q'), true)
    const input = fixedInput(10, 0)
    while (world.casts.length === 0) stepWorld(world, input)
    world.player.attackCooldown = 0
    stepWorld(world, input)
    return { world, upper, lower }
  }

  const base = activateVolley(null)
  const ranked = activateVolley(null, 1)
  assert.ok(
    ranked.world.enemies.hp[ranked.upper]! <
      base.world.enemies.hp[base.upper]!,
  )

  const extended = activateVolley('orbital-prism')
  assert.ok(extended.world.player.rangedVolleyUntil - extended.world.time > 6.9)

  const gathered = activateVolley('singularity-interference')
  assert.ok(
    gathered.world.enemies.pullUntil[gathered.upper]! > gathered.world.time,
    'Q fusion pulls the upper side-ray target',
  )
  assert.ok(
    gathered.world.enemies.pullUntil[gathered.lower]! > gathered.world.time,
    'Q fusion pulls the lower side-ray target',
  )
}

{
  const world = createWorld(4301, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  world.player.hp = 100
  const contact = addTarget(world, 0, 0)
  world.lastAim.x = 10
  unlockSkill(world.skills, 'r', 1)

  assert.equal(castSkill(world, 'r'), true)
  const actionEnd = world.playerAction?.endAt
  assert.ok(actionEnd !== undefined)
  assert.equal(actionEnd, playerActionTiming('ranged', 'r').duration)
  assert.equal(world.player.invulnUntil, actionEnd)

  const protectedTicks = Math.round(actionEnd / DT)
  for (let tick = 0; tick < protectedTicks; tick += 1) {
    stepWorld(world, fixedInput(10, 0))
  }
  assert.equal(world.time, actionEnd)
  assert.equal(world.player.hp, 100)
  world.enemies.x[contact] = world.player.pos.x
  world.enemies.y[contact] = world.player.pos.y
  world.enemies.prevX[contact] = world.player.pos.x
  world.enemies.prevY[contact] = world.player.pos.y
  world.enemies.vx[contact] = 0
  world.enemies.vy[contact] = 0
  stepWorld(world, fixedInput(10, 0))
  assert.ok(world.player.hp < 100)
}

{
  const rangedTraits = new Set([
    'orbital-prism',
    'singularity-interference',
    'double-collapse',
    'afterimage-aperture',
    'heliostat-chain',
  ])
  const meleeTraits = new Set([
    'returning-draw-cut',
    'returning-sheath',
    'afterimage-step',
    'mirror-counter',
    'fullmoon-domain',
    'eclipse-sword-domain',
  ])
  const ranged = (id: SkillId) =>
    getSkillDamageBreakdown('ranged', id, {
      damageMultiplier: 2,
      attackDamage: 40,
      hasTrait: (trait) => rangedTraits.has(trait),
    })
  const melee = (id: SkillId) =>
    getSkillDamageBreakdown('melee', id, {
      damageMultiplier: 2,
      attackDamage: 40,
      hasTrait: (trait) => meleeTraits.has(trait),
    })

  assert.equal(ranged('q'), '강화 평타 중심 40 / 양옆 각각 24')
  assert.equal(
    getSkillDamageBreakdown('ranged', 'q', {
      damageMultiplier: 2,
      attackDamage: 40,
      hasTrait: (trait) => trait === 'split-refraction',
    }),
    '강화 평타 중심 40 / 양옆 각각 30',
  )
  assert.equal(ranged('w'), '기본 14 × 12회 · 중심 폭발 75.6')
  assert.equal(ranged('e'), '기본 320 + 12 × 12회 · 경로 잔광 112')
  assert.equal(ranged('r'), '기본 3,400 · 굴절 대상당 850')
  assert.equal(melee('q'), '기본 선두 192 / 후속 104 · 귀환 참격 105.6')
  assert.equal(
    melee('w'),
    '기본 경로 120 + 착지 120 · 귀환 납도 66 · 무영보 잔상 26',
  )
  assert.equal(melee('e'), '기본 280 · 반격 참격 196')
  assert.equal(
    melee('r'),
    '기본 520 × 5 + 860 · 교차 발도 182 × 5 + 301 · 만월 결계 68.8 × 8회',
  )
  assert.equal(melee('f'), '무영보 잔상 26')

  for (const meta of DAMAGE_TRAIT_META) {
    assert.ok(meta.affectsSlots.length > 0, `${meta.trait} tooltip slot metadata`)
  }
}

{
  const pierce = createWorld(4350, 'ranged')
  pierce.spawnEnabled = false
  pierce.stats.atkPierce = 2
  pierce.upgradesTaken.add(upgradeTraitToken('pierce-amplification'))
  const first = addTarget(pierce, 3, 0, 1000)
  const second = addTarget(pierce, 6, 0, 1000)
  stepWorld(pierce, fixedInput(10, 0))
  const firstLoss = 1000 - pierce.enemies.hp[first]!
  const secondLoss = 1000 - pierce.enemies.hp[second]!
  assert.ok(secondLoss > firstLoss)

  const split = createWorld(4351, 'ranged')
  split.spawnEnabled = false
  split.upgradesTaken.add(upgradeTraitToken('split-refraction'))
  addTarget(split, 4, 0, 1000)
  const upper = addTarget(split, 6, 1.45, 1000)
  const lower = addTarget(split, 6, -1.45, 1000)
  for (let shot = 0; shot < 3; shot += 1) {
    split.player.attackCooldown = 0
    stepWorld(split, fixedInput(10, 0))
  }
  assert.equal(split.basicAttackSequence, 3)
  assert.ok(split.enemies.hp[upper]! < 1000)
  assert.ok(split.enemies.hp[lower]! < 1000)

  const focus = createWorld(4352, 'ranged')
  focus.spawnEnabled = false
  focus.stats.atkPierce = 1
  focus.upgradesTaken.add(upgradeTraitToken('horizon-focus'))
  addTarget(focus, 12, 0, 1000)
  const focusTarget = addTarget(focus, 14.2, 1.6, 1000)
  stepWorld(focus, fixedInput(15, 0))
  assert.ok(focus.enemies.hp[focusTarget]! < 1000)
  assert.ok(focus.rings.some((ring) => ring.radius === 2.2))

  const echo = createWorld(4353, 'melee')
  echo.spawnEnabled = false
  echo.upgradesTaken.add(upgradeTraitToken('echoing-crescent'))
  const echoTarget = addTarget(echo, 2, 0, 1000)
  echo.player.empowered = true
  echo.player.gauge = 100
  stepWorld(echo, fixedInput(5, 0))
  const afterFirstCut = echo.enemies.hp[echoTarget]!
  assert.ok(echo.blasts.some((blast) => blast.fireAt > echo.time))
  advance(echo, 0.5, 5, 0)
  assert.ok(echo.enemies.hp[echoTarget]! < afterFirstCut)

  const afterimage = createWorld(4354, 'melee')
  afterimage.spawnEnabled = false
  afterimage.player.attackCooldown = Number.POSITIVE_INFINITY
  afterimage.upgradesTaken.add(upgradeTraitToken('afterimage-step'))
  const afterimageTarget = addTarget(afterimage, 1, 0, 1000)
  const flash = fixedInput(8, 0)
  flash.skillsPressed = SKILL_BIT.f
  stepWorld(afterimage, flash)
  assert.ok(afterimage.blasts.some((blast) => blast.x === 0))
  advance(afterimage, 0.4, 8, 0)
  assert.ok(afterimage.enemies.hp[afterimageTarget]! < 1000)

  const overflow = createWorld(4355, 'melee')
  overflow.spawnEnabled = false
  overflow.upgradesTaken.add(upgradeTraitToken('overflow-guard'))
  const heal = fixedInput(1, 0)
  heal.skillsPressed = SKILL_BIT.d
  stepWorld(overflow, heal)
  assert.ok(overflow.player.invulnUntil >= 0.65)

  const photon = createWorld(4356, 'ranged')
  photon.spawnEnabled = false
  photon.player.attackCooldown = Number.POSITIVE_INFINITY
  photon.player.hp = 0.05
  photon.upgradesTaken.add(upgradeTraitToken('photon-barrier'))
  addTarget(photon, 0, 0, 1000)
  stepWorld(photon, fixedInput(1, 0))
  assert.equal(photon.player.hp, 0.05)
  assert.ok(photon.player.invulnUntil > photon.time)
  assert.ok(photon.upgradesTaken.has('state:photon-barrier:spent'))

  const guard = createWorld(4357, 'melee')
  guard.spawnEnabled = false
  guard.player.attackCooldown = Number.POSITIVE_INFINITY
  guard.player.hp = 1
  guard.player.gauge = 0
  guard.upgradesTaken.add(upgradeTraitToken('perfect-guard'))
  addTarget(guard, 0, 0, 1000)
  stepWorld(guard, fixedInput(1, 0))
  assert.equal(guard.player.hp, 1)
  assert.ok(guard.player.gauge >= 35 && guard.player.gauge < 36)
  assert.ok(guard.upgradesTaken.has('state:perfect-guard:spent'))
}

function setupBossAt(x: number, y: number) {
  const pool = createEnemyPool()
  const hash = createEnemyHash()
  const rng = createRng(4400)
  assert.equal(spawnBoss(pool, rng, 0, 0), true)
  const i = pool.count - 1
  assert.equal(pool.type[i], TYPE_BOSS)
  pool.x[i] = x
  pool.y[i] = y
  pool.prevX[i] = x
  pool.prevY[i] = y
  pool.vx[i] = 0
  pool.vy[i] = 0
  return { pool, hash, i }
}

function stepBoss(
  state: ReturnType<typeof setupBossAt>,
  now: number,
  px: number,
  py: number,
) {
  rebuildEnemyHash(state.pool, state.hash)
  return stepEnemies(state.pool, state.hash, px, py, 0.55, now, 0)
}

{
  const windupStart = BOSS_INTRO_DURATION + BOSS_WINDUP_AT
  const chargeStart = BOSS_INTRO_DURATION + BOSS_CHARGE_AT
  const recoverStart = BOSS_INTRO_DURATION + BOSS_RECOVER_AT
  assert.equal(bossPhaseAt(windupStart, 0), 'windup')
  assert.equal(bossPhaseAt(chargeStart, 0), 'charge')

  const frozen = setupBossAt(-9, 0)
  for (let now = windupStart; now < chargeStart; now += DT) {
    stepBoss(frozen, now, 0, 0)
  }
  assert.ok(frozen.pool.bossChargeDirX[frozen.i]! > 0.99)
  assert.ok(Math.abs(frozen.pool.bossChargeDirY[frozen.i]!) < 1e-6)

  for (let now = chargeStart; now < chargeStart + 0.55; now += DT) {
    stepBoss(frozen, now, 0, 10)
  }
  assert.ok(frozen.pool.vx[frozen.i]! > 12)
  assert.ok(Math.abs(frozen.pool.vy[frozen.i]!) < 0.1)
  assert.ok(BOSS_CHARGE_SPEED > 10.5)

  const threat = setupBossAt(-9, 0)
  for (let now = windupStart; now < chargeStart; now += DT) {
    stepBoss(threat, now, 0, 0)
  }
  let contactDamage = 0
  for (let now = chargeStart; now < recoverStart; now += DT) {
    contactDamage += stepBoss(threat, now, 0, 0).contactDamage
  }
  assert.ok(contactDamage > 8, `boss charge damage=${contactDamage}`)

  const runner = setupBossAt(-9, 0)
  let runnerX = 0
  for (let now = windupStart; now < chargeStart; now += DT) {
    runnerX += 10 * DT
    stepBoss(runner, now, runnerX, 0)
  }
  let runnerDamage = 0
  for (let now = chargeStart; now < recoverStart; now += DT) {
    runnerX += 10 * DT
    runnerDamage += stepBoss(runner, now, runnerX, 0).contactDamage
  }
  assert.ok(
    runnerDamage > 0,
    `boss must catch a straight-line runner, damage=${runnerDamage}`,
  )

  const dodger = setupBossAt(-9, 0)
  for (let now = windupStart; now < chargeStart; now += DT) {
    stepBoss(dodger, now, 0, 0)
  }
  let dodgeY = 0
  let dodgeDamage = 0
  for (let now = chargeStart; now < recoverStart; now += DT) {
    dodgeY += 10 * DT
    dodgeDamage += stepBoss(dodger, now, 0, dodgeY).contactDamage
  }
  assert.equal(dodgeDamage, 0, `side-step remains a valid answer, damage=${dodgeDamage}`)
}

function setupBossWorld(seed = 4500): { world: World; bossIndex: number } {
  const world = createWorld(seed, 'ranged')
  world.spawnEnabled = false
  world.player.attackCooldown = Number.POSITIVE_INFINITY
  assert.equal(
    spawnBoss(world.enemies, world.rng, world.player.pos.x, world.player.pos.y),
    true,
  )
  const bossIndex = world.enemies.count - 1
  world.enemies.x[bossIndex] = 0
  world.enemies.y[bossIndex] = 0
  world.enemies.prevX[bossIndex] = 0
  world.enemies.prevY[bossIndex] = 0
  world.enemies.vx[bossIndex] = 0
  world.enemies.vy[bossIndex] = 0
  world.boss.spawned = true
  world.boss.spawnedAt = 0
  world.boss.active = true
  world.boss.hp = BOSS_MAX_HP
  assert.equal(world.enemies.hp[bossIndex], BOSS_MAX_HP)
  return { world, bossIndex }
}

function addTypedTarget(
  world: World,
  type: number,
  x: number,
  y: number,
): number {
  spawnEnemy(
    world.enemies,
    world.rng,
    world.player.pos.x,
    world.player.pos.y,
    type,
    world.time,
  )
  const i = world.enemies.count - 1
  world.enemies.x[i] = x
  world.enemies.y[i] = y
  world.enemies.prevX[i] = x
  world.enemies.prevY[i] = y
  return i
}

function startPhaseTwoForHazardTest(
  world: World,
  phaseTwoAt = 0,
): void {
  world.boss.phaseTwoAt = phaseTwoAt
  world.boss.invulnerableUntil =
    phaseTwoAt + BOSS_PHASE_TWO_TRANSITION_DURATION
  world.boss.hazardCycle = -1
  world.boss.recoverBlastCycle = -1
  world.boss.nextHazardVolley = 0
  world.boss.lastHazardHitVolley = -1
  world.boss.hazardDetonations = 0
  world.hostileHazards.length = 0
  world.time = phaseTwoAt + BOSS_PHASE_TWO_TRANSITION_DURATION
  world.tick = Math.round(world.time / DT)
}

{
  assert.equal(BOSS_PHASE_TWO_THRESHOLD, 1300)
  assert.equal(BOSS_PHASE_TWO_THRESHOLD, BOSS_MAX_HP / 2)
  // 비율을 그대로 박아 두지 않는다. 이 검사가 지켜야 할 것은 특정 숫자가
  // 아니라 **한 방에 2페이즈 게이트를 건너뛸 수 없다**는 성질이다. 상한이
  // 50% 미만이면 첫 타 뒤 반드시 절반 위에 남고 두 번째 타에서 게이트를
  // 통과한다. 숫자를 고정하면 튜닝할 때마다 이 검사가 의미 없이 실패한다.
  assert.ok(
    BOSS_SINGLE_HIT_DAMAGE_CAP_RATIO > 0 &&
      BOSS_SINGLE_HIT_DAMAGE_CAP_RATIO < 0.5,
    `보스 일격 상한은 0~50% 사이여야 페이즈 게이트가 보장된다 — ` +
      `${BOSS_SINGLE_HIT_DAMAGE_CAP_RATIO}`,
  )

  const { world, bossIndex } = setupBossWorld()
  world.time = 50
  world.tick = Math.round(world.time / DT)
  world.enemies.vx[bossIndex] = 7
  world.enemies.vy[bossIndex] = -3
  world.enemies.pushVx[bossIndex] = 4
  world.enemies.pushVy[bossIndex] = 2
  world.enemies.bossChargeDirX[bossIndex] = 1
  world.enemies.bossChargeDirY[bossIndex] = 0.5
  world.enemies.bossChargeCycle[bossIndex] = 6

  const hitCap = BOSS_MAX_HP * BOSS_SINGLE_HIT_DAMAGE_CAP_RATIO
  assert.equal(damageEnemy(world, bossIndex, BOSS_MAX_HP * 4), false)
  assert.equal(world.enemies.hp[bossIndex], BOSS_MAX_HP - hitCap)
  assert.equal(world.boss.hp, BOSS_MAX_HP - hitCap)
  assert.equal(world.boss.phaseTwoAt, -1)
  assert.ok(world.enemies.hp[bossIndex]! > BOSS_PHASE_TWO_THRESHOLD)
  assert.deepEqual(
    world.damageFeedback.at(-1),
    {
      x: 0,
      y: 0,
      amount: hitCap,
      hpAfter: BOSS_MAX_HP - hitCap,
      maxHp: BOSS_MAX_HP,
      enemyType: TYPE_BOSS,
      lethal: false,
      capped: true,
    },
  )

  // 최대 피해를 계속 넣어도 **한 타가 50% 게이트를 건너뛰지 못한다.**
  //
  // 몇 번째 타에서 게이트에 닿는지는 상한 비율에 따라 달라지므로 횟수를
  // 고정하지 않는다. 지켜야 할 성질은 두 가지다 — 게이트를 반드시 한 번
  // 밟는다는 것, 그리고 게이트 위에서 한 방에 죽지 않는다는 것. 상한을
  // 제거하면 첫 타가 곧바로 0까지 내려가 두 조건이 함께 깨진다.
  let visitedGate = world.enemies.hp[bossIndex] === BOSS_PHASE_TWO_THRESHOLD
  for (let hit = 0; hit < 12 && world.enemies.hp[bossIndex]! > 0; hit++) {
    const before = world.enemies.hp[bossIndex]!
    damageEnemy(world, bossIndex, BOSS_MAX_HP * 4)
    const after = world.enemies.hp[bossIndex]!
    if (before > BOSS_PHASE_TWO_THRESHOLD) {
      assert.ok(
        after > 0,
        '게이트 위에서 한 타에 즉사할 수 없다',
      )
    }
    if (after === BOSS_PHASE_TWO_THRESHOLD) {
      // 게이트에 닿으면 멈춘다. 아래 검사들이 전환 순간의 무적·정지·링을
      // 확인하므로, 계속 때려서 지나쳐 버리면 그 상태를 볼 수 없다.
      visitedGate = true
      break
    }
  }
  assert.ok(visitedGate, '보스는 반드시 50% 게이트를 한 번 밟는다')
  assert.ok(world.boss.phaseTwoAt >= 0, '2페이즈가 실제로 열린다')
  assert.equal(world.boss.hp, BOSS_PHASE_TWO_THRESHOLD)
  assert.equal(world.boss.phaseTwoAt, 50)
  assert.equal(
    world.boss.invulnerableUntil,
    50 + BOSS_PHASE_TWO_TRANSITION_DURATION,
  )
  assert.equal(bossPhaseAt(50, 0, world.boss.phaseTwoAt), 'transition')
  assert.notEqual(bossPhaseAt(49, 0, world.boss.phaseTwoAt), 'transition')
  assert.equal(world.enemies.vx[bossIndex], 0)
  assert.equal(world.enemies.vy[bossIndex], 0)
  assert.equal(world.enemies.pushVx[bossIndex], 0)
  assert.equal(world.enemies.pushVy[bossIndex], 0)
  assert.equal(world.enemies.bossChargeCycle[bossIndex], -1)
  assert.deepEqual(
    world.rings.filter((ring) => ring.kind === 5),
    [
      {
        x: 0,
        y: 0,
        radius: BOSS_PHASE_TWO_KNOCKBACK_RADIUS,
        kind: 5,
      },
    ],
  )
  const shockwaves = world.hostileHazards.filter(
    (hazard) => hazard.kind === 'phase-shockwave',
  )
  assert.equal(shockwaves.length, 2)
  assert.equal(shockwaves[0]?.radius, BOSS_PHASE_SHOCKWAVE_INNER_RADIUS)
  assert.equal(shockwaves[0]?.damage, BOSS_PHASE_SHOCKWAVE_INNER_DAMAGE)
  assert.equal(
    shockwaves[0]?.detonateAt,
    world.time + BOSS_PHASE_SHOCKWAVE_INNER_WARNING_DURATION,
  )
  assert.equal(shockwaves[1]?.radius, BOSS_PHASE_SHOCKWAVE_RADIUS)
  assert.equal(shockwaves[1]?.damage, BOSS_PHASE_SHOCKWAVE_DAMAGE)
  assert.equal(
    shockwaves[1]?.detonateAt,
    world.time + BOSS_PHASE_SHOCKWAVE_WARNING_DURATION,
  )
  assert.notEqual(shockwaves[0]?.volley, shockwaves[1]?.volley)

  const transitionAt = world.boss.phaseTwoAt
  const hpAtGate = world.enemies.hp[bossIndex]
  world.time = world.boss.invulnerableUntil - DT
  assert.equal(damageEnemy(world, bossIndex, 100), false)
  assert.equal(world.enemies.hp[bossIndex], hpAtGate)
  assert.equal(world.boss.phaseTwoAt, transitionAt)
  assert.equal(triggerBossPhaseTwo(world, bossIndex), false)
  assert.equal(world.rings.filter((ring) => ring.kind === 5).length, 1)

  world.time = world.boss.invulnerableUntil
  assert.equal(
    bossPhaseAt(world.time, world.boss.spawnedAt, world.boss.phaseTwoAt),
    'windup',
  )
  assert.equal(
    bossCycleTime(world.time, world.boss.spawnedAt, world.boss.phaseTwoAt),
    BOSS_PHASE_TWO_OPENING_CYCLE_AT,
  )
  assert.equal(
    bossCycleIndex(world.time, world.boss.spawnedAt, world.boss.phaseTwoAt),
    0,
  )
  damageEnemy(world, bossIndex, 100)
  assert.equal(world.enemies.hp[bossIndex], hpAtGate - 100)
  assert.equal(world.boss.phaseTwoAt, transitionAt)
  assert.equal(
    bossCycleIndex(
      world.time + BOSS_CYCLE_TIME,
      world.boss.spawnedAt,
      world.boss.phaseTwoAt,
    ),
    1,
  )

  const inactive = createWorld(4501)
  inactive.spawnEnabled = false
  spawnBoss(inactive.enemies, inactive.rng, 0, 0)
  const inactiveBoss = inactive.enemies.count - 1
  assert.equal(inactive.boss.active, false)
  // 필요한 타수는 상한 비율에서 나온다. 숫자를 박아 두면 비율을 조정할
  // 때마다 이 검사가 의미 없이 실패한다.
  const hitsToKill = Math.ceil(1 / BOSS_SINGLE_HIT_DAMAGE_CAP_RATIO)
  for (let hit = 0; hit < hitsToKill - 1; hit += 1) {
    assert.equal(
      damageEnemy(inactive, inactiveBoss, BOSS_MAX_HP),
      false,
      `상한이 걸린 ${hit + 1}번째 타는 보스를 죽이지 못한다`,
    )
  }
  assert.equal(damageEnemy(inactive, inactiveBoss, BOSS_MAX_HP), true)
  assert.equal(inactive.enemies.hp[inactiveBoss], 0)
  assert.equal(inactive.boss.phaseTwoAt, -1)

  const eliteWorld = createWorld(4502)
  eliteWorld.spawnEnabled = false
  const eliteIndex = addTypedTarget(eliteWorld, TYPE_ELITE, 0, 0)
  const eliteHp = eliteWorld.enemies.hp[eliteIndex]!
  assert.equal(damageEnemy(eliteWorld, eliteIndex, eliteHp * 4), true)
  assert.equal(eliteWorld.enemies.hp[eliteIndex], 0)
  assert.equal(eliteWorld.damageFeedback.at(-1)?.amount, eliteHp)
  assert.equal(eliteWorld.damageFeedback.at(-1)?.capped, false)
}

{
  const { world, bossIndex } = setupBossWorld(4510)
  world.enemies.x[bossIndex] = 2
  world.enemies.y[bossIndex] = -1
  const walker = addTypedTarget(world, TYPE_WALKER, 5, -1)
  const bruteOnBoss = addTypedTarget(world, TYPE_BRUTE, 2, -1)
  const outside = addTypedTarget(
    world,
    TYPE_WALKER,
    2 + BOSS_PHASE_TWO_KNOCKBACK_RADIUS + 0.01,
    -1,
  )
  const elite = addTypedTarget(world, TYPE_ELITE, 4, -1)

  assert.equal(triggerBossPhaseTwo(world, bossIndex), true)
  assert.ok(
    Math.hypot(
      world.enemies.pushVx[walker]!,
      world.enemies.pushVy[walker]!,
    ) > 0,
  )
  assert.ok(
    Math.hypot(
      world.enemies.pushVx[bruteOnBoss]!,
      world.enemies.pushVy[bruteOnBoss]!,
    ) > 0,
  )
  assert.equal(world.enemies.pushVx[outside], 0)
  assert.equal(world.enemies.pushVy[outside], 0)
  assert.equal(world.enemies.pushVx[elite], 0)
  assert.equal(world.enemies.pushVy[elite], 0)
}

{
  const { world } = setupBossWorld(4520)
  startPhaseTwoForHazardTest(world)
  world.player.pos.x = 23
  world.player.pos.y = 0
  world.player.vel.x = 20
  world.player.vel.y = 0

  assert.equal(stepBossEncounter(world), 0)
  assert.equal(world.hostileHazards.length, 2)
  const [current, predicted] = world.hostileHazards
  assert.equal(current?.kind, 'phase-zone')
  assert.equal(predicted?.kind, 'phase-zone')
  assert.equal(current?.x, 23)
  assert.equal(current?.radius, BOSS_PHASE_ZONE_RADIUS)
  assert.equal(current?.damage, BOSS_PHASE_ZONE_DAMAGE)
  assert.equal(
    current?.detonateAt,
    world.time + BOSS_PHASE_ZONE_WARNING_DURATION,
  )
  assert.equal(current?.volley, predicted?.volley)
  assert.equal(
    predicted?.x,
    world.arenaRadius - BOSS_PHASE_ZONE_RADIUS,
  )
  assert.ok(
    Math.abs(
      23 +
        world.player.vel.x * BOSS_PHASE_ZONE_PREDICTION_SECONDS -
        predicted!.x,
    ) > 0,
  )
  assert.ok(
    Math.hypot(predicted!.x, predicted!.y) <=
      world.arenaRadius - BOSS_PHASE_ZONE_RADIUS + 1e-9,
  )
  assert.equal(world.boss.nextHazardVolley, 1)
  assert.equal(stepBossEncounter(world), 0)
  assert.equal(world.hostileHazards.length, 2)
}

{
  const { world } = setupBossWorld(4530)
  startPhaseTwoForHazardTest(world)
  world.player.pos.x = 0
  world.player.pos.y = 0
  world.player.vel.x = 0
  world.player.vel.y = 0

  stepBossEncounter(world)
  assert.equal(world.hostileHazards.length, 2)
  assert.equal(world.boss.hazardDetonations, 0)
  world.time = world.hostileHazards[0]!.detonateAt
  assert.equal(stepBossEncounter(world), BOSS_PHASE_ZONE_DAMAGE)
  assert.equal(world.hostileHazards.length, 0)
  assert.equal(world.boss.hazardDetonations, 1)
  assert.equal(stepBossEncounter(world), 0)
  assert.equal(world.boss.hazardDetonations, 1)
}

{
  const { world, bossIndex } = setupBossWorld(4540)
  startPhaseTwoForHazardTest(world)
  const patternStart =
    world.boss.phaseTwoAt + BOSS_PHASE_TWO_TRANSITION_DURATION
  world.time =
    patternStart + BOSS_RECOVER_AT - BOSS_PHASE_TWO_OPENING_CYCLE_AT
  world.tick = Math.round(world.time / DT)
  world.boss.hazardCycle = 0
  world.enemies.x[bossIndex] = 10
  world.enemies.y[bossIndex] = -4
  world.enemies.prevX[bossIndex] = 10
  world.enemies.prevY[bossIndex] = -4
  world.enemies.vx[bossIndex] = 18
  world.enemies.vy[bossIndex] = 3
  world.enemies.bossChargeDirX[bossIndex] = 1
  world.enemies.bossChargeDirY[bossIndex] = 0

  stepWorld(world, fixedInput(0, 0))
  const blast = world.hostileHazards.find(
    (hazard) => hazard.kind === 'charge-end',
  )
  assert.ok(blast)
  assert.equal(blast.x, 10)
  assert.equal(blast.y, -4)
  assert.equal(blast.radius, BOSS_RECOVER_BLAST_RADIUS)
  assert.equal(blast.damage, BOSS_RECOVER_BLAST_DAMAGE)
  assert.ok(
    Math.abs(
      blast.detonateAt -
        blast.telegraphAt -
        BOSS_RECOVER_BLAST_WARNING_DURATION,
    ) < 1e-9,
  )
  assert.equal(
    world.hostileHazards.filter((hazard) => hazard.kind === 'charge-end')
      .length,
    1,
  )
  const trail = world.hostileHazards.filter(
    (hazard) => hazard.kind === 'charge-trail',
  )
  assert.equal(trail.length, BOSS_CHARGE_TRAIL_COUNT)
  for (let i = 0; i < trail.length; i += 1) {
    assert.equal(trail[i]?.radius, BOSS_CHARGE_TRAIL_RADIUS)
    assert.equal(trail[i]?.damage, BOSS_CHARGE_TRAIL_DAMAGE)
    assert.ok(
      Math.abs(
        trail[i]!.x -
          (10 - BOSS_CHARGE_TRAIL_SPACING * (i + 1)),
      ) < 1e-6,
    )
    assert.ok(
      Math.abs(
        trail[i]!.detonateAt -
          trail[i]!.telegraphAt -
          BOSS_CHARGE_TRAIL_WARNING_DURATION,
      ) < 1e-9,
    )
  }

  world.player.pos.x = blast.x
  world.player.pos.y = blast.y
  world.player.vel.x = 0
  world.player.vel.y = 0
  world.boss.hazardCycle = 1
  world.time = blast.detonateAt
  assert.equal(stepBossEncounter(world), BOSS_RECOVER_BLAST_DAMAGE)
  assert.equal(
    world.hostileHazards.some((hazard) => hazard.kind === 'charge-end'),
    false,
  )
  assert.equal(world.boss.hazardDetonations, 1)
}

{
  const left = setupBossWorld(4550).world
  const right = setupBossWorld(4550).world
  startPhaseTwoForHazardTest(left)
  startPhaseTwoForHazardTest(right)
  const rngBefore = [
    left.rng.state(),
    left.choiceRng.state(),
    left.pickupRng.state(),
  ]

  const firstTick = Math.round(left.time / DT)
  const lastTick = firstTick + Math.round(16 / DT)
  for (let tick = firstTick; tick <= lastTick; tick += 1) {
    const time = tick * DT
    const x = Math.sin(tick * 0.017) * 20
    const y = Math.cos(tick * 0.013) * 18
    const vx = Math.cos(tick * 0.017) * 7.5
    const vy = -Math.sin(tick * 0.013) * 6.25
    for (const world of [left, right]) {
      world.tick = tick
      world.time = time
      world.player.pos.x = x
      world.player.pos.y = y
      world.player.vel.x = vx
      world.player.vel.y = vy
    }
    const leftDamage = stepBossEncounter(left)
    const rightDamage = stepBossEncounter(right)
    assert.equal(leftDamage, rightDamage)
    assert.deepEqual(left.hostileHazards, right.hostileHazards)
    assert.deepEqual(left.boss, right.boss)
  }
  assert.deepEqual(
    [
      left.rng.state(),
      left.choiceRng.state(),
      left.pickupRng.state(),
    ],
    rngBefore,
  )
  assert.deepEqual(
    [
      right.rng.state(),
      right.choiceRng.state(),
      right.pickupRng.state(),
    ],
    rngBefore,
  )
}

{
  const { world } = setupBossWorld(4560)
  startPhaseTwoForHazardTest(world)
  world.time = 2.5
  world.tick = Math.round(world.time / DT)
  world.boss.hazardCycle = bossCycleIndex(
    world.time,
    world.boss.spawnedAt,
    world.boss.phaseTwoAt,
  )
  world.enemies.x[0] = 20
  world.enemies.y[0] = 0
  world.player.hp = world.stats.maxHp
  world.hostileHazards.push({
    kind: 'phase-zone',
    x: world.player.pos.x,
    y: world.player.pos.y,
    radius: BOSS_PHASE_ZONE_RADIUS,
    damage: BOSS_PHASE_ZONE_DAMAGE,
    telegraphAt: world.time - BOSS_PHASE_ZONE_WARNING_DURATION,
    detonateAt: world.time,
    volley: 99,
  })
  world.boss.nextHazardVolley = 100

  const hpBefore = world.player.hp
  stepWorld(world, fixedInput(0, 0))
  assert.ok(
    Math.abs(
      world.player.hp -
        (hpBefore - BOSS_PHASE_ZONE_DAMAGE * world.stats.damageTakenMul),
    ) < 1e-9,
  )
  assert.equal(world.boss.hazardDetonations, 1)
}

console.log(
  'Combat check passed: retarget, buffer, QWER scaling, awakenings, boss threat + phase 2',
)
