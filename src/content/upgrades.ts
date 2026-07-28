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
export type UpgradeFamily = 'optical-device' | 'sword-art' | 'fusion'
export type UpgradeRarity = 'standard' | 'awakening' | 'fusion'

export interface UpgradeRankDef {
  rank: UpgradeRank
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
  isAvailable?: (world: World) => boolean
  effects: readonly ((world: World) => void)[]
}

export interface UpgradePresentation {
  id: string
  name: string
  oneLiner: string
  currentRank: number
  nextRank: number
  maxRank: number
  rankLabel: string
  rarity: UpgradeRarity
  family: UpgradeFamily
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
  if (!blueprint.fusion && blueprint.ranks.length !== 3) {
    throw new Error(`일반 강화 ${blueprint.id}는 I·II·III 세 랭크가 필요합니다.`)
  }
  if (blueprint.ranks.some((rank, index) => rank.rank !== index + 1)) {
    throw new Error(`강화 ${blueprint.id}의 랭크 순서가 올바르지 않습니다.`)
  }

  const available = (world: World): boolean => {
    if (!blueprint.classFilter.includes(world.playerClass)) return false
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
      { rank: 1, oneLiner: '평타 관통 +1' },
      { rank: 2, oneLiner: '공격 피해 +16% (평타·QWER)' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: '평타 공격 간격 -14%' },
      { rank: 2, oneLiner: '평타 공격 간격 -14%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: '평타 사거리 +22%' },
      { rank: 2, oneLiner: '평타 사거리 +18%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: '최대 체력 +24, 즉시 24 회복' },
      { rank: 2, oneLiner: '받는 피해 -10%' },
      {
        rank: 3,
        oneLiner: '치명상을 한 번 막고 1.2초 동안 피해를 받지 않습니다.',
        trait: 'photon-barrier',
        awakeningName: '비상 점등',
      },
    ],
    effects: [
      (w) => {
        w.stats.maxHp += 24
        w.player.hp = Math.min(w.stats.maxHp, w.player.hp + 24)
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
      { rank: 1, oneLiner: 'Q 재사용 대기시간 -12%' },
      { rank: 2, oneLiner: 'Q 재사용 대기시간 -12%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: 'W 재사용 대기시간 -10%' },
      { rank: 2, oneLiner: 'W 재사용 대기시간 -10%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: 'E 재사용 대기시간 -10%' },
      { rank: 2, oneLiner: 'E 재사용 대기시간 -10%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: 'R 재사용 대기시간 -8%' },
      { rank: 2, oneLiner: 'R 재사용 대기시간 -8%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: '공격 피해 +18% (평타·QWER)' },
      { rank: 2, oneLiner: '공격 피해 +15% (평타·QWER)' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: '이동 속도 +10%' },
      { rank: 2, oneLiner: '평타 공격 간격 -10%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: '받는 피해 -12%' },
      { rank: 2, oneLiner: '최대 체력 +22, 즉시 22 회복' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: '회복(D) 회복량 +20' },
      { rank: 2, oneLiner: '회복(D) 재사용 대기시간 -18%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: 'Q 재사용 대기시간 -12%' },
      { rank: 2, oneLiner: 'Q 재사용 대기시간 -12%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: 'W 재사용 대기시간 -10%' },
      { rank: 2, oneLiner: 'W 재사용 대기시간 -10%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: 'E 재사용 대기시간 -10%' },
      { rank: 2, oneLiner: 'E 재사용 대기시간 -10%' },
      {
        rank: 3,
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
      { rank: 1, oneLiner: 'R 재사용 대기시간 -8%' },
      { rank: 2, oneLiner: 'R 재사용 대기시간 -8%' },
      {
        rank: 3,
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

const FUSION_UPGRADES: readonly UpgradeDef[] = [
  defineUpgrade({
    id: 'singularity-interferometer',
    name: '사건지평 간섭계',
    glyph: '✦',
    weight: 24,
    classFilter: RANGED,
    family: 'fusion',
    slot: 'q',
    fusion: { requires: ['orbit-lens', 'gravity-prism'] },
    ranks: [
      {
        rank: 1,
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
    fusion: { requires: ['iai-scroll', 'fullmoon-form'] },
    ranks: [
      {
        rank: 1,
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

export const UPGRADES: readonly UpgradeDef[] = [
  ...RANGED_UPGRADES,
  ...MELEE_UPGRADES,
  ...FUSION_UPGRADES,
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
  const awakening = !fusion && nextRank === 3
  const rarity: UpgradeRarity = fusion ? 'fusion' : awakening ? 'awakening' : 'standard'
  const familyLabel =
    upgrade.family === 'optical-device'
      ? '광학 장치'
      : upgrade.family === 'sword-art'
        ? '검술 유파'
        : '각성 합성'
  const rankLabel = fusion ? '합성' : `RANK ${romanRank(nextRank)}`
  const name =
    awakening && rankDef.awakeningName
      ? `${upgrade.name} · ${rankDef.awakeningName}`
      : upgrade.name
  const badges = [
    familyLabel,
    ...(upgrade.slot ? [`${upgrade.slot.toUpperCase()} 변형`] : []),
    rankLabel,
    ...(awakening ? ['각성'] : []),
  ]

  return {
    id: upgrade.id,
    name,
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
  const completesRecipe = FUSION_UPGRADES.some((fusion) => {
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
