import type { RunMetaSnapshot } from '../sim/types.ts'

export const META_STORAGE_KEY = 'myeongwol-meta-v1'
export const META_VERSION = 1

export type MetaStatId = 'vitality' | 'stride'
export type MetaUnlockId =
  | 'decapitating-flash'
  | 'supernova-specimen'
  | 'eclipse-execution-array'
  | 'revival-seal'
export type MetaPurchaseId = MetaStatId | MetaUnlockId

export interface MetaProgress {
  version: typeof META_VERSION
  moonlight: number
  lifetimeKills: number
  bossWins: number
  vitalityRank: number
  strideRank: number
  purchasedUnlocks: MetaUnlockId[]
}

export interface MetaUnlockDef {
  id: MetaUnlockId
  name: string
  description: string
  cost: number
  conditionLabel: string
  condition: (progress: MetaProgress) => boolean
}

export const META_UNLOCKS: readonly MetaUnlockDef[] = [
  {
    id: 'decapitating-flash',
    name: '단두 일섬',
    description: '월아 처형 계열 카드를 강화 풀에 추가합니다.',
    cost: 300,
    conditionLabel: '누적 3,000 처치',
    condition: (progress) => progress.lifetimeKills >= 3000,
  },
  {
    id: 'supernova-specimen',
    name: '초신성 표본',
    description: '루멘의 간섭·이중 초점 각성을 합성할 수 있습니다.',
    cost: 260,
    conditionLabel: '누적 1,500 처치',
    condition: (progress) => progress.lifetimeKills >= 1500,
  },
  {
    id: 'eclipse-execution-array',
    name: '월식 처형진',
    description: '월아의 처형·쌍격 각성을 합성할 수 있습니다.',
    cost: 360,
    conditionLabel: '보스 처치 1회',
    condition: (progress) => progress.bossWins >= 1,
  },
  {
    id: 'revival-seal',
    name: '회생의 월인',
    description: '사망 시 한 번 되살아나는 공용 카드를 추가합니다.',
    cost: 500,
    conditionLabel: '보스 처치 1회',
    condition: (progress) => progress.bossWins >= 1,
  },
] as const

export const META_STAT_RANK_MAX = 3
const VITALITY_COSTS = [120, 240, 420] as const
const STRIDE_COSTS = [140, 280, 460] as const

function freshProgress(): MetaProgress {
  return {
    version: META_VERSION,
    moonlight: 0,
    lifetimeKills: 0,
    bossWins: 0,
    vitalityRank: 0,
    strideRank: 0,
    purchasedUnlocks: [],
  }
}

let memory = freshProgress()

