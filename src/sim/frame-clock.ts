import { DT, MAX_TICKS_PER_FRAME } from './constants.ts'

/**
 * Advances the fixed-step accumulator from real elapsed time.
 *
 * Combat feedback is deliberately absent from this boundary: damage, kills,
 * animation, and effects may change presentation, but never movement, input
 * sampling, cooldowns, or the world clock.
 */
export function advanceSimulationAccumulator(
  accumulator: number,
  rawDt: number,
): number {
  return accumulator + Math.min(rawDt, DT * MAX_TICKS_PER_FRAME)
}
