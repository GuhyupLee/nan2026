import assert from 'node:assert/strict'
import { createWorld } from '../src/sim/world.ts'
import {
  META_DOCTRINE_SLOT_MAX,
  META_STORAGE_KEY,
  awardMetaRun,
  createRunMetaSnapshot,
  isHardModeUnlocked,
  isMetaUnlockActive,
  loadMetaProgress,
  purchaseMetaItem,
  sanitizeMetaProgress,
  scoreToMoonlight,
  toggleMetaDoctrine,
} from '../src/ui/meta-progression.ts'

const entries = new Map<string, string>()
const storage: Storage = {
  get length() {
    return entries.size
  },
  clear() {
    entries.clear()
  },
  getItem(key) {
    return entries.get(key) ?? null
  },
  key(index) {
    return [...entries.keys()][index] ?? null
  },
  removeItem(key) {
    entries.delete(key)
  },
  setItem(key, value) {
    entries.set(key, String(value))
  },
}
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
})

storage.setItem(META_STORAGE_KEY, '{broken')
assert.deepEqual(loadMetaProgress(), {
  version: 3,
  moonlight: 0,
  lifetimeKills: 0,
  bossWins: 0,
  lifetimeScore: 0,
  completedRuns: 0,
  vitalityRank: 0,
  strideRank: 0,
  mightRank: 0,
  celerityRank: 0,
  wardRank: 0,
  harvestRank: 0,
  mendingRank: 0,
  fateRank: 0,
  purchasedUnlocks: [],
  purchasedDoctrines: [],
  equippedDoctrineIds: [],
})

assert.deepEqual(
  sanitizeMetaProgress({
    version: 99,
    moonlight: Number.POSITIVE_INFINITY,
    lifetimeKills: -20,
    bossWins: 2.9,
    vitalityRank: 99,
    strideRank: -4,
    purchasedUnlocks: ['revival-seal', 'not-real', 'revival-seal'],
    purchasedDoctrines: [
      'guardian-inscription',
      'not-real',
      'wanderer-inscription',
      'guardian-inscription',
      'executioner-inscription',
    ],
    equippedDoctrineIds: [
      'guardian-inscription',
      'not-real',
      'timekeeper-inscription',
      'wanderer-inscription',
      'guardian-inscription',
      'executioner-inscription',
    ],
  }),
  {
    version: 3,
    moonlight: 0,
    lifetimeKills: 0,
    bossWins: 2,
    lifetimeScore: 0,
    completedRuns: 0,
    vitalityRank: 5,
    strideRank: 0,
    mightRank: 0,
    celerityRank: 0,
    wardRank: 0,
    harvestRank: 0,
    mendingRank: 0,
    fateRank: 0,
    purchasedUnlocks: ['revival-seal'],
    purchasedDoctrines: [
      'guardian-inscription',
      'wanderer-inscription',
      'executioner-inscription',
    ],
    equippedDoctrineIds: [
      'guardian-inscription',
      'wanderer-inscription',
    ],
  },
)

assert.deepEqual(
  sanitizeMetaProgress({
    version: 1,
    moonlight: 50,
    lifetimeKills: 75,
    bossWins: 1,
    vitalityRank: 1,
    strideRank: 2,
    purchasedUnlocks: ['decapitating-flash'],
  }),
  {
    version: 3,
    moonlight: 50,
    lifetimeKills: 75,
    bossWins: 1,
    lifetimeScore: 0,
    completedRuns: 0,
    vitalityRank: 1,
    strideRank: 2,
    mightRank: 0,
    celerityRank: 0,
    wardRank: 0,
    harvestRank: 0,
    mendingRank: 0,
    fateRank: 0,
    purchasedUnlocks: ['decapitating-flash'],
    purchasedDoctrines: [],
    equippedDoctrineIds: [],
  },
)

