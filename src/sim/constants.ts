/**
 * 시뮬레이션 초기값 테이블.
 *
 * 아래 값들은 "상수"가 아니라 world.stats의 초기값이다. 강화 카드가
 * 런타임에 바꾸는 대상이므로 게임 코드는 이 상수가 아니라 world.stats를 읽는다.
 * (진짜 상수는 SIM_HZ / DT / RUN_TIME_LIMIT / MAX_TICKS_PER_FRAME /
 * ARENA_RADIUS / PLAYER_ACCEL뿐이다.)
 *
 * 렌더링·연출용 수치는 절대 여기 두지 않는다.
 */

/** 시뮬레이션 주파수. 렌더 프레임레이트와 무관하게 고정이다. */
export const SIM_HZ = 60

/** 시뮬레이션 한 틱의 길이(초). */
export const DT = 1 / SIM_HZ

/** 보스를 쓰러뜨려야 하는 전체 런 제한 시간(초). */
export const RUN_TIME_LIMIT = 300

/** 한 프레임에 밀어넣을 수 있는 최대 틱 수. 탭 복귀 시 death spiral 방지. */
export const MAX_TICKS_PER_FRAME = 8

/** 원형 아레나 반지름(월드 단위). */
export const ARENA_RADIUS = 30

/** 플레이어 기본 스탯. */
export const PLAYER_RADIUS = 0.55
export const PLAYER_SPEED = 10.7
export const PLAYER_MAX_HP = 125

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
export const HEAL_AMOUNT = 42

/**
 * 처치 회복 예산이 차는 속도(초당 HP)와 최대치.
 *
 * 한 판에 3,000마리를 죽이는 게임에서 처치당 회복을 상한 없이 두면
 * 회복이 피해를 완전히 압도한다. 계측된 값이 그랬다 — 최대 1,800 회복 대
 * 받은 피해 54라 체력이 줄어들 수가 없었다.
 *
 * 값은 실측으로 잡았다. 후반 교전에서 들어오는 피해가 평균 약 1.0/초인데
 * 처음에 2.4/초로 두니 회복 용량이 피해의 두 배라 여전히 아무도 안 죽었다
 * (12시드 전부 최저 체력 87%). 반대로 회복을 완전히 끄면 원거리가 12/12
 * 전멸한다. 그 사이가 이 값이다 — 조용한 구간을 버는 데는 충분하고
 * 몰린 상태를 버티는 데는 모자라다.
 *
 * 최대치 12는 약 3초치. 한 번 크게 쓸어담았을 때 목돈으로 돌아오되,
 * 계속 쓸어담는다고 계속 돌아오지는 않는다.
 */
export const KILL_HEAL_RATE = 4
export const KILL_HEAL_CAP = 12
/** 회복에 딸린 이동속도 배수와 지속 시간. */
export const HEAL_SPEED_BOOST = 1.45
export const HEAL_BOOST_TIME = 1.6

/**
 * 자동 공격 초기값(원거리 기준).
 *
 * 이 네 값은 헤드리스 8시드 실측으로 XP 곡선을 맞춰둔 상태라
 * 함부로 건드리면 비트 시트의 레벨업 타이밍이 통째로 어긋난다.
 */
export const ATK_INTERVAL = 0.28
export const ATK_DAMAGE = 13
export const ATK_RANGE = 15
/**
 * 관통 수. 선 위의 적을 몇 명까지 뚫는가.
 *
 * 3으로 두니 원거리가 8시드 전부 3:14에 죽었다. 생존력이 아니라 군중
 * 정리 속도가 원인이었다 — 근접은 「월참」이 1초마다 부채꼴 광역을 뿌리는데
 * 원거리의 광역은 14초 쿨의 E 하나뿐이었다.
 * 관통을 늘리는 것이 "선을 긋는다"는 정체성과도 맞는다.
 */
export const ATK_PIERCE = 5
