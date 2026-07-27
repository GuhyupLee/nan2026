import {
  UPGRADES,
  applyUpgrade,
  getUpgrade,
  getUpgradePresentation,
  getUpgradeRank,
  getUpgradeRollPriority,
} from './upgrades.ts'
import {
  rollUpgrades,
  upgradeRankToken,
  upgradeTraitToken,
  type UpgradeCandidate,
} from '../sim/progression.ts'
import { createRng } from '../sim/rng.ts'
import type { SkillId } from '../sim/skills.ts'
import type { World } from '../sim/types.ts'
import { createWorld } from '../sim/world.ts'
import { buildLevelUpCards } from '../ui/levelup.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function unlockCombatSkills(world: World): void {
  for (const id of ['q', 'w', 'e', 'r'] as const satisfies readonly SkillId[]) {
    world.skills[id].unlocked = true
    world.skills[id].maxCooldown = 10
  }
}

function candidatePool(world: World): UpgradeCandidate[] {
  return UPGRADES.map((upgrade) => ({
    id: upgrade.id,
    available: upgrade.isAvailable(world),
    weight: upgrade.weight,
    classFilter: upgrade.classFilter,
    currentRank: getUpgradeRank(world.upgradesTaken, upgrade.id),
    maxRank: upgrade.ranks.length,
    priority: getUpgradeRollPriority(world, upgrade),
  }))
}

// I·II는 수치, III는 branch라는 전투 규칙만 바꾼다.
{
  const world = createWorld(101, 'ranged')
  unlockCombatSkills(world)
  const before = world.skills.q.maxCooldown
  assert(applyUpgrade(world, 'orbit-lens')?.rank === 1, '궤도 렌즈 I 적용 실패')
  assert(applyUpgrade(world, 'orbit-lens')?.rank === 2, '궤도 렌즈 II 적용 실패')
  const afterNumericRanks = world.skills.q.maxCooldown
  assert(afterNumericRanks < before, 'I·II 쿨다운 강화가 적용되지 않음')
  assert(applyUpgrade(world, 'orbit-lens')?.rank === 3, '궤도 렌즈 III 적용 실패')
  assert(world.skills.q.maxCooldown === afterNumericRanks, 'III가 수치를 다시 올림')
  assert(world.skills.q.branch === 'orbital-prism', 'III 각성 branch가 기록되지 않음')
  assert(
    world.upgradesTaken.has(upgradeTraitToken('orbital-prism')),
    'III 각성 trait 토큰이 기록되지 않음',
  )
  assert(getUpgradeRank(world.upgradesTaken, 'orbit-lens') === 3, '랭크 이력 복원 실패')
  assert(applyUpgrade(world, 'orbit-lens') === null, '최대 랭크를 초과 적용함')

  const presentation = getUpgradePresentation(
    getUpgrade('orbit-lens')!,
    new Set(['orbit-lens', upgradeRankToken('orbit-lens', 2)]),
  )
  assert(presentation.rarity === 'awakening', 'III 카드가 각성 배지를 제공하지 않음')

  const attackWorld = createWorld(102, 'ranged')
  applyUpgrade(attackWorld, 'focused-lens')
  applyUpgrade(attackWorld, 'focused-lens')
  const damageAfterII = attackWorld.stats.atkDamageMul
  applyUpgrade(attackWorld, 'focused-lens')
  assert(attackWorld.stats.atkDamageMul === damageAfterII, '일반 카드 III가 수치를 더 올림')
  assert(
    attackWorld.upgradesTaken.has(upgradeTraitToken('pierce-amplification')),
    '일반 카드 III trait 토큰이 기록되지 않음',
  )
}

// 두 선행 각성이 모두 끝난 뒤에만 합성 카드가 열린다.
{
  const world = createWorld(202, 'ranged')
  unlockCombatSkills(world)
  for (let rank = 0; rank < 3; rank++) applyUpgrade(world, 'orbit-lens')
  const fusion = getUpgrade('singularity-interferometer')!
  assert(!fusion.isAvailable(world), '선행 각성 하나만으로 합성이 열림')
  for (let rank = 0; rank < 3; rank++) applyUpgrade(world, 'gravity-prism')
  assert(fusion.isAvailable(world), '두 선행 각성 뒤 합성이 열리지 않음')
  assert(applyUpgrade(world, fusion.id)?.rank === 1, '합성 적용 실패')
  assert(
    world.skills.q.branch === 'singularity-interference' &&
      world.skills.w.branch === 'singularity-interference',
    '합성 branch가 두 스킬에 연결되지 않음',
  )
}

