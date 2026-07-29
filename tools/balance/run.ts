import { MAX_LEVEL, TARGET_LEVEL_TIMES } from '../../src/sim/progression.ts'
import {
  WAVE_LULL_MULTIPLIER,
  WAVE_PEAK_MULTIPLIER,
  baseTargetAliveCount,
} from '../../src/sim/enemies.ts'
import type { PlayerClass } from '../../src/sim/types.ts'
import {
  BALANCE_SEEDS,
  DPS_HEALTH_SAMPLE_TIMES,
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
  console.log('class   seed  kills  kills/min  auto kills  uplift   Lv26    curve MAE')

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

function printDpsHealthRatios(
  qwer: readonly BalanceRunResult[],
  autoOnly: readonly BalanceRunResult[],
): void {
  console.log('\n유효 DPS ÷ 해당 시점 워커 체력 (초당 워커 환산 처치력)\n')
  console.log('time    ranged QWER  ranged auto   melee QWER   melee auto')

  for (let i = 0; i < DPS_HEALTH_SAMPLE_TIMES.length; i += 1) {
    const med = (
      results: readonly BalanceRunResult[],
      playerClass: PlayerClass,
    ): number =>
      median(
        results
          .filter((result) => result.playerClass === playerClass)
          .map((result) => result.dpsHealthRatios[i]!),
      )
    console.log(
      `${formatTime(DPS_HEALTH_SAMPLE_TIMES[i]!).padStart(6)}  ` +
        `${med(qwer, 'ranged').toFixed(2).padStart(12)}  ` +
        `${med(autoOnly, 'ranged').toFixed(2).padStart(11)}  ` +
        `${med(qwer, 'melee').toFixed(2).padStart(11)}  ` +
        `${med(autoOnly, 'melee').toFixed(2).padStart(10)}`,
    )
  }
}

function assertDpsHealthGrowth(
  qwer: readonly BalanceRunResult[],
  autoOnly: readonly BalanceRunResult[],
): void {
  for (const playerClass of CLASSES) {
    const qwerCurve = DPS_HEALTH_SAMPLE_TIMES.map((_, i) =>
      median(
        qwer
          .filter((result) => result.playerClass === playerClass)
          .map((result) => result.dpsHealthRatios[i]!),
      ),
    )
    for (let i = 1; i < qwerCurve.length; i += 1) {
      if (qwerCurve[i]! <= qwerCurve[i - 1]!) {
        throw new Error(
          `${playerClass}: 유효 DPS/체력 비율이 ` +
            `${formatTime(DPS_HEALTH_SAMPLE_TIMES[i - 1]!)} ` +
            `${qwerCurve[i - 1]!.toFixed(2)} → ` +
            `${formatTime(DPS_HEALTH_SAMPLE_TIMES[i]!)} ` +
            `${qwerCurve[i]!.toFixed(2)}로 성장하지 않았습니다.`,
        )
      }
    }

    const autoCurve = DPS_HEALTH_SAMPLE_TIMES.map((_, i) =>
      median(
        autoOnly
          .filter((result) => result.playerClass === playerClass)
          .map((result) => result.dpsHealthRatios[i]!),
      ),
    )
    const earlyGap = qwerCurve[1]! / autoCurve[1]!
    const lateGap = qwerCurve.at(-1)! / autoCurve.at(-1)!
    if (lateGap <= earlyGap) {
      throw new Error(
        `${playerClass}: 조합 격차가 1:30 ${earlyGap.toFixed(2)}x → ` +
          `4:30 ${lateGap.toFixed(2)}x로 벌어지지 않았습니다.`,
      )
    }
  }
}

console.log(`고정 시드 ${BALANCE_SEEDS.length}개 × 2클래스 × QWER on/off 측정 중...`)
const peakDensityBaseline = baseTargetAliveCount(200)
console.log(
  `3:20 기준선 ${peakDensityBaseline.toFixed(0)}마리의 웨이브 목표 진폭 ` +
    `${Math.floor(peakDensityBaseline * WAVE_LULL_MULTIPLIER)} ↔ ` +
    `${Math.floor(peakDensityBaseline * WAVE_PEAK_MULTIPLIER)}마리`,
)

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
printDpsHealthRatios(qwerResults, autoOnlyResults)
assertDpsHealthGrowth(qwerResults, autoOnlyResults)

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
