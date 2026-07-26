import type { SkillId } from '../sim/skills.ts'
import type { PlayerClass } from '../sim/types.ts'

/**
 * 스킬 표시 정보.
 *
 * 시뮬은 수치만 알고 이름·문구는 여기 있다. 레벨업 카드와 스킬바가 읽는다.
 *
 * 슬롯 역할 규약은 두 클래스 공통이다 — Q 기본공격기 / W 이동기 /
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
  glyph: string
  cooldown: number
}

/** 일현(日弦) — 해의 활시위. 전부 직선이다. */
const RANGED: Record<string, SkillDef> = {
  q: {
    id: 'q',
    key: 'Q',
    name: '섬광',
    tag: '단일',
    oneLiner: '적들을 꿰뚫어 좌우로 갈라내고, 맨 앞 하나를 못 박는다',
    glyph: '⟶',
    cooldown: 3.5,
  },
  w: {
    id: 'w',
    key: 'W',
    name: '굴절',
    tag: '생존',
    oneLiner: '커서 반대쪽으로 도약하고, 있던 자리에 적을 밀어내는 빛기둥을 남긴다',
    glyph: '⤺',
    cooldown: 12,
  },
  e: {
    id: 'e',
    key: 'E',
    name: '분광',
    tag: '광역',
    oneLiner: '빛덩이를 던져 터뜨린다. 사방으로 밀려나고 그 자리가 3초간 느려진다',
    glyph: '✷',
    cooldown: 14,
  },
  r: {
    id: 'r',
    key: 'R',
    name: '일현',
    tag: '궁극',
    oneLiner: '화면 끝에서 끝까지. 직선 위의 모든 것이 사라진다',
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
    tag: '단일',
    oneLiner: '앞의 적을 칼끝 거리로 끌어다 꿰뚫는다. 붙은 적은 떼어낸다',
    glyph: '⟡',
    cooldown: 3.5,
  },
  w: {
    id: 'w',
    key: 'W',
    name: '이합참',
    tag: '생존',
    oneLiner: '가려는 쪽으로 꿰뚫고 나간다. 그동안 무적이고, 내린 자리가 열린다',
    glyph: '⇉',
    cooldown: 12,
  },
  e: {
    id: 'e',
    key: 'E',
    name: '월륜',
    tag: '광역',
    oneLiner: '주변을 한 겹 밀어낸 뒤 끌어모아 통째로 벤다',
    glyph: '◯',
    cooldown: 16,
  },
  r: {
    id: 'r',
    key: 'R',
    name: '만월난무',
    tag: '궁극',
    oneLiner: '사라져서 여섯 번 벤다. 마지막에 크게 회복한다',
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
    glyph: '✚',
    cooldown: 45,
  },
  f: {
    id: 'f',
    key: 'F',
    name: '점멸',
    tag: '이동',
    oneLiner: '커서 쪽으로 순간이동한다',
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
