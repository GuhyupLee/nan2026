import type { SkillId } from '../sim/skills.ts'
import {
  getRecordedUpgradeRank as readRank,
  recordUpgradeRank as rememberRank,
  upgradeTraitToken,
} from '../sim/progression.ts'
import type { PlayerClass, World } from '../sim/types.ts'

/**
 * 강화는 I·II에서 수치를 올리고 III에서 전투 규칙을 바꾼다.
 *
 * 월드는 기존 호환성을 위해 `Set<string>` 하나만 보관한다. 첫 획득은 예전과
 * 똑같이 카드 id를 넣고, II·III만 별도 토큰을 더한다. 저장 타입을 바꾸지
 * 않으면서 같은 카드를 다시 뽑을 수 있고, 예전 코드의 `taken.has(id)`도
 * 여전히 "한 번 이상 획득했는가"라는 뜻으로 동작한다.
 */

export type UpgradeRank = 1 | 2 | 3
export type UpgradeFamily = 'optical-device' | 'sword-art' | 'fusion' | 'legacy'
export type UpgradeRarity = 'standard' | 'awakening' | 'fusion' | 'legacy'

export interface UpgradeRankDef {
  rank: UpgradeRank
  /** 같은 강화 경로 안에서도 I·II·III를 즉시 구분하는 고유 표시명. */
  displayName: string
  /** 카드 본문. III는 숫자 대신 바뀌는 규칙을 설명한다. */
  oneLiner: string
  /** 시뮬레이션이 소비할 수 있는 안정적인 성질 id. */
  trait?: string
  /** III 카드의 각성 이름. */
  awakeningName?: string
}

export interface UpgradeFusion {
  /** 두 카드가 모두 III일 때만 합성 카드가 풀에 들어온다. */
  requires: readonly [string, string]
  /** 하나의 합성이 여러 스킬에 연결될 때 슬롯별로 보여 줄 고유 경로명. */
  slotDisplayNames?: Partial<Record<SkillId, string>>
}

export interface UpgradeDef {
  id: string
  name: string
  /** 이전 UI·도구 호환용. 항상 I 설명과 같다. */
  oneLiner: string
  glyph: string
  weight: number
  /** progression이 클래스와 맞지 않는 카드를 추첨 전에 제거한다. */
  classFilter: readonly PlayerClass[]
  family: UpgradeFamily
  /** QWER 자체를 바꾸는 카드가 어느 슬롯을 겨냥하는지 UI와 시뮬에 알린다. */
  slot?: SkillId
  ranks: readonly UpgradeRankDef[]
  fusion?: UpgradeFusion
  /** 월광 전승에서 해금되어야 드래프트에 등장하는 콘텐츠 id. */
  unlockId?: string
  /** 클래스·선행 각성·스킬 해금·최대 랭크를 한 번에 검사한다. */
  isAvailable: (world: World) => boolean
  /**
   * 해당 랭크의 증분만 적용한다. rank를 생략한 예전 호출은 I을 적용한다.
   * 획득 이력까지 안전하게 갱신하려면 `applyUpgrade`를 사용한다.
   */
  apply: (world: World, rank?: UpgradeRank) => void
}

interface UpgradeBlueprint {
  id: string
  name: string
  glyph: string
  weight: number
  classFilter: readonly PlayerClass[]
  family: UpgradeFamily
  slot?: SkillId
  ranks: readonly UpgradeRankDef[]
  fusion?: UpgradeFusion
  unlockId?: string
  /** 융합이 아닌 1랭크 전승 카드에만 사용한다. */
  singleRank?: boolean
  isAvailable?: (world: World) => boolean
  effects: readonly ((world: World) => void)[]
}

export interface UpgradePresentation {
  id: string
  name: string
  pathName: string
  oneLiner: string
  currentRank: number
  nextRank: number
  maxRank: number
  rankLabel: string
  rarity: UpgradeRarity
  family: UpgradeFamily
  /** 카드에서 같은 클래스의 선택지를 구분하는 고유 강화 경로명. */
  familyLabel: string
  slot?: SkillId
  trait?: string
  badges: readonly string[]
}

export interface UpgradeApplication {
  id: string
  rank: number
  trait?: string
}

const RANGED = ['ranged'] as const satisfies readonly PlayerClass[]
const MELEE = ['melee'] as const satisfies readonly PlayerClass[]

function scaleSkillCooldown(world: World, slot: SkillId, multiplier: number): void {
  const skill = world.skills[slot]
  skill.maxCooldown *= multiplier
  skill.cooldown = Math.min(skill.cooldown, skill.maxCooldown)
}

function awakenSkill(world: World, slot: SkillId, branch: string): void {
  // branch는 원래 스킬의 배타적 변형을 위해 마련된 런타임 필드다.
  world.skills[slot].branch = branch
}

function defineUpgrade(blueprint: UpgradeBlueprint): UpgradeDef {
  const first = blueprint.ranks[0]
  if (!first || blueprint.ranks.length !== blueprint.effects.length) {
    throw new Error(`강화 ${blueprint.id}의 랭크 설명과 효과 수가 다릅니다.`)
  }
  if (
    !blueprint.fusion &&
    !blueprint.singleRank &&
    blueprint.ranks.length !== 3
  ) {
    throw new Error(`일반 강화 ${blueprint.id}는 I·II·III 세 랭크가 필요합니다.`)
  }
  if (blueprint.ranks.some((rank, index) => rank.rank !== index + 1)) {
    throw new Error(`강화 ${blueprint.id}의 랭크 순서가 올바르지 않습니다.`)
  }

  const available = (world: World): boolean => {
    if (!blueprint.classFilter.includes(world.playerClass)) return false
    if (
      blueprint.unlockId &&
      !world.runConfig.meta.unlockedUpgradeIds.includes(blueprint.unlockId)
    ) {
      return false
    }
    if (readRank(world.upgradesTaken, blueprint.id) >= blueprint.ranks.length) return false
    if (blueprint.slot && !world.skills[blueprint.slot].unlocked) return false
    if (
      blueprint.fusion &&
      !blueprint.fusion.requires.every((id) => readRank(world.upgradesTaken, id) >= 3)
    ) {
      return false
    }
    return blueprint.isAvailable ? blueprint.isAvailable(world) : true
  }

  return {
    id: blueprint.id,
    name: blueprint.name,
    oneLiner: first.oneLiner,
    glyph: blueprint.glyph,
    weight: blueprint.weight,
    classFilter: blueprint.classFilter,
    family: blueprint.family,
    ...(blueprint.slot ? { slot: blueprint.slot } : {}),
    ranks: blueprint.ranks,
    ...(blueprint.fusion ? { fusion: blueprint.fusion } : {}),
    ...(blueprint.unlockId ? { unlockId: blueprint.unlockId } : {}),
    isAvailable: available,
    apply: (world, rank = 1) => {
      const effect = blueprint.effects[rank - 1]
      if (!effect) return
      effect(world)
      const trait = blueprint.ranks[rank - 1]?.trait
      if (trait) world.upgradesTaken.add(upgradeTraitToken(trait))
    },
  }
}

