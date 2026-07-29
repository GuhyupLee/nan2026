import type { RunMetaSnapshot } from '../sim/types.ts'

export const META_STORAGE_KEY = 'myeongwol-meta-v1'
export const META_VERSION = 3

export type MetaStatId =
  | 'vitality'
  | 'stride'
  | 'might'
  | 'celerity'
  | 'ward'
  | 'harvest'
  | 'mending'
  | 'fate'
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
  | 'star-eater-inscription'
  | 'bloodmoon-inscription'
  | 'tempest-inscription'
  | 'hunter-inscription'
export type MetaPurchaseId = MetaStatId | MetaUnlockId | MetaDoctrineId

export interface MetaProgress {
  version: typeof META_VERSION
  moonlight: number
  lifetimeKills: number
  bossWins: number
  lifetimeScore: number
  completedRuns: number
  vitalityRank: number
  strideRank: number
  mightRank: number
  celerityRank: number
  wardRank: number
  harvestRank: number
  mendingRank: number
  fateRank: number
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

export interface MetaStatDef {
  id: MetaStatId
  name: string
  summary: string
  costs: readonly [number, number, number, number, number]
  currentEffect: (rank: number) => string
  nextEffect: (rank: number) => string
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
  {
    id: 'star-eater-inscription',
    name: '별을 삼킨 패',
    pathName: '별을 삼킨 패',
    rankLines: ['획득 XP +18%', '아이템 획득 범위 +30%', '모든 공격 피해 +10%'],
    cost: 260,
  },
  {
    id: 'bloodmoon-inscription',
    name: '혈월의 서약',
    pathName: '혈월의 서약',
    rankLines: ['모든 공격 피해 +12%', '처치 회복 충전 +70%', '최대 체력 -15 · 피해 +18%'],
    cost: 300,
  },
  {
    id: 'tempest-inscription',
    name: '폭풍의 매듭',
    pathName: '폭풍의 매듭',
    rankLines: ['이동 속도 +7%', '기본 공격 간격 -12%', 'QWER 재사용 대기시간 -9%'],
    cost: 280,
  },
  {
    id: 'hunter-inscription',
    name: '천궁의 사냥패',
    pathName: '천궁의 사냥패',
    rankLines: ['기본 공격 사거리 +1.5', '기본 공격 관통 +1', '모든 공격 피해 +14%'],
    cost: 320,
  },
] as const

export const META_STAT_RANK_MAX = 5

const percent = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1)

export const META_STATS: readonly MetaStatDef[] = [
  {
    id: 'vitality',
    name: '월맥',
    summary: '전투 시작 체력을 높입니다.',
    costs: [90, 180, 320, 520, 800],
    currentEffect: (rank) => `최대 체력 +${rank * 4}`,
    nextEffect: () => '최대 체력 +4',
  },
  {
    id: 'stride',
    name: '월보',
    summary: '위험 지대를 빠르게 벗어납니다.',
    costs: [100, 200, 360, 580, 880],
    currentEffect: (rank) => `이동 속도 +${percent(rank * 1.2)}%`,
    nextEffect: () => '이동 속도 +1.2%',
  },
  {
    id: 'might',
    name: '쇄월',
    summary: '기본 공격과 모든 스킬의 피해를 높입니다.',
    costs: [120, 240, 420, 680, 1020],
    currentEffect: (rank) => `모든 피해 +${percent(rank * 2.5)}%`,
    nextEffect: () => '모든 피해 +2.5%',
  },
  {
    id: 'celerity',
    name: '월각',
    summary: 'QWER·D·F를 더 자주 사용합니다.',
    costs: [130, 260, 450, 720, 1080],
    currentEffect: (rank) => `재사용 대기시간 -${percent(rank * 1.5)}%`,
    nextEffect: () => '재사용 대기시간 -1.5%',
  },
  {
    id: 'ward',
    name: '월갑',
    summary: '모든 적과 보스에게 받는 피해를 줄입니다.',
    costs: [120, 250, 440, 700, 1050],
    currentEffect: (rank) => `받는 피해 -${rank * 2}%`,
    nextEffect: () => '받는 피해 -2%',
  },
  {
    id: 'harvest',
    name: '인력',
    summary: '더 멀리서 보석을 모으고 더 빠르게 성장합니다.',
    costs: [100, 210, 380, 620, 940],
    currentEffect: (rank) =>
      `획득 범위 +${rank * 8}% · XP +${rank * 3}%`,
    nextEffect: () => '획득 범위 +8% · XP +3%',
  },
  {
    id: 'mending',
    name: '재생',
    summary: '회복 스킬과 전장 회복 효과를 키웁니다.',
    costs: [90, 190, 340, 560, 850],
    currentEffect: (rank) => `모든 회복 +${rank * 8}%`,
    nextEffect: () => '모든 회복 +8%',
  },
  {
    id: 'fate',
    name: '운명',
    summary: '마음에 들지 않는 일반 강화 선택을 다시 뽑습니다.',
    costs: [160, 300, 500, 760, 1100],
    currentEffect: (rank) => `강화 재굴림 ${Math.ceil(rank / 2)}회`,
    nextEffect: (rank) =>
      Math.ceil((rank + 1) / 2) > Math.ceil(rank / 2)
        ? '런당 재굴림 +1'
        : '다음 재굴림 단계에 접근',
  },
] as const

