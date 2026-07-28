import type { SkillId } from '../sim/skills.ts'
import type { PlayerClass } from '../sim/types.ts'

/**
 * 스킬 표시 정보.
 *
 * 시뮬은 수치만 알고 이름·문구는 여기 있다. 레벨업 카드와 스킬바가 읽는다.
 *
 * 슬롯 역할 규약은 두 클래스 공통이다 — Q 저쿨 주력기 / W 이동기 /
 * E 광역기 / R 궁극기. 클래스가 달라도 "W는 언제나 탈출"이 되어
 * 두 번째 캐릭터를 배우는 비용이 0이 된다.
 */
export interface SkillDef {
  id: SkillId
  key: string
  name: string
  /** 【단일】【생존】【광역】【궁극】 */
  tag: string
  /** 카드에 뜨는 한 줄. 결과를 말하지 원리를 말하지 않는다. */
  oneLiner: string
  /** 툴팁에 표시할 기본 수치와 판정 범위. */
  detail: string
  /** 공격력·스킬 랭크 배율을 적용하기 전 기본 피해 묶음. */
  damage: readonly number[]
  damagePattern?:
    | 'single'
    | 'zone-12'
    | 'burst-zone-12'
    | 'first-following'
    | 'path-landing'
    | 'five-finisher'
  /** public 기준 스킬 아이콘 경로. */
  icon: string
  glyph: string
  cooldown: number
}

/** 일현(日弦) — 먼 지점을 낙점하고 마지막에 전장을 가르는 클래스다. */
const RANGED: Record<string, SkillDef> = {
  q: {
    id: 'q',
    key: 'Q',
    name: '낙광',
    tag: '광역',
    oneLiner: '조준점에 빛을 떨어뜨려 한 무리를 붙잡고 점등한다',
    detail: '사거리 14 · 반경 3.6 · 피해 135 · 0.75초 속박 · 점등 4초',
    damage: [135],
    damagePattern: 'single',
    icon: 'art/skills/ranged-q.webp',
    glyph: '⟶',
    cooldown: 3.5,
  },
  w: {
    id: 'w',
    key: 'W',
    name: '굴절',
    tag: '생존',
    oneLiner: '커서 반대쪽으로 도약하고, 있던 자리에 적을 모으는 렌즈를 남긴다',
    detail: '8 후퇴 · 0.55초 무적 · 반경 5.5 견인 · 3초 렌즈(7 × 12회)',
    damage: [7],
    damagePattern: 'zone-12',
    icon: 'art/skills/ranged-w.webp',
    glyph: '⤺',
    cooldown: 10,
  },
  e: {
    id: 'e',
    key: 'E',
    name: '분광',
    tag: '광역',
    oneLiner: '빛덩이를 던져 터뜨린다. 사방으로 밀려나고 그 자리가 3초간 느려진다',
    detail: '사거리 14 · 0.3초 비행 · 반경 6 피해 160 · 3초 둔화장(6 × 12회)',
    damage: [160, 6],
    damagePattern: 'burst-zone-12',
    icon: 'art/skills/ranged-e.webp',
    glyph: '✷',
    cooldown: 14,
  },
  r: {
    id: 'r',
    key: 'R',
    name: '일현',
    tag: '궁극',
    oneLiner: '화면 끝에서 끝까지. 직선 위의 모든 것이 사라진다',
    detail: '전장 관통 · 폭 6.8 · 피해 1,700 · 시전 0.9초 무적 · 점등 5초',
    damage: [1700],
    damagePattern: 'single',
    icon: 'art/skills/ranged-r.webp',
    glyph: '☀',
    cooldown: 36,
  },
}

/** 월아(月牙) — 달의 이빨. 전부 원이다. */
const MELEE: Record<string, SkillDef> = {
  q: {
    id: 'q',
    key: 'Q',
    name: '인월참',
    tag: '관통',
    oneLiner: '앞의 적을 칼끝 거리로 끌어다 꿰뚫는다. 붙은 적은 떼어낸다',
    detail: '사거리 5.5 · 폭 3.6 · 선두 피해 96 / 후속 피해 52 · 점등 4초',
    damage: [96, 52],
    damagePattern: 'first-following',
    icon: 'art/skills/melee-q.webp',
    glyph: '⟡',
    cooldown: 3.5,
  },
  w: {
    id: 'w',
    key: 'W',
    name: '이합참',
    tag: '생존',
    oneLiner: '가려는 쪽으로 꿰뚫고 나간다. 그동안 무적이고, 내린 자리가 열린다',
    detail: '거리 7 · 경로 피해 60 + 착지 피해 60 · 돌진 중 무적',
    damage: [60, 60],
    damagePattern: 'path-landing',
    icon: 'art/skills/melee-w.webp',
    glyph: '⇉',
    cooldown: 12,
  },
  e: {
    id: 'e',
    key: 'E',
    name: '월륜',
    tag: '광역',
    oneLiner: '주변을 한 겹 밀어낸 뒤 끌어모아 통째로 벤다',
    detail: '반경 9 집결 · 반경 6 피해 140 · 점등 4초',
    damage: [140],
    damagePattern: 'single',
    icon: 'art/skills/melee-e.webp',
    glyph: '◯',
    cooldown: 16,
  },
  r: {
    id: 'r',
    key: 'R',
    name: '만월난무',
    tag: '궁극',
    oneLiner: '사라져서 여섯 번 벤다. 마지막에 크게 회복한다',
    detail: '반경 4.6 피해 260 × 5 · 마지막 반경 8.5 피해 430 · 회복 60',
    damage: [260, 430],
    damagePattern: 'five-finisher',
    icon: 'art/skills/melee-r.webp',
    glyph: '☾',
    cooldown: 45,
  },
}

