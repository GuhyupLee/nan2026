import {
  UPGRADES,
  applyRelicUpgrade,
  applyUpgrade,
  applyUpgradeBurst,
  getUpgrade,
  getUpgradeBranchPresentation,
  getUpgradePresentation,
  getUpgradeRank,
  getRelicFusionPreview,
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

// 같은 강화의 I·II·III와 하나의 합성을 공유하는 각 스킬 슬롯이 서로 다른 경로명으로 읽혀야 한다.
{
  for (const upgrade of UPGRADES.filter((candidate) => candidate.fusion === undefined)) {
    const rankNames = upgrade.ranks.map((rank) => rank.displayName)
    assert(
      new Set(rankNames).size === rankNames.length,
      `${upgrade.id}의 랭크별 경로명이 중복됨`,
    )

    const presentations = [
      getUpgradePresentation(upgrade, new Set()),
      getUpgradePresentation(upgrade, new Set([upgrade.id])),
      getUpgradePresentation(
        upgrade,
        new Set([upgrade.id, upgradeRankToken(upgrade.id, 2)]),
      ),
    ].slice(0, upgrade.ranks.length)
    assert(
      new Set(presentations.map((entry) => entry.name)).size ===
        upgrade.ranks.length,
      `${upgrade.id}의 I·II·III 카드 제목이 구분되지 않음`,
    )
    assert(
      presentations.every((entry) => entry.familyLabel === upgrade.name),
      `${upgrade.id}의 카드 경로명이 고유 장비명과 다름`,
    )
  }

  const rangedQ = getUpgradeBranchPresentation('singularity-interference', 'q')
  const rangedW = getUpgradeBranchPresentation('singularity-interference', 'w')
  assert(rangedQ !== null && rangedW !== null, '원거리 합성 경로 표시를 찾지 못함')
  assert(rangedQ.name !== rangedW.name, '원거리 Q/W 합성 경로명이 동일함')
  assert(rangedQ.name === '특이점 낙광', '원거리 Q 합성 경로명이 잘못됨')
  assert(rangedW.name === '사건지평 견인', '원거리 W 합성 경로명이 잘못됨')

  const meleeQ = getUpgradeBranchPresentation('eclipse-sword-domain', 'q')
  const meleeR = getUpgradeBranchPresentation('eclipse-sword-domain', 'r')
  assert(meleeQ !== null && meleeR !== null, '근거리 합성 경로 표시를 찾지 못함')
  assert(meleeQ.name !== meleeR.name, '근거리 Q/R 합성 경로명이 동일함')
  assert(meleeQ.name === '월식 발도', '근거리 Q 합성 경로명이 잘못됨')
  assert(meleeR.name === '월식 난무', '근거리 R 합성 경로명이 잘못됨')
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

// 확장 카드 풀과 월광 전승 잠금은 런 시작 스냅샷만 읽는다.
{
  const rangedBase = UPGRADES.filter(
    (upgrade) =>
      upgrade.classFilter.includes('ranged') &&
      upgrade.family === 'optical-device',
  )
  const meleeBase = UPGRADES.filter(
    (upgrade) =>
      upgrade.classFilter.includes('melee') &&
      upgrade.family === 'sword-art',
  )
  assert(rangedBase.length === 12, '원거리 기본 카드 풀이 12종이 아님')
  assert(meleeBase.length === 12, '근거리 기본 카드 풀이 12종이 아님')

  const locked = createWorld(260, 'melee')
  assert(
    !getUpgrade('decapitating-flash')!.isAvailable(locked),
    '잠긴 참두 일섬이 기본 런에 노출됨',
  )
  assert(
    !getUpgrade('revival-seal')!.isAvailable(locked),
    '잠긴 귀환의 인장이 기본 런에 노출됨',
  )

  const unlocked = createWorld(260, 'melee', {
    meta: {
      version: 1,
      maxHpBonus: 0,
      speedMultiplier: 1,
      unlockedUpgradeIds: [
        'decapitating-flash',
        'eclipse-execution-array',
        'revival-seal',
      ],
    },
  })
  assert(
    getUpgrade('decapitating-flash')!.isAvailable(unlocked),
    '런 스냅샷으로 참두 일섬이 열리지 않음',
  )
  const revival = getUpgrade('revival-seal')!
  assert(revival.isAvailable(unlocked), '귀환의 인장이 열리지 않음')
  assert(applyUpgrade(unlocked, revival.id)?.rank === 1, '전승 카드 적용 실패')
  assert(!revival.isAvailable(unlocked), '1랭크 전승 카드가 다시 노출됨')
  assert(
    getUpgradePresentation(revival, new Set()).rarity === 'legacy',
    '전승 카드 희귀도 표시가 없음',
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

// 정예 전리품은 같은 장비를 최대 두 랭크 올리고 최대치를 넘지 않는다.
{
  const world = createWorld(353, 'ranged')
  unlockCombatSkills(world)
  const first = applyUpgradeBurst(world, 'orbit-lens')
  assert(
    first.length === 2 && getUpgradeRank(world.upgradesTaken, 'orbit-lens') === 2,
    '신규 장비가 전리품에서 I·II로 연속 각인되지 않음',
  )
  const second = applyUpgradeBurst(world, 'orbit-lens')
  assert(
    second.length === 1 &&
      getUpgradeRank(world.upgradesTaken, 'orbit-lens') === 3 &&
      world.skills.q.branch === 'orbital-prism',
    'II 장비가 전리품에서 III 각성으로 승격되지 않음',
  )

  const fusionWorld = createWorld(355, 'ranged')
  unlockCombatSkills(fusionWorld)
  applyRelicUpgrade(fusionWorld, 'orbit-lens')
  applyRelicUpgrade(fusionWorld, 'orbit-lens')
  const fusionPreview = getRelicFusionPreview(fusionWorld, 'gravity-prism')
  assert(
    fusionPreview?.id === 'singularity-interferometer',
    '세 번째 전리품 카드가 함께 발동할 융합을 예고하지 못함',
  )
  applyRelicUpgrade(fusionWorld, 'gravity-prism')
  assert(
    getUpgradeRank(fusionWorld.upgradesTaken, 'gravity-prism') === 3 &&
      fusionWorld.upgradesTaken.has('singularity-interferometer'),
    '세 번째 정예 전리품이 두 번째 재료와 융합을 한 번에 완성하지 못함',
  )

  const cardWorld = createWorld(354, 'ranged')
  unlockCombatSkills(cardWorld)
  cardWorld.pendingRelicChoices = 1
  cardWorld.awaitingChoice = true
  const cards = buildLevelUpCards(cardWorld)
  assert(cards.length === 3, '전리품 3택이 만들어지지 않음')
  assert(
    cards.every(
      (card) =>
        card.kind === 'relic-upgrade' &&
        card.badges?.includes('정예 전리품') &&
        card.badges.includes('RANK II') &&
        !card.badges.includes('RANK I') &&
        card.rank === 2,
    ),
    '전리품 카드가 2단 연속 각인 정보를 표시하지 않음',
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

console.log('upgrade-system: 7 suites passed')
