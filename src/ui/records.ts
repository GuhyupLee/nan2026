import type { PlayerClass } from '../sim/types.ts'

/**
 * 최고 기록 저장.
 *
 * 서버가 없다(GitHub Pages 정적 호스팅). localStorage에만 남긴다 —
 * 심사자가 두 번째 판을 돌릴 이유를 만드는 게 목적이지 순위 경쟁이 아니다.
 *
 * 저장이 막힌 환경(시크릿 모드·저장소 차단)에서도 게임은 그대로 돌아가야 한다.
 * 그래서 모든 접근을 try로 감싸고 실패하면 조용히 메모리만 쓴다.
 */

export const RECORDS_STORAGE_KEY = 'myeongwol-records-v1'
/** 클래스당 보관하는 기록 수. 결과 화면에 다 들어가는 만큼만. */
const KEEP = 5

export const RUN_BUILD_VERSION = 1
export const RUN_BUILD_SKILLS = ['q', 'w', 'e', 'r'] as const
export type RunBuildSkillId = (typeof RUN_BUILD_SKILLS)[number]

export interface RunBuildSkill {
  unlocked: boolean
  /** 스킬 자체의 반복 강화 랭크. 0..4. */
  rank: number
  /** 최종 각성·융합 trait id. 콘텐츠 표의 안전한 이름으로 다시 해석한다. */
  branch?: string
}

/**
 * 결과·기록 화면용 빌드 스냅샷.
 *
 * 기록 저장소 키는 과거 v1과 공유하되 이 선택 필드 안에서만 버전을 올린다.
 * 따라서 예전 기록은 그대로 읽고, 미래 빌드는 기본 전적을 잃지 않은 채 무시한다.
 */
export interface RunBuildSummaryV1 {
  version: typeof RUN_BUILD_VERSION
  seed: number
  skills: Record<RunBuildSkillId, RunBuildSkill>
  /** 일반 장비 중 III까지 완성한 id. */
  awakeningIds: string[]
  /** 완성한 합성 장비 id. */
  fusionIds: string[]
  /** 이번 판에 회수한 월식 인장 수. */
  seals: number
}

export interface RunRecord {
  score: number
  kills: number
  level: number
  /** 생존/클리어 시간(초). */
  time: number
  victory: boolean
  /** 기록 시각(epoch ms). 동점일 때 최신을 위로 올린다. */
  at: number
  /** 이전 기록에는 없을 수 있으며, 손상되면 기본 전적만 보존한다. */
  build?: RunBuildSummaryV1
}

type Store = Partial<Record<PlayerClass, RunRecord[]>>

/** 저장소가 막혔을 때를 대비한 세션 메모리. */
let memory: Store = {}

function read(): Store {
  try {
    const raw = globalThis.localStorage?.getItem(RECORDS_STORAGE_KEY)
    if (!raw) return memory
    const parsed = JSON.parse(raw) as Store
    // 형태가 깨져 있으면 무시한다. 저장 포맷이 바뀌어도 게임이 멈추지 않게.
    if (typeof parsed !== 'object' || parsed === null) return memory
    return parsed
  } catch {
    return memory
  }
}

function write(store: Store): void {
  memory = store
  try {
    globalThis.localStorage?.setItem(RECORDS_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // 저장 실패는 조용히 넘긴다. 이번 세션 동안은 메모리 기록이 유지된다.
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sanitizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const unique = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 80) continue
    unique.add(entry)
    if (unique.size >= 16) break
  }
  return [...unique]
}

function sanitizeBuildSkill(value: unknown): RunBuildSkill | null {
  if (typeof value !== 'object' || value === null) return null
  const skill = value as Partial<RunBuildSkill>
  if (
    typeof skill.unlocked !== 'boolean' ||
    !Number.isInteger(skill.rank) ||
    !finiteNumber(skill.rank) ||
    skill.rank < 0 ||
    skill.rank > 4
  ) {
    return null
  }

  const branch =
    typeof skill.branch === 'string' &&
    skill.branch.length > 0 &&
    skill.branch.length <= 80
      ? skill.branch
      : undefined
  return {
    unlocked: skill.unlocked,
    rank: skill.rank,
    ...(branch ? { branch } : {}),
  }
}

function sanitizeBuild(value: unknown): RunBuildSummaryV1 | null {
  if (typeof value !== 'object' || value === null) return null
  const build = value as Partial<RunBuildSummaryV1>
  if (
    build.version !== RUN_BUILD_VERSION ||
    !Number.isInteger(build.seed) ||
    !finiteNumber(build.seed) ||
    build.seed < 0 ||
    build.seed > 0xffffffff ||
    !Number.isInteger(build.seals) ||
    !finiteNumber(build.seals) ||
    build.seals < 0 ||
    build.seals > 999 ||
    typeof build.skills !== 'object' ||
    build.skills === null
  ) {
    return null
  }

  const skills = build.skills as Partial<Record<RunBuildSkillId, unknown>>
  const q = sanitizeBuildSkill(skills.q)
  const w = sanitizeBuildSkill(skills.w)
  const e = sanitizeBuildSkill(skills.e)
  const r = sanitizeBuildSkill(skills.r)
  if (!q || !w || !e || !r) return null

  return {
    version: RUN_BUILD_VERSION,
    seed: build.seed,
    skills: { q, w, e, r },
    awakeningIds: sanitizeIdList(build.awakeningIds),
    fusionIds: sanitizeIdList(build.fusionIds),
    seals: build.seals,
  }
}

function sanitizeRecord(value: unknown): RunRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Partial<RunRecord>
  if (
    !finiteNumber(record.score) ||
    !finiteNumber(record.kills) ||
    !finiteNumber(record.level) ||
    !finiteNumber(record.time) ||
    !finiteNumber(record.at) ||
    Number.isNaN(new Date(record.at).getTime()) ||
    typeof record.victory !== 'boolean'
  ) {
    return null
  }

  const build = sanitizeBuild(record.build)
  return {
    score: record.score,
    kills: record.kills,
    level: record.level,
    time: record.time,
    victory: record.victory,
    at: record.at,
    ...(build ? { build } : {}),
  }
}

function sanitize(list: unknown): RunRecord[] {
  if (!Array.isArray(list)) return []
  const records: RunRecord[] = []
  for (const value of list) {
    const record = sanitizeRecord(value)
    if (record) records.push(record)
    if (records.length >= KEEP) break
  }
  return records
}

export function loadRecords(cls: PlayerClass): RunRecord[] {
  return sanitize(read()[cls])
}

export function loadBest(cls: PlayerClass): RunRecord | null {
  return loadRecords(cls)[0] ?? null
}

/**
 * 기록을 남기고 갱신 여부를 알려준다.
 * @returns isBest 이번 판이 최고 기록인가
 */
export function saveRecord(
  cls: PlayerClass,
  record: RunRecord,
): { records: RunRecord[]; isBest: boolean } {
  const store = read()
  const prev = sanitize(store[cls])
  const prevBest = prev[0]?.score ?? -1
  const safeRecord = sanitizeRecord(record)
  if (!safeRecord) return { records: prev, isBest: false }

  const next = [...prev, safeRecord]
    // 점수 내림차순, 동점이면 최신 우선.
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, KEEP)

  write({ ...store, [cls]: next })
  return { records: next, isBest: safeRecord.score > prevBest }
}

/** m:ss 포맷. */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const mm = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${mm}:${String(ss).padStart(2, '0')}`
}