// 새 문맥은 중첩을 허용하지만, Set만 받는 레거시 호출은 기존 제외 규칙을 지킨다.
{
  const pool: UpgradeCandidate[] = [
    {
      id: 'stackable',
      available: true,
      weight: 1,
      classFilter: ['ranged'],
      currentRank: 1,
      maxRank: 3,
    },
  ]
  const ranked = rollUpgrades(createRng(7), pool, 1, {
    playerClass: 'ranged',
    taken: new Set(['stackable']),
    allowRankUps: true,
  })
  assert(ranked[0]?.rank === 2, '같은 카드가 II로 중첩되지 않음')
  assert(
    rollUpgrades(createRng(7), pool, 1, new Set(['stackable'])).length === 0,
    '레거시 Set 호출의 제외 규칙이 깨짐',
  )
}

// 진행 중인 장비→조합 짝→합성은 선택지 첫 칸에 차례로 보장된다.
{
  const world = createWorld(252, 'ranged')
  unlockCombatSkills(world)
  for (let rank = 0; rank < 3; rank += 1) {
    assert(applyUpgrade(world, 'orbit-lens'), '궤도 렌즈 각성 준비 실패')
  }

  const partnerChoices = rollUpgrades(createRng(9), candidatePool(world), 3, {
    playerClass: 'ranged',
    taken: world.upgradesTaken,
    allowRankUps: true,
  })
  assert(
    partnerChoices[0]?.id === 'gravity-prism',
    '각성 조합의 짝 장비가 첫 칸에 보장되지 않음',
  )

  for (let rank = 0; rank < 3; rank += 1) {
    assert(applyUpgrade(world, 'gravity-prism'), '중력 프리즘 각성 준비 실패')
  }
  const fusionChoices = rollUpgrades(createRng(10), candidatePool(world), 3, {
    playerClass: 'ranged',
    taken: world.upgradesTaken,
    allowRankUps: true,
  })
  assert(
    fusionChoices[0]?.id === 'singularity-interferometer',
    '해금된 합성 카드가 첫 칸에 보장되지 않음',
  )
}

// 클래스 필터는 후보가 실수로 available=true여도 근접 풀에서 광학 장치를 제거한다.
{
  const world = createWorld(303, 'melee')
  unlockCombatSkills(world)
  const deliberatelyLoose = UPGRADES.map((upgrade) => ({
    id: upgrade.id,
    available: true,
    weight: upgrade.weight,
    classFilter: upgrade.classFilter,
    currentRank: 0,
    maxRank: upgrade.ranks.length,
  }))
  const first = rollUpgrades(createRng(19), deliberatelyLoose, 30, {
    playerClass: 'melee',
    allowRankUps: true,
  })
  const second = rollUpgrades(createRng(19), deliberatelyLoose, 30, {
    playerClass: 'melee',
    allowRankUps: true,
  })
  assert(JSON.stringify(first) === JSON.stringify(second), '고정 시드 추첨이 달라짐')
  assert(
    first.every((choice) => getUpgrade(choice.id)?.classFilter.includes('melee')),
    '근접 풀에 원거리 광학 장치가 섞임',
  )
  assert(
    first.every((choice) => choice.id !== 'telescopic-aperture'),
    '근접에게 사거리 강화가 노출됨',
  )

  // 실제 available 경로도 클래스·스킬·합성 전제를 모두 포함해야 한다.
  assert(
    candidatePool(world).every((candidate) => {
      const upgrade = getUpgrade(candidate.id)!
      return candidate.available === upgrade.isAvailable(world)
    }),
    '콘텐츠와 후보 가용성 판정이 어긋남',
  )
}

// UI는 다음 랭크가 III이면 수치 카드가 아니라 각성 이름·배지를 보여준다.
{
  const world = createWorld(404, 'ranged')
  unlockCombatSkills(world)
  world.progression.level = 3
  world.progression.pendingLevelUps = 1

  for (const upgrade of UPGRADES) {
    if (
      upgrade.classFilter.includes('ranged') &&
      !upgrade.fusion &&
      upgrade.id !== 'orbit-lens'
    ) {
      world.upgradesTaken.add(upgrade.id)
      world.upgradesTaken.add(upgradeRankToken(upgrade.id, 2))
      world.upgradesTaken.add(upgradeRankToken(upgrade.id, 3))
    }
  }
  world.upgradesTaken.add('orbit-lens')
  world.upgradesTaken.add(upgradeRankToken('orbit-lens', 2))

  const cards = buildLevelUpCards(world)
  assert(cards.length === 1, '각성 후보만 남았을 때 단일 카드가 나오지 않음')
  assert(cards[0]?.rank === 3, 'UI 카드가 다음 랭크 III를 표시하지 않음')
  assert(cards[0]?.rarity === 'awakening', 'UI 카드가 각성 희귀도를 표시하지 않음')
  assert(cards[0]?.badges?.includes('각성'), 'UI 카드에 각성 배지가 없음')
  assert(cards[0]?.name.includes('귀환 궤도'), 'UI 카드에 각성 이름이 없음')
}

console.log('upgrade-system: 6 suites passed')