/** 두 클래스 공용 소환사 주문. */
export const SUMMONER: Record<string, SkillDef> = {
  d: {
    id: 'd',
    key: 'D',
    name: '회복',
    tag: '회복',
    oneLiner: '즉시 체력을 회복하고 잠시 빨라진다',
    detail: '체력 42 회복 · 1.6초 동안 이동 속도 +45%',
    damage: [],
    icon: 'art/skills/heal.webp',
    glyph: '✚',
    cooldown: 45,
  },
  f: {
    id: 'f',
    key: 'F',
    name: '점멸',
    tag: '이동',
    oneLiner: '커서 쪽으로 순간이동한다',
    detail: '최대 거리 8 · 경기장 경계 안으로 이동',
    damage: [],
    icon: 'art/skills/flash.webp',
    glyph: '⚡',
    cooldown: 40,
  },
}

export function getSkillDef(cls: PlayerClass, id: SkillId): SkillDef | undefined {
  if (id === 'd' || id === 'f') return SUMMONER[id]
  return (cls === 'melee' ? MELEE : RANGED)[id]
}

/** 클래스의 QWER 전체. 스킬바 라벨이 쓴다. */
export function getClassSkills(cls: PlayerClass): SkillDef[] {
  const t = cls === 'melee' ? MELEE : RANGED
  return ['q', 'w', 'e', 'r'].map((k) => t[k]!)
}

function formatDamage(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded)
    ? rounded.toLocaleString('ko-KR')
    : rounded.toFixed(1)
}

/**
 * UI가 시뮬의 기본 피해를 복제하지 않도록 이미 계산한 배율만 받아 문구를 만든다.
 */
export function getSkillDamageSummary(
  cls: PlayerClass,
  id: SkillId,
  damageMultiplier = 1,
): string | null {
  const def = getSkillDef(cls, id)
  if (!def || def.damage.length === 0) return null
  const values = def.damage.map((value) => value * damageMultiplier)
  const value = (index: number): string => formatDamage(values[index] ?? 0)

  switch (def.damagePattern) {
    case 'zone-12':
      return `${value(0)} × 12회`
    case 'burst-zone-12':
      return `${value(0)} + ${value(1)} × 12회`
    case 'first-following':
      return `선두 ${value(0)} / 후속 ${value(1)}`
    case 'path-landing':
      return `경로 ${value(0)} + 착지 ${value(1)}`
    case 'five-finisher':
      return `${value(0)} × 5 + ${value(1)}`
    default:
      return value(0)
  }
}

export interface DamageTraitMeta {
  trait: string
  playerClass: PlayerClass
  /** 이 성질이 실제 추가 피해를 만드는 슬롯. */
  affectsSlots: readonly (SkillId | 'attack')[]
  label: string
}

/**
 * 각성·합성의 추가 피해가 어느 슬롯에 붙는지 UI와 검증 코드가 함께 읽는다.
 * 수치 계산은 아래 getSkillDamageBreakdown 한 곳에서 맡는다.
 */
