import type { World } from '../sim/types.ts'

/**
 * 강화 카드 풀.
 *
 * 전부 world.stats만 건드린다 — 그게 stats를 도입한 이유다.
 * 상수를 직접 바꿀 수 없으니 강화는 존재할 수 없었다.
 *
 * 5분에 강화 선택은 5~6번뿐이다. 그래서 미미한 +5% 같은 카드는 넣지 않는다.
 * 한 장 한 장이 체감되어야 선택이 의미를 갖는다.
 */

export interface UpgradeDef {
  id: string
  name: string
  /** 카드에 뜨는 한 줄. 무엇이 얼마나 좋아지는지 숫자로 말한다. */
  oneLiner: string
  /** 임시 아이콘. 나중에 생성 아이콘으로 교체된다. */
  glyph: string
  /** 뽑기 가중치. 클수록 자주 등장. */
  weight: number
  /** 지금 뽑을 수 있는가. 전제 조건이 있으면 여기서 막는다. */
  isAvailable?: (world: World) => boolean
  apply: (world: World) => void
}

export const UPGRADES: readonly UpgradeDef[] = [
  {
    id: 'honed-edge',
    name: '예리함',
    oneLiner: '공격력 +20%',
    glyph: '◆',
    weight: 10,
    apply: (w) => {
      w.stats.atkDamageMul *= 1.2
    },
  },
  {
    id: 'quickened',
    name: '속사',
    oneLiner: '공격 속도 +18%',
    glyph: '≫',
    weight: 10,
    apply: (w) => {
      w.stats.atkIntervalMul *= 0.85
    },
  },
  {
    id: 'piercing',
    name: '관통 강화',
    oneLiner: '한 발이 적 1명을 더 뚫는다',
    glyph: '➤',
    weight: 8,
    apply: (w) => {
      w.stats.atkPierce += 1
    },
  },
  {
    id: 'long-sight',
    name: '시야 확장',
    oneLiner: '공격 사거리 +25%',
    glyph: '◎',
    weight: 7,
    apply: (w) => {
      w.stats.atkRange *= 1.25
    },
  },
  {
    id: 'vital-core',
    name: '활력의 핵',
    oneLiner: '최대 체력 +30, 즉시 30 회복',
    glyph: '✚',
    weight: 9,
    apply: (w) => {
      w.stats.maxHp += 30
      w.player.hp = Math.min(w.stats.maxHp, w.player.hp + 30)
    },
  },
  {
    id: 'warpath',
    name: '질주',
    oneLiner: '이동 속도 +12%',
    glyph: '⇢',
    weight: 8,
    apply: (w) => {
      w.stats.speed *= 1.12
    },
  },
  {
    id: 'iron-skin',
    name: '강철 피부',
    oneLiner: '받는 피해 -15%',
    glyph: '⛨',
    weight: 8,
    apply: (w) => {
      w.stats.damageTakenMul *= 0.85
    },
  },
  {
    id: 'overdrive',
    name: '과부하',
    oneLiner: '모든 스킬 쿨다운 -18%',
    glyph: '↻',
    weight: 7,
    apply: (w) => {
      w.stats.cooldownMul *= 0.82
      // 이미 해금된 스킬의 최대 쿨다운도 같이 줄여야 체감된다.
      for (const id of ['q', 'w', 'e', 'r', 'd', 'f'] as const) {
        w.skills[id].maxCooldown *= 0.82
      }
    },
  },
  {
    id: 'second-wind',
    name: '재생',
    oneLiner: '회복(D) 회복량 +25',
    glyph: '✜',
    weight: 6,
    apply: (w) => {
      w.stats.healAmount += 25
    },
  },
  {
    id: 'swift-mend',
    name: '신속 치유',
    oneLiner: '회복(D) 쿨다운 -25%',
    glyph: '⟳',
    weight: 5,
    apply: (w) => {
      w.stats.healCooldown *= 0.75
      w.skills.d.maxCooldown *= 0.75
    },
  },
  {
    id: 'blink-shock',
    name: '도약',
    oneLiner: '점멸(F) 사거리 +4',
    glyph: '⚡',
    weight: 5,
    apply: (w) => {
      w.stats.flashRange += 4
    },
  },
  {
    id: 'blink-haste',
    name: '점멸 연마',
    oneLiner: '점멸(F) 쿨다운 -30%',
    glyph: '⟡',
    weight: 5,
    apply: (w) => {
      w.stats.flashCooldown *= 0.7
      w.skills.f.maxCooldown *= 0.7
    },
  },
  {
    id: 'berserk',
    name: '광폭화',
    oneLiner: '공격력 +40%, 받는 피해 +15%',
    glyph: '✖',
    weight: 4,
    // 이미 물러터진 상태에서 뽑으면 그냥 죽는다. 여유가 있을 때만 제시한다.
    isAvailable: (w) => w.player.hp / w.stats.maxHp > 0.5,
    apply: (w) => {
      w.stats.atkDamageMul *= 1.4
      w.stats.damageTakenMul *= 1.15
    },
  },
]

const BY_ID = new Map(UPGRADES.map((u) => [u.id, u]))

export function getUpgrade(id: string): UpgradeDef | undefined {
  return BY_ID.get(id)
}
