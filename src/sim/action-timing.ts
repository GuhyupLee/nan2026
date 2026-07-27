import type { PlayerActionKind } from './types.ts'

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
  attack: { duration: 0.26, impact: 0.11 },
  empowered: { duration: 0.46, impact: 0.21 },
  ult: { duration: 0.34, impact: 0.11 },
  q: { duration: 0.36, impact: 0.16 },
  w: { duration: 0.44, impact: 0.11 },
  e: { duration: 0.58, impact: 0.3 },
  r: { duration: 0.9, impact: 0.52 },
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
