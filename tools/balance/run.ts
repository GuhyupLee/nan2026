import { MAX_LEVEL, TARGET_LEVEL_TIMES } from '../../src/sim/progression.ts'
import type { PlayerClass } from '../../src/sim/types.ts'
import {
  BALANCE_SEEDS,
  levelCurveMae,
  median,
  runBalanceScenario,
  type BalanceRunResult,
} from './model.ts'

const CLASSES = ['ranged', 'melee'] as const satisfies readonly PlayerClass[]

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`
}

function printSeedResults(
  qwer: readonly BalanceRunResult[],
  autoOnly: readonly BalanceRunResult[],
): void {
  console.log('\n시드별 5분 실측 (QWER 쿨마다 사용)\n')
  console.log('class   seed  kills  kills/min  auto kills  uplift   Lv20    curve MAE')

  for (const result of qwer) {
    const baseline = autoOnly.find(
      (sample) =>
        sample.playerClass === result.playerClass && sample.seed === result.seed,
    )!
    const qwerRate = result.kills / (result.elapsed / 60)
    const baselineRate = baseline.kills / (baseline.elapsed / 60)
    const uplift = baselineRate > 0 ? qwerRate / baselineRate : Number.POSITIVE_INFINITY
    const mae = levelCurveMae(result)
    console.log(
      `${result.playerClass.padEnd(7)} ${String(result.seed).padStart(4)}  ` +
        `${String(result.kills).padStart(5)}  ${qwerRate.toFixed(1).padStart(9)}  ` +
        `${String(baseline.kills).padStart(10)}  ${`${uplift.toFixed(2)}x`.padStart(7)}  ` +
        `${formatTime(result.levelTimes[MAX_LEVEL - 1] ?? null).padStart(6)}  ` +
        `${(Number.isFinite(mae) ? `${mae.toFixed(1)}s` : '--').padStart(9)}`,
    )
  }
}

function printCurves(results: readonly BalanceRunResult[]): void {
  console.log('\n클래스별 중앙값 레벨업 곡선\n')
  console.log('level  target   ranged   delta    melee   delta')

  for (let i = 1; i < TARGET_LEVEL_TIMES.length; i++) {
    const target = TARGET_LEVEL_TIMES[i]!
    const values = CLASSES.map((playerClass) =>
      results
        .filter((result) => result.playerClass === playerClass)
        .map((result) => result.levelTimes[i] ?? Number.POSITIVE_INFINITY),
    )
    const ranged = median(values[0]!)
    const melee = median(values[1]!)
    console.log(
      `${String(i + 1).padStart(5)}  ${formatTime(target).padStart(6)}  ` +
        `${formatTime(ranged).padStart(7)}  ${`${ranged - target >= 0 ? '+' : ''}${(ranged - target).toFixed(1)}s`.padStart(7)}  ` +
        `${formatTime(melee).padStart(7)}  ${`${melee - target >= 0 ? '+' : ''}${(melee - target).toFixed(1)}s`.padStart(7)}`,
    )
  }
}

console.log(`고정 시드 ${BALANCE_SEEDS.length}개 × 2클래스 × QWER on/off 측정 중...`)

const qwerResults = CLASSES.flatMap((playerClass) =>
  BALANCE_SEEDS.map((seed) => runBalanceScenario(playerClass, seed)),
)
const autoOnlyResults = CLASSES.flatMap((playerClass) =>
  BALANCE_SEEDS.map((seed) =>
    runBalanceScenario(playerClass, seed, { useQwer: false }),
  ),
)

printSeedResults(qwerResults, autoOnlyResults)
printCurves(qwerResults)

for (const playerClass of CLASSES) {
  const qwerRates = qwerResults
    .filter((result) => result.playerClass === playerClass)
    .map((result) => result.kills / (result.elapsed / 60))
  const autoRates = autoOnlyResults
    .filter((result) => result.playerClass === playerClass)
    .map((result) => result.kills / (result.elapsed / 60))
  console.log(
    `\n${playerClass}: 중앙 처치율 ${median(autoRates).toFixed(1)} → ` +
      `${median(qwerRates).toFixed(1)} kills/min (${(median(qwerRates) / median(autoRates)).toFixed(2)}x)`,
  )
}
