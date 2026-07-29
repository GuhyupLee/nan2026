/**
 * 실제 선택·이동·회피를 포함한 5분 생존 계측.
 *
 * balance/model.ts는 XP 곡선을 격리하려고 무적·정지 봇을 쓴다. 이 파일은
 * 반대로 필멸 상태에서 카드와 QWER를 하나씩 순환해 위험도와 보스전을 잰다.
 */
import {
  UPGRADES,
  applyUpgrade,
  applyRelicUpgrade,
  getUpgradeRank,
  getRelicRollPriority,
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
import {
  createWorld,
  resolveLevelUp,
  resolveRewardChoice,
  stepWorld,
} from '../src/sim/world.ts'

const SEEDS = [
  1, 5, 11, 17, 23, 31, 47, 59, 71, 89, 101, 127,
  137, 149, 163, 179, 191, 211, 223, 239, 251, 269, 283, 307,
] as const
const QWER = ['q', 'w', 'e', 'r'] as const satisfies readonly SkillId[]
const XP_GEM_SEEK_RADIUS = 10
const XP_GEM_SEEK_WEIGHT = 1

interface PilotState {
  nextSkill: number
  orbitSign: -1 | 1
}

interface Result {
  cls: PlayerClass
  seed: number
  outcome: World['outcome']
  survivedSec: number
  minHpFrac: number
  dangerFrac: number
  /** 회복까지 반영한 틱간 순 HP 감소 합계. 실제 원시 피해량과는 다르다. */
  netHpLoss: number
  /** 장판·돌진·접촉을 모두 포함해 틱간 HP가 순감소한 틱 비율. */
  damageTickFrac: number
  bossProgress: number
  kills: number
  level: number
  upgradeRanks: number
  relics: number
  awakenings: number
  fusions: number
  healPickups: number
  magnetPickups: number
  bombPickups: number
}

function resolveFirstChoice(world: World): void {
  if (world.pendingRelicChoices > 0) {
    const candidates = UPGRADES.map((upgrade) => ({
      id: upgrade.id,
      available: upgrade.isAvailable(world),
      weight: upgrade.weight,
      classFilter: upgrade.classFilter,
      currentRank: getUpgradeRank(world.upgradesTaken, upgrade.id),
      maxRank: upgrade.ranks.length,
      priority: getRelicRollPriority(world, upgrade),
    }))
    const choices = rollUpgrades(world.choiceRng, candidates, 3, {
      playerClass: world.playerClass,
      taken: world.upgradesTaken,
      allowRankUps: true,
    })
    const choice = choices[0]
    if (choice) applyRelicUpgrade(world, choice.id)
    resolveRewardChoice(world)
    return
  }

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
    const choices = rollUpgrades(world.choiceRng, candidates, 4, {
      playerClass: world.playerClass,
      taken: world.upgradesTaken,
      allowRankUps: true,
    })
    // 생존 계측 봇은 선택지를 무작정 첫 칸만 누르지 않는다. 체력이 낮은
    // 클래스가 방어 장비를 봤는데도 버리는 정책은 난이도 대신 봇의 실수를
    // 측정하므로, 노출된 네 장 안에서는 클래스의 대표 생존 장비를 우선한다.
    const defensiveIds =
      world.playerClass === 'ranged'
        ? ['photon-core']
        : ['ironwall-breath', 'bloodflow-breath']
    const defensiveChoice = choices.find((candidate) =>
      defensiveIds.includes(candidate.id),
    )
    const defensiveRank = defensiveChoice
      ? getUpgradeRank(world.upgradesTaken, defensiveChoice.id)
      : 0
    const needsDefense =
      world.player.hp / world.stats.maxHp < 0.55 || defensiveRank === 0
    const choice =
      defensiveChoice && needsDefense
        ? defensiveChoice
        : choices.find((candidate) => !defensiveIds.includes(candidate.id)) ??
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

  // Floor XP is an intentional movement objective. Only route toward a nearby
  // idle gem while no enemy or boss currently demands an evasive response.
  if (crowd === 0 && boss < 0) {
    const gemPool = world.xpGems
    let nearestGem = -1
    let nearestGemDistanceSq = XP_GEM_SEEK_RADIUS * XP_GEM_SEEK_RADIUS
    for (let i = 0; i < gemPool.count; i++) {
      if (gemPool.attracted[i] !== 0) continue
      const dx = gemPool.x[i]! - px
      const dy = gemPool.y[i]! - py
      const distanceSq = dx * dx + dy * dy
      if (distanceSq < nearestGemDistanceSq) {
        nearestGem = i
        nearestGemDistanceSq = distanceSq
      }
    }
    if (nearestGem >= 0 && nearestGemDistanceSq > 1e-12) {
      const inverseDistance = 1 / Math.sqrt(nearestGemDistanceSq)
      moveX +=
        (gemPool.x[nearestGem]! - px) * inverseDistance * XP_GEM_SEEK_WEIGHT
      moveY +=
        (gemPool.y[nearestGem]! - py) * inverseDistance * XP_GEM_SEEK_WEIGHT
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
    const phase = bossPhaseAt(
      world.time,
      world.boss.spawnedAt,
      world.boss.phaseTwoAt,
    )
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
    if (!melee && edge > 0.68) {
      const radialX = px / centerDistance
      const radialY = py / centerDistance
      const outward = moveX * radialX + moveY * radialY
      if (outward > 0) {
        moveX -= radialX * outward
        moveY -= radialY * outward
      }

      const velocityCross =
        radialX * world.player.vel.y -
        radialY * world.player.vel.x
      const orbitSign =
        Math.abs(velocityCross) > 0.2
          ? velocityCross > 0
            ? 1
            : -1
          : state.orbitSign
      moveX += -radialY * orbitSign * 5.5
      moveY += radialX * orbitSign * 5.5
      moveX -= radialX * (edge - 0.68) * 8
      moveY -= radialY * (edge - 0.68) * 8
    }
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

  let chosenSlot: SkillId | null = null
  if (!world.playerAction && !world.ult.active) {
    for (let offset = 0; offset < QWER.length; offset++) {
      const index = (state.nextSkill + offset) % QWER.length
      const slot = QWER[index]!
      if (!isReady(world.skills, slot)) continue
      pressed |= SKILL_BIT[slot]
      chosenSlot = slot
      state.nextSkill = (index + 1) % QWER.length
      break
    }
  }
  if (
    !melee &&
    chosenSlot === 'w' &&
    moveLength > 1e-6 &&
    (crowd >= 3 || world.player.hp < world.stats.maxHp * 0.75)
  ) {
    // 광도약은 커서 방향으로 이동한다. 평상시에는 전투 표적 쪽으로 전진해
    // 공격적으로 쓰고, 실제로 포위됐거나 체력이 밀렸을 때만 회피 벡터로 쓴다.
    // 매 쿨다운마다 완벽한 도주로 소비하는 봇은 플레이어의 공격/생존 선택을
    // 계측하지 않고 이동기만으로 위험을 삭제해 버린다.
    input.aim.x = px + input.move.x * 10
    input.aim.y = py + input.move.y * 10
  }
  input.skillsPressed = pressed
}

function run(cls: PlayerClass, seed: number): Result {
  const world = createWorld(seed, cls)
  const input = createInput()
  const state: PilotState = {
    nextSkill: seed % QWER.length,
    orbitSign: seed % 2 === 0 ? 1 : -1,
  }
  const maxTicks = Math.round(RUN_TIME_LIMIT / DT)

  let minHpFrac = 1
  let dangerTicks = 0
  let damageTicks = 0
  let netHpLoss = 0
  let previousHp = world.player.hp
  let ticks = 0

  for (; ticks < maxTicks && world.outcome === 'alive'; ticks++) {
    while (world.awaitingChoice) resolveFirstChoice(world)
    pilot(world, input, state)
    stepWorld(world, input)

    if (world.player.hp < previousHp) {
      netHpLoss += previousHp - world.player.hp
      damageTicks += 1
    }
    previousHp = world.player.hp
    const hpFraction = world.player.hp / world.stats.maxHp
    minHpFrac = Math.min(minHpFrac, hpFraction)
    if (hpFraction < 0.5) dangerTicks += 1
  }

  let upgradeRanks = 0
  let awakenings = 0
  let fusions = 0
  for (const upgrade of UPGRADES) {
    const rank = getUpgradeRank(world.upgradesTaken, upgrade.id)
    upgradeRanks += rank
    if (upgrade.fusion && rank > 0) fusions += 1
    else if (!upgrade.fusion && rank >= 3) awakenings += 1
  }

  return {
    cls,
    seed,
    outcome: world.outcome,
    survivedSec: world.time,
    minHpFrac,
    dangerFrac: dangerTicks / Math.max(1, ticks),
    netHpLoss,
    damageTickFrac: damageTicks / Math.max(1, ticks),
    bossProgress: world.boss.spawned
      ? world.outcome === 'victory'
        ? 1
        : 1 - world.boss.hp / Math.max(1, world.boss.maxHp)
      : 0,
    kills: world.kills,
    level: world.progression.level,
    upgradeRanks,
    relics: world.relicsClaimed,
    awakenings,
    fusions,
    healPickups: world.battlefieldPickups.healActivations,
    magnetPickups: world.battlefieldPickups.magnetActivations,
    bombPickups: world.battlefieldPickups.bombActivations,
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
      `순HP손실 ${String(Math.round(median(selected.map((row) => row.netHpLoss)))).padStart(4)}  ` +
      `피격틱 ${(median(selected.map((row) => row.damageTickFrac)) * 100).toFixed(1).padStart(4)}%  ` +
      `보스 ${(median(selected.map((row) => row.bossProgress)) * 100).toFixed(0).padStart(3)}%  ` +
      `킬 ${String(Math.round(median(selected.map((row) => row.kills)))).padStart(4)}  ` +
      `Lv ${String(median(selected.map((row) => row.level))).padStart(2)}  ` +
      `강화 ${String(median(selected.map((row) => row.upgradeRanks))).padStart(2)}  ` +
      `인장 ${String(median(selected.map((row) => row.relics))).padStart(1)}  ` +
      `각성 ${String(median(selected.map((row) => row.awakenings))).padStart(1)}  ` +
      `합성 ${String(median(selected.map((row) => row.fusions))).padStart(1)}  ` +
      `pickups H/M/B ` +
      `${median(selected.map((row) => row.healPickups))}/` +
      `${median(selected.map((row) => row.magnetPickups))}/` +
      `${median(selected.map((row) => row.bombPickups))}`,
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

if (process.argv.includes('--verbose')) {
  for (const cls of ['ranged', 'melee'] as const) {
    console.log(`\n${cls} seeds`)
    for (const row of results.filter((result) => result.cls === cls)) {
      console.log(
        `  ${String(row.seed).padStart(3)}  ${row.outcome.padEnd(7)}  ` +
          `${row.survivedSec.toFixed(1).padStart(5)}s  ` +
          `boss ${(row.bossProgress * 100).toFixed(0).padStart(3)}%  ` +
          `minHP ${(row.minHpFrac * 100).toFixed(0).padStart(3)}%  ` +
          `netLoss ${Math.round(row.netHpLoss).toString().padStart(4)}  ` +
          `kills ${String(row.kills).padStart(4)}  Lv${String(row.level).padStart(2)}  ` +
          `H/M/B ${row.healPickups}/${row.magnetPickups}/${row.bombPickups}`,
      )
    }
  }
}

for (const cls of ['ranged', 'melee'] as const) {
  const selected = results.filter((row) => row.cls === cls)
  const wins = selected.filter((row) => row.outcome === 'victory').length
  if (median(selected.map((row) => row.netHpLoss)) <= 0) {
    throw new Error(`${cls}: 순 HP 손실이 0이라 생존 계측이 무효입니다.`)
  }
  if (median(selected.map((row) => row.bossProgress)) < 0.8) {
    throw new Error(`${cls}: 보스 진행도 중앙값이 80% 미만이라 보스 계측이 무효입니다.`)
  }
  if (wins < Math.ceil(selected.length / 2) || wins >= selected.length) {
    throw new Error(
      `${cls}: 승리 ${wins}/${selected.length} — 강하지만 이길 수 있는 50~92% 범위를 벗어났습니다.`,
    )
  }
  const relics = median(selected.map((row) => row.relics))
  const fusions = median(selected.map((row) => row.fusions))
  if (relics < 3 || fusions < 1) {
    throw new Error(
      `${cls}: 정예 보상 회귀 — 인장 중앙값 ${relics}, 융합 중앙값 ${fusions}`,
    )
  }
  const danger = median(selected.map((row) => row.dangerFrac))
  const minimumHp = median(selected.map((row) => row.minHpFrac))
  // 회복 봇은 72% 아래에서 즉시 D를 써 저체력 체류 시간을 의도적으로 지운다.
  // 따라서 실제 사망 시드가 하나라도 있으면 위험이 성립한 것으로 보고, 전승
  // 보호막으로 사망을 넘기는 경우에는 기존 저체력 문턱을 함께 사용한다.
  const pressured =
    wins < selected.length ||
    danger >= 0.01 ||
    (cls === 'melee' && minimumHp <= 0.55)
  if (!pressured || danger > 0.35) {
    throw new Error(
      `${cls}: 위험시간 ${(danger * 100).toFixed(1)}% · 최저체력 ` +
        `${(minimumHp * 100).toFixed(1)}%가 유효 범위를 벗어났습니다.`,
    )
  }
}

const rangedWins = results.filter(
  (row) => row.cls === 'ranged' && row.outcome === 'victory',
).length
const meleeWins = results.filter(
  (row) => row.cls === 'melee' && row.outcome === 'victory',
).length
if (rangedWins < 8) {
  throw new Error(
    `원거리 생존 회귀 — 승리 ${rangedWins}/${SEEDS.length}, 최소 8승이 필요합니다.`,
  )
}
if (Math.abs(rangedWins - meleeWins) > 3) {
  throw new Error(
    `클래스 생존 격차 ${Math.abs(rangedWins - meleeWins)}승 — ` +
      `원거리 ${rangedWins}/${SEEDS.length}, 근거리 ${meleeWins}/${SEEDS.length}`,
  )
}
