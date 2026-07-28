import type { PlayerClass } from '../../src/sim/types.ts'

export interface BalanceRegressionSample {
  playerClass: PlayerClass
  seed: number
}

/**
 * 빠른 스모크 회귀에서 QWER/평타 격차와 결정론을 재검사할 대표 시드.
 * 전체 12시드의 만렙 도달은 sim-check가 별도로 모두 확인한다.
 */
export const BALANCE_REGRESSION_SAMPLES: readonly BalanceRegressionSample[] = [
  { playerClass: 'ranged', seed: 1 },
  { playerClass: 'ranged', seed: 17 },
  { playerClass: 'ranged', seed: 59 },
  { playerClass: 'melee', seed: 1 },
  { playerClass: 'melee', seed: 17 },
  { playerClass: 'melee', seed: 59 },
]
