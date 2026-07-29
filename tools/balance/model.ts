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
  ENEMY_TYPES,
  TYPE_WALKER,
  enemyHealthMultiplier,
} from '../../src/sim/enemies.ts'
import {
  TARGET_LEVEL_TIMES,
  pendingReward,
  rollUpgrades,
  upgradeTraitToken,
} from '../../src/sim/progression.ts'
import {
  SKILL_E,
  SKILL_Q,
  SKILL_R,
  SKILL_W,
  lockedChoosableSkills,
  rankUpSkill,
  rankableSkills,
  skillDamageMul,
  unlockSkill,
} from '../../src/sim/skills.ts'
import {
  effectiveBasicAttackDamage,
  effectiveAtkInterval,
} from '../../src/sim/stats.ts'
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
/** Requested build-power checkpoints across the five-minute run. */
export const DPS_HEALTH_SAMPLE_TIMES = [30, 90, 150, 210, 270] as const

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
  /** Lv1부터 현재 최대 레벨까지. 도달하지 못한 레벨은 null. */
  levelTimes: Array<number | null>
  /** 각 목표 시각까지 실제로 얻은 누적 XP. */
  xpAtTargets: number[]
  kills: number
  totalXp: number
  elapsed: number
  outcome: World['outcome']
  /**
   * Current effective damage throughput divided by a current walker HP.
   * This is a build snapshot rather than applied damage, so a harvest lull or
   * an empty screen cannot make a stronger character appear weaker.
   */
  dpsHealthRatios: number[]
}

function hasTrait(world: World, trait: string): boolean {
  return world.upgradesTaken.has(upgradeTraitToken(trait))
}

function skillDamagePerCast(world: World, id: 'q' | 'w' | 'e' | 'r'): number {
  const runtime = world.skills[id]
  if (!runtime.unlocked) return 0
  const def = getSkillDef(world.playerClass, id)
  if (!def || def.damage.length === 0) return 0

  const [first = 0, second = 0] = def.damage
  let base = 0
  switch (def.damagePattern) {
    case 'zone-12':
      base = first * 12
      break
    case 'burst-zone-12':
      base = first + second * 12
      break
    case 'first-following':
      // One lead target plus two representative follow-through targets.
      base = first + second * 2
      break
    case 'path-landing':
      base = first + second
      break
    case 'five-finisher':
      base = first * 5 + second
      break
    default:
      base = def.damage.reduce((sum, value) => sum + value, 0)
      break
  }

  const attackDamage = effectiveBasicAttackDamage(world.stats)
  if (world.playerClass === 'ranged') {
    if (
      id === 'w' &&
      (hasTrait(world, 'double-collapse') ||
        hasTrait(world, 'singularity-interference'))
    ) {
      base += 7 * 12 * 0.45
    } else if (id === 'e' && hasTrait(world, 'afterimage-aperture')) {
      base += 160 * 0.35
    } else if (id === 'r' && hasTrait(world, 'heliostat-chain')) {
      base += 1700 * 0.25
    }
  } else if (id === 'q' && (
    hasTrait(world, 'returning-draw-cut') ||
    hasTrait(world, 'eclipse-sword-domain')
  )) {
    base += 96 * 0.55
  } else if (id === 'w') {
    if (hasTrait(world, 'returning-sheath')) base += 60 * 0.55
    if (hasTrait(world, 'afterimage-step')) base += attackDamage * 0.65
  } else if (id === 'e' && hasTrait(world, 'mirror-counter')) {
    base += 140 * 0.7
  } else if (id === 'r') {
    if (hasTrait(world, 'eclipse-sword-domain')) {
      base += 260 * 0.35 * 5 + 430 * 0.35
    }
    if (
      hasTrait(world, 'fullmoon-domain') ||
      hasTrait(world, 'eclipse-sword-domain')
    ) {
      base += 430 * 0.08 * 8
    }
  }

  return (
    base *
    skillDamageMul(world.skills, id) *
    world.stats.atkDamageMul
  )
}

/**
 * A deterministic build-power snapshot used only by the balance harness.
 *
 * Basic attacks include their authored pierce, split, auxiliary and backstrike
 * throughput. QWER contributes damage per cast over current cooldown. This is
 * deliberately independent of current enemy count and hit-point truncation.
 */
