import type { PlayerClass } from '../../src/sim/types.ts'

export interface BalanceRegressionSample {
  playerClass: PlayerClass
  seed: number
  qwerKills: number
  autoKills: number
  /** 0.1초 단위 스냅샷. 시뮬레이션 자체는 60Hz 고정 틱이다. */
  level20Time: number
}

/**
 * XP_FOR_NEXT를 확정한 시점의 대표 시드 결과.
 *
 * 단순 레벨 허용 범위만 두면 QWER 하나가 판정에서 빠져도 다른 광역기가 가릴 수 있다.
 * 처치 수와 시각 기준값을 함께 두고 작은 스폰 편차만 허용해 전 경로의 드리프트를 잡는다.
 */
export const BALANCE_REGRESSION_SAMPLES: readonly BalanceRegressionSample[] = [
  { playerClass: 'ranged', seed: 1, qwerKills: 3587, autoKills: 1951, level20Time: 277.2 },
  { playerClass: 'ranged', seed: 17, qwerKills: 3821, autoKills: 2039, level20Time: 269.0 },
  { playerClass: 'ranged', seed: 59, qwerKills: 3266, autoKills: 1686, level20Time: 295.5 },
  { playerClass: 'melee', seed: 1, qwerKills: 4337, autoKills: 2475, level20Time: 273.1 },
  { playerClass: 'melee', seed: 17, qwerKills: 3955, autoKills: 2401, level20Time: 288.4 },
  { playerClass: 'melee', seed: 59, qwerKills: 3742, autoKills: 2237, level20Time: 298.8 },
]
