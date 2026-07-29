import type { Rng } from './rng.ts'
import type { PlayerClass } from './types.ts'

/**
 * 진행도 — XP, 레벨, 레벨업 보상.
 *
 * 이 파일의 핵심은 TARGET_LEVEL_TIMES 다. 비트 시트에 적어둔 레벨업 시각을
 * 코드 안으로 끌고 들어와 "검증 대상"으로 만든다. 희망이 아니라 스펙이다.
 * tools/balance 가 실제 도달 시각과 이 표를 비교해 드리프트를 보고한다.
 */

/**
 * 비트 시트가 지정한 레벨 도달 목표 시각(초).
 * 인덱스 i = 레벨 (i+1). 즉 [1] = Lv2 = 12초.
 */
export const TARGET_LEVEL_TIMES = [
  0, // Lv1  0:00
  12, // Lv2  0:12
  25, // Lv3  0:25
  40, // Lv4  0:40
  53, // Lv5  0:53
  66, // Lv6  1:06
  79, // Lv7  1:19
  92, // Lv8  1:32
  105, // Lv9  1:45
  118, // Lv10  1:58
  131, // Lv11  2:11
  144, // Lv12  2:24
  156, // Lv13  2:36
  168, // Lv14  2:48
  180, // Lv15  3:00
  192, // Lv16  3:12
  204, // Lv17  3:24
  215, // Lv18  3:35
  226, // Lv19  3:46
  236, // Lv20  3:56
  246, // Lv21  4:06
  256, // Lv22  4:16
  265, // Lv23  4:25
  274, // Lv24  4:34
  283, // Lv25  4:43
  292, // Lv26  4:52
] as const

export const MAX_LEVEL = TARGET_LEVEL_TIMES.length

/** 만렙 이후 반복 스킬 강화의 첫 요구 XP. */
export const REPEAT_SKILL_XP_BASE = 420
/** 무한모드 반복 강화마다 기본 요구량의 20%(84 XP)씩 선형으로 오른다. */
export const ENDLESS_REPEAT_SKILL_XP_STEP = 84

export function repeatSkillXpRequirement(
  endless: boolean,
  endlessRewardsEarned = 0,
): number {
  if (!endless) return REPEAT_SKILL_XP_BASE
  const earned = Number.isFinite(endlessRewardsEarned)
    ? Math.max(0, Math.floor(endlessRewardsEarned))
    : 0
  return REPEAT_SKILL_XP_BASE + earned * ENDLESS_REPEAT_SKILL_XP_STEP
}

/**
 * Lv(i+1) → Lv(i+2) 에 필요한 XP.
 *
 * Q→W→E 해금, 낮은 랭크 우선, QWER 쿨마다 사용이라는 고정 입력을
 * 원거리·근거리 각각 12개 시드로 5분간 실측했다. 각 목표 시각까지의
 * 클래스 보정 누적 XP 중앙값을 되먹임해 차분한 값이다.
 *
 * 재측정·시드별 리포트는 tools/balance가 담당한다. QWER 피해·쿨다운,
 * 스폰 또는 적 체력을 바꾸면 반드시 npm run balance로 곡선을 다시 확인한다.
 */
export const XP_FOR_NEXT = [
  // 초반 네 구간은 웨이브 도입으로 다시 잡았다.
  //
  // 예전 값(16/36/60/88)은 스폰 밀도가 일정하다는 전제로 맞춘 것이다.
  // 파동이 생기면서 런 시작이 소강이고 첫 파고가 20초에 오는 리듬으로
  // 바뀌었고, 그 결과 근접의 Lv2가 0.5초 늦고 두 클래스의 Lv3가 3초 넘게
  // 빨라졌다. 파동 상수를 아무리 조합해도 이 둘을 동시에 맞출 수 없었다 —
  // 도달 시각을 결정하는 것이 밀도가 아니라 **파고가 오는 시점**이기 때문이다.
  //
  // 그래서 요구량 쪽을 리듬에 맞춘다. Lv2는 첫 소강 안에서, Lv3는 첫 파고를
  // 정리한 직후에 오도록 옮겼다. Lv5 누적 200은 그대로다(14+42+60+84).
  14,
  42,
  60,
  84,
  97,
  101,
  163,
  187,
  210,
  249,
  270,
  309,
  326,
  328,
  385,
  394,
  327,
  271,
  268,
  275,
  254,
  237,
  234,
  259,
  299,
] as const

/**
 * 서지까지 포함한 24시드 실측에서 두 클래스의 Lv26 중앙값이
 * 4:52 목표 ±8초 회귀 범위에 모이도록 보정했다. 요구 XP는 공통으로
 * 유지해 카드 선택 문법은 같게 둔다.
 */
export const MELEE_XP_GAIN_MULTIPLIER = 0.56

/**
 * 원거리는 Q의 지속 3갈래 평타와 넓은 E로 처치 편차가 크다. 24시드 중앙값을 기준으로
 * 보정해 특정 빌드가 조금 느려도 대표 회귀 시드는 제한 시간 안에 완주한다.
 */
export const RANGED_XP_GAIN_MULTIPLIER = 0.595

