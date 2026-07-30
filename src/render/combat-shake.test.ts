import assert from 'node:assert/strict'

import {
  TYPE_BOSS,
  TYPE_BRUTE,
  TYPE_ELITE,
  TYPE_WALKER,
  type DeathEvent,
} from '../sim/enemies.ts'
import type { DamageFeedbackEvent } from '../sim/types.ts'
import {
  selectDeathCameraBeat,
  shouldShakeDamageImpact,
} from './combat-shake.ts'
import { coalesceShakeTrauma } from './impact.ts'

const death = (type: number): DeathEvent => ({ x: 0, y: 0, type })
const hit = (
  overrides: Partial<DamageFeedbackEvent> = {},
): DamageFeedbackEvent => ({
  x: 0,
  y: 0,
  amount: 20,
  hpAfter: 80,
  maxHp: 100,
  enemyType: TYPE_WALKER,
  lethal: false,
  capped: false,
  ...overrides,
})

const rangedBruteWave = Array.from(
  { length: 20 },
  () => death(TYPE_BRUTE),
)
assert.equal(selectDeathCameraBeat(rangedBruteWave, 'ranged', false), null)
assert.equal(
  selectDeathCameraBeat(rangedBruteWave, 'melee', false),
  'brute',
)
assert.equal(selectDeathCameraBeat(rangedBruteWave, 'melee', true), null)
assert.equal(
  selectDeathCameraBeat(
    [death(TYPE_BRUTE), death(TYPE_ELITE), death(TYPE_BRUTE)],
    'ranged',
    false,
  ),
  'elite',
)
assert.equal(
  selectDeathCameraBeat(
    [death(TYPE_ELITE), death(TYPE_BOSS)],
    'ranged',
    false,
  ),
  'boss',
)

assert.equal(
  shouldShakeDamageImpact('ranged', hit({ lethal: true }), true),
  false,
)
assert.equal(
  shouldShakeDamageImpact('ranged', hit({ capped: true }), false),
  true,
)
assert.equal(
  shouldShakeDamageImpact(
    'ranged',
    hit({ enemyType: TYPE_BOSS, amount: 31 }),
    false,
  ),
  false,
)
assert.equal(
  shouldShakeDamageImpact(
    'ranged',
    hit({ enemyType: TYPE_BOSS, amount: 32 }),
    false,
  ),
  true,
)
assert.equal(
  shouldShakeDamageImpact('melee', hit({ lethal: true }), true),
  true,
)

let trauma = 0
for (let i = 0; i < 20; i++) trauma = coalesceShakeTrauma(trauma, 0.2)
assert.equal(trauma, 0.2)
assert.equal(coalesceShakeTrauma(0.2, 0.7), 0.7)
assert.equal(coalesceShakeTrauma(0.7, 0.1), 0.7)

console.log(
  'combat-shake: ranged AoE coalescing, elite/boss beats, and trauma budget ok',
)
