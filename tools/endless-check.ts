import assert from 'node:assert/strict'
import {
  TYPE_ELITE,
  TYPE_WALKER,
  enemyHealthMultiplier,
  spawnEnemy,
  targetAliveCount,
} from '../src/sim/enemies.ts'
import { MAX_LEVEL } from '../src/sim/progression.ts'
import { computeScore } from '../src/sim/score.ts'
import { MAX_SKILL_RANK, unlockSkill } from '../src/sim/skills.ts'
import type { World } from '../src/sim/types.ts'
import {
  continueIntoEndless,
  createWorld,
  grantXp,
  resolveRewardChoice,
  stepWorld,
} from '../src/sim/world.ts'
import {
  applyLevelUpCard,
  buildLevelUpCards,
} from '../src/ui/levelup.ts'

const idleInput = {
  move: { x: 0, y: 0 },
  aim: { x: 10, y: 0 },
  skillsPressed: 0,
}

function addEnemy(world: World, x: number, y: number): number {
  spawnEnemy(world.enemies, world.rng, 0, 0, TYPE_WALKER, world.time)
  const index = world.enemies.count - 1
  world.enemies.x[index] = x
  world.enemies.y[index] = y
  world.enemies.prevX[index] = x
  world.enemies.prevY[index] = y
  return index
}

// 하드 모드는 런 스냅샷에 고정되고 접촉 피해·점수를 정확히 배율 적용한다.
{
  const normal = createWorld(9101, 'ranged')
  const hard = createWorld(9101, 'ranged', { difficulty: 'hard' })
  normal.spawnEnabled = false
  hard.spawnEnabled = false
  normal.player.attackCooldown = Number.POSITIVE_INFINITY
  hard.player.attackCooldown = Number.POSITIVE_INFINITY
  addEnemy(normal, 0.1, 0)
  addEnemy(hard, 0.1, 0)
  const normalHp = normal.player.hp
  const hardHp = hard.player.hp
  stepWorld(normal, idleInput)
  stepWorld(hard, idleInput)
  const normalLoss = normalHp - normal.player.hp
  const hardLoss = hardHp - hard.player.hp
  assert.ok(normalLoss > 0, '일반 모드 접촉 피해 표본이 없음')
  assert.ok(
    Math.abs(hardLoss / normalLoss - 1.25) < 1e-5,
    '하드 접촉 피해가 1.25배가 아님',
  )

  normal.kills = 10
  hard.kills = 10
  normal.outcome = 'victory'
  hard.outcome = 'victory'
  normal.time = 250
  hard.time = 250
  normal.victoryAt = 250
  hard.victoryAt = 250
  assert.equal(
    computeScore(hard).total,
    Math.round(computeScore(normal).total * 1.5),
    '하드 점수 배율이 1.5가 아님',
  )
}

// 무한전은 같은 월드를 이어 쓰고 30초마다 밀도, 시간에 따라 체력을 올린다.
{
  const world = createWorld(9102, 'melee')
  world.outcome = 'victory'
  world.victoryAt = 280
  world.time = 280
  assert.ok(continueIntoEndless(world), '승리 월드가 무한전으로 이어지지 않음')
  assert.equal(world.outcome, 'alive')
  assert.equal(world.endlessStartedAt, 280)
  assert.equal(world.nextEndlessEliteAt, 320)
  assert.ok(!continueIntoEndless(world), '무한전을 중복 시작함')

  assert.equal(targetAliveCount(300, true), 95)
  assert.equal(targetAliveCount(330, true), 107)
  assert.equal(targetAliveCount(360, true), 119)
  assert.ok(
    enemyHealthMultiplier(600, true) > enemyHealthMultiplier(300, true),
    '무한전 체력 배율이 계속 오르지 않음',
  )
}

// 40초 반복 정예와 만렙 이후 반복 스킬 강화가 실제 선택 흐름에 연결된다.
{
  const world = createWorld(9103, 'ranged')
  world.boss.spawned = true
  world.boss.active = false
  world.outcome = 'victory'
  world.victoryAt = 300
  world.time = 300
  world.tick = 18_000
  world.eliteBeatIndex = 3
  world.surgeBeatIndex = 3
  world.surgeWarningIndex = 3
  assert.ok(continueIntoEndless(world))
  world.time = world.nextEndlessEliteAt
  world.tick = Math.round(world.time * 60)
  stepWorld(world, idleInput)
  let eliteCount = 0
  for (let i = 0; i < world.enemies.count; i += 1) {
    if (world.enemies.type[i] === TYPE_ELITE) eliteCount += 1
  }
  assert.equal(eliteCount, 1, '40초 반복 정예가 등장하지 않음')

  world.progression.level = MAX_LEVEL
  world.progression.pendingLevelUps = 0
  for (const id of ['q', 'w', 'e', 'r'] as const) {
    unlockSkill(world.skills, id, 5)
    world.skills[id].rank = MAX_SKILL_RANK
  }
  grantXp(world, 1_000)
  assert.ok(world.pendingEndlessSkillRanks > 0)
  const cards = buildLevelUpCards(world)
  assert.ok(cards.length > 0 && cards.every((card) => card.kind === 'skill-rank'))
  const before = world.skills[cards[0]!.id.slice(5) as 'q' | 'w' | 'e' | 'r'].rank
  applyLevelUpCard(world, cards[0]!)
  resolveRewardChoice(world)
  const after = world.skills[cards[0]!.id.slice(5) as 'q' | 'w' | 'e' | 'r'].rank
  assert.equal(after, before + 1, '무한 연마가 기본 랭크 상한을 넘지 못함')
}

console.log(
  'endless-check: hard multipliers, endless scaling, repeat elites, and infinite skill ranks ok',
)
