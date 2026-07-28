import assert from 'node:assert/strict'
import {
  DAMAGE_TRAIT_META,
  getSkillDamageBreakdown,
} from '../src/content/skills.ts'
import { PLAYER_ACTION_BUFFER_WINDOW } from '../src/sim/actions.ts'
import { playerActionTiming } from '../src/sim/action-timing.ts'
import { DT } from '../src/sim/constants.ts'
import {
  BOSS_CHARGE_AT,
  BOSS_CHARGE_SPEED,
  BOSS_INTRO_DURATION,
  BOSS_RECOVER_AT,
  BOSS_WINDUP_AT,
  TYPE_BOSS,
  TYPE_WALKER,
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
  const oldTarget = addTarget(world, 6, 0)
  const newTarget = addTarget(world, -6, 0)
  const nearbyTarget = addTarget(world, -6, 2.4)
  world.lastAim.x = 6
  world.lastAim.y = 0
  unlockSkill(world.skills, 'q', 1)
  assert.equal(castSkill(world, 'q'), true)

  const input = fixedInput(-6, 0)
  input.move.y = 1
  while (world.casts.length === 0) stepWorld(world, input)

  assert.equal(world.enemies.hp[oldTarget], 10_000)
  assert.ok(world.enemies.hp[newTarget]! < 10_000)
  assert.ok(world.enemies.hp[nearbyTarget]! < 10_000)
  assert.equal(world.casts[0]?.targetX, -6)
  assert.equal(world.casts[0]?.targetY, 0)
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
    ['ranged', 'q', 'orbital-prism'],
    ['ranged', 'w', 'double-collapse'],
    ['ranged', 'e', 'afterimage-aperture'],
    ['melee', 'q', 'returning-draw-cut'],
    ['melee', 'w', 'returning-sheath'],
    ['melee', 'e', 'mirror-counter'],
    ['melee', 'r', 'fullmoon-domain'],
    ['ranged', 'q', 'singularity-interference'],
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

  assert.equal(ranged('q'), '기본 270 · 귀환 낙광 148.5 · 특이점 54 × 4회')
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

console.log('Combat check passed: retarget, buffer, QWER scaling, awakenings, boss threat')
