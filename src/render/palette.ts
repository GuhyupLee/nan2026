import type { PlayerClass } from '../sim/types.ts'

/**
 * 렌더 전용 의미 색상.
 *
 * 색을 사용하는 쪽에서는 RGB 값이나 색 이름 대신 소유권과 게임플레이 의미를
 * 고른다. 플레이어 소유 효과는 CLASS_COLORS, 피해야 하는 적 효과는
 * DANGER_COLORS를 사용해야 한다.
 */
export const CLASS_COLORS = {
  ranged: 0x4dd0ff,
  melee: 0xff5a6e,
} as const satisfies Record<PlayerClass, number>

export const DANGER_COLORS = {
  telegraph: 0xff4a2e,
  boss: 0xf25a8c,
  bossZone: 0xff4f86,
  bossCharge: 0xffa146,
  brute: 0xff9a61,
  chargeLaneDeep: 0x8f0913,
  chargeLaneHot: 0xff5c24,
  ember: 0xff6a2a,
  surge: [0xff7548, 0xffad43, 0xb76cff],
} as const

export const REWARD_COLORS = {
  gold: 0xffd978,
  health: 0x7df0a0,
  silver: 0xeaf2ff,
  arcane: 0x8f6cff,
  elite: 0xe8bd61,
} as const
