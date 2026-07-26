import type { Rng } from './rng.ts'

/**
 * 진행도 — XP, 레벨, 레벨업 보상.
 *
 * 이 파일의 핵심은 TARGET_LEVEL_TIMES 다. 비트 시트에 적어둔 레벨업 시각을
 * 코드 안으로 끌고 들어와 "검증 대상"으로 만든다. 희망이 아니라 스펙이다.
 * tools/balance 가 실제 도달 시각과 이 표를 비교해 드리프트를 보고한다.
 */

/**
 * 비트 시트가 지정한 레벨 도달 목표 시각(초).
 * 인덱스 i = 레벨 (i+1). 즉 [1] = Lv2 = 20초.
 */
export const TARGET_LEVEL_TIMES = [
  0, //   Lv1  0:00  시작
  20, //  Lv2  0:20  첫 스킬 해금 (3중 1택)
  50, //  Lv3  0:50  두번째 스킬 해금 (2중 1택)
  75, //  Lv4  1:15  강화
  100, // Lv5  1:40  마지막 스킬 확정 획득
  130, // Lv6  2:10  강화
  165, // Lv7  2:45  강화
  200, // Lv8  3:20  궁극기 해금 → 10초 뒤 보스
  240, // Lv9  4:00  강화
  270, // Lv10 4:30  강화
] as const

export const MAX_LEVEL = TARGET_LEVEL_TIMES.length

/**
 * Lv(i+1) → Lv(i+2) 에 필요한 XP.
 *
 * 이 수치는 스폰 커브·플레이어 DPS와 맞물려야 목표 시각이 나온다.
 * D9 밸런싱에서 조정될 초기값이다. 손으로 맞추려 들지 말 것.
 */
export const XP_FOR_NEXT = [8, 16, 26, 38, 54, 74, 98, 128, 164] as const

/** 레벨업 시 무엇을 주는가. */
export type LevelReward =
  | 'unlock-choice' // 아직 없는 스킬 중 하나를 고른다
  | 'unlock-last' // 남은 마지막 스킬을 확정 지급 (선택지가 1개면 선택이 아니다)
  | 'unlock-ult' // 궁극기 확정 지급
  | 'upgrade' // 강화 3택

export const LEVEL_REWARDS: Readonly<Record<number, LevelReward>> = {
  2: 'unlock-choice',
  3: 'unlock-choice',
  4: 'upgrade',
  5: 'unlock-last',
  6: 'upgrade',
  7: 'upgrade',
  8: 'unlock-ult',
  9: 'upgrade',
  10: 'upgrade',
}

export interface Progression {
  level: number
  /** 현재 레벨 구간에서 모은 XP. */
  xp: number
  /** 아직 보상을 고르지 않은 레벨업 수. 0보다 크면 게임이 멈춘다. */
  pendingLevelUps: number
  /** 누적 획득 XP. 계측용. */
  totalXp: number
  /**
   * 레벨별 실제 도달 시각(초). 인덱스는 TARGET_LEVEL_TIMES와 같다.
   * 비트 시트 검증의 원천 데이터다.
   */
  levelTimes: number[]
}

export function createProgression(): Progression {
  return {
    level: 1,
    xp: 0,
    pendingLevelUps: 0,
    totalXp: 0,
    levelTimes: [0],
  }
}

/** 현재 레벨에서 다음 레벨까지 필요한 XP. 만렙이면 Infinity. */
export function xpToNext(level: number): number {
  if (level >= MAX_LEVEL) return Number.POSITIVE_INFINITY
  return XP_FOR_NEXT[level - 1] ?? Number.POSITIVE_INFINITY
}

/**
 * XP를 넣고 레벨업을 처리한다.
 *
 * 보스 처치처럼 한 번에 큰 XP가 들어오면 여러 레벨이 동시에 오를 수 있으므로
 * 루프로 처리한다. @param time 은 levelTimes 기록용 현재 시각(초).
 */
export function addXp(prog: Progression, amount: number, time: number): void {
  if (amount <= 0) return
  prog.totalXp += amount

  if (prog.level >= MAX_LEVEL) return

  prog.xp += amount
  while (prog.level < MAX_LEVEL) {
    const need = xpToNext(prog.level)
    if (prog.xp < need) break
    prog.xp -= need
    prog.level += 1
    prog.pendingLevelUps += 1
    prog.levelTimes[prog.level - 1] = time
  }

  if (prog.level >= MAX_LEVEL) prog.xp = 0
}

/** 다음에 처리해야 할 레벨업의 보상 종류. 대기 중인 레벨업이 없으면 null. */
export function pendingReward(prog: Progression): LevelReward | null {
  if (prog.pendingLevelUps <= 0) return null
  // 여러 개가 밀려 있으면 낮은 레벨부터 처리한다.
  const level = prog.level - prog.pendingLevelUps + 1
  return LEVEL_REWARDS[level] ?? 'upgrade'
}

/** 대기 중인 레벨업 하나를 소진한다. 선택 적용 후 호출한다. */
export function consumeLevelUp(prog: Progression): void {
  if (prog.pendingLevelUps > 0) prog.pendingLevelUps -= 1
}

// ---------------------------------------------------------------------------
// 선택지 생성
// ---------------------------------------------------------------------------

/**
 * 레벨업 화면에 뜨는 카드 하나.
 * 시뮬은 id만 알면 되고, 표시 문구는 UI가 콘텐츠에서 가져다 쓴다.
 */
export interface LevelChoice {
  id: string
  kind: 'unlock' | 'upgrade'
}

/**
 * 강화 후보 하나. 콘텐츠(src/content)가 제공한다.
 * 시뮬을 콘텐츠에 직접 묶지 않기 위해 풀을 인자로 받는다 —
 * 밸런싱에서 다른 풀을 주입해 비교 실험을 돌릴 수 있다.
 */
export interface UpgradeCandidate {
  id: string
  /** 지금 뽑을 수 있는가. 전제 스킬 미보유 등으로 막힐 수 있다. */
  available: boolean
  /** 뽑기 가중치. 클수록 자주 등장. */
  weight: number
}

/**
 * 중복 없이 count개를 가중 추출한다.
 *
 * 반드시 rng만 쓴다. 정렬·순회 순서가 입력 배열 순서에만 의존하므로
 * 같은 시드 + 같은 상태면 항상 같은 카드가 나온다.
 */
export function rollUpgrades(
  rng: Rng,
  pool: readonly UpgradeCandidate[],
  count: number,
): LevelChoice[] {
  const bag = pool.filter((c) => c.available && c.weight > 0)
  const picked: LevelChoice[] = []

  // 후보가 모자라면 있는 만큼만 낸다. 카드가 2장이어도 게임은 굴러가야 한다.
  const n = Math.min(count, bag.length)
  let totalWeight = 0
  for (const c of bag) totalWeight += c.weight

  const taken = new Set<number>()
  for (let k = 0; k < n; k++) {
    let r = rng.next() * totalWeight
    let chosen = -1
    for (let i = 0; i < bag.length; i++) {
      if (taken.has(i)) continue
      r -= bag[i]!.weight
      if (r <= 0) {
        chosen = i
        break
      }
    }
    // 부동소수 오차로 못 고르면 남은 것 중 첫 번째를 집는다.
    if (chosen < 0) {
      for (let i = 0; i < bag.length; i++) {
        if (!taken.has(i)) {
          chosen = i
          break
        }
      }
    }
    if (chosen < 0) break

    taken.add(chosen)
    totalWeight -= bag[chosen]!.weight
    picked.push({ id: bag[chosen]!.id, kind: 'upgrade' })
  }

  return picked
}
