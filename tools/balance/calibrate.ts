import { XP_FOR_NEXT } from '../../src/sim/progression.ts'
import type { PlayerClass } from '../../src/sim/types.ts'
import { BALANCE_SEEDS, median, runBalanceScenario } from './model.ts'

const CLASSES = ['ranged', 'melee'] as const satisfies readonly PlayerClass[]
const ITERATIONS = 10
const DAMPING = 0.5
const mutableCurve = XP_FOR_NEXT as unknown as number[]
const originalCurve: number[] = [...XP_FOR_NEXT]
let curve: number[] = [...originalCurve]

/**
 * 목표 시각까지 실제 획득한 누적 XP의 전체 시드·클래스 중앙값을 다음
 * 누적 문턱으로 삼는다. 새 문턱이 스킬 해금 시각과 처치율을 바꾸므로
 * 감쇠를 둔 되먹임으로 고정점에 수렴시킨다.
 */
for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
  mutableCurve.splice(0, mutableCurve.length, ...curve)

  const results = CLASSES.flatMap((playerClass) =>
    BALANCE_SEEDS.map((seed) => runBalanceScenario(playerClass, seed)),
  )
  const measuredCumulative = results[0]!.xpAtTargets.map((_, levelIndex) =>
    levelIndex === 0
      ? 0
      : Math.round(median(results.map((result) => result.xpAtTargets[levelIndex]!))),
  )
  const currentCumulative = [0]
  for (const amount of curve) {
    currentCumulative.push(currentCumulative[currentCumulative.length - 1]! + amount)
  }
  const cumulative = measuredCumulative.map((measured, i) =>
    Math.round(currentCumulative[i]! * (1 - DAMPING) + measured * DAMPING),
  )

  for (let i = 1; i < cumulative.length; i++) {
    cumulative[i] = Math.max(cumulative[i]!, cumulative[i - 1]! + 1)
  }

  curve = cumulative.slice(1).map((value, i) => value - cumulative[i]!)
  console.log(`iteration ${iteration}: [${curve.join(', ')}]`)
}

mutableCurve.splice(0, mutableCurve.length, ...originalCurve)