function effectiveDpsHealthRatio(world: World, time: number): number {
  const stats = world.stats
  const attackDamage = effectiveBasicAttackDamage(stats)
  const pierce = Math.max(1, stats.atkPierce)
  let attackPerShot = 0

  for (let hit = 0; hit < pierce; hit += 1) {
    const amplification =
      hasTrait(world, 'pierce-amplification') ? 1 + hit * 0.12 : 1
    attackPerShot += attackDamage * amplification
  }
  if (hasTrait(world, 'auxiliary-beam')) attackPerShot += attackDamage * 0.4
  if (hasTrait(world, 'supernova-chain')) attackPerShot += attackDamage * 0.4
  if (hasTrait(world, 'interference-burst')) {
    attackPerShot +=
      attackDamage *
      (hasTrait(world, 'supernova-chain') ? 0.8 * 3 : 0.45 * 2)
  }
  if (hasTrait(world, 'backstrike')) {
    attackPerShot +=
      attackDamage * (hasTrait(world, 'backstrike-focus') ? 0.75 : 0.5)
  }
  if (hasTrait(world, 'split-refraction')) {
    attackPerShot += attackDamage * 0.5 * 2 * pierce / 3
  }
  if (hasTrait(world, 'horizon-focus')) attackPerShot += attackDamage * 0.4
  if (hasTrait(world, 'decapitation')) attackPerShot /= 0.82
  if (hasTrait(world, 'execution-spread')) attackPerShot *= 1.15

  if (world.playerClass === 'ranged' && world.skills.q.unlocked) {
    const duration = hasTrait(world, 'orbital-prism') ||
      hasTrait(world, 'singularity-interference')
      ? 7
      : 5
    const duty = duration / (duration + world.skills.q.maxCooldown)
    const splitMultiplier =
      0.3 *
      skillDamageMul(world.skills, 'q') *
      (hasTrait(world, 'split-refraction') ? 1.25 : 1)
    attackPerShot += attackDamage * splitMultiplier * 2 * pierce * duty
    attackPerShot += stats.markBonus * pierce * duty
  }

  let effectiveDps = attackPerShot / effectiveAtkInterval(stats)
  for (const id of ['q', 'w', 'e', 'r'] as const) {
    const perCast = skillDamagePerCast(world, id)
    if (perCast > 0) {
      effectiveDps += perCast / Math.max(DT, world.skills[id].maxCooldown)
    }
  }

  const referenceHealth =
    ENEMY_TYPES[TYPE_WALKER]!.hp * enemyHealthMultiplier(time)
  return effectiveDps / referenceHealth
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
 * Drives toward the nearest XP gem that has not started its pickup flight.
 *
 * The balance pilot used to stand still and depended on the old arena-wide
 * attraction radius. Explicit collection keeps the pacing measurement aligned
 * with the player-facing rule: floor XP is earned by moving close enough to it.
 */
function moveTowardNearestXpGem(
  world: World,
  input: ReturnType<typeof createInput>,
): void {
  const pool = world.xpGems
  const px = world.player.pos.x
  const py = world.player.pos.y
  let nearest = -1
  let nearestDistanceSquared = Number.POSITIVE_INFINITY

  for (let i = 0; i < pool.count; i += 1) {
    if (pool.attracted[i] !== 0) continue
    const dx = pool.x[i]! - px
    const dy = pool.y[i]! - py
    const distanceSquared = dx * dx + dy * dy
    if (distanceSquared < nearestDistanceSquared) {
      nearest = i
      nearestDistanceSquared = distanceSquared
    }
  }

  if (nearest < 0 || nearestDistanceSquared <= 1e-12) {
    input.move.x = 0
    input.move.y = 0
    return
  }

  const inverseDistance = 1 / Math.sqrt(nearestDistanceSquared)
  input.move.x = (pool.x[nearest]! - px) * inverseDistance
  input.move.y = (pool.y[nearest]! - py) * inverseDistance
}

/**
 * 5분 레벨 곡선의 표준 측정 시나리오.
 *
 * 플레이어는 가까운 바닥 XP를 회수하면서 가장 가까운 적을 조준하고,
 * 해금된 QWER을 쿨마다 누른다. 무적은 생존 운을 제거할 뿐
 * 공격·스폰·XP 판정에는 손대지 않는다.
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
  const dpsHealthRatios = Array<number>(DPS_HEALTH_SAMPLE_TIMES.length).fill(0)
  let nextTarget = 1
  let nextDpsSample = 0
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
    moveTowardNearestXpGem(world, input)
    input.skillsPressed = useQwer ? QWER_MASK : 0
    stepWorld(world, input)

    const sampleAt = DPS_HEALTH_SAMPLE_TIMES[nextDpsSample]
    world.damageFeedback.length = 0
    if (sampleAt !== undefined && world.time + 1e-9 >= sampleAt) {
      dpsHealthRatios[nextDpsSample] =
        effectiveDpsHealthRatio(world, sampleAt)
      nextDpsSample += 1
    }

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
    dpsHealthRatios,
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