function finiteInt(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function isMetaUnlockId(value: unknown): value is MetaUnlockId {
  return META_UNLOCKS.some((unlock) => unlock.id === value)
}

export function sanitizeMetaProgress(value: unknown): MetaProgress {
  if (typeof value !== 'object' || value === null) return freshProgress()
  const source = value as Partial<MetaProgress>
  const purchasedUnlocks = Array.isArray(source.purchasedUnlocks)
    ? Array.from(new Set(source.purchasedUnlocks.filter(isMetaUnlockId)))
    : []
  return {
    version: META_VERSION,
    moonlight: finiteInt(source.moonlight, 0, 9_999_999),
    lifetimeKills: finiteInt(source.lifetimeKills, 0, 99_999_999),
    bossWins: finiteInt(source.bossWins, 0, 999_999),
    vitalityRank: finiteInt(
      source.vitalityRank,
      0,
      META_STAT_RANK_MAX,
    ),
    strideRank: finiteInt(source.strideRank, 0, META_STAT_RANK_MAX),
    purchasedUnlocks,
  }
}

function read(): MetaProgress {
  try {
    const raw = globalThis.localStorage?.getItem(META_STORAGE_KEY)
    if (!raw) return sanitizeMetaProgress(memory)
    return sanitizeMetaProgress(JSON.parse(raw))
  } catch {
    return sanitizeMetaProgress(memory)
  }
}

function write(progress: MetaProgress): MetaProgress {
  const safe = sanitizeMetaProgress(progress)
  memory = safe
  try {
    globalThis.localStorage?.setItem(META_STORAGE_KEY, JSON.stringify(safe))
  } catch {
    // 저장소가 막혀도 현재 세션의 성장 상태는 메모리에 유지한다.
  }
  return safe
}

export function loadMetaProgress(): MetaProgress {
  return read()
}

export function isMetaUnlockActive(
  progress: MetaProgress,
  id: MetaUnlockId,
): boolean {
  const def = META_UNLOCKS.find((unlock) => unlock.id === id)
  return (
    progress.purchasedUnlocks.includes(id) ||
    (def?.condition(progress) ?? false)
  )
}

export function isHardModeUnlocked(progress: MetaProgress): boolean {
  return progress.bossWins >= 1
}

export function createRunMetaSnapshot(
  progress: MetaProgress,
): RunMetaSnapshot {
  const safe = sanitizeMetaProgress(progress)
  return {
    version: 1,
    // 6칸을 다 찍어도 런 파워가 크게 흔들리지 않는 작은 보정이다.
    maxHpBonus: safe.vitalityRank * 3,
    speedMultiplier: 1 + safe.strideRank * 0.01,
    unlockedUpgradeIds: META_UNLOCKS.filter((unlock) =>
      isMetaUnlockActive(safe, unlock.id),
    ).map((unlock) => unlock.id),
  }
}

export interface MetaRunAward {
  moonlight: number
  kills: number
  bossWins: number
}

export function awardMetaRun(award: MetaRunAward): {
  progress: MetaProgress
  newlyUnlocked: MetaUnlockId[]
} {
  const before = read()
  const beforeUnlocks = new Set(
    META_UNLOCKS.filter((unlock) => isMetaUnlockActive(before, unlock.id)).map(
      (unlock) => unlock.id,
    ),
  )
  const progress = write({
    ...before,
    moonlight:
      before.moonlight + finiteInt(award.moonlight, 0, 9_999_999),
    lifetimeKills:
      before.lifetimeKills + finiteInt(award.kills, 0, 99_999_999),
    bossWins: before.bossWins + finiteInt(award.bossWins, 0, 999_999),
  })
  const newlyUnlocked = META_UNLOCKS.flatMap((unlock) =>
    !beforeUnlocks.has(unlock.id) &&
    isMetaUnlockActive(progress, unlock.id)
      ? [unlock.id]
      : [],
  )
  return { progress, newlyUnlocked }
}

export function metaStatCost(
  id: MetaStatId,
  currentRank: number,
): number | null {
  const costs = id === 'vitality' ? VITALITY_COSTS : STRIDE_COSTS
  return costs[currentRank] ?? null
}

export function purchaseMetaItem(id: MetaPurchaseId): {
  progress: MetaProgress
  purchased: boolean
} {
  const current = read()
  if (id === 'vitality' || id === 'stride') {
    const rank =
      id === 'vitality' ? current.vitalityRank : current.strideRank
    const cost = metaStatCost(id, rank)
    if (cost === null || current.moonlight < cost) {
      return { progress: current, purchased: false }
    }
    return {
      progress: write({
        ...current,
        moonlight: current.moonlight - cost,
        ...(id === 'vitality'
          ? { vitalityRank: rank + 1 }
          : { strideRank: rank + 1 }),
      }),
      purchased: true,
    }
  }

  const unlock = META_UNLOCKS.find((candidate) => candidate.id === id)
  if (
    !unlock ||
    isMetaUnlockActive(current, id) ||
    current.moonlight < unlock.cost
  ) {
    return { progress: current, purchased: false }
  }
  return {
    progress: write({
      ...current,
      moonlight: current.moonlight - unlock.cost,
      purchasedUnlocks: [...current.purchasedUnlocks, id],
    }),
    purchased: true,
  }
}
