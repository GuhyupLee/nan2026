import type { RunMetaSnapshot } from '../sim/types.ts'

export const META_STORAGE_KEY = 'myeongwol-meta-v1'
export const META_VERSION = 2

export type MetaStatId = 'vitality' | 'stride'
export type MetaUnlockId =
  | 'decapitating-flash'
  | 'supernova-specimen'
  | 'eclipse-execution-array'
  | 'revival-seal'
export type MetaDoctrineId =
  | 'wanderer-inscription'
  | 'executioner-inscription'
  | 'guardian-inscription'
  | 'timekeeper-inscription'
export type MetaPurchaseId = MetaStatId | MetaUnlockId | MetaDoctrineId

export interface MetaProgress {
  version: typeof META_VERSION
  moonlight: number
  lifetimeKills: number
  bossWins: number
  vitalityRank: number
  strideRank: number
  purchasedUnlocks: MetaUnlockId[]
  purchasedDoctrines: MetaDoctrineId[]
  equippedDoctrineIds: MetaDoctrineId[]
}

export interface MetaUnlockDef {
  id: MetaUnlockId
  scopeLabel: string
  name: string
  description: string
  cost: number
  conditionLabel: string
  condition: (progress: MetaProgress) => boolean
}

export const META_UNLOCKS: readonly MetaUnlockDef[] = [
  {
    id: 'decapitating-flash',
    scopeLabel: '월아 · 공격 경로',
    name: '참두 일섬',
    description: 'III에서 체력 18% 이하 일반 적을 처형합니다.',
    cost: 300,
    conditionLabel: '누적 3,000 처치',
    condition: (progress) => progress.lifetimeKills >= 3000,
  },
  {
    id: 'supernova-specimen',
    scopeLabel: '루멘 · 융합',
    name: '초신성 표본',
    description: '간섭 필라멘트 III + 이중 초점 III.',
    cost: 260,
    conditionLabel: '누적 1,500 처치',
    condition: (progress) => progress.lifetimeKills >= 1500,
  },
  {
    id: 'eclipse-execution-array',
    scopeLabel: '월아 · 융합',
    name: '월식 처형진',
    description: '참두 일섬 III + 월영 쌍격 III.',
    cost: 360,
    conditionLabel: '보스 처치 1회',
    condition: (progress) => progress.bossWins >= 1,
  },
  {
    id: 'revival-seal',
    scopeLabel: '공용 · 생존',
    name: '귀환의 인장',
    description: '런마다 한 번, 치명상을 버티고 체력 50%로 돌아옵니다.',
    cost: 500,
    conditionLabel: '보스 처치 1회',
    condition: (progress) => progress.bossWins >= 1,
  },
] as const

export interface MetaDoctrineDef {
  id: MetaDoctrineId
  name: string
  pathName: string
  rankLines: readonly [string, string, string]
  cost: number
}

export const META_DOCTRINE_SLOT_MAX = 2

export const META_DOCTRINES: readonly MetaDoctrineDef[] = [
  {
    id: 'wanderer-inscription',
    name: '유랑자의 나침반',
    pathName: '유랑자의 나침반',
    rankLines: ['아이템 획득 범위 +25%', '이동 속도 +6%', '전장 회복 +40%'],
    cost: 180,
  },
  {
    id: 'executioner-inscription',
    name: '집행자의 매듭',
    pathName: '집행자의 매듭',
    rankLines: ['공격 피해 +10%', '기본 공격 간격 -10%', '기본 공격 관통 +1'],
    cost: 220,
  },
  {
    id: 'guardian-inscription',
    name: '수호월 인장',
    pathName: '수호월 인장',
    rankLines: ['최대 체력 +18', '받는 피해 -7%', '회복량 +14'],
    cost: 240,
  },
  {
    id: 'timekeeper-inscription',
    name: '시계공의 월침',
    pathName: '시계공의 월침',
    rankLines: ['QWER 재사용 대기시간 -7%', 'D/F 재사용 대기시간 -12%', '점멸 거리 +2'],
    cost: 280,
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
    purchasedDoctrines: [],
    equippedDoctrineIds: [],
  }
}

let memory = freshProgress()

function finiteInt(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

export function isMetaUnlockId(value: unknown): value is MetaUnlockId {
  return META_UNLOCKS.some((unlock) => unlock.id === value)
}

export function isMetaDoctrineId(value: unknown): value is MetaDoctrineId {
  return META_DOCTRINES.some((doctrine) => doctrine.id === value)
}

export function sanitizeMetaProgress(value: unknown): MetaProgress {
  if (typeof value !== 'object' || value === null) return freshProgress()
  const source = value as Partial<MetaProgress>
  const purchasedUnlocks = Array.isArray(source.purchasedUnlocks)
    ? Array.from(new Set(source.purchasedUnlocks.filter(isMetaUnlockId)))
    : []
  const purchasedDoctrines = Array.isArray(source.purchasedDoctrines)
    ? Array.from(new Set(source.purchasedDoctrines.filter(isMetaDoctrineId)))
    : []
  const purchasedDoctrineSet = new Set(purchasedDoctrines)
  const equippedDoctrineIds = Array.isArray(source.equippedDoctrineIds)
    ? Array.from(
        new Set(
          source.equippedDoctrineIds.filter(
            (id): id is MetaDoctrineId =>
              isMetaDoctrineId(id) && purchasedDoctrineSet.has(id),
          ),
        ),
      ).slice(0, META_DOCTRINE_SLOT_MAX)
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
    purchasedDoctrines,
    equippedDoctrineIds,
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
    unlockedUpgradeIds: [
      ...META_UNLOCKS.filter((unlock) =>
        isMetaUnlockActive(safe, unlock.id),
      ).map((unlock) => unlock.id),
      ...META_DOCTRINES.filter((doctrine) =>
        safe.equippedDoctrineIds.includes(doctrine.id),
      ).map((doctrine) => doctrine.id),
    ],
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

  if (isMetaDoctrineId(id)) {
    const doctrine = META_DOCTRINES.find((candidate) => candidate.id === id)!
    if (
      current.purchasedDoctrines.includes(id) ||
      current.moonlight < doctrine.cost
    ) {
      return { progress: current, purchased: false }
    }
    const equippedDoctrineIds =
      current.equippedDoctrineIds.length < META_DOCTRINE_SLOT_MAX
        ? [...current.equippedDoctrineIds, id]
        : current.equippedDoctrineIds
    return {
      progress: write({
        ...current,
        moonlight: current.moonlight - doctrine.cost,
        purchasedDoctrines: [...current.purchasedDoctrines, id],
        equippedDoctrineIds,
      }),
      purchased: true,
    }
  }

  if (!isMetaUnlockId(id)) {
    return { progress: current, purchased: false }
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

export function toggleMetaDoctrine(id: MetaDoctrineId): {
  progress: MetaProgress
  changed: boolean
  equipped: boolean
} {
  const current = read()
  if (!current.purchasedDoctrines.includes(id)) {
    return { progress: current, changed: false, equipped: false }
  }
  if (current.equippedDoctrineIds.includes(id)) {
    return {
      progress: write({
        ...current,
        equippedDoctrineIds: current.equippedDoctrineIds.filter(
          (equippedId) => equippedId !== id,
        ),
      }),
      changed: true,
      equipped: false,
    }
  }
  if (current.equippedDoctrineIds.length >= META_DOCTRINE_SLOT_MAX) {
    return { progress: current, changed: false, equipped: false }
  }
  return {
    progress: write({
      ...current,
      equippedDoctrineIds: [...current.equippedDoctrineIds, id],
    }),
    changed: true,
    equipped: true,
  }
}
