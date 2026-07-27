/**
 * 실제 선택·이동·회피를 포함한 5분 생존 계측.
 *
 * balance/model.ts는 XP 곡선을 격리하려고 무적·정지 봇을 쓴다. 이 파일은
 * 반대로 필멸 상태에서 카드와 QWER를 하나씩 순환해 위험도와 보스전을 잰다.
 */
import {
  UPGRADES,
  applyUpgrade,
  getUpgradeRank,
  getUpgradeRollPriority,
} from '../src/content/upgrades.ts'
import { getSkillDef } from '../src/content/skills.ts'
import { DT, RUN_TIME_LIMIT } from '../src/sim/constants.ts'
import {
  ENEMY_TYPES,
  TYPE_BOSS,
  bossPhaseAt,
  targetAliveCount,
} from '../src/sim/enemies.ts'
import {
  pendingReward,
  rollUpgrades,
} from '../src/sim/progression.ts'
import {
  SKILL_BIT,
  isReady,
  lockedChoosableSkills,
  rankUpSkill,
  rankableSkills,
  unlockSkill,
  type SkillId,
} from '../src/sim/skills.ts'
import { createInput, type PlayerClass, type World } from '../src/sim/types.ts'
import { createWorld, resolveLevelUp, stepWorld } from '../src/sim/world.ts'

const SEEDS = [1, 5, 11, 17, 23, 31, 47, 59, 71, 89, 101, 127] as const
const QWER = ['q', 'w', 'e', 'r'] as const satisfies readonly SkillId[]

interface PilotState {
  nextSkill: number
}

interface Result {
  cls: PlayerClass
  seed: number
  outcome: World['outcome']
  survivedSec: number
  minHpFrac: number
  dangerFrac: number
  totalDamage: number
  contactFrac: number
  bossProgress: number
  kills: number
  level: number
  upgradeRanks: number
}

function resolveFirstChoice(world: World): void {
  const reward = pendingReward(world.progression)

  if (reward === 'unlock-choice' || reward === 'unlock-last') {
    const id = lockedChoosableSkills(world.skills)[0]
    if (id) {
      const def = getSkillDef(world.playerClass, id)
      if (def) unlockSkill(world.skills, id, def.cooldown * world.stats.cooldownMul)
    }
  } else if (reward === 'unlock-ult') {
    if (!world.skills.r.unlocked) {
      const def = getSkillDef(world.playerClass, 'r')
      if (def) unlockSkill(world.skills, 'r', def.cooldown * world.stats.cooldownMul)
    }
  } else if (reward === 'skill-rank') {
    const id = [...rankableSkills(world.skills)].sort(
      (a, b) => world.skills[a].rank - world.skills[b].rank,
    )[0]
    if (id) rankUpSkill(world.skills, id)
  } else if (reward === 'upgrade') {
    const candidates = UPGRADES.map((upgrade) => ({
      id: upgrade.id,
      available: upgrade.isAvailable(world),
      weight: upgrade.weight,
      classFilter: upgrade.classFilter,
      currentRank: getUpgradeRank(world.upgradesTaken, upgrade.id),
      maxRank: upgrade.ranks.length,
      priority: getUpgradeRollPriority(world, upgrade),
    }))
    const choices = rollUpgrades(world.choiceRng, candidates, 3, {
      playerClass: world.playerClass,
      taken: world.upgradesTaken,
      allowRankUps: true,
    })
    // 생존 계측 봇은 선택지를 무작정 첫 칸만 누르지 않는다. 체력이 낮은
    // 클래스가 방어 장비를 봤는데도 버리는 정책은 난이도 대신 봇의 실수를
    // 측정하므로, 노출된 세 장 안에서는 클래스의 대표 생존 장비를 우선한다.
    const defensiveIds =
      world.playerClass === 'ranged'
        ? ['photon-core']
        : ['ironwall-breath', 'bloodflow-breath']
    const choice =
      choices.find((candidate) => defensiveIds.includes(candidate.id)) ??
      choices[0]
    if (choice) applyUpgrade(world, choice.id)
  }

  resolveLevelUp(world)
}