export const DAMAGE_TRAIT_META: readonly DamageTraitMeta[] = [
  {
    trait: 'interference-burst',
    playerClass: 'ranged',
    affectsSlots: ['attack'],
    label: '종단 간섭 폭발',
  },
  {
    trait: 'auxiliary-beam',
    playerClass: 'ranged',
    affectsSlots: ['attack'],
    label: '보조 광선',
  },
  {
    trait: 'supernova-chain',
    playerClass: 'ranged',
    affectsSlots: ['attack'],
    label: '연쇄 초신성',
  },
  {
    trait: 'utility-overdrive',
    playerClass: 'ranged',
    affectsSlots: ['attack', 'q', 'w', 'e', 'r', 'f'],
    label: '잔광 과출력',
  },
  { trait: 'orbital-prism', playerClass: 'ranged', affectsSlots: ['q'], label: '귀환 낙광' },
  {
    trait: 'singularity-interference',
    playerClass: 'ranged',
    affectsSlots: ['q', 'w'],
    label: '특이점 간섭',
  },
  { trait: 'double-collapse', playerClass: 'ranged', affectsSlots: ['w'], label: '이중 붕괴' },
  {
    trait: 'afterimage-aperture',
    playerClass: 'ranged',
    affectsSlots: ['e'],
    label: '잔광 통로',
  },
  { trait: 'heliostat-chain', playerClass: 'ranged', affectsSlots: ['r'], label: '굴절 광선' },
  {
    trait: 'returning-draw-cut',
    playerClass: 'melee',
    affectsSlots: ['q'],
    label: '귀환 참격',
  },
  {
    trait: 'decapitation',
    playerClass: 'melee',
    affectsSlots: ['attack'],
    label: '참수',
  },
  {
    trait: 'backstrike',
    playerClass: 'melee',
    affectsSlots: ['attack'],
    label: '월영 후면 참격',
  },
  {
    trait: 'gem-double-strike',
    playerClass: 'melee',
    affectsSlots: ['attack'],
    label: '보석 포식 연격',
  },
  {
    trait: 'execution-spread',
    playerClass: 'melee',
    affectsSlots: ['attack'],
    label: '연쇄 처형',
  },
  {
    trait: 'returning-sheath',
    playerClass: 'melee',
    affectsSlots: ['w'],
    label: '귀환 납도',
  },
  {
    trait: 'afterimage-step',
    playerClass: 'melee',
    affectsSlots: ['w', 'f'],
    label: '무영보 잔상',
  },
  { trait: 'mirror-counter', playerClass: 'melee', affectsSlots: ['e'], label: '반격 참격' },
  {
    trait: 'fullmoon-domain',
    playerClass: 'melee',
    affectsSlots: ['r'],
    label: '만월 결계',
  },
  {
    trait: 'eclipse-sword-domain',
    playerClass: 'melee',
    affectsSlots: ['q', 'r'],
    label: '일식 검결',
  },
] as const

export interface SkillDamageContext {
  /** 스킬 랭크와 전역 공격 피해 배율을 모두 곱한 값. */
  damageMultiplier?: number
  /** atkDamageMul까지 적용된 현재 평타 공격력. 무영보가 이 값을 쓴다. */
  attackDamage?: number
  hasTrait?: (trait: string) => boolean
}

/**
 * 기본 피해와 활성 각성·합성의 조건부 추가타를 한 줄씩 정직하게 표시한다.
 * 서로 대체하는 branch가 아니라 획득 trait를 읽으므로 합성 뒤에도 유지되는
 * 선행 각성 피해까지 숨기지 않는다.
 */
export function getSkillDamageBreakdown(
  cls: PlayerClass,
  id: SkillId,
  context: SkillDamageContext = {},
): string | null {
  const multiplier = context.damageMultiplier ?? 1
  const attackDamage = context.attackDamage ?? 0
  const has = context.hasTrait ?? (() => false)
  const base = getSkillDamageSummary(cls, id, multiplier)
  const extras: string[] = []
  const skill = (value: number): string => formatDamage(value * multiplier)
  const attack = (value: number): string => formatDamage(value * attackDamage)

  if (cls === 'ranged') {
    if (id === 'q') {
      if (has('orbital-prism')) extras.push(`귀환 낙광 ${skill(135 * 0.55)}`)
      if (has('singularity-interference')) {
        extras.push(`특이점 ${skill(135 * 0.2)} × 4회`)
      }
    } else if (
      id === 'w' &&
      (has('double-collapse') || has('singularity-interference'))
    ) {
      extras.push(`중심 폭발 ${skill(7 * 12 * 0.45)}`)
    } else if (id === 'e' && has('afterimage-aperture')) {
      extras.push(`경로 잔광 ${skill(160 * 0.35)}`)
    } else if (id === 'r' && has('heliostat-chain')) {
      extras.push(`굴절 대상당 ${skill(1700 * 0.25)}`)
    }
  } else {
    if (
      id === 'q' &&
      (has('returning-draw-cut') || has('eclipse-sword-domain'))
    ) {
      extras.push(`귀환 참격 ${skill(96 * 0.55)}`)
    } else if (id === 'w') {
      if (has('returning-sheath')) extras.push(`귀환 납도 ${skill(60 * 0.55)}`)
      if (has('afterimage-step')) extras.push(`무영보 잔상 ${attack(0.65)}`)
    } else if (id === 'e' && has('mirror-counter')) {
      extras.push(`반격 참격 ${skill(140 * 0.7)}`)
    } else if (id === 'r') {
      if (has('eclipse-sword-domain')) {
        extras.push(
          `교차 발도 ${skill(260 * 0.35)} × 5 + ${skill(430 * 0.35)}`,
        )
      }
      if (has('fullmoon-domain') || has('eclipse-sword-domain')) {
        extras.push(`만월 결계 ${skill(430 * 0.08)} × 8회`)
      }
    } else if (id === 'f' && has('afterimage-step')) {
      extras.push(`무영보 잔상 ${attack(0.65)}`)
    }
  }

  if (extras.length === 0) return base
  return [base ? `기본 ${base}` : null, ...extras].filter(Boolean).join(' · ')
}
