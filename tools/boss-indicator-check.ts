import assert from 'node:assert/strict'

import {
  bossIndicatorDirection,
  bossIndicatorPosition,
} from '../src/ui/boss-indicator.ts'

assert.equal(bossIndicatorPosition(640, 360, 1280, 720), null)

const right = bossIndicatorPosition(1600, 360, 1280, 720)
assert.ok(right)
assert.equal(right.x, 1280 - 76)
assert.equal(right.y, 360)
assert.equal(right.angle, 0)

const top = bossIndicatorPosition(640, -400, 1280, 720)
assert.ok(top)
assert.equal(top.x, 640)
assert.equal(top.y, 86)
assert.equal(top.angle, -90)

const corner = bossIndicatorPosition(1600, -400, 1280, 720)
assert.ok(corner)
assert.ok(corner.x <= 1280 - 76)
assert.ok(corner.y >= 86)

const behind = bossIndicatorPosition(1600, 360, 1280, 720, false)
assert.ok(behind)
assert.equal(behind.x, 76)
assert.equal(Math.abs(behind.angle), 180)

const reservedTop = bossIndicatorPosition(
  640,
  -400,
  1280,
  720,
  true,
  { top: 124, bottom: 140, left: 64, right: 64 },
)
assert.ok(reservedTop)
assert.ok(Math.abs(reservedTop.y - 124) < 1e-9)
assert.equal(bossIndicatorDirection(reservedTop.angle), '위')
assert.equal(bossIndicatorDirection(45), '오른쪽 아래')
assert.equal(bossIndicatorDirection(180), '왼쪽')

console.log(
  'boss-indicator-check: on-screen hiding, HUD-safe clamps, and direction labels ok',
)
