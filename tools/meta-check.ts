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
  version: 2,
  moonlight: 0,
  lifetimeKills: 0,
  bossWins: 0,
  vitalityRank: 0,
  strideRank: 0,
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
    version: 2,
    moonlight: 0,
    lifetimeKills: 0,
    bossWins: 2,
    vitalityRank: 3,
    strideRank: 0,
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
    version: 2,
    moonlight: 50,
    lifetimeKills: 75,
    bossWins: 1,
    vitalityRank: 1,
    strideRank: 2,
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
assert.equal(vitality.progress.moonlight, 880)
const stride = purchaseMetaItem('stride')
assert.equal(stride.purchased, true)
assert.equal(stride.progress.strideRank, 1)
assert.equal(stride.progress.moonlight, 740)
const revival = purchaseMetaItem('revival-seal')
assert.equal(revival.purchased, true)
assert.equal(revival.progress.moonlight, 240)
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
assert.equal(wanderer.progress.moonlight, 1060)
assert.deepEqual(wanderer.progress.purchasedDoctrines, [
  'wanderer-inscription',
])
assert.deepEqual(wanderer.progress.equippedDoctrineIds, [
  'wanderer-inscription',
])

const executioner = purchaseMetaItem('executioner-inscription')
assert.equal(executioner.purchased, true)
assert.equal(executioner.progress.moonlight, 840)
assert.deepEqual(executioner.progress.equippedDoctrineIds, [
  'wanderer-inscription',
  'executioner-inscription',
])
assert.equal(META_DOCTRINE_SLOT_MAX, 2)

const guardian = purchaseMetaItem('guardian-inscription')
assert.equal(guardian.purchased, true)
assert.equal(guardian.progress.moonlight, 600)
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
  version: 1,
  maxHpBonus: 3,
  speedMultiplier: 1.01,
  unlockedUpgradeIds: [
    'decapitating-flash',
    'supernova-specimen',
    'eclipse-execution-array',
    'revival-seal',
  ],
})
const doctrineSnapshot = createRunMetaSnapshot(equipGuardian.progress)
assert.deepEqual(doctrineSnapshot, {
  version: 1,
  maxHpBonus: 3,
  speedMultiplier: 1.01,
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
assert.equal(enhanced.stats.maxHp, base.stats.maxHp + 3)
assert.ok(Math.abs(enhanced.stats.speed / base.stats.speed - 1.01) < 1e-9)
assert.deepEqual(enhanced.runConfig.meta, doctrineSnapshot)
assert.equal(enhanced.rng.state(), base.rng.state())
assert.equal(enhanced.choiceRng.state(), base.choiceRng.state())
assert.equal(enhanced.pickupRng.state(), base.pickupRng.state())

console.log(
  'meta-check: migration, doctrines, purchases, and deterministic run snapshot ok',
)
