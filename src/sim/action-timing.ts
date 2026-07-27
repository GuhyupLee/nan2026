import type { PlayerActionKind, PlayerClass } from './types.ts'

export interface PlayerActionTiming {
  /** 애니메이션 전체 길이. 이 시각까지 다음 평타·QWER를 받지 않는다. */
  duration: number
  /** 시작 후 실제 판정이 발생하는 시각. 애니메이션의 타격 포즈와 맞춘다. */
  impact: number
}

/**
 * 플레이어 전투 동작의 단일 타이밍 표.
 *
 * 렌더 애니메이션과 시뮬 판정이 같은 값을 공유해야 모션 중간에 다른 공격이
 * 끼어들거나, 검을 휘두르기 전에 피해가 들어가는 현상이 생기지 않는다.
 */
export const PLAYER_ACTION_TIMING: Readonly<Record<PlayerActionKind, PlayerActionTiming>> = {
  attack: { duration: 0.26, impact: 0 },
  empowered: { duration: 0.46, impact: 0 },
  ult: { duration: 0.34, impact: 0.11 },
  q: { duration: 0.36, impact: 0.16 },
  w: { duration: 0.44, impact: 0.11 },
  e: { duration: 0.58, impact: 0.3 },
  r: { duration: 0.9, impact: 0.52 },
}

/**
 * 근거리 W는 발도 준비(0.00..0.16), 무적 돌진(0.16..0.32),
 * 베기와 회복(0.32..0.56)의 세 단계다. 원거리 W 타이밍은 그대로 둔다.
 */
export const MELEE_W_PREPARE_END = 0.16
export const MELEE_W_DASH_END = 0.32
export const MELEE_W_TIMING: Readonly<PlayerActionTiming> = {
  duration: 0.56,
  impact: MELEE_W_DASH_END,
}

export function playerActionTiming(
  playerClass: PlayerClass,
  kind: PlayerActionKind,
): PlayerActionTiming {
  return playerClass === 'melee' && kind === 'w'
    ? MELEE_W_TIMING
    : PLAYER_ACTION_TIMING[kind]
}

/** 캐릭터별로 실제 잠금에 쓰이는 액션 전체 길이. */
export function playerActionDuration(
  playerClass: PlayerClass,
  kind: PlayerActionKind,
): number {
  return playerActionTiming(playerClass, kind).duration
}

/** 애니메이션 재생기가 바로 쓸 수 있는 동작별 전체 길이. */
export const PLAYER_ACTION_DURATION: Readonly<Record<PlayerActionKind, number>> = {
  attack: PLAYER_ACTION_TIMING.attack.duration,
  empowered: PLAYER_ACTION_TIMING.empowered.duration,
  ult: PLAYER_ACTION_TIMING.ult.duration,
  q: PLAYER_ACTION_TIMING.q.duration,
  w: PLAYER_ACTION_TIMING.w.duration,
  e: PLAYER_ACTION_TIMING.e.duration,
  r: PLAYER_ACTION_TIMING.r.duration,
}