function freshProgress(): MetaProgress {
  return {
    version: META_VERSION,
    moonlight: 0,
    lifetimeKills: 0,
    bossWins: 0,
    lifetimeScore: 0,
    completedRuns: 0,
    vitalityRank: 0,
    strideRank: 0,
    mightRank: 0,
    celerityRank: 0,
    wardRank: 0,
    harvestRank: 0,
    mendingRank: 0,
    fateRank: 0,
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
    lifetimeScore: finiteInt(source.lifetimeScore, 0, 999_999_999),
    completedRuns: finiteInt(source.completedRuns, 0, 9_999_999),
    vitalityRank: finiteInt(
      source.vitalityRank,
      0,
      META_STAT_RANK_MAX,
    ),
    strideRank: finiteInt(source.strideRank, 0, META_STAT_RANK_MAX),
    mightRank: finiteInt(source.mightRank, 0, META_STAT_RANK_MAX),
    celerityRank: finiteInt(source.celerityRank, 0, META_STAT_RANK_MAX),
    wardRank: finiteInt(source.wardRank, 0, META_STAT_RANK_MAX),
    harvestRank: finiteInt(source.harvestRank, 0, META_STAT_RANK_MAX),
    mendingRank: finiteInt(source.mendingRank, 0, META_STAT_RANK_MAX),
    fateRank: finiteInt(source.fateRank, 0, META_STAT_RANK_MAX),
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
    version: 2,
    maxHpBonus: safe.vitalityRank * 4,
    speedMultiplier: 1 + safe.strideRank * 0.012,
    damageMultiplier: 1 + safe.mightRank * 0.025,
    cooldownMultiplier: 1 - safe.celerityRank * 0.015,
    damageTakenMultiplier: 1 - safe.wardRank * 0.02,
    pickupRadiusMultiplier: 1 + safe.harvestRank * 0.08,
    healingMultiplier: 1 + safe.mendingRank * 0.08,
    xpMultiplier: 1 + safe.harvestRank * 0.03,
    rerolls: Math.ceil(safe.fateRank / 2),
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
  score?: number
  runs?: number
}

/** 결과 점수를 영구 성장 재화로 바꾼다. 난이도 배율까지 반영된 75점당 월광 1개다. */
export function scoreToMoonlight(score: number): number {
  return Math.max(0, Math.floor(finiteInt(score, 0, 999_999_999) / 75))
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
    lifetimeScore:
      before.lifetimeScore + finiteInt(award.score, 0, 999_999_999),
    completedRuns:
      before.completedRuns + finiteInt(award.runs, 0, 9_999_999),
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
  return META_STATS.find((stat) => stat.id === id)?.costs[currentRank] ?? null
}

export function metaStatRank(
  progress: MetaProgress,
  id: MetaStatId,
): number {
  if (id === 'vitality') return progress.vitalityRank
  if (id === 'stride') return progress.strideRank
  if (id === 'might') return progress.mightRank
  if (id === 'celerity') return progress.celerityRank
  if (id === 'ward') return progress.wardRank
  if (id === 'harvest') return progress.harvestRank
  if (id === 'mending') return progress.mendingRank
  return progress.fateRank
}

function withMetaStatRank(
  progress: MetaProgress,
  id: MetaStatId,
  rank: number,
): MetaProgress {
  if (id === 'vitality') return { ...progress, vitalityRank: rank }
  if (id === 'stride') return { ...progress, strideRank: rank }
  if (id === 'might') return { ...progress, mightRank: rank }
  if (id === 'celerity') return { ...progress, celerityRank: rank }
  if (id === 'ward') return { ...progress, wardRank: rank }
  if (id === 'harvest') return { ...progress, harvestRank: rank }
  if (id === 'mending') return { ...progress, mendingRank: rank }
  return { ...progress, fateRank: rank }
}

export function purchaseMetaItem(id: MetaPurchaseId): {
  progress: MetaProgress
  purchased: boolean
} {
  const current = read()
  if (META_STATS.some((stat) => stat.id === id)) {
    const statId = id as MetaStatId
    const rank = metaStatRank(current, statId)
    const cost = metaStatCost(statId, rank)
    if (cost === null || current.moonlight < cost) {
      return { progress: current, purchased: false }
    }
    return {
      progress: write(
        withMetaStatRank(
          { ...current, moonlight: current.moonlight - cost },
          statId,
          rank + 1,
        ),
      ),
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