function pilot(
  world: World,
  input: ReturnType<typeof createInput>,
  state: PilotState,
): void {
  const pool = world.enemies
  const px = world.player.pos.x
  const py = world.player.pos.y
  const melee = world.playerClass === 'melee'
  const fleeRadiusSq = (melee ? 2.4 : 7.5) ** 2

  let moveX = 0
  let moveY = 0
  let nearest = -1
  let nearestDistanceSq = Number.POSITIVE_INFINITY
  let boss = -1
  let crowd = 0

  for (let i = 0; i < pool.count; i++) {
    if (pool.hp[i]! <= 0) continue
    if (pool.type[i] === TYPE_BOSS) boss = i
    const dx = px - pool.x[i]!
    const dy = py - pool.y[i]!
    const distanceSq = dx * dx + dy * dy
    if (distanceSq < nearestDistanceSq) {
      nearest = i
      nearestDistanceSq = distanceSq
    }
    if (distanceSq > 1e-6 && distanceSq < fleeRadiusSq) {
      const inverse = 1 / distanceSq
      moveX += dx * inverse
      moveY += dy * inverse
      crowd += 1
    }
  }

  const combatTarget = boss >= 0 ? boss : nearest
  if (
    melee &&
    combatTarget >= 0
  ) {
    const dx = pool.x[combatTarget]! - px
    const dy = pool.y[combatTarget]! - py
    const distance = Math.hypot(dx, dy)
    if (distance > world.stats.atkRange && distance > 1e-6) {
      moveX += (dx / distance) * 3.5
      moveY += (dy / distance) * 3.5
    }
  }

  // 보스는 예고 방향을 고정한 뒤 직선 돌진한다. 같은 선으로 달리면 잡히고,
  // 옆으로 한 걸음 비키면 피할 수 있다는 실제 전투 문법을 봇도 따른다.
  if (boss >= 0 && world.boss.spawnedAt >= 0) {
    const phase = bossPhaseAt(world.time, world.boss.spawnedAt)
    if (phase === 'windup' || phase === 'charge') {
      let chargeX = pool.bossChargeDirX[boss]!
      let chargeY = pool.bossChargeDirY[boss]!
      if (Math.hypot(chargeX, chargeY) < 0.5) {
        chargeX = px - pool.x[boss]!
        chargeY = py - pool.y[boss]!
      }
      const chargeLength = Math.max(1e-6, Math.hypot(chargeX, chargeY))
      moveX += (-chargeY / chargeLength) * 7
      moveY += (chargeX / chargeLength) * 7
    }
  }

  const centerDistance = Math.hypot(px, py)
  if (centerDistance > 1e-6) {
    const edge = centerDistance / world.arenaRadius
    const pull = edge * edge * 2.2
    moveX -= (px / centerDistance) * pull
    moveY -= (py / centerDistance) * pull
  }

  const moveLength = Math.hypot(moveX, moveY)
  input.move.x = moveLength > 1e-6 ? moveX / moveLength : 0
  input.move.y = moveLength > 1e-6 ? moveY / moveLength : 0

  if (combatTarget >= 0) {
    input.aim.x = pool.x[combatTarget]!
    input.aim.y = pool.y[combatTarget]!
  } else {
    input.aim.x = px + Math.cos(world.player.facing) * 10
    input.aim.y = py + Math.sin(world.player.facing) * 10
  }

  let pressed = 0
  if (world.player.hp < world.stats.maxHp * 0.72 && isReady(world.skills, 'd')) {
    pressed |= SKILL_BIT.d
  }
  if (
    crowd >= 4 &&
    world.player.hp < world.stats.maxHp * 0.68 &&
    isReady(world.skills, 'f')
  ) {
    pressed |= SKILL_BIT.f
    // F는 커서 방향으로 나간다. 평소 조준(적)을 그대로 두면 "회피" 조건에서
    // 적 한가운데로 점멸하는 반대 행동이 된다.
    if (moveLength > 1e-6) {
      input.aim.x = px + input.move.x * world.stats.flashRange
      input.aim.y = py + input.move.y * world.stats.flashRange
    }
  }

  if (!world.playerAction && !world.ult.active) {
    for (let offset = 0; offset < QWER.length; offset++) {
      const index = (state.nextSkill + offset) % QWER.length
      const slot = QWER[index]!
      if (!isReady(world.skills, slot)) continue
      pressed |= SKILL_BIT[slot]
      state.nextSkill = (index + 1) % QWER.length
      break
    }
  }
  input.skillsPressed = pressed
}

