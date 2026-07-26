/**
 * 스킬 슬롯 비트마스크.
 *
 * 키 이름이 아니라 "역할"로 정의한다. WASD 이동의 W와 MOBA의 W가 충돌하므로
 * 실제 바인딩은 Q / Space / E / R 이고, 그 매핑은 src/input.ts 가 전담한다.
 * 시뮬은 어떤 키가 눌렸는지 알 필요도, 알아서도 안 된다.
 */
export const SKILL_PRIMARY = 1 << 0 // Q     — 주력기
export const SKILL_DASH = 1 << 1 // Space — 대시
export const SKILL_AREA = 1 << 2 // E     — 광역기
export const SKILL_ULT = 1 << 3 // R     — 궁극기 (Lv8 확정)

/**
 * 스킬 슬롯.
 *
 * 키 바인딩은 스킬마다 "고정"이다. 해금 순서만 플레이어가 고른다.
 * 획득 순서대로 슬롯을 채우면 같은 스킬이 판마다 다른 키에 붙어
 * 머슬메모리가 무너진다. MOBA에서 R이 항상 궁극기인 것과 같은 이유다.
 */
export const SKILL_IDS = ['primary', 'dash', 'area', 'ult'] as const
export type SkillId = (typeof SKILL_IDS)[number]

/** 슬롯 → 입력 비트마스크. src/input.ts 의 바인딩과 짝이 맞는다. */
export const SKILL_BIT: Record<SkillId, number> = {
  primary: SKILL_PRIMARY, // Q
  dash: SKILL_DASH, // Space
  area: SKILL_AREA, // E
  ult: SKILL_ULT, // R
}

/** 플레이어가 해금 순서를 고를 수 있는 스킬. 궁극기(ult)는 Lv8 확정이라 제외된다. */
export const CHOOSABLE_SKILL_IDS = ['primary', 'dash', 'area'] as const satisfies readonly SkillId[]

export interface SkillRuntime {
  unlocked: boolean
  /** 강화 횟수. 0 = 해금 직후. */
  rank: number
  /** 남은 쿨다운(초). 0이면 사용 가능. */
  cooldown: number
  /** 최대 쿨다운(초). 강화로 줄어들 수 있어 런타임에 보관한다. */
  maxCooldown: number
}

export type SkillBook = Record<SkillId, SkillRuntime>

export function createSkillBook(): SkillBook {
  const make = (): SkillRuntime => ({
    unlocked: false,
    rank: 0,
    cooldown: 0,
    // 실제 값은 해금 시 콘텐츠 정의에서 채운다.
    maxCooldown: 1,
  })
  return {
    primary: make(),
    dash: make(),
    area: make(),
    ult: make(),
  }
}

/** 쿨다운을 한 틱 진행시킨다. */
export function tickSkills(book: SkillBook, dt: number): void {
  for (const id of SKILL_IDS) {
    const s = book[id]
    if (s.cooldown > 0) {
      s.cooldown -= dt
      if (s.cooldown < 0) s.cooldown = 0
    }
  }
}

export function isReady(book: SkillBook, id: SkillId): boolean {
  const s = book[id]
  return s.unlocked && s.cooldown <= 0
}

/**
 * 사용 가능하면 쿨다운을 걸고 true를 반환한다.
 * 실제 효과 적용은 호출부(스킬별 로직)가 책임진다.
 */
export function consumeCooldown(book: SkillBook, id: SkillId): boolean {
  if (!isReady(book, id)) return false
  const s = book[id]
  s.cooldown = s.maxCooldown
  return true
}

export function unlockSkill(book: SkillBook, id: SkillId, cooldown: number): void {
  const s = book[id]
  s.unlocked = true
  s.rank = 0
  s.maxCooldown = cooldown
  // 해금하자마자 쓸 수 있어야 한다. 새 장난감을 손에 쥐고 기다리게 하지 않는다.
  s.cooldown = 0
}

/** 아직 해금되지 않은, 선택 가능한 스킬 목록. */
export function lockedChoosableSkills(book: SkillBook): SkillId[] {
  return CHOOSABLE_SKILL_IDS.filter((id) => !book[id].unlocked)
}

export function unlockedCount(book: SkillBook): number {
  return SKILL_IDS.reduce((n, id) => n + (book[id].unlocked ? 1 : 0), 0)
}