storage.removeItem(META_STORAGE_KEY)
const firstAward = awardMetaRun({
  moonlight: 1000,
  kills: 1600,
  bossWins: 0,
})
assert.equal(firstAward.progress.moonlight, 1000)
assert.equal(firstAward.progress.lifetimeKills, 1600)
assert.deepEqual(firstAward.newlyUnlocked, ['supernova-specimen'])
assert.equal(
  isMetaUnlockActive(firstAward.progress, 'supernova-specimen'),
  true,
)
assert.equal(isHardModeUnlocked(firstAward.progress), false)

const vitality = purchaseMetaItem('vitality')
assert.equal(vitality.purchased, true)
assert.equal(vitality.progress.vitalityRank, 1)
assert.equal(vitality.progress.moonlight, 910)
const stride = purchaseMetaItem('stride')
assert.equal(stride.purchased, true)
assert.equal(stride.progress.strideRank, 1)
assert.equal(stride.progress.moonlight, 810)
const revival = purchaseMetaItem('revival-seal')
assert.equal(revival.purchased, true)
assert.equal(revival.progress.moonlight, 310)
assert.equal(isMetaUnlockActive(revival.progress, 'revival-seal'), true)

const winAward = awardMetaRun({
  moonlight: 1000,
  kills: 1500,
  bossWins: 1,
})
assert.equal(isHardModeUnlocked(winAward.progress), true)
assert.equal(
  isMetaUnlockActive(winAward.progress, 'decapitating-flash'),
  true,
)
assert.equal(
  isMetaUnlockActive(winAward.progress, 'eclipse-execution-array'),
  true,
)

const wanderer = purchaseMetaItem('wanderer-inscription')
assert.equal(wanderer.purchased, true)
assert.equal(wanderer.progress.moonlight, 1130)
assert.deepEqual(wanderer.progress.purchasedDoctrines, [
  'wanderer-inscription',
])
assert.deepEqual(wanderer.progress.equippedDoctrineIds, [
  'wanderer-inscription',
])

const executioner = purchaseMetaItem('executioner-inscription')
assert.equal(executioner.purchased, true)
assert.equal(executioner.progress.moonlight, 910)
assert.deepEqual(executioner.progress.equippedDoctrineIds, [
  'wanderer-inscription',
  'executioner-inscription',
])
assert.equal(META_DOCTRINE_SLOT_MAX, 2)

const guardian = purchaseMetaItem('guardian-inscription')
assert.equal(guardian.purchased, true)
assert.equal(guardian.progress.moonlight, 670)
assert.deepEqual(guardian.progress.equippedDoctrineIds, [
  'wanderer-inscription',
  'executioner-inscription',
])
assert.equal(purchaseMetaItem('guardian-inscription').purchased, false)

const blockedToggle = toggleMetaDoctrine('guardian-inscription')
assert.equal(blockedToggle.changed, false)
assert.equal(blockedToggle.equipped, false)
assert.deepEqual(blockedToggle.progress.equippedDoctrineIds, [
  'wanderer-inscription',
  'executioner-inscription',
])

const unequipWanderer = toggleMetaDoctrine('wanderer-inscription')
assert.equal(unequipWanderer.changed, true)
assert.equal(unequipWanderer.equipped, false)
assert.deepEqual(unequipWanderer.progress.equippedDoctrineIds, [
  'executioner-inscription',
])

const equipGuardian = toggleMetaDoctrine('guardian-inscription')
assert.equal(equipGuardian.changed, true)
assert.equal(equipGuardian.equipped, true)
assert.deepEqual(equipGuardian.progress.equippedDoctrineIds, [
  'executioner-inscription',
  'guardian-inscription',
])

const unpurchasedToggle = toggleMetaDoctrine('timekeeper-inscription')
assert.equal(unpurchasedToggle.changed, false)
assert.equal(unpurchasedToggle.equipped, false)

