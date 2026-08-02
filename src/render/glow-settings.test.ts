import assert from 'node:assert/strict'

import {
  GLOW_DEFAULT,
  GLOW_MAX,
  GLOW_MIN,
  getGlowIntensity,
  setGlowIntensity,
} from './glow-settings.ts'

assert.equal(GLOW_DEFAULT, 0.65)
assert.equal(getGlowIntensity(), GLOW_DEFAULT)

setGlowIntensity(2)
assert.equal(getGlowIntensity(), GLOW_MAX)

setGlowIntensity(-1)
assert.equal(getGlowIntensity(), GLOW_MIN)

setGlowIntensity(Number.NaN)
assert.equal(getGlowIntensity(), GLOW_DEFAULT)

console.log('glow-settings: eye-comfort default and safety bounds ok')