/** 마지막 1분에 목표 레벨보다 뒤처진 빌드만 완만하게 따라잡는다. */
export const XP_CATCH_UP_START = 240
export const XP_CATCH_UP_MAX = 1.5
const XP_CATCH_UP_FULL_DELAY = 10

export function xpPacingMultiplier(level: number, time: number): number {
  if (level >= MAX_LEVEL || time < XP_CATCH_UP_START) return 1
  const target = TARGET_LEVEL_TIMES[level]
  if (target === undefined || time <= target) return 1
  const bonus = Math.min(
    XP_CATCH_UP_MAX - 1,
    ((time - target) / XP_CATCH_UP_FULL_DELAY) *
      (XP_CATCH_UP_MAX - 1),
  )
  return 1 + bonus
}

/** 레벨업 시 무엇을 주는가. */
export type LevelReward =
  | 'unlock-choice' // 아직 없는 스킬 중 하나를 고른다
  | 'unlock-last' // 남은 마지막 스킬을 확정 지급 (선택지가 1개면 선택이 아니다)
  | 'unlock-ult' // 궁극기 확정 지급
  | 'upgrade' // 강화 3택
  | 'skill-rank' // 해금한 스킬 하나의 랭크를 올린다 (반복 가능)

export const LEVEL_REWARDS: Readonly<Record<number, LevelReward>> = {
  2: 'unlock-choice',
  3: 'upgrade',
  4: 'unlock-choice',
  5: 'upgrade',
  6: 'skill-rank',
  7: 'unlock-last',
  8: 'unlock-ult',
  9: 'skill-rank',
  10: 'upgrade',
  11: 'skill-rank',
  12: 'upgrade',
  13: 'upgrade',
  14: 'skill-rank',
  15: 'upgrade',
  16: 'skill-rank',
  17: 'skill-rank',
  18: 'upgrade',
  19: 'skill-rank',
  20: 'upgrade',
  21: 'skill-rank',
  22: 'upgrade',
  23: 'skill-rank',
  24: 'upgrade',
  25: 'skill-rank',
  26: 'upgrade',
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
export function addXp(
  prog: Progression,
  amount: number,
  time: number,
): number {
  if (amount <= 0) return 0
  prog.totalXp += amount

  if (prog.level >= MAX_LEVEL) return amount

  prog.xp += amount
  while (prog.level < MAX_LEVEL) {
    const need = xpToNext(prog.level)
    if (prog.xp + 1e-9 < need) break
    prog.xp -= need
    prog.level += 1
    prog.pendingLevelUps += 1
    prog.levelTimes[prog.level - 1] = time
  }

  if (prog.level >= MAX_LEVEL) {
    const overflow = prog.xp
    prog.xp = 0
    return overflow
  }
  return 0
}

/** 다음에 처리해야 할 레벨업의 보상 종류. 대기 중인 레벨업이 없으면 null. */
export function pendingReward(prog: Progression): LevelReward | null {
  if (prog.pendingLevelUps <= 0) return null
  // 여러 개가 밀려 있으면 낮은 레벨부터 처리한다.
  const level = prog.level - prog.pendingLevelUps + 1
  return LEVEL_REWARDS[level] ?? 'skill-rank'
}

/** 대기 중인 레벨업 하나를 소진한다. 선택 적용 후 호출한다. */
export function consumeLevelUp(prog: Progression): void {
  if (prog.pendingLevelUps > 0) prog.pendingLevelUps -= 1
}

// ---------------------------------------------------------------------------
// 선택지 생성
// ---------------------------------------------------------------------------

export const UPGRADE_RANK_TOKEN_PREFIX = 'upgrade-rank:'
export const UPGRADE_TRAIT_TOKEN_PREFIX = 'trait:'

export function upgradeRankToken(id: string, rank: number): string {
  return `${UPGRADE_RANK_TOKEN_PREFIX}${id}:${rank}`
}

/** 전투 코드는 콘텐츠 테이블을 import하지 않고 이 토큰만 검사한다. */
export function upgradeTraitToken(trait: string): string {
  return `${UPGRADE_TRAIT_TOKEN_PREFIX}${trait}`
}

/**
 * Set 기반 월드와 리플레이 포맷을 유지하면서 카드 랭크를 복원한다.
 * 첫 획득은 예전처럼 id 자체이고 II·III만 명시적인 토큰을 더한다.
 */
export function getRecordedUpgradeRank(taken: ReadonlySet<string>, id: string): number {
  if (!taken.has(id)) return 0
  if (taken.has(upgradeRankToken(id, 3))) return 3
  if (taken.has(upgradeRankToken(id, 2))) return 2
  return 1
}

export function hasRecordedUpgradeRank(
  taken: ReadonlySet<string>,
  id: string,
  rank: number,
): boolean {
  return getRecordedUpgradeRank(taken, id) >= rank
}

export function recordUpgradeRank(taken: Set<string>, id: string, rank: number): void {
  taken.add(id)
  for (let value = 2; value <= rank; value++) taken.add(upgradeRankToken(id, value))
}

/**
 * 레벨업 화면에 뜨는 카드 하나.
 * 시뮬은 id만 알면 되고, 표시 문구는 UI가 콘텐츠에서 가져다 쓴다.
 */
export interface LevelChoice {
  id: string
  kind: 'unlock' | 'upgrade'
  /** 강화 중첩 모드에서 이번에 적용할 랭크. 예전 호출에서는 생략된다. */
  rank?: number
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
  /** 클래스가 맞지 않으면 available 값과 관계없이 추첨기가 제거한다. */
  classFilter?: readonly PlayerClass[]
  /** 같은 카드를 다시 뽑는 모드에서 현재·최대 랭크를 비교한다. */
  currentRank?: number
  maxRank?: number
  /**
   * 빌드 완성 후보의 노출 우선순위. 0은 일반 카드, 1 이상이면 가장 높은
   * 우선순위 묶음에서 한 장을 먼저 보장한다.
   */
  priority?: number
}

/**
 * 새 강화 시스템용 추첨 문맥.
 *
 * 네 번째 인자에 Set만 넘기는 예전 호출은 "이미 먹은 카드를 완전히 제외"하는
 * 의미를 보존한다. 이 객체를 넘긴 호출만 랭크 중첩과 클래스 필터를 켠다.
 */
export interface UpgradeRollContext {
  playerClass: PlayerClass
  taken?: ReadonlySet<string>
  allowRankUps?: boolean
}

function isRollContext(
  value: ReadonlySet<string> | UpgradeRollContext | undefined,
): value is UpgradeRollContext {
  return value !== undefined && 'playerClass' in value
}

/**
 * 중복 없이 count개를 가중 추출한다.
 *
 * 반드시 rng만 쓴다. 정렬·순회 순서가 입력 배열 순서에만 의존하므로
 * 같은 시드 + 같은 상태면 항상 같은 카드가 나온다.
 *
 * @param takenOrContext Set만 넘기는 레거시 호출에서는 이미 가진 카드를 뺀다.
 *              새 문맥은 같은 카드를 다음 랭크로 올리고 클래스로 한 번 더 거른다.
 */
export function rollUpgrades(
  rng: Rng,
  pool: readonly UpgradeCandidate[],
  count: number,
  takenOrContext?: ReadonlySet<string> | UpgradeRollContext,
): LevelChoice[] {
  const context = isRollContext(takenOrContext) ? takenOrContext : undefined
  const taken: ReadonlySet<string> | undefined = isRollContext(takenOrContext)
    ? takenOrContext.taken
    : takenOrContext
  const allowRankUps = context?.allowRankUps ?? false
  const bag = pool.filter(
    (candidate) =>
      candidate.available &&
      candidate.weight > 0 &&
      (!context ||
        candidate.classFilter === undefined ||
        candidate.classFilter.includes(context.playerClass)) &&
      (allowRankUps
        ? (candidate.currentRank ?? 0) < (candidate.maxRank ?? 1)
        : !(taken !== undefined && taken.has(candidate.id))),
  )
  const picked: LevelChoice[] = []

  // 후보가 모자라면 있는 만큼만 낸다. 카드가 2장이어도 게임은 굴러가야 한다.
  const n = Math.min(count, bag.length)

  const usedIndices = new Set<number>()
  for (let k = 0; k < n; k++) {
    // 진행 중인 장비·각성 조합·합성은 단순 가중치만 높이면 짧은 5분 안에
    // 못 볼 수 있다. 가장 높은 우선순위 후보를 선택지 한 칸에 먼저 보장해
    // 플레이어가 의도적으로 빌드를 완성할 수 있게 한다.
    let eligiblePriority = 0
    if (k === 0) {
      for (let i = 0; i < bag.length; i++) {
        if (usedIndices.has(i)) continue
        eligiblePriority = Math.max(eligiblePriority, bag[i]!.priority ?? 0)
      }
    }

    let eligibleWeight = 0
    for (let i = 0; i < bag.length; i++) {
      if (usedIndices.has(i)) continue
      if (eligiblePriority > 0 && (bag[i]!.priority ?? 0) !== eligiblePriority) continue
      eligibleWeight += bag[i]!.weight
    }

    let r = rng.next() * eligibleWeight
    let chosen = -1
    for (let i = 0; i < bag.length; i++) {
      if (usedIndices.has(i)) continue
      if (eligiblePriority > 0 && (bag[i]!.priority ?? 0) !== eligiblePriority) continue
      r -= bag[i]!.weight
      if (r <= 0) {
        chosen = i
        break
      }
    }
    // 부동소수 오차로 못 고르면 남은 것 중 첫 번째를 집는다.
    if (chosen < 0) {
      for (let i = 0; i < bag.length; i++) {
        if (!usedIndices.has(i)) {
          chosen = i
          break
        }
      }
    }
    if (chosen < 0) break

    usedIndices.add(chosen)
    const candidate = bag[chosen]!
    picked.push({
      id: candidate.id,
      kind: 'upgrade',
      ...(allowRankUps ? { rank: (candidate.currentRank ?? 0) + 1 } : {}),
    })
  }

  return picked
}
