import {
  UPGRADES,
  applyUpgrade,
  applyRelicUpgrade,
  getUpgradeRank,
  getRelicRollPriority,
  getUpgradeRollPriority,
} from '../../src/content/upgrades.ts'
import { getSkillDef } from '../../src/content/skills.ts'
import { DT, RUN_TIME_LIMIT } from '../../src/sim/constants.ts'
import {
  TARGET_LEVEL_TIMES,
  pendingReward,
  rollUpgrades,
} from '../../src/sim/progression.ts'
import {
  SKILL_E,
  SKILL_Q,
  SKILL_R,
  SKILL_W,
  lockedChoosableSkills,
  rankUpSkill,
  rankableSkills,
  unlockSkill,
} from '../../src/sim/skills.ts'
import { createInput, type PlayerClass, type World } from '../../src/sim/types.ts'
import {
  createWorld,
  resolveLevelUp,
  resolveRewardChoice,
  stepWorld,
} from '../../src/sim/world.ts'

/**
 * 넓게 흩어진 고정 시드. 밸런스 수치는 이 목록 전체로 재며, 일부만 골라
 * 회귀 검사에 쓰지 않는다. 그래야 우연히 쉬운 세 시드에 맞는 곡선이 나오지 않는다.
 */
export const BALANCE_SEEDS = [1, 5, 11, 17, 23, 31, 47, 59, 71, 89, 101, 127] as const

/** 매 npm run check에서 돌릴 대표 시드. 전체 표는 npm run balance가 담당한다. */
export const REGRESSION_SEEDS = [1, 17, 59] as const

const QWER_MASK = SKILL_Q | SKILL_W | SKILL_E | SKILL_R

export interface BalanceRunOptions {
  /** false면 같은 선택 정책에서 QWER 입력만 빼 자동 공격 기준선을 잰다. */
  useQwer?: boolean
  /** 생존 편차가 아닌 처치율만 재므로 기본값은 true다. */
  invulnerable?: boolean
  duration?: number
  /**
   * 5분 곡선은 보스를 일찍 잡아도 300초까지 잰다. 실제 게임 결과는 outcome에
   * 보존하고, 승리 뒤 일반 스폰에서 얻었을 XP를 이어서 관찰한다.
   */
  continueAfterVictory?: boolean
}

export interface BalanceRunResult {
  playerClass: PlayerClass
  seed: number
  level: number
  /** Lv1부터 Lv20까지. 도달하지 못한 레벨은 null. */
  levelTimes: Array<number | null>
  /** 각 목표 시각까지 실제로 얻은 누적 XP. */
  xpAtTargets: number[]
  kills: number
  totalXp: number
  elapsed: number
  outcome: World['outcome']
}

function upgradeCandidates(world: World, relic = false) {
  return UPGRADES.map((upgrade) => ({
    id: upgrade.id,
    available: upgrade.isAvailable ? upgrade.isAvailable(world) : true,
    weight: upgrade.weight,
    classFilter: upgrade.classFilter,
    currentRank: getUpgradeRank(world.upgradesTaken, upgrade.id),
    maxRank: upgrade.ranks.length,
    priority: relic
      ? getRelicRollPriority(world, upgrade)
      : getUpgradeRollPriority(world, upgrade),
  }))
}

/**
 * 헤드리스 플레이어의 선택 정책: 화면에 보이는 첫 카드를 누른다.
 *
 * UI와 같은 후보 순서·추첨기를 사용하므로 Q→W→E 해금, 낮은 랭크 우선,
 * 가중 추첨된 첫 강화라는 재현 가능한 한 가지 실제 빌드가 된다.
 */
