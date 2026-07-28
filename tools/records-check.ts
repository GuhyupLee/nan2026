import assert from 'node:assert/strict'
import { applyUpgrade } from '../src/content/upgrades.ts'
import { rankUpSkill, unlockSkill } from '../src/sim/skills.ts'
import { createWorld } from '../src/sim/world.ts'
import {
  RECORDS_STORAGE_KEY,
  loadRecords,
  saveRecord,
  type RunRecord,
} from '../src/ui/records.ts'
import {
  createRunBuildSummary,
  getRunBuildPresentation,
} from '../src/ui/run-build.ts'

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

const legacy: RunRecord = {
  score: 1200,
  kills: 74,
  level: 12,
  time: 118.5,
  victory: false,
  at: 1000,
}

// 완전히 깨진 저장소는 첫 실행처럼 조용히 비운다.
storage.setItem(RECORDS_STORAGE_KEY, '{not-json')
assert.deepEqual(loadRecords('ranged'), [])

// build가 없던 과거 v1 기록은 모양을 바꾸지 않고 그대로 읽는다.
storage.setItem(RECORDS_STORAGE_KEY, JSON.stringify({ ranged: [legacy] }))
assert.deepEqual(loadRecords('ranged'), [legacy])

// 손상 행과 손상된 선택 build는 정상 기본 전적까지 끌고 내려가면 안 된다.
storage.setItem(
  RECORDS_STORAGE_KEY,
  JSON.stringify({
    ranged: [
      legacy,
      { ...legacy, score: 'broken', at: 1001 },
      {
        ...legacy,
        score: 1100,
        at: 1002,
        build: { version: 1, seed: 'broken' },
      },
      {
        ...legacy,
        score: 1000,
        at: 1003,
        build: { version: 2, seed: 42 },
      },
    ],
  }),
)
const recovered = loadRecords('ranged')
assert.equal(recovered.length, 3)
assert.ok(!('build' in recovered[1]!))
assert.ok(!('build' in recovered[2]!))

// 대표 완성 빌드: QWER 랭크, 선행 각성 둘, 융합 하나, 월식 인장 셋.
const seed = 0x5f2a91c0
const world = createWorld(seed, 'ranged')
const skillRanks = { q: 4, w: 3, e: 2, r: 1 } as const
for (const id of ['q', 'w', 'e', 'r'] as const) {
  unlockSkill(world.skills, id, 10)
  for (let rank = 0; rank < skillRanks[id]; rank += 1) {
    assert.equal(rankUpSkill(world.skills, id), true)
  }
}
for (const id of ['orbit-lens', 'gravity-prism']) {
  for (let rank = 0; rank < 3; rank += 1) {
    assert.ok(applyUpgrade(world, id))
  }
}
assert.ok(applyUpgrade(world, 'singularity-interferometer'))
world.relicsClaimed = 3

const build = createRunBuildSummary(world)
assert.deepEqual(
  {
    q: build.skills.q.rank,
    w: build.skills.w.rank,
    e: build.skills.e.rank,
    r: build.skills.r.rank,
  },
  skillRanks,
)
assert.deepEqual(build.awakeningIds, ['orbit-lens', 'gravity-prism'])
assert.deepEqual(build.fusionIds, ['singularity-interferometer'])
assert.equal(build.seals, 3)

const presentation = getRunBuildPresentation(build)
assert.equal(presentation.battlefieldCode, '5F2A-91C0')
assert.deepEqual(presentation.awakeningNames, ['귀환 궤도', '이중 붕괴'])
assert.deepEqual(presentation.fusionNames, ['사건지평 간섭계'])
assert.equal(presentation.skills[0]?.branchName, '특이점 낙광')
assert.equal(presentation.skills[1]?.branchName, '사건지평 견인')

// 선택 V1 build는 점수 정렬을 거쳐도 완전히 왕복한다.
storage.setItem(RECORDS_STORAGE_KEY, JSON.stringify({ ranged: [legacy] }))
const completed: RunRecord = {
  score: 9900,
  kills: 318,
  level: 26,
  time: 247.4,
  victory: true,
  at: 2000,
  build,
}
const saved = saveRecord('ranged', completed)
assert.equal(saved.isBest, true)
assert.deepEqual(saved.records[0], completed)
assert.deepEqual(loadRecords('ranged')[0], completed)

// 결과 화면의 전장 코드를 재사용하면 같은 클래스·시드의 초기 난수열이다.
const storedBuild = loadRecords('ranged')[0]?.build
assert.ok(storedBuild)
const retry = createWorld(storedBuild.seed, 'ranged')
const reference = createWorld(seed, 'ranged')
assert.equal(retry.seed, reference.seed)
assert.equal(retry.rng.state(), reference.rng.state())
assert.equal(retry.choiceRng.state(), reference.choiceRng.state())
assert.equal(retry.pickupRng.state(), reference.pickupRng.state())

console.log(
  'Records check passed: legacy recovery, versioned builds, build identity, same-seed retry',
)
