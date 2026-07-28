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

const KEY = 'myeongwol-records-v1'
/** 클래스당 보관하는 기록 수. 결과 화면에 다 들어가는 만큼만. */
const KEEP = 5

export interface RunRecord {
  score: number
  kills: number
  level: number
  /** 생존/클리어 시간(초). */
  time: number
  victory: boolean
  /** 기록 시각(epoch ms). 동점일 때 최신을 위로 올린다. */
  at: number
}

type Store = Partial<Record<PlayerClass, RunRecord[]>>

/** 저장소가 막혔을 때를 대비한 세션 메모리. */
let memory: Store = {}

function read(): Store {
  try {
    const raw = globalThis.localStorage?.getItem(KEY)
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
    globalThis.localStorage?.setItem(KEY, JSON.stringify(store))
  } catch {
    // 저장 실패는 조용히 넘긴다. 이번 세션 동안은 메모리 기록이 유지된다.
  }
}

function sanitize(list: unknown): RunRecord[] {
  if (!Array.isArray(list)) return []
  return list
    .filter(
      (r): r is RunRecord =>
        typeof r === 'object' &&
        r !== null &&
        Number.isFinite((r as RunRecord).score) &&
        Number.isFinite((r as RunRecord).kills) &&
        Number.isFinite((r as RunRecord).level) &&
        Number.isFinite((r as RunRecord).time) &&
        Number.isFinite((r as RunRecord).at) &&
        !Number.isNaN(new Date((r as RunRecord).at).getTime()) &&
        typeof (r as RunRecord).victory === 'boolean',
    )
    .slice(0, KEEP)
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

  const next = [...prev, record]
    // 점수 내림차순, 동점이면 최신 우선.
    .sort((a, b) => b.score - a.score || b.at - a.at)
    .slice(0, KEEP)

  write({ ...store, [cls]: next })
  return { records: next, isBest: record.score > prevBest }
}

/** m:ss 포맷. */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const mm = Math.floor(s / 60)
  const ss = Math.floor(s % 60)
  return `${mm}:${String(ss).padStart(2, '0')}`
}
