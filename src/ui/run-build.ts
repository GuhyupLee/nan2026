import {
  UPGRADES,
  getUpgrade,
  getUpgradeBranchPresentation,
  getUpgradeRank,
} from '../content/upgrades.ts'
import type { World } from '../sim/types.ts'
import {
  RUN_BUILD_SKILLS,
  RUN_BUILD_VERSION,
  type RunBuildSkill,
  type RunBuildSkillId,
  type RunBuildSummaryV1,
} from './records.ts'

export interface RunBuildSkillPresentation {
  id: RunBuildSkillId
  unlocked: boolean
  rank: number
  branchName: string | null
  evolution: 'locked' | 'base' | 'awakening' | 'fusion'
}

export interface RunBuildPresentation {
  battlefieldCode: string
  skills: RunBuildSkillPresentation[]
  awakeningNames: string[]
  fusionNames: string[]
}

function snapshotSkill(world: World, id: RunBuildSkillId): RunBuildSkill {
  const runtime = world.skills[id]
  const rank = Math.max(0, Math.min(4, Math.floor(runtime.rank)))
  return {
    unlocked: runtime.unlocked,
    rank,
    ...(runtime.branch ? { branch: runtime.branch } : {}),
  }
}

/** 현재 월드에서 결과·기록에 필요한 작은 불변 빌드 스냅샷만 만든다. */
export function createRunBuildSummary(world: World): RunBuildSummaryV1 {
  const awakeningIds: string[] = []
  const fusionIds: string[] = []

  for (const upgrade of UPGRADES) {
    const rank = getUpgradeRank(world.upgradesTaken, upgrade.id)
    if (upgrade.fusion) {
      if (rank > 0) fusionIds.push(upgrade.id)
    } else if (rank >= 3) {
      // branch는 융합 완성 때 덮일 수 있으므로 획득 랭크로 선행 각성을 센다.
      awakeningIds.push(upgrade.id)
    }
  }

  return {
    version: RUN_BUILD_VERSION,
    seed: world.seed >>> 0,
    skills: {
      q: snapshotSkill(world, 'q'),
      w: snapshotSkill(world, 'w'),
      e: snapshotSkill(world, 'e'),
      r: snapshotSkill(world, 'r'),
    },
    awakeningIds,
    fusionIds,
    seals: Math.max(0, Math.floor(world.relicsClaimed)),
  }
}

/** 숫자 시드를 결과 화면에서 짧고 다시 읽기 쉬운 전장 코드로 표시한다. */
export function formatBattlefieldCode(seed: number): string {
  const hex = (seed >>> 0).toString(16).toUpperCase().padStart(8, '0')
  return `${hex.slice(0, 4)}-${hex.slice(4)}`
}

/**
 * 저장된 id만 현재 콘텐츠 표의 신뢰 가능한 표시명으로 바꾼다.
 * 손상되었거나 미래 콘텐츠에서 사라진 id는 조용히 건너뛴다.
 */
export function getRunBuildPresentation(
  build: RunBuildSummaryV1,
): RunBuildPresentation {
  const skills = RUN_BUILD_SKILLS.map((id) => {
    const skill = build.skills[id]
    const branchUpgrade = skill.branch
      ? UPGRADES.find((upgrade) =>
          upgrade.ranks.some((rank) => rank.trait === skill.branch),
        )
      : undefined
    const branchName = skill.branch
      ? getUpgradeBranchPresentation(skill.branch, id)?.name ?? null
      : null
    const evolution: RunBuildSkillPresentation['evolution'] = !skill.unlocked
      ? 'locked'
      : branchUpgrade?.fusion
        ? 'fusion'
        : branchUpgrade
          ? 'awakening'
          : 'base'
    return {
      id,
      unlocked: skill.unlocked,
      rank: skill.rank,
      branchName,
      evolution,
    }
  })

  const awakeningNames = build.awakeningIds.flatMap((id) => {
    const upgrade = getUpgrade(id)
    if (!upgrade || upgrade.fusion) return []
    const finalRank = upgrade.ranks[upgrade.ranks.length - 1]
    return finalRank
      ? [finalRank.awakeningName ?? finalRank.displayName ?? upgrade.name]
      : []
  })
  const fusionNames = build.fusionIds.flatMap((id) => {
    const upgrade = getUpgrade(id)
    return upgrade?.fusion ? [upgrade.name] : []
  })

  return {
    battlefieldCode: formatBattlefieldCode(build.seed),
    skills,
    awakeningNames,
    fusionNames,
  }
}
