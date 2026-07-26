/**
 * 스킬 슬롯 비트마스크.
 *
 * 이동이 마우스 전용이 되면서 WASD가 풀렸고, W 충돌이 사라졌다.
 * 그래서 슬롯 이름을 키 그대로 쓴다 — 롤/이터널 리턴 문법에서 QWER·DF는
 * 곧 도메인 언어다. 코드·UI·플레이어의 머릿속이 같은 이름을 쓰게 한다.
 */
export const SKILL_Q = 1 << 0
export const SKILL_W = 1 << 1
export const SKILL_E = 1 << 2
export const SKILL_R = 1 << 3
export const SKILL_D = 1 << 4
export const SKILL_F = 1 << 5

export const SKILL_IDS = ['q', 'w', 'e', 'r', 'd', 'f'] as const
export type SkillId = (typeof SKILL_IDS)[number]

export const SKILL_BIT: Record<SkillId, number> = {
  q: SKILL_Q,
  w: SKILL_W,
  e: SKILL_E,
  r: SKILL_R,
  d: SKILL_D, // 회복 — 시작부터 보유
  f: SKILL_F, // 점멸 — 시작부터 보유
}

/**
 * 플레이어가 해금 순서를 고르는 주력 스킬.
 * R(궁극기)은 Lv8 확정, D/F(소환사 주문)는 시작부터라 여기 없다.
 */
export const CHOOSABLE_SKILL_IDS = ['q', 'w', 'e'] as const satisfies readonly SkillId[]

export interface SkillRuntime {
  unlocked: boolean
  /** 강화 분기를 탄 횟수. 0 = 해금 직후. */
  rank: number
  /**
   * 선택한 강화 분기 id. 분기는 서로 배타적이라 하나만 갖는다.
   * null이면 아직 분기를 타지 않았다.
   */
  branch: string | null
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
    branch: null,
    cooldown: 0,
    maxCooldown: 1,
  })
  return {
    q: make(),
    w: make(),
    e: make(),
    r: make(),
    d: make(),
    f: make(),
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
  s.branch = null
  s.maxCooldown = cooldown
  // 해금하자마자 쓸 수 있어야 한다. 새 장난감을 쥐고 기다리게 하지 않는다.
  s.cooldown = 0
}

/** 아직 해금되지 않은, 선택 가능한 주력 스킬 목록. */
export function lockedChoosableSkills(book: SkillBook): SkillId[] {
  return CHOOSABLE_SKILL_IDS.filter((id) => !book[id].unlocked)
}

export function unlockedCount(book: SkillBook): number {
  return SKILL_IDS.reduce((n, id) => n + (book[id].unlocked ? 1 : 0), 0)
}

/** 쿨다운 진행률 0..1. UI의 부채꼴 게이지가 이 값을 쓴다. */
export function cooldownProgress(book: SkillBook, id: SkillId): number {
  const s = book[id]
  if (!s.unlocked || s.maxCooldown <= 0) return 0
  return s.cooldown <= 0 ? 0 : s.cooldown / s.maxCooldown
}