function run(cls: PlayerClass, seed: number): Result {
  const world = createWorld(seed, cls)
  const input = createInput()
  const state: PilotState = { nextSkill: seed % QWER.length }
  const maxTicks = Math.round(RUN_TIME_LIMIT / DT)

  let minHpFrac = 1
  let dangerTicks = 0
  let hitTicks = 0
  let totalDamage = 0
  let previousHp = world.player.hp
  let ticks = 0

  for (; ticks < maxTicks && world.outcome === 'alive'; ticks++) {
    while (world.awaitingChoice) resolveFirstChoice(world)
    pilot(world, input, state)
    stepWorld(world, input)

    if (world.player.hp < previousHp) {
      totalDamage += previousHp - world.player.hp
      hitTicks += 1
    }
    previousHp = world.player.hp
    const hpFraction = world.player.hp / world.stats.maxHp
    minHpFrac = Math.min(minHpFrac, hpFraction)
    if (hpFraction < 0.5) dangerTicks += 1
  }

  let upgradeRanks = 0
  for (const upgrade of UPGRADES) {
    upgradeRanks += getUpgradeRank(world.upgradesTaken, upgrade.id)
  }

  return {
    cls,
    seed,
    outcome: world.outcome,
    survivedSec: world.time,
    minHpFrac,
    dangerFrac: dangerTicks / Math.max(1, ticks),
    totalDamage,
    contactFrac: hitTicks / Math.max(1, ticks),
    bossProgress: world.boss.spawned
      ? world.outcome === 'victory'
        ? 1
        : 1 - world.boss.hp / Math.max(1, world.boss.maxHp)
      : 0,
    kills: world.kills,
    level: world.progression.level,
    upgradeRanks,
  }
}

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function summarize(rows: Result[], cls: PlayerClass): void {
  const selected = rows.filter((row) => row.cls === cls)
  const wins = selected.filter((row) => row.outcome === 'victory').length
  const deaths = selected.filter((row) => row.outcome === 'dead').length
  const timeouts = selected.filter((row) => row.outcome === 'timeout').length
  console.log(
    `${cls.padEnd(8)} 승 ${String(wins).padStart(2)}/${selected.length}  ` +
      `사망 ${String(deaths).padStart(2)}  시간초과 ${String(timeouts).padStart(2)}  ` +
      `생존 ${median(selected.map((row) => row.survivedSec)).toFixed(0).padStart(3)}초  ` +
      `최저체력 ${(median(selected.map((row) => row.minHpFrac)) * 100).toFixed(0).padStart(3)}%  ` +
      `위험시간 ${(median(selected.map((row) => row.dangerFrac)) * 100).toFixed(0).padStart(3)}%  ` +
      `총피해 ${String(Math.round(median(selected.map((row) => row.totalDamage)))).padStart(4)}  ` +
      `접촉 ${(median(selected.map((row) => row.contactFrac)) * 100).toFixed(1).padStart(4)}%  ` +
      `보스 ${(median(selected.map((row) => row.bossProgress)) * 100).toFixed(0).padStart(3)}%  ` +
      `킬 ${String(Math.round(median(selected.map((row) => row.kills)))).padStart(4)}  ` +
      `Lv ${String(median(selected.map((row) => row.level))).padStart(2)}  ` +
      `강화 ${String(median(selected.map((row) => row.upgradeRanks))).padStart(2)}`,
  )
}

const results: Result[] = []
for (const cls of ['ranged', 'melee'] as const) {
  for (const seed of SEEDS) results.push(run(cls, seed))
}

console.log(
  '\n필멸·이동·실제 선택 생존 계측\n' +
    `스폰 상한 ${targetAliveCount(200).toFixed(0)} · ` +
    `워커 ${ENEMY_TYPES[0]!.contactDamage} / ` +
    `러셔 ${ENEMY_TYPES[1]!.contactDamage} / ` +
    `브루트 ${ENEMY_TYPES[2]!.contactDamage}\n`,
)
summarize(results, 'ranged')
summarize(results, 'melee')

for (const cls of ['ranged', 'melee'] as const) {
  const selected = results.filter((row) => row.cls === cls)
  const wins = selected.filter((row) => row.outcome === 'victory').length
  if (median(selected.map((row) => row.totalDamage)) <= 0) {
    throw new Error(`${cls}: 접촉 피해가 0이라 생존 계측이 무효입니다.`)
  }
  if (median(selected.map((row) => row.bossProgress)) < 0.5) {
    throw new Error(`${cls}: 보스 진행도 중앙값이 50% 미만이라 보스 계측이 무효입니다.`)
  }
  if (wins < Math.ceil(selected.length / 3) || wins >= selected.length) {
    throw new Error(
      `${cls}: 승리 ${wins}/${selected.length} — 강하지만 이길 수 있는 33~92% 범위를 벗어났습니다.`,
    )
  }
  const danger = median(selected.map((row) => row.dangerFrac))
  if (danger < 0.01 || danger > 0.35) {
    throw new Error(`${cls}: 위험시간 ${(danger * 100).toFixed(1)}%가 유효 범위를 벗어났습니다.`)
  }
}
