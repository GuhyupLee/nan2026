import assert from 'node:assert/strict'

import {
  BASE_SCATTER_GATHER_RADIUS,
  CAMERA_REFERENCE_ASPECT,
  MAX_SCATTER_GATHER_RADIUS,
  resolveScatterGatherRadius,
} from './ultrawide-culling.ts'

assert.equal(
  resolveScatterGatherRadius(CAMERA_REFERENCE_ASPECT, 1),
  BASE_SCATTER_GATHER_RADIUS,
)
assert.equal(
  resolveScatterGatherRadius(4 / 3, 1.34),
  BASE_SCATTER_GATHER_RADIUS,
)

const wide = resolveScatterGatherRadius(21 / 9, 1)
const ultra = resolveScatterGatherRadius(32 / 9, 1)
const ultraZoomedOut = resolveScatterGatherRadius(32 / 9, 1.34)

assert(wide > BASE_SCATTER_GATHER_RADIUS)
assert(ultra > wide)
assert(ultraZoomedOut > ultra)
assert(ultraZoomedOut <= MAX_SCATTER_GATHER_RADIUS)
assert.equal(
  resolveScatterGatherRadius(100, 10),
  MAX_SCATTER_GATHER_RADIUS,
)
assert.equal(
  resolveScatterGatherRadius(Number.NaN, 1),
  BASE_SCATTER_GATHER_RADIUS,
)

console.log('ultrawide-culling: 16:9 baseline and wider preload radius ok')