const snapshot = createRunMetaSnapshot(winAward.progress)
assert.deepEqual(snapshot, {
  version: 2,
  maxHpBonus: 4,
  speedMultiplier: 1.012,
  damageMultiplier: 1,
  cooldownMultiplier: 1,
  damageTakenMultiplier: 1,
  pickupRadiusMultiplier: 1,
  healingMultiplier: 1,
  xpMultiplier: 1,
  rerolls: 0,
  unlockedUpgradeIds: [
    'decapitating-flash',
    'supernova-specimen',
    'eclipse-execution-array',
    'revival-seal',
  ],
})
const doctrineSnapshot = createRunMetaSnapshot(equipGuardian.progress)
assert.deepEqual(doctrineSnapshot, {
  version: 2,
  maxHpBonus: 4,
  speedMultiplier: 1.012,
  damageMultiplier: 1,
  cooldownMultiplier: 1,
  damageTakenMultiplier: 1,
  pickupRadiusMultiplier: 1,
  healingMultiplier: 1,
  xpMultiplier: 1,
  rerolls: 0,
  unlockedUpgradeIds: [
    'decapitating-flash',
    'supernova-specimen',
    'eclipse-execution-array',
    'revival-seal',
    'executioner-inscription',
    'guardian-inscription',
  ],
})
assert.deepEqual(
  createRunMetaSnapshot({
    ...equipGuardian.progress,
    equippedDoctrineIds: [
      'guardian-inscription',
      'executioner-inscription',
    ],
  }),
  doctrineSnapshot,
)
const base = createWorld(7001, 'ranged')
const enhanced = createWorld(7001, 'ranged', { meta: doctrineSnapshot })
assert.equal(enhanced.stats.maxHp, base.stats.maxHp + 4)
assert.ok(Math.abs(enhanced.stats.speed / base.stats.speed - 1.012) < 1e-9)
assert.deepEqual(enhanced.runConfig.meta, doctrineSnapshot)
assert.equal(enhanced.rng.state(), base.rng.state())
assert.equal(enhanced.choiceRng.state(), base.choiceRng.state())
assert.equal(enhanced.pickupRng.state(), base.pickupRng.state())

assert.equal(scoreToMoonlight(74), 0)
assert.equal(scoreToMoonlight(75), 1)
assert.equal(scoreToMoonlight(7_500), 100)

const expandedAward = awardMetaRun({
  moonlight: 1000,
  kills: 0,
  bossWins: 0,
  score: 75_000,
  runs: 1,
})
assert.equal(expandedAward.progress.lifetimeScore, 75_000)
assert.equal(expandedAward.progress.completedRuns, 1)
for (const id of [
  'might',
  'celerity',
  'ward',
  'harvest',
  'mending',
  'fate',
] as const) {
  assert.equal(purchaseMetaItem(id).purchased, true, `${id} 1단계 구매 실패`)
}
const expandedSnapshot = createRunMetaSnapshot(loadMetaProgress())
assert.equal(expandedSnapshot.damageMultiplier, 1.025)
assert.equal(expandedSnapshot.cooldownMultiplier, 0.985)
assert.equal(expandedSnapshot.damageTakenMultiplier, 0.98)
assert.equal(expandedSnapshot.pickupRadiusMultiplier, 1.08)
assert.equal(expandedSnapshot.healingMultiplier, 1.08)
assert.equal(expandedSnapshot.xpMultiplier, 1.03)
assert.equal(expandedSnapshot.rerolls, 1)

const expandedWorld = createWorld(7002, 'ranged', { meta: expandedSnapshot })
assert.ok(Math.abs(expandedWorld.stats.atkDamageMul / 1.03 - 1.025) < 1e-9)
assert.ok(Math.abs(expandedWorld.stats.cooldownMul - 0.985) < 1e-9)
assert.ok(Math.abs(expandedWorld.stats.pickupRadiusMul - 1.08) < 1e-9)
assert.ok(Math.abs(expandedWorld.stats.xpGainMul - 1.03) < 1e-9)
assert.equal(expandedWorld.upgradeRerollsRemaining, 1)

console.log(
  'meta-check: score economy, 40-rank legacy, doctrines, rerolls, migration, and deterministic snapshot ok',
)
