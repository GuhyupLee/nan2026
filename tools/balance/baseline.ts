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
  { playerClass: 'ranged', seed: 1, qwerKills: 3265, autoKills: 1864, level20Time: 299.4 },
  { playerClass: 'ranged', seed: 5, qwerKills: 3458, autoKills: 1863, level20Time: 286.3 },
  { playerClass: 'ranged', seed: 47, qwerKills: 3355, autoKills: 2024, level20Time: 291.6 },
  { playerClass: 'melee', seed: 1, qwerKills: 4164, autoKills: 2381, level20Time: 278.7 },
  { playerClass: 'melee', seed: 5, qwerKills: 3901, autoKills: 2371, level20Time: 292.6 },
  { playerClass: 'melee', seed: 47, qwerKills: 4004, autoKills: 2315, level20Time: 285.6 },
]
