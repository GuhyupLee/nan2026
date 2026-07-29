import assert from 'node:assert/strict'

import {
  BOSS_PHASE_THREE_ZONE_INTERVAL,
  bossPhaseThreeThreshold,
  bossPhaseTwoThreshold,
  stepBossEncounter,
} from '../src/sim/boss.ts'
import { DT } from '../src/sim/constants.ts'
import {
  FULLMOON_BOSS_SINGLE_HIT_DAMAGE_CAP_RATIO,
  damageEnemy,
} from '../src/sim/damage.ts'
import { difficultyRules } from '../src/sim/difficulty.ts'
import {
  BOSS_MAX_HP,
  BOSS_PHASE_THREE_CYCLE_TIME,
  BOSS_PHASE_TWO_TRANSITION_DURATION,
  TYPE_BOSS,
  TYPE_WALKER,
  bossPhaseAt,
  spawnBoss,
  spawnEnemy,
} from '../src/sim/enemies.ts'
import {
  MAX_LEVEL,
  REPEAT_SKILL_XP_BASE,
  repeatSkillXpRequirement,
  xpToNext,
} from '../src/sim/progression.ts'
import { computeScore } from '../src/sim/score.ts'
import { createInput } from '../src/sim/types.ts'
import type { World } from '../src/sim/types.ts'
import { createWorld, grantXp, stepWorld } from '../src/sim/world.ts'

const rules = difficultyRules('fullmoon')
assert.equal(rules.bossSpawnTime, 600)
assert.equal(rules.runTimeLimit, 720)
assert.equal(rules.bossMaxHp, 19_152)
assert.equal(rules.bossPhaseCount, 3)
assert.equal(rules.enemySpeedMultiplier, 1.18)
assert.equal(rules.contactDamageMultiplier, 1.5)
assert.equal(rules.bossHazardDamageMultiplier, 1.3)
assert.equal(rules.scoreMultiplier, 2.25)
assert.ok(Math.abs(BOSS_PHASE_THREE_CYCLE_TIME - 5.6) < 1e-9)
assert.equal(BOSS_PHASE_THREE_ZONE_INTERVAL, 1.45)

function bossWorld(seed: number): { world: World; bossIndex: number } {
  const world = createWorld(seed, 'ranged', { difficulty: 'fullmoon' })
  assert.equal(
    spawnBoss(
      world.enemies,
      world.rng,
      world.player.pos.x,
      world.player.pos.y,
      rules.bossMaxHp / BOSS_MAX_HP,
    ),
    true,
  )
  const bossIndex = world.enemies.count - 1
  assert.equal(world.enemies.type[bossIndex], TYPE_BOSS)
  world.time = rules.bossSpawnTime + 10
  world.tick = Math.round(world.time / DT)
  world.boss.spawned = true
  world.boss.spawnedAt = rules.bossSpawnTime
  world.boss.active = true
  world.boss.hp = rules.bossMaxHp
  world.boss.maxHp = rules.bossMaxHp
  return { world, bossIndex }
}

{
  const world = createWorld(91, 'ranged', { difficulty: 'fullmoon' })
  for (let i = 0; i < 80; i += 1) {
    spawnEnemy(
      world.enemies,
      world.rng,
      world.player.pos.x,
      world.player.pos.y,
      TYPE_WALKER,
      rules.bossSpawnTime,
    )
  }
  assert.ok(world.enemies.count > rules.bossArenaTarget)
  world.tick = Math.round(rules.bossSpawnTime / DT)
  world.time = world.tick * DT
  world.player.invulnUntil = Number.POSITIVE_INFINITY
  stepWorld(world, createInput())
  assert.equal(world.boss.spawned, true, '만월 보스는 정확히 10:00 비트에 등장한다')
  assert.equal(world.boss.spawnedAt, rules.bossSpawnTime)
  assert.equal(world.boss.maxHp, rules.bossMaxHp)
  assert.equal(world.boss.hp, rules.bossMaxHp)
  const boss = Array.from(
    { length: world.enemies.count },
    (_, index) => index,
  ).find((index) => world.enemies.type[index] === TYPE_BOSS)
  assert.notEqual(boss, undefined)
  assert.equal(world.enemies.maxHp[boss!]!, rules.bossMaxHp)
  assert.ok(
    world.enemies.count <= rules.bossArenaTarget,
    '보스 활성 중에는 일반 스포너도 60마리 상한을 유지한다',
  )
}

