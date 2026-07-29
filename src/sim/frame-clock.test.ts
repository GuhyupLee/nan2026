import assert from 'node:assert/strict'

import { DT, MAX_TICKS_PER_FRAME } from './constants.ts'
import { advanceSimulationAccumulator } from './frame-clock.ts'

{
  let accumulator = 0
  for (let frame = 0; frame < 60; frame += 1) {
    accumulator = advanceSimulationAccumulator(accumulator, DT)
  }
  assert.ok(
    Math.abs(accumulator - 1) < 1e-9,
    'one real-time second advances one simulation second',
  )
}

{
  const carried = DT * 0.35
  assert.equal(
    advanceSimulationAccumulator(carried, DT),
    carried + DT,
    'combat frames preserve all elapsed time without a feedback multiplier',
  )
  assert.equal(
    advanceSimulationAccumulator(0, 10),
    DT * MAX_TICKS_PER_FRAME,
    'background gaps still obey the fixed-step catch-up cap',
  )
}

console.log('frame-clock: real-time simulation rate and catch-up cap ok')