/**
 * 일현 — 광학 장치.
 *
 * 렌즈·프리즘·조리개·코어라는 한 축으로 읽히고, 네 장의 QWER 장치는
 * III에서 각각 스킬의 발동 구조를 바꾼다.
 */
const RANGED_UPGRADES: readonly UpgradeDef[] = [
  defineUpgrade({
    id: 'focused-lens',
    name: '집광 렌즈',
    glyph: '◉',
    weight: 10,
    classFilter: RANGED,
    family: 'optical-device',
    ranks: [
      { rank: 1, displayName: '초점 정렬', oneLiner: '평타 관통 +1' },
      { rank: 2, displayName: '광량 증폭', oneLiner: '공격 피해 +16% (평타·QWER)' },
      {
        rank: 3,
        displayName: '연쇄 집광',
        oneLiner: '관통할 때마다 다음 대상에게 더 강한 빛이 전달됩니다.',
        trait: 'pierce-amplification',
        awakeningName: '연쇄 집광',
      },
    ],
    effects: [
      (w) => {
        w.stats.atkPierce += 1
      },
      (w) => {
        w.stats.atkDamageMul *= 1.16
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'diffraction-prism',
    name: '회절 프리즘',
    glyph: '◇',
    weight: 9,
    classFilter: RANGED,
    family: 'optical-device',
    ranks: [
      { rank: 1, displayName: '고속 굴절', oneLiner: '평타 공격 간격 -14%' },
      { rank: 2, displayName: '연속 회절', oneLiner: '평타 공격 간격 -14%' },
      {
        rank: 3,
        displayName: '삼중 회절',
        oneLiner: '세 번째 평타가 양옆으로 갈라지는 보조 광선을 만듭니다.',
        trait: 'split-refraction',
        awakeningName: '삼중 회절',
      },
    ],
    effects: [
      (w) => {
        w.stats.atkIntervalMul *= 0.86
      },
      (w) => {
        w.stats.atkIntervalMul *= 0.86
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'telescopic-aperture',
    name: '원경 조리개',
    glyph: '◎',
    weight: 7,
    classFilter: RANGED,
    family: 'optical-device',
    ranks: [
      { rank: 1, displayName: '원거리 개방', oneLiner: '평타 사거리 +22%' },
      { rank: 2, displayName: '극초점 확장', oneLiner: '평타 사거리 +18%' },
      {
        rank: 3,
        displayName: '수평선 고정',
        oneLiner: '먼 거리에서 맞힌 평타가 대상 뒤까지 초점 폭발을 일으킵니다.',
        trait: 'horizon-focus',
        awakeningName: '수평선 고정',
      },
    ],
    effects: [
      (w) => {
        w.stats.atkRange *= 1.22
      },
      (w) => {
        w.stats.atkRange *= 1.18
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'photon-core',
    name: '광자 생명 코어',
    glyph: '✚',
    weight: 8,
    classFilter: RANGED,
    family: 'optical-device',
    ranks: [
      {
        rank: 1,
        displayName: '생명광 충전',
        oneLiner: '최대 체력 +32, 즉시 32 회복, 공격 피해 +4%',
      },
      { rank: 2, displayName: '광막 경화', oneLiner: '받는 피해 -10%' },
      {
        rank: 3,
        displayName: '비상 점등',
        oneLiner: '치명상을 한 번 막고 1.2초 동안 피해를 받지 않습니다.',
        trait: 'photon-barrier',
        awakeningName: '비상 점등',
      },
    ],
    effects: [
      (w) => {
        w.stats.maxHp += 32
        w.player.hp = Math.min(w.stats.maxHp, w.player.hp + 32)
        w.stats.atkDamageMul *= 1.04
      },
      (w) => {
        w.stats.damageTakenMul *= 0.9
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'orbit-lens',
    name: '궤도 렌즈',
    glyph: 'Q',
    weight: 8,
    classFilter: RANGED,
    family: 'optical-device',
    slot: 'q',
    ranks: [
      { rank: 1, displayName: '저궤도 조준', oneLiner: 'Q 재사용 대기시간 -12%' },
      { rank: 2, displayName: '궤도 단축', oneLiner: 'Q 재사용 대기시간 -12%' },
      {
        rank: 3,
        displayName: '귀환 궤도',
        oneLiner: '낙광이 0.55초 뒤 더 좁은 범위에 한 번 더 떨어집니다.',
        trait: 'orbital-prism',
        awakeningName: '귀환 궤도',
      },
    ],
    effects: [
      (w) => scaleSkillCooldown(w, 'q', 0.88),
      (w) => scaleSkillCooldown(w, 'q', 0.88),
      (w) => awakenSkill(w, 'q', 'orbital-prism'),
    ],
  }),
  defineUpgrade({
    id: 'gravity-prism',
    name: '중력 프리즘',
    glyph: 'W',
    weight: 8,
    classFilter: RANGED,
    family: 'optical-device',
    slot: 'w',
    ranks: [
      { rank: 1, displayName: '인력 증폭', oneLiner: 'W 재사용 대기시간 -10%' },
      { rank: 2, displayName: '붕괴 가속', oneLiner: 'W 재사용 대기시간 -10%' },
      {
        rank: 3,
        displayName: '이중 붕괴',
        oneLiner: 'W 견인이 두 배 오래 이어지고 끝에서 중심 폭발을 일으킵니다.',
        trait: 'double-collapse',
        awakeningName: '이중 붕괴',
      },
    ],
    effects: [
      (w) => scaleSkillCooldown(w, 'w', 0.9),
      (w) => scaleSkillCooldown(w, 'w', 0.9),
      (w) => awakenSkill(w, 'w', 'double-collapse'),
    ],
  }),
  defineUpgrade({
    id: 'phase-aperture',
    name: '위상 조리개',
    glyph: 'E',
    weight: 7,
    classFilter: RANGED,
    family: 'optical-device',
    slot: 'e',
    ranks: [
      { rank: 1, displayName: '위상 정렬', oneLiner: 'E 재사용 대기시간 -10%' },
      { rank: 2, displayName: '통로 가속', oneLiner: 'E 재사용 대기시간 -10%' },
      {
        rank: 3,
        displayName: '잔광 통로',
        oneLiner: 'E 투사체 경로를 잔광이 즉시 한 번 가르며 적을 점등합니다.',
        trait: 'afterimage-aperture',
        awakeningName: '잔광 통로',
      },
    ],
    effects: [
      (w) => scaleSkillCooldown(w, 'e', 0.9),
      (w) => scaleSkillCooldown(w, 'e', 0.9),
      (w) => awakenSkill(w, 'e', 'afterimage-aperture'),
    ],
  }),
  defineUpgrade({
    id: 'heliostat-core',
    name: '태양 추적 코어',
    glyph: 'R',
    weight: 6,
    classFilter: RANGED,
    family: 'optical-device',
    slot: 'r',
    ranks: [
      { rank: 1, displayName: '태양 정렬', oneLiner: 'R 재사용 대기시간 -8%' },
      { rank: 2, displayName: '추적 가속', oneLiner: 'R 재사용 대기시간 -8%' },
      {
        rank: 3,
        displayName: '태양 추적',
        oneLiner: 'R 광선이 점등된 적에게서 가장 가까운 새 대상으로 굴절됩니다.',
        trait: 'heliostat-chain',
        awakeningName: '태양 추적',
      },
    ],
    effects: [
      (w) => scaleSkillCooldown(w, 'r', 0.92),
      (w) => scaleSkillCooldown(w, 'r', 0.92),
      (w) => awakenSkill(w, 'r', 'heliostat-chain'),
    ],
  }),
] as const

/**
 * 월아 — 검술 유파.
 *
 * 연마·보법·호흡·납도·검세로 용어를 묶었다. 원거리 전용 사거리 카드는
 * 이 목록에 없고 클래스 필터가 한 번 더 차단한다.
 */
const MELEE_UPGRADES: readonly UpgradeDef[] = [
  defineUpgrade({
    id: 'crescent-honing',
    name: '반월 연마',
    glyph: '◆',
    weight: 10,
    classFilter: MELEE,
    family: 'sword-art',
    ranks: [
      { rank: 1, displayName: '초승날 벼림', oneLiner: '공격 피해 +18% (평타·QWER)' },
      { rank: 2, displayName: '반월 예각', oneLiner: '공격 피해 +15% (평타·QWER)' },
      {
        rank: 3,
        displayName: '잔월',
        oneLiner: '월참이 검기를 남겨 잠시 뒤 같은 자리를 다시 베어냅니다.',
        trait: 'echoing-crescent',
        awakeningName: '잔월',
      },
    ],
    effects: [
      (w) => {
        w.stats.atkDamageMul *= 1.18
      },
      (w) => {
        w.stats.atkDamageMul *= 1.15
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'flowing-footwork',
    name: '유수 보법',
    glyph: '⇢',
    weight: 9,
    classFilter: MELEE,
    family: 'sword-art',
    ranks: [
      { rank: 1, displayName: '유수 전진', oneLiner: '이동 속도 +10%' },
      { rank: 2, displayName: '흐름 가속', oneLiner: '평타 공격 간격 -10%' },
      {
        rank: 3,
        displayName: '무영보',
        oneLiner: '점멸·돌진 후 출발점의 잔상이 뒤쫓는 적을 한 차례 벱니다.',
        trait: 'afterimage-step',
        awakeningName: '무영보',
      },
    ],
    effects: [
      (w) => {
        w.stats.speed *= 1.1
      },
      (w) => {
        w.stats.atkIntervalMul *= 0.9
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'ironwall-breath',
    name: '철벽 호흡',
    glyph: '⛨',
    weight: 8,
    classFilter: MELEE,
    family: 'sword-art',
    ranks: [
      { rank: 1, displayName: '철벽 들숨', oneLiner: '받는 피해 -12%' },
      { rank: 2, displayName: '강체 순환', oneLiner: '최대 체력 +22, 즉시 22 회복' },
      {
        rank: 3,
        displayName: '부동',
        oneLiner: '체력을 절반 아래로 떨어뜨릴 첫 피해를 흘리고 참흔 35를 얻습니다.',
        trait: 'perfect-guard',
        awakeningName: '부동',
      },
    ],
    effects: [
      (w) => {
        w.stats.damageTakenMul *= 0.88
      },
      (w) => {
        w.stats.maxHp += 22
        w.player.hp = Math.min(w.stats.maxHp, w.player.hp + 22)
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'bloodflow-breath',
    name: '혈류 호흡',
    glyph: '✜',
    weight: 7,
    classFilter: MELEE,
    family: 'sword-art',
    ranks: [
      { rank: 1, displayName: '혈기 충만', oneLiner: '회복(D) 회복량 +20' },
      { rank: 2, displayName: '순환 가속', oneLiner: '회복(D) 재사용 대기시간 -18%' },
      {
        rank: 3,
        displayName: '혈기 전환',
        oneLiner: '초과 회복이 발생하면 0.65초 동안 피해를 받지 않습니다.',
        trait: 'overflow-guard',
        awakeningName: '혈기 전환',
      },
    ],
    effects: [
      (w) => {
        w.stats.healAmount += 20
      },
      (w) => {
        w.stats.healCooldown *= 0.82
        scaleSkillCooldown(w, 'd', 0.82)
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'iai-scroll',
    name: '발도 비전',
    glyph: 'Q',
    weight: 8,
    classFilter: MELEE,
    family: 'sword-art',
    slot: 'q',
    ranks: [
      { rank: 1, displayName: '초식 단련', oneLiner: 'Q 재사용 대기시간 -12%' },
      { rank: 2, displayName: '납검 가속', oneLiner: 'Q 재사용 대기시간 -12%' },
      {
        rank: 3,
        displayName: '교차 발도',
        oneLiner: 'Q를 벤 뒤 같은 경로를 거슬러 교차 참격이 되돌아옵니다.',
        trait: 'returning-draw-cut',
        awakeningName: '교차 발도',
      },
    ],
    effects: [
      (w) => scaleSkillCooldown(w, 'q', 0.88),
      (w) => scaleSkillCooldown(w, 'q', 0.88),
      (w) => awakenSkill(w, 'q', 'returning-draw-cut'),
    ],
  }),
  defineUpgrade({
    id: 'watermoon-sheath',
    name: '수월 납도',
    glyph: 'W',
    weight: 8,
    classFilter: MELEE,
    family: 'sword-art',
    slot: 'w',
    ranks: [
      { rank: 1, displayName: '수월 초식', oneLiner: 'W 재사용 대기시간 -10%' },
      { rank: 2, displayName: '유영 납도', oneLiner: 'W 재사용 대기시간 -10%' },
      {
        rank: 3,
        displayName: '수면 회귀',
        oneLiner: 'W 착지점에서 출발점까지 귀환 검기가 되돌아갑니다.',
        trait: 'returning-sheath',
        awakeningName: '수면 회귀',
      },
    ],
    effects: [
      (w) => scaleSkillCooldown(w, 'w', 0.9),
      (w) => scaleSkillCooldown(w, 'w', 0.9),
      (w) => awakenSkill(w, 'w', 'returning-sheath'),
    ],
  }),
  defineUpgrade({
    id: 'mirror-guard',
    name: '명경지수 자세',
    glyph: 'E',
    weight: 7,
    classFilter: MELEE,
    family: 'sword-art',
    slot: 'e',
    ranks: [
      { rank: 1, displayName: '명경 입문', oneLiner: 'E 재사용 대기시간 -10%' },
      { rank: 2, displayName: '지수 심화', oneLiner: 'E 재사용 대기시간 -10%' },
      {
        rank: 3,
        displayName: '수경 반격',
        oneLiner: 'E가 모은 적을 0.45초 뒤 같은 자리에서 다시 베어냅니다.',
        trait: 'mirror-counter',
        awakeningName: '수경 반격',
      },
    ],
    effects: [
      (w) => scaleSkillCooldown(w, 'e', 0.9),
      (w) => scaleSkillCooldown(w, 'e', 0.9),
      (w) => awakenSkill(w, 'e', 'mirror-counter'),
    ],
  }),
  defineUpgrade({
    id: 'fullmoon-form',
    name: '만월 검세',
    glyph: 'R',
    weight: 6,
    classFilter: MELEE,
    family: 'sword-art',
    slot: 'r',
    ranks: [
      { rank: 1, displayName: '월륜 전개', oneLiner: 'R 재사용 대기시간 -8%' },
      { rank: 2, displayName: '만월 응축', oneLiner: 'R 재사용 대기시간 -8%' },
      {
        rank: 3,
        displayName: '월하 결계',
        oneLiner: 'R의 마지막 타격이 넓은 만월 결계를 남겨 적을 연속으로 벱니다.',
        trait: 'fullmoon-domain',
        awakeningName: '월하 결계',
      },
    ],
    effects: [
      (w) => scaleSkillCooldown(w, 'r', 0.92),
      (w) => scaleSkillCooldown(w, 'r', 0.92),
      (w) => awakenSkill(w, 'r', 'fullmoon-domain'),
    ],
  }),
] as const

const RANGED_EXPANSION_UPGRADES: readonly UpgradeDef[] = [
  defineUpgrade({
    id: 'interference-filament',
    name: '간섭 필라멘트',
    glyph: '⌁',
    weight: 8,
    classFilter: RANGED,
    family: 'optical-device',
    ranks: [
      { rank: 1, displayName: '이중 투과', oneLiner: '평타 관통 +1' },
      { rank: 2, displayName: '다중 투과', oneLiner: '평타 관통 +1' },
      {
        rank: 3,
        displayName: '종단 간섭',
        oneLiner: '마지막 관통 지점에서 간섭 폭발을 일으킵니다.',
        trait: 'interference-burst',
        awakeningName: '종단 간섭',
      },
    ],
    effects: [
      (w) => {
        w.stats.atkPierce += 1
      },
      (w) => {
        w.stats.atkPierce += 1
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'dual-focus',
    name: '이중 초점',
    glyph: '◉',
    weight: 8,
    classFilter: RANGED,
    family: 'optical-device',
    ranks: [
      {
        rank: 1,
        displayName: '보조 광선',
        oneLiner: '평타 피해 40%의 보조 광선을 발사합니다.',
        trait: 'auxiliary-beam',
      },
      {
        rank: 2,
        displayName: '초점 수렴',
        oneLiner: '보조 광선의 발사각이 좁아집니다.',
        trait: 'auxiliary-focus',
      },
      {
        rank: 3,
        displayName: '자율 초점',
        oneLiner: '보조 광선이 가까운 별도 표적을 자동 추적합니다.',
        trait: 'auxiliary-tracking',
        awakeningName: '자율 초점',
      },
    ],
    effects: [() => {}, () => {}, () => {}],
  }),
  defineUpgrade({
    id: 'collector-array',
    name: '수집 배열기',
    glyph: '⌾',
    weight: 7,
    classFilter: RANGED,
    family: 'optical-device',
    ranks: [
      { rank: 1, displayName: '인력 증폭', oneLiner: '획득 반경 +30%' },
      { rank: 2, displayName: '광역 집속', oneLiner: '획득 반경 +30%' },
      {
        rank: 3,
        displayName: '보석 과충전',
        oneLiner: 'XP 보석을 주우면 0.5초간 평타 간격이 35% 감소합니다.',
        trait: 'gem-overclock',
        awakeningName: '보석 과충전',
      },
    ],
    effects: [
      (w) => {
        w.stats.pickupRadiusMul *= 1.3
      },
      (w) => {
        w.stats.pickupRadiusMul *= 1.3
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'afterglow-battery',
    name: '월광 축전지',
    glyph: '◇',
    weight: 7,
    classFilter: RANGED,
    family: 'optical-device',
    ranks: [
      { rank: 1, displayName: '회복 충전', oneLiner: 'D 재사용 대기시간 -15%' },
      { rank: 2, displayName: '점멸 충전', oneLiner: 'F 재사용 대기시간 -15%' },
      {
        rank: 3,
        displayName: '잔광 과출력',
        oneLiner: 'D·F 사용 후 3초간 공격 피해가 25% 증가합니다.',
        trait: 'utility-overdrive',
        awakeningName: '잔광 과출력',
      },
    ],
    effects: [
      (w) => scaleSkillCooldown(w, 'd', 0.85),
      (w) => scaleSkillCooldown(w, 'f', 0.85),
      () => {},
    ],
  }),
] as const

const MELEE_EXPANSION_UPGRADES: readonly UpgradeDef[] = [
  defineUpgrade({
    id: 'decapitating-flash',
    name: '참두 일섬',
    glyph: '斬',
    weight: 8,
    classFilter: MELEE,
    family: 'sword-art',
    unlockId: 'decapitating-flash',
    ranks: [
      { rank: 1, displayName: '급소 절개', oneLiner: '평타 피해 +12%' },
      { rank: 2, displayName: '필살 예기', oneLiner: '평타 피해 +12%' },
      {
        rank: 3,
        displayName: '참수',
        oneLiner: '체력 18% 이하 일반 적을 평타로 즉시 처형합니다.',
        trait: 'decapitation',
        awakeningName: '참수',
      },
    ],
    effects: [
      (w) => {
        w.stats.basicAttackDamageMul *= 1.12
      },
      (w) => {
        w.stats.basicAttackDamageMul *= 1.12
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'moon-drain-breath',
    name: '흡월 연공',
    glyph: '月',
    weight: 8,
    classFilter: MELEE,
    family: 'sword-art',
    ranks: [
      {
        rank: 1,
        displayName: '월기 흡수',
        oneLiner: '처치 회복 상한 +6',
        trait: 'moon-drain',
      },
      { rank: 2, displayName: '연공 순환', oneLiner: '처치 회복 속도 +2' },
      {
        rank: 3,
        displayName: '과회복 호흡',
        oneLiner: '과회복을 다음 피격 1회를 막는 보호막으로 바꿉니다.',
        trait: 'overheal-guard',
        awakeningName: '과회복 호흡',
      },
    ],
    effects: [
      (w) => {
        w.stats.killHealCap += 6
        w.player.killHealBudget += 6
      },
      (w) => {
        w.stats.killHealRate += 2
      },
      () => {},
    ],
  }),
  defineUpgrade({
    id: 'moonshadow-double',
    name: '월영 쌍격',
    glyph: '双',
    weight: 8,
    classFilter: MELEE,
    family: 'sword-art',
    ranks: [
      {
        rank: 1,
        displayName: '등 뒤의 칼',
        oneLiner: '평타가 뒤쪽 적도 피해 50%로 벱니다.',
        trait: 'backstrike',
      },
      {
        rank: 2,
        displayName: '월영 강화',
        oneLiner: '뒤쪽 베기 피해가 75%로 증가합니다.',
        trait: 'backstrike-focus',
      },
      {
        rank: 3,
        displayName: '쌍살',
        oneLiner: '앞뒤 적을 동시에 처치하면 게이지를 8 얻습니다.',
        trait: 'dual-kill-gauge',
        awakeningName: '쌍살',
      },
    ],
    effects: [() => {}, () => {}, () => {}],
  }),
  defineUpgrade({
    id: 'blood-feast-step',
    name: '혈연 보식',
    glyph: '血',
    weight: 7,
    classFilter: MELEE,
    family: 'sword-art',
    ranks: [
      { rank: 1, displayName: '포식 반경', oneLiner: '획득 반경 +30%' },
      { rank: 2, displayName: '혈기 섭취', oneLiner: '회복 구슬 효과 +50%' },
      {
        rank: 3,
        displayName: '보석 포식',
        oneLiner: 'XP 보석 10개마다 다음 평타가 두 번 적중합니다.',
        trait: 'gem-double-strike',
        awakeningName: '보석 포식',
      },
    ],
    effects: [
      (w) => {
        w.stats.pickupRadiusMul *= 1.3
      },
      (w) => {
        w.stats.battlefieldHealMul *= 1.5
      },
      () => {},
    ],
  }),
] as const

const FUSION_UPGRADES: readonly UpgradeDef[] = [
  defineUpgrade({
    id: 'supernova-specimen',
    name: '초신성 표본',
    glyph: '✦',
    weight: 24,
    classFilter: RANGED,
    family: 'fusion',
    unlockId: 'supernova-specimen',
    fusion: {
      requires: ['interference-filament', 'dual-focus'],
    },
    ranks: [
      {
        rank: 1,
        displayName: '연쇄 초신성',
        oneLiner: '종단 폭발이 커지고 보조 광선이 양방향으로 연쇄됩니다.',
        trait: 'supernova-chain',
      },
    ],
    effects: [() => {}],
  }),
  defineUpgrade({
    id: 'eclipse-execution-array',
    name: '월식 처형진',
    glyph: '☾',
    weight: 24,
    classFilter: MELEE,
    family: 'fusion',
    unlockId: 'eclipse-execution-array',
    fusion: {
      requires: ['decapitating-flash', 'moonshadow-double'],
    },
    ranks: [
      {
        rank: 1,
        displayName: '연쇄 처형',
        oneLiner: '처형이 주변의 빈사 상태 일반 적에게 퍼집니다.',
        trait: 'execution-spread',
      },
    ],
    effects: [() => {}],
  }),
  defineUpgrade({
    id: 'singularity-interferometer',
    name: '사건지평 간섭계',
    glyph: '✦',
    weight: 24,
    classFilter: RANGED,
    family: 'fusion',
    slot: 'q',
    fusion: {
      requires: ['orbit-lens', 'gravity-prism'],
      slotDisplayNames: {
        q: '특이점 낙광',
        w: '사건지평 견인',
      },
    },
    ranks: [
      {
        rank: 1,
        displayName: '특이점 중첩',
        oneLiner: '두 각성을 유지한 채 Q 지점에 W 견인장을 겹쳐 적을 가둡니다.',
        trait: 'singularity-interference',
      },
    ],
    effects: [
      (w) => {
        awakenSkill(w, 'q', 'singularity-interference')
        awakenSkill(w, 'w', 'singularity-interference')
      },
    ],
  }),
  defineUpgrade({
    id: 'eclipse-sword-codex',
    name: '월식 검전',
    glyph: '☾',
    weight: 24,
    classFilter: MELEE,
    family: 'fusion',
    slot: 'q',
    fusion: {
      requires: ['iai-scroll', 'fullmoon-form'],
      slotDisplayNames: {
        q: '월식 발도',
        r: '월식 난무',
      },
    },
    ranks: [
      {
        rank: 1,
        displayName: '월식 합일',
        oneLiner: '두 각성을 유지한 채 R의 모든 난격에 교차 발도를 더합니다.',
        trait: 'eclipse-sword-domain',
      },
    ],
    effects: [
      (w) => {
        awakenSkill(w, 'q', 'eclipse-sword-domain')
        awakenSkill(w, 'r', 'eclipse-sword-domain')
      },
    ],
  }),
] as const

const LEGACY_UPGRADES: readonly UpgradeDef[] = [
  defineUpgrade({
    id: 'wanderer-inscription',
    name: '유랑자의 나침반',
    glyph: '⌖',
    weight: 6,
    classFilter: [...RANGED, ...MELEE],
    family: 'legacy',
    unlockId: 'wanderer-inscription',
    ranks: [
      {
        rank: 1,
        displayName: '먼 길의 손',
        oneLiner: 'XP 보석과 전장 아이템 획득 반경 +25%',
      },
      {
        rank: 2,
        displayName: '바람걸음',
        oneLiner: '이동 속도 +6%',
      },
      {
        rank: 3,
        displayName: '샘의 기억',
        oneLiner: '회복 구슬 회복량 +40%',
      },
    ],
    effects: [
      (w) => {
        w.stats.pickupRadiusMul *= 1.25
      },
      (w) => {
        w.stats.speed *= 1.06
      },
      (w) => {
        w.stats.battlefieldHealMul *= 1.4
      },
    ],
  }),
  defineUpgrade({
    id: 'executioner-inscription',
    name: '집행자의 매듭',
    glyph: '結',
    weight: 6,
    classFilter: [...RANGED, ...MELEE],
    family: 'legacy',
    unlockId: 'executioner-inscription',
    ranks: [
      {
        rank: 1,
        displayName: '집행 칼날',
        oneLiner: '평타와 QWER 피해 +10%',
      },
      {
        rank: 2,
        displayName: '끊김 없는 추격',
        oneLiner: '평타 공격 간격 -10%',
      },
      {
        rank: 3,
        displayName: '관통 판결',
        oneLiner: '평타 관통 +1',
      },
    ],
    effects: [
      (w) => {
        w.stats.atkDamageMul *= 1.1
      },
      (w) => {
        w.stats.atkIntervalMul *= 0.9
      },
      (w) => {
        w.stats.atkPierce += 1
      },
    ],
  }),
  defineUpgrade({
    id: 'guardian-inscription',
    name: '수호월 인장',
    glyph: '盾',
    weight: 5,
    classFilter: [...RANGED, ...MELEE],
    family: 'legacy',
    unlockId: 'guardian-inscription',
    ranks: [
      {
        rank: 1,
        displayName: '달빛 갑주',
        oneLiner: '최대 체력과 현재 체력 +18',
      },
      {
        rank: 2,
        displayName: '봉합 결계',
        oneLiner: '받는 피해 -7%',
      },
      {
        rank: 3,
        displayName: '회복 각인',
        oneLiner: '회복(D) 회복량 +14',
      },
    ],
    effects: [
      (w) => {
        w.stats.maxHp += 18
        w.player.hp = Math.min(w.stats.maxHp, w.player.hp + 18)
      },
      (w) => {
        w.stats.damageTakenMul *= 0.93
      },
      (w) => {
        w.stats.healAmount += 14
      },
    ],
  }),
  defineUpgrade({
    id: 'timekeeper-inscription',
    name: '시계공의 월침',
    glyph: '刻',
    weight: 7,
    classFilter: [...RANGED, ...MELEE],
    family: 'legacy',
    unlockId: 'timekeeper-inscription',
    ranks: [
      {
        rank: 1,
        displayName: '칠성 태엽',
        oneLiner: 'QWER 재사용 대기시간 -7%',
      },
      {
        rank: 2,
        displayName: '쌍침 동조',
        oneLiner: 'D·F 재사용 대기시간 -12%',
      },
      {
        rank: 3,
        displayName: '도약 눈금',
        oneLiner: '점멸(F) 이동 거리 +2',
      },
    ],
    effects: [
      (w) => {
        w.stats.cooldownMul *= 0.93
        for (const slot of ['q', 'w', 'e', 'r'] as const) {
          if (w.skills[slot].unlocked) scaleSkillCooldown(w, slot, 0.93)
        }
      },
      (w) => {
        scaleSkillCooldown(w, 'd', 0.88)
        scaleSkillCooldown(w, 'f', 0.88)
      },
      (w) => {
        w.stats.flashRange += 2
      },
    ],
  }),
  defineUpgrade({
    id: 'revival-seal',
    name: '귀환의 인장',
    glyph: '印',
    weight: 3,
    classFilter: [...RANGED, ...MELEE],
    family: 'legacy',
    unlockId: 'revival-seal',
    singleRank: true,
    ranks: [
      {
        rank: 1,
        displayName: '월광 귀환',
        oneLiner: '치명상을 한 번 버티고 체력 50%·2초 무적·정화 폭발을 얻습니다.',
        trait: 'revival',
      },
    ],
    effects: [() => {}],
  }),
] as const

export const UPGRADES: readonly UpgradeDef[] = [
  ...RANGED_UPGRADES,
  ...RANGED_EXPANSION_UPGRADES,
  ...MELEE_UPGRADES,
  ...MELEE_EXPANSION_UPGRADES,
  ...FUSION_UPGRADES,
  ...LEGACY_UPGRADES,
]

const BY_ID = new Map(UPGRADES.map((upgrade) => [upgrade.id, upgrade]))

export function getUpgrade(id: string): UpgradeDef | undefined {
  return BY_ID.get(id)
}

export function getUpgradeRank(taken: ReadonlySet<string>, id: string): number {
  return readRank(taken, id)
}

export function isUpgradeAwakened(taken: ReadonlySet<string>, id: string): boolean {
  const upgrade = getUpgrade(id)
  if (!upgrade || upgrade.ranks.length < 3) return false
  return readRank(taken, id) >= 3
}

export function hasUpgradeTrait(world: World, trait: string): boolean {
  if (world.upgradesTaken.has(upgradeTraitToken(trait))) return true

  // 이전 랭크 토큰만 가진 리플레이도 III 성질을 잃지 않게 복원한다.
  for (const upgrade of UPGRADES) {
    const rank = readRank(world.upgradesTaken, upgrade.id)
    if (rank <= 0) continue
    const rankDef = upgrade.ranks[Math.min(rank, upgrade.ranks.length) - 1]
    if (rankDef?.trait === trait) return true
  }
  return false
}

function isFusionContentUnlocked(world: World, fusion: UpgradeDef): boolean {
  return (
    !fusion.unlockId ||
    world.runConfig.meta.unlockedUpgradeIds.includes(fusion.unlockId)
  )
}

export interface UpgradeFusionRoute {
  id: string
  name: string
  partnerId: string
  partnerName: string
  partnerRank: number
}

/**
 * 재료 카드를 고르는 순간 그 경로가 어느 융합으로 이어지는지 보여준다.
 * 여러 조합에 쓰이는 재료라면 현재 가장 많이 완성된 짝을 먼저 안내한다.
 */
export function getUpgradeFusionRoute(
  world: World,
  materialId: string,
): UpgradeFusionRoute | null {
  const routes = FUSION_UPGRADES.flatMap((fusion) => {
    if (
      !fusion.classFilter.includes(world.playerClass) ||
      !isFusionContentUnlocked(world, fusion) ||
      !fusion.fusion?.requires.includes(materialId)
    ) {
      return []
    }
    const partnerId =
      fusion.fusion.requires[0] === materialId
        ? fusion.fusion.requires[1]
        : fusion.fusion.requires[0]
    return [
      {
        id: fusion.id,
        name: fusion.name,
        partnerId,
        partnerName: getUpgrade(partnerId)?.name ?? partnerId,
        partnerRank: readRank(world.upgradesTaken, partnerId),
      },
    ]
  })

  routes.sort(
    (a, b) =>
      b.partnerRank - a.partnerRank ||
      a.name.localeCompare(b.name, 'ko-KR'),
  )
  return routes[0] ?? null
}

/**
 * 5분 안에 한 빌드가 각성→합성까지 이어지도록 선택지 한 칸의 우선순위를
 * 정한다. 진행 중인 장비를 먼저 완성하고, 각성 뒤에는 짝 장비, 마지막에는
 * 합성 카드를 차례로 노출한다.
 */
export function getUpgradeRollPriority(
  world: World,
  upgrade: UpgradeDef,
): number {
  if (upgrade.fusion) return upgrade.isAvailable(world) ? 3 : 0

  for (const fusion of FUSION_UPGRADES) {
    if (!isFusionContentUnlocked(world, fusion)) continue
    const requirements = fusion.fusion?.requires
    if (!requirements?.includes(upgrade.id)) continue
    const partner = requirements[0] === upgrade.id ? requirements[1] : requirements[0]
    if (readRank(world.upgradesTaken, partner) >= 3) return 2
  }

  return readRank(world.upgradesTaken, upgrade.id) > 0 ? 1 : 0
}

/**
 * 정예 전리품은 기존 각성·합성 콘텐츠를 실제 런에서 보여주는 장치다.
 * 처음부터 조합 재료를 한 칸에 보장하고, 시작한 재료→짝 재료→합성을
 * 일반 레벨업보다 더 강하게 우선해 세 번의 인장이 하나의 빌드 서사가 된다.
 */
export function getRelicRollPriority(world: World, upgrade: UpgradeDef): number {
  if (upgrade.fusion) return upgrade.isAvailable(world) ? 6 : 0

  let isFusionPart = false
  for (const fusion of FUSION_UPGRADES) {
    if (!isFusionContentUnlocked(world, fusion)) continue
    const requirements = fusion.fusion?.requires
    if (!requirements?.includes(upgrade.id)) continue
    isFusionPart = true
    const partner = requirements[0] === upgrade.id ? requirements[1] : requirements[0]
    if (readRank(world.upgradesTaken, partner) >= 3) return 5
  }

  const currentRank = readRank(world.upgradesTaken, upgrade.id)
  if (isFusionPart && currentRank > 0 && currentRank < upgrade.ranks.length) return 4
  if (isFusionPart) return 2
  return currentRank > 0 ? 1 : 0
}

export function isUpgradeAvailable(world: World, upgrade: UpgradeDef): boolean {
  return upgrade.isAvailable(world)
}

export function getUpgradePresentation(
  upgrade: UpgradeDef,
  taken: ReadonlySet<string>,
): UpgradePresentation {
  const currentRank = readRank(taken, upgrade.id)
  const maxRank = upgrade.ranks.length
  const nextRank = Math.min(currentRank + 1, maxRank)
  const rankDef = upgrade.ranks[nextRank - 1]!
  const fusion = upgrade.fusion !== undefined
  const legacy = upgrade.family === 'legacy'
  const awakening = !fusion && !legacy && nextRank === 3
  const rarity: UpgradeRarity = fusion
    ? 'fusion'
    : legacy
      ? 'legacy'
      : awakening
        ? 'awakening'
        : 'standard'
  // family는 카드 색·문양을 통일하는 시각 그룹이다. 이를 그대로 문구로
  // 노출하면 원거리 3택이 모두 "광학 장치"로 보여 선택지를 구분할 수 없다.
  // 화면에는 각 장비의 고유 경로명을 쓰고, 시각 그룹은 data-family로 유지한다.
  const familyLabel = upgrade.name
  const rankLabel = fusion
    ? '합성'
    : legacy
      ? maxRank === 1
        ? '전승'
        : `전승 ${romanRank(nextRank)}`
      : `RANK ${romanRank(nextRank)}`
  const name = fusion ? upgrade.name : `${upgrade.name} · ${rankDef.displayName}`
  const badges = [
    familyLabel,
    ...(upgrade.slot ? [`${upgrade.slot.toUpperCase()} 변형`] : []),
    rankLabel,
    ...(awakening ? ['각성'] : []),
  ]

  return {
    id: upgrade.id,
    name,
    pathName: rankDef.displayName,
    oneLiner: rankDef.oneLiner,
    currentRank,
    nextRank,
    maxRank,
    rankLabel,
    rarity,
    family: upgrade.family,
    familyLabel,
    ...(upgrade.slot ? { slot: upgrade.slot } : {}),
    ...(rankDef.trait ? { trait: rankDef.trait } : {}),
    badges,
  }
}

export interface UpgradeBranchPresentation {
  name: string
  oneLiner: string
}

/** 같은 fusion trait를 공유하는 Q/W 또는 Q/R도 슬롯별 고유 경로명으로 설명한다. */
export function getUpgradeBranchPresentation(
  branch: string,
  slot: SkillId,
): UpgradeBranchPresentation | null {
  for (const upgrade of UPGRADES) {
    const rank = upgrade.ranks.find((candidate) => candidate.trait === branch)
    if (!rank) continue
    return {
      name:
        upgrade.fusion?.slotDisplayNames?.[slot] ??
        rank.awakeningName ??
        rank.displayName ??
        upgrade.name,
      oneLiner: rank.oneLiner,
    }
  }
  return null
}

/**
 * 다음 랭크를 적용하고 이력을 원자적으로 기록한다.
 *
 * 같은 프레임에 중복 입력이 들어와도 Set에서 현재 랭크를 다시 읽으므로 최대
 * 랭크를 넘지 않는다. 난수나 시각을 읽지 않아 리플레이 결정론에도 영향이 없다.
 */
export function applyUpgrade(world: World, id: string): UpgradeApplication | null {
  const upgrade = getUpgrade(id)
  if (!upgrade || !upgrade.isAvailable(world)) return null

  const nextRank = readRank(world.upgradesTaken, id) + 1
  const rankDef = upgrade.ranks[nextRank - 1]
  if (!rankDef) return null

  upgrade.apply(world, rankDef.rank)
  rememberRank(world.upgradesTaken, id, nextRank)
  return {
    id,
    rank: nextRank,
    ...(rankDef.trait ? { trait: rankDef.trait } : {}),
  }
}

/**
 * 정예 전리품은 짧은 런에서 각성까지 도달하게 같은 장비를 최대 두 번 새긴다.
 * 합성처럼 최대 랭크가 1인 카드는 첫 적용 뒤 자연스럽게 멈춘다.
 */
export function applyUpgradeBurst(
  world: World,
  id: string,
  count = 2,
): UpgradeApplication[] {
  const applied: UpgradeApplication[] = []
  for (let i = 0; i < count; i++) {
    const result = applyUpgrade(world, id)
    if (!result) break
    applied.push(result)
  }
  return applied
}

/**
 * Apply an elite relic burst and immediately seal a fusion when this burst
 * completes its second ingredient. This keeps the third elite beat capable of
 * delivering the run's headline evolution instead of stopping one draft short.
 */
export function getRelicUpgradeBurstCount(world: World, id: string): number {
  const upgrade = getUpgrade(id)
  if (upgrade?.ranks.length === 1) return 1
  const completesRecipe = FUSION_UPGRADES.some((fusion) => {
    if (!isFusionContentUnlocked(world, fusion)) return false
    const requirements = fusion.fusion?.requires
    if (!requirements?.includes(id)) return false
    const partner = requirements[0] === id ? requirements[1] : requirements[0]
    return readRank(world.upgradesTaken, partner) >= 3
  })
  return completesRecipe ? 3 : 2
}

/** Fusion that will be completed by taking this relic card, before mutating the world. */
export function getRelicFusionPreview(
  world: World,
  id: string,
): UpgradeDef | undefined {
  const upgrade = getUpgrade(id)
  if (!upgrade) return undefined
  const projectedRank = Math.min(
    upgrade.ranks.length,
    readRank(world.upgradesTaken, id) + getRelicUpgradeBurstCount(world, id),
  )
  return FUSION_UPGRADES.find((fusion) => {
    if (!isFusionContentUnlocked(world, fusion)) return false
    if (world.upgradesTaken.has(fusion.id)) return false
    const requirements = fusion.fusion?.requires
    if (!requirements?.includes(id)) return false
    return requirements.every((requirement) =>
      requirement === id
        ? projectedRank >= 3
        : readRank(world.upgradesTaken, requirement) >= 3,
    )
  })
}

export function applyRelicUpgrade(world: World, id: string): UpgradeApplication[] {
  const completedFusion = getRelicFusionPreview(world, id)
  const applied = applyUpgradeBurst(world, id, getRelicUpgradeBurstCount(world, id))
  if (completedFusion) {
    const fusion = applyUpgrade(world, completedFusion.id)
    if (fusion) applied.push(fusion)
  }
  return applied
}

function romanRank(rank: number): string {
  if (rank === 1) return 'I'
  if (rank === 2) return 'II'
  return 'III'
}