function resolveFirstCard(world: World): void {
  if (world.pendingRelicChoices > 0) {
    const choice = rollUpgrades(
      world.choiceRng,
      upgradeCandidates(world, true),
      3,
      {
        playerClass: world.playerClass,
        taken: world.upgradesTaken,
        allowRankUps: true,
      },
    )[0]
    if (choice !== undefined) applyRelicUpgrade(world, choice.id)
    resolveRewardChoice(world)
    return
  }

  const reward = pendingReward(world.progression)

  if (reward === 'unlock-choice' || reward === 'unlock-last') {
    const id = lockedChoosableSkills(world.skills)[0]
    if (id !== undefined) {
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
    if (id !== undefined) rankUpSkill(world.skills, id)
  } else if (reward === 'upgrade') {
    const choice = rollUpgrades(
      world.choiceRng,
      upgradeCandidates(world),
      3,
      {
        playerClass: world.playerClass,
        taken: world.upgradesTaken,
        allowRankUps: true,
      },
    )[0]
    if (choice !== undefined) {
      applyUpgrade(world, choice.id)
    }
  }

  resolveLevelUp(world)
}

function aimAtNearestEnemy(world: World, input: ReturnType<typeof createInput>): void {
  const pool = world.enemies
  const px = world.player.pos.x
  const py = world.player.pos.y
  let nearest = -1
  let nearestDist2 = Number.POSITIVE_INFINITY

  for (let i = 0; i < pool.count; i++) {
    if (pool.hp[i]! <= 0) continue
    const dx = pool.x[i]! - px
    const dy = pool.y[i]! - py
    const dist2 = dx * dx + dy * dy
    if (dist2 < nearestDist2) {
      nearest = i
      nearestDist2 = dist2
    }
  }

  if (nearest >= 0) {
    input.aim.x = pool.x[nearest]!
    input.aim.y = pool.y[nearest]!
  } else {
    input.aim.x = px + Math.cos(world.player.facing) * 10
    input.aim.y = py + Math.sin(world.player.facing) * 10
  }
}

/**
 * 5분 레벨 곡선의 표준 측정 시나리오.
 *
 * 플레이어는 가장 가까운 적을 조준하고, 해금된 QWER을 쿨마다 누른다.
 * 무적은 생존 운을 제거할 뿐 공격·스폰·XP 판정에는 손대지 않는다.
 */
export function runBalanceScenario(
  playerClass: PlayerClass,
  seed: number,
  options: BalanceRunOptions = {},
): BalanceRunResult {
  const useQwer = options.useQwer ?? true
  const duration = options.duration ?? RUN_TIME_LIMIT
  const world = createWorld(seed, playerClass)
  const input = createInput()
  const xpAtTargets = Array<number>(TARGET_LEVEL_TIMES.length).fill(0)
  let nextTarget = 1
  let observedOutcome: World['outcome'] = 'alive'

  if (options.invulnerable ?? true) {
    world.player.invulnUntil = Number.POSITIVE_INFINITY
  }

  const maxTicks = Math.round(duration / DT)
  for (let tick = 0; tick < maxTicks; tick++) {
    if (world.outcome !== 'alive') {
      if (world.outcome === 'victory' && (options.continueAfterVictory ?? true)) {
        observedOutcome = 'victory'
        world.outcome = 'alive'
      } else {
        observedOutcome = world.outcome
        break
      }
    }

    while (world.awaitingChoice) resolveFirstCard(world)

    // W·R의 짧은 무적이 invulnUntil을 덮어쓴다. 계측 모드의 무적은 매 틱
    // 다시 세워야 스킬을 쓴 표본만 중간에 사망하는 선택 편향이 생기지 않는다.
    if (options.invulnerable ?? true) {
      world.player.invulnUntil = Number.POSITIVE_INFINITY
    }

    aimAtNearestEnemy(world, input)
    input.skillsPressed = useQwer ? QWER_MASK : 0
    stepWorld(world, input)

    while (
      nextTarget < TARGET_LEVEL_TIMES.length &&
      world.time >= TARGET_LEVEL_TIMES[nextTarget]!
    ) {
      xpAtTargets[nextTarget] = world.progression.totalXp
      nextTarget += 1
    }
  }

  while (nextTarget < TARGET_LEVEL_TIMES.length) {
    xpAtTargets[nextTarget] = world.progression.totalXp
    nextTarget += 1
  }

  return {
    playerClass,
    seed,
    level: world.progression.level,
    levelTimes: TARGET_LEVEL_TIMES.map((_, i) => world.progression.levelTimes[i] ?? null),
    xpAtTargets,
    kills: world.kills,
    totalXp: world.progression.totalXp,
    elapsed: world.time,
    outcome: observedOutcome === 'alive' ? world.outcome : observedOutcome,
  }
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!
}

export function levelCurveMae(result: BalanceRunResult): number {
  const errors: number[] = []
  for (let i = 1; i < TARGET_LEVEL_TIMES.length; i++) {
    const actual = result.levelTimes[i]
    if (actual === null) return Number.POSITIVE_INFINITY
    errors.push(Math.abs(actual - TARGET_LEVEL_TIMES[i]!))
  }
  return errors.reduce((sum, error) => sum + error, 0) / errors.length
}
