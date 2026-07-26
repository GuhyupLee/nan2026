/**
 * 시뮬레이션 상수.
 *
 * 여기 있는 값은 전부 헤드리스 밸런싱(tools/balance)에서 그대로 쓰인다.
 * 렌더링·연출용 수치는 절대 여기 두지 않는다.
 */

/** 시뮬레이션 주파수. 렌더 프레임레이트와 무관하게 고정이다. */
export const SIM_HZ = 60

/** 시뮬레이션 한 틱의 길이(초). */
export const DT = 1 / SIM_HZ

/** 한 프레임에 밀어넣을 수 있는 최대 틱 수. 탭 복귀 시 death spiral 방지. */
export const MAX_TICKS_PER_FRAME = 8

/** 원형 아레나 반지름(월드 단위). */
export const ARENA_RADIUS = 30

/** 플레이어 기본 스탯. */
export const PLAYER_RADIUS = 0.55
export const PLAYER_SPEED = 10
export const PLAYER_MAX_HP = 100

/** 이동 응답성. 값이 클수록 즉각적. 서바이버류는 즉각적인 쪽이 손맛이 좋다. */
export const PLAYER_ACCEL = 90