{
  const { world, bossIndex } = bossWorld(92)
  const phaseTwoHp = bossPhaseTwoThreshold(world)
  const phaseThreeHp = bossPhaseThreeThreshold(world)
  assert.equal(phaseTwoHp, 12_768)
  assert.equal(phaseThreeHp, 6_384)

  damageEnemy(world, bossIndex, rules.bossMaxHp * 4)
  assert.equal(world.boss.phaseTwoAt, -1)
  assert.equal(
    world.boss.hp,
    Math.fround(
      rules.bossMaxHp *
        (1 - FULLMOON_BOSS_SINGLE_HIT_DAMAGE_CAP_RATIO),
    ),
  )
  damageEnemy(world, bossIndex, rules.bossMaxHp * 4)
  assert.equal(world.boss.hp, phaseTwoHp)
  assert.equal(world.boss.phaseTwoAt, world.time)
  assert.equal(world.hostileHazards.length, 2)
  assert.equal(
    bossPhaseAt(
      world.time,
      world.boss.spawnedAt,
      world.boss.phaseTwoAt,
      world.boss.phaseThreeAt,
    ),
    'transition',
  )

  const invulnerableHp = world.boss.hp
  damageEnemy(world, bossIndex, rules.bossMaxHp * 4)
  assert.equal(world.boss.hp, invulnerableHp, '페이즈 전환 중 피해는 무시된다')

  world.time = world.boss.invulnerableUntil
  world.tick = Math.round(world.time / DT)
  damageEnemy(world, bossIndex, rules.bossMaxHp * 4)
  assert.equal(
    world.boss.hp,
    Math.fround(
      phaseTwoHp -
        rules.bossMaxHp * FULLMOON_BOSS_SINGLE_HIT_DAMAGE_CAP_RATIO,
    ),
  )
  assert.equal(world.boss.phaseThreeAt, -1)
  damageEnemy(world, bossIndex, rules.bossMaxHp * 4)
  assert.equal(world.boss.hp, phaseThreeHp)
  assert.equal(world.boss.phaseThreeAt, world.time)
  assert.equal(world.hostileHazards.length, 3)

  world.time =
    world.boss.phaseThreeAt + BOSS_PHASE_TWO_TRANSITION_DURATION
  world.tick = Math.round(world.time / DT)
  stepBossEncounter(world)
  const phaseZones = world.hostileHazards.filter(
    (hazard) => hazard.kind === 'phase-zone',
  )
  assert.equal(phaseZones.length, 3, '3페이즈는 같은 volley의 삼중 장판을 연다')
  assert.equal(new Set(phaseZones.map((hazard) => hazard.volley)).size, 1)
}

{
  const { world } = bossWorld(93)
  world.spawnEnabled = false
  world.player.invulnUntil = Number.POSITIVE_INFINITY
  world.tick = Math.round(rules.runTimeLimit / DT) - 1
  world.time = world.tick * DT
  stepWorld(world, createInput())
  assert.equal(world.time, rules.runTimeLimit)
  assert.equal(world.outcome, 'timeout', '12:00에 살아 있는 만월 보스는 시간 초과다')
}

{
  const world = createWorld(94, 'ranged', { difficulty: 'fullmoon' })
  world.progression.level = MAX_LEVEL
  world.time = 500
  grantXp(world, 1_000)
  assert.ok(
    world.pendingEndlessSkillRanks >= 1,
    '만월은 만렙 뒤 XP를 반복 QWER 연마로 전환한다',
  )
  assert.equal(world.endlessRankRewardsEarned, 0)
  assert.equal(
    repeatSkillXpRequirement(false, 99),
    REPEAT_SKILL_XP_BASE,
    '만월 보스 이전 성장 요구량은 고정해 풀강화 빌드업 속도를 보존한다',
  )
}

{
  const world = createWorld(941, 'ranged', { difficulty: 'fullmoon' })
  world.progression.level = MAX_LEVEL - 1
  world.progression.xp = xpToNext(MAX_LEVEL - 1) - 1
  grantXp(world, 1_000)
  assert.equal(world.progression.level, MAX_LEVEL)
  assert.equal(world.pendingEndlessSkillRanks, 1)
  assert.ok(
    world.endlessXp > 170 && world.endlessXp < 180,
    'Lv26 도달 타격의 초과 XP도 반복 강화 순환으로 이월한다',
  )
}

{
  const world = createWorld(95, 'ranged', { difficulty: 'fullmoon' })
  world.victoryAt = 700
  world.outcome = 'victory'
  assert.equal(computeScore(world).difficultyMultiplier, 2.25)
}

console.log(
  'fullmoon-check: 10:00 spawn, 12:00 deadline, 19,152 HP, gated phase 2/3, triple hazards, extended growth, and score multiplier ok',
)
