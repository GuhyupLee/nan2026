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

/**
 * 소환사 주문 쿨다운(초). 시작부터 보유한다.
 *
 * 롤의 점멸은 300초지만 그건 30분 게임 기준이다. 5분 판에서 그 비율이면
 * 한 번밖에 못 쓴다. 판당 6~7회 쓰이도록 낮춰 잡고 D9 밸런싱에서 조정한다.
 */
export const FLASH_COOLDOWN = 40
export const HEAL_COOLDOWN = 45

/** 점멸 사거리(월드 단위). 롤과 비슷하게 "한 벽 넘는" 감각. */
export const FLASH_RANGE = 8

/** 회복량. 최대 체력의 35%. */
export const HEAL_AMOUNT = 35
/** 회복에 딸린 이동속도 배수와 지속 시간. */
export const HEAL_SPEED_BOOST = 1.45
export const HEAL_BOOST_TIME = 1.6
