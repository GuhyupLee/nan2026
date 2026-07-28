import { ARENA_RADIUS, DT, RUN_TIME_LIMIT } from './constants.ts'
import { randRange, type Rng } from './rng.ts'
import { SpatialHash } from './spatial.ts'
import { integrateImpulse, speedMultiplier } from './status.ts'

/**
 * 적 — 구조체 배열(SoA)로 관리한다.
 *
 * 수백 마리를 객체 배열로 들고 있으면 GC 압박과 캐시 미스가 같이 온다.
 * 타입 배열은 렌더러가 InstancedMesh 행렬로 바로 밀어넣기도 좋다.
 *
 * 사망은 swap-remove로 처리해 배열을 항상 조밀하게 유지한다.
 * 순회 순서가 인덱스 순서로 고정되므로 결정론이 깨지지 않는다.
 */

export const MAX_ENEMIES = 600

export interface EnemyTypeDef {
  id: string
  name: string
  hp: number
  speed: number
  radius: number
  /** 접촉 시 플레이어에게 주는 피해. */
  contactDamage: number
  xp: number
  /**
   * 넉백 저항 0~1. 큰 적일수록 덜 밀린다.
   * 없으면 브루트가 잡몹처럼 날아가서 무게감이 사라진다.
   */
  knockbackResist: number
}

/**
 * 잡몹 3종. 서로 다른 문제를 낸다 —
 * 워커는 수, 러셔는 속도, 브루트는 맷집.
 */
/**
 * 접촉 피해는 초당 값이다(뱀서 방식의 지속 피해).
 * 처음 잡았던 7/5/15는 너무 셌다 — 가만히 선 플레이어가 5초에 죽어서
 * 0:00~0:20 조작 학습 구간이 성립하지 않았다. 군중에 서 있으면 위험하되
 * 실수 한 번으로 즉사하지는 않는 선으로 낮춘다.
 */
export const ENEMY_TYPES: readonly EnemyTypeDef[] = [
  // 속도가 이 게임의 위험도를 지배한다.
  //
  // 계측 결과 플레이어가 5분 동안 받는 총 피해가 **1~6**이었다(최대 체력 120).
  // 접촉 시간은 전체의 0%. 원인은 피해량이 아니라 속도였다 — 플레이어가 10.0,
  // 가장 빠른 적이 6.4라 카이팅하면 물리적으로 절대 잡히지 않는다. 그 상태에서
  // 접촉 피해를 아무리 올려도 0에 곱하는 것이라 아무 일도 일어나지 않는다.
  //
  // 그래서 세 종류에 서로 다른 역할을 준다:
  //   워커  — 느리지만 수가 많다. 벽을 만들어 도망칠 공간을 좁힌다
  //   러셔  — **플레이어보다 빠르다**. 도망은 답이 아니고 죽여야 한다.
  //           대신 종잇장이라 스쳐도 죽는다. 위협의 주된 원천
  //   브루트 — 느리고 단단하고 아프다. 무시하면 누적된다
  { id: 'walker', name: '워커', hp: 26, speed: 7.6, radius: 0.42, contactDamage: 6, xp: 1, knockbackResist: 0.1 },
  { id: 'rusher', name: '러셔', hp: 14, speed: 10.9, radius: 0.33, contactDamage: 8.5, xp: 1, knockbackResist: 0 },
  { id: 'brute', name: '브루트', hp: 110, speed: 5.2, radius: 0.62, contactDamage: 17, xp: 4, knockbackResist: 0.6 },
  {
    id: 'rift-sovereign',
    name: '균열의 군주',
    // 6,500은 아무도 못 잡는 수치였다. 12시드 × 2클래스 계측에서 승리 0/24,
    // 90초 동안 깎아낸 양이 근접 23% · 원거리 6%였다. 클라이맥스가 "격파"인데
    // 격파가 구조적으로 불가능하면 5분 아크가 완성되지 않는다.
    // 스킬 밸류를 올리는 작업(별건)이 끝나면 다시 올려 잡는다.
    hp: 2600,
    speed: 2.45,
    radius: 1.55,
    // 돌진 중 붙어도 회피 한 번을 쓸 시간은 남도록 초당 피해를 낮게 잡는다.
    contactDamage: 12,
    xp: 0,
    knockbackResist: 0.92,
  },
  {
    id: 'eclipse-warden',
    name: '월식의 수호자',
    // 정예는 한 웨이브의 목표물이다. 브루트보다 확실히 오래 버티되,
    // 10초 넘게 두들겨야 하는 소형 보스가 되면 전리품 비트가 흐름을 막는다.
    hp: 620,
    speed: 6.5,
    radius: 0.86,
    contactDamage: 20,
    xp: 12,
    knockbackResist: 0.78,
  },
]

export const TYPE_WALKER = 0
export const TYPE_RUSHER = 1
export const TYPE_BRUTE = 2
export const TYPE_BOSS = 3
export const TYPE_ELITE = 4

/** 5분 런의 중간 파워 스파이크. 보스 직전에는 15초의 정리 시간을 남긴다. */
export const ELITE_SPAWN_TIMES = [75, 145, 195] as const

/** 보스는 3:30에 한 번만 등장한다. */
export const BOSS_SPAWN_TIME = 210
/** UI와 World 초기 상태가 타입 테이블을 뒤질 필요 없게 한 단일 진실 원천. */
export const BOSS_MAX_HP = ENEMY_TYPES[TYPE_BOSS]!.hp
/** 등장 중에는 공격하지 않고 실루엣과 보스바를 읽을 시간을 준다. */
export const BOSS_INTRO_DURATION = 1.6
/** 선회 → 돌진 예고 → 돌진 → 회복으로 이어지는 반복 주기. */
export const BOSS_CYCLE_TIME = 7
export const BOSS_WINDUP_AT = 3.8
export const BOSS_CHARGE_AT = 4.6
export const BOSS_RECOVER_AT = 6.35
/** 예고를 보고 옆으로 피할 수 있지만 직선 도주로는 따돌릴 수 없는 속도다. */
export const BOSS_CHARGE_SPEED = 24
/** 직선 돌진에 맞은 실수가 일반 선회 접촉과 같은 값으로 끝나지 않게 한다. */
export const BOSS_CHARGE_DAMAGE_MUL = 3.5

export type BossPhase = 'arrival' | 'orbit' | 'windup' | 'charge' | 'recover'

export function bossCycleTime(now: number, spawnedAt = BOSS_SPAWN_TIME): number {
  const introTicks = Math.round(BOSS_INTRO_DURATION / DT)
  const cycleTicks = Math.round(BOSS_CYCLE_TIME / DT)
  const elapsedTicks = Math.max(0, Math.round((now - spawnedAt) / DT) - introTicks)
  return (elapsedTicks % cycleTicks) * DT
}

function bossCycleIndex(now: number, spawnedAt: number): number {
  const introTicks = Math.round(BOSS_INTRO_DURATION / DT)
  const cycleTicks = Math.round(BOSS_CYCLE_TIME / DT)
  const elapsedTicks = Math.max(0, Math.round((now - spawnedAt) / DT) - introTicks)
  return Math.floor(elapsedTicks / cycleTicks)
}

/**
 * 시뮬레이션·렌더러·보스바가 함께 읽는 보스 페이즈.
 *
 * 별도 타이머나 난수를 소비하지 않고 고정 월드 시간만 사용하므로, 같은 시드와
 * 입력으로 재생하면 돌진 예고와 돌진 시작 틱까지 정확히 일치한다.
 */
export function bossPhaseAt(now: number, spawnedAt = BOSS_SPAWN_TIME): BossPhase {
  const elapsedTicks = Math.max(0, Math.round((now - spawnedAt) / DT))
  if (elapsedTicks < Math.round(BOSS_INTRO_DURATION / DT)) return 'arrival'
  const cycle = bossCycleTime(now, spawnedAt)
  if (cycle < BOSS_WINDUP_AT) return 'orbit'
  if (cycle < BOSS_CHARGE_AT) return 'windup'
  if (cycle < BOSS_RECOVER_AT) return 'charge'
  return 'recover'
}

export interface EnemyPool {
  /** 살아있는 적 수. 배열 앞쪽 count개만 유효하다. */
  count: number
  x: Float32Array
  y: Float32Array
  /** 직전 틱 위치. 렌더 보간용. */
  prevX: Float32Array
  prevY: Float32Array
  vx: Float32Array
  vy: Float32Array
  hp: Float32Array
  maxHp: Float32Array
  type: Uint8Array
  /** 피격 점멸 남은 시간(초). 렌더가 흰색 보간에 쓴다. */
  flash: Float32Array

  // --- 상태 (전부 "만료 시각" 방식) ---
  // 남은 시간을 매 틱 감산하면 적 수백 마리에 대해 매번 써야 한다.
  // 만료 시각은 쓰기가 1회뿐이고 판정은 비교 하나다.

  /** 점등 만료 시각. 원거리 패시브가 이 하나만 읽는다. */
  markExpire: Float32Array
  /** 둔화 만료 시각과 배수. */
  slowUntil: Float32Array
  slowMul: Float32Array
  /** 속박 만료 시각. 이동이 완전히 멈춘다. */
  rootUntil: Float32Array

  // --- 임펄스: 밀어냄·넉백. 지수 감쇠한다 ---
  pushVx: Float32Array
  pushVy: Float32Array

  // --- 견인: 지정 지점으로 끌려간다. AI 조향과 분리를 무시한다 ---
  pullX: Float32Array
  pullY: Float32Array
  pullUntil: Float32Array
  /** 견인 목표 링 반경. 이 반경까지만 접근한다(겹침 폭발 방지). */
  pullRing: Float32Array
  /** 견인 속도(초당). */
  pullSpeed: Float32Array

  /** 예고 중 고정한 돌진 방향과 그 방향이 속한 패턴 주기. */
  bossChargeDirX: Float32Array
  bossChargeDirY: Float32Array
  bossChargeCycle: Int32Array

  /**
   * swap-remove가 순회할 타입 배열 목록.
   *
   * 손으로 복사문을 쓰면 필드를 추가할 때마다 하나씩 빠뜨리고, 그러면
   * 죽은 적의 둔화·점등이 새로 스폰된 적에게 상속되는 유령 버그가 생긴다.
   * 생성 시점에 자동으로 모아 그 경로를 없앤다.
   */
  readonly views: ArrayBufferView[]
}

export function createEnemyPool(): EnemyPool {
  const pool: EnemyPool = {
    count: 0,
    x: new Float32Array(MAX_ENEMIES),
    y: new Float32Array(MAX_ENEMIES),
    prevX: new Float32Array(MAX_ENEMIES),
    prevY: new Float32Array(MAX_ENEMIES),
    vx: new Float32Array(MAX_ENEMIES),
    vy: new Float32Array(MAX_ENEMIES),
    hp: new Float32Array(MAX_ENEMIES),
    maxHp: new Float32Array(MAX_ENEMIES),
    type: new Uint8Array(MAX_ENEMIES),
    flash: new Float32Array(MAX_ENEMIES),

    markExpire: new Float32Array(MAX_ENEMIES),
    slowUntil: new Float32Array(MAX_ENEMIES),
    slowMul: new Float32Array(MAX_ENEMIES).fill(1),
    rootUntil: new Float32Array(MAX_ENEMIES),

    pushVx: new Float32Array(MAX_ENEMIES),
    pushVy: new Float32Array(MAX_ENEMIES),

    pullX: new Float32Array(MAX_ENEMIES),
    pullY: new Float32Array(MAX_ENEMIES),
    pullUntil: new Float32Array(MAX_ENEMIES),
    pullRing: new Float32Array(MAX_ENEMIES),
    pullSpeed: new Float32Array(MAX_ENEMIES),

    bossChargeDirX: new Float32Array(MAX_ENEMIES),
    bossChargeDirY: new Float32Array(MAX_ENEMIES),
    bossChargeCycle: new Int32Array(MAX_ENEMIES).fill(-1),

    views: [],
  }

  // 타입 배열을 전부 모은다. 필드를 추가해도 자동으로 따라온다.
  const views = pool.views as ArrayBufferView[]
  for (const v of Object.values(pool)) {
    if (ArrayBuffer.isView(v)) views.push(v as ArrayBufferView)
  }
  return pool
}

/** 사망 이벤트. 렌더러가 소멸 연출에 쓰고 비운다. */
export interface DeathEvent {
  x: number
  y: number
  type: number
}

// ---------------------------------------------------------------------------
// 스폰 커브
// ---------------------------------------------------------------------------

/**
 * 시각별 목표 생존 수.
 *
 * 스폰 "속도"가 아니라 "목표 마릿수"로 잡는다. 비트 시트가 "적 N마리"로
 * 쓰여 있으므로 이렇게 해야 스펙과 코드가 1:1로 붙고 튜닝이 직관적이다.
 *
 * 수치는 카메라를 당긴 뒤 다시 잡은 값이다. 시야가 좁아져서
 * 예전 계획의 150~250마리는 필요 없다 — 100마리면 화면이 가득 찬다.
 */
const SPAWN_CURVE: ReadonlyArray<readonly [number, number]> = [
  // 밀도가 두 번째 위험 축이다. 러셔가 속도로 압박한다면 워커는 **공간**으로
  // 압박한다 — 뱀서라이크에서 죽는 이유는 한 마리가 세서가 아니라 도망칠
  // 틈이 없어서다. 반지름 30 아레나에서 100마리는 마리당 28유닛²라 걸어서
  // 빠져나가진다. 그래서 후반 밀도를 크게 올렸다.
  [0, 5], // 0:00  조작 학습
  [20, 16], // 0:20  첫 스킬 해금
  [50, 30], // 0:50  두번째 해금
  [100, 62], // 1:40  마지막 스킬 → 파워스파이크 시작
  [160, 95], // 2:40  압박 구간 진입
  [200, 135], // 3:20  밀도 최대 — 회피 통로 한 줄은 남긴다
  [210, 70], // 3:30  보스 등장 — 잡몹을 정리해 패턴을 읽게 한다
  [300, 95], // 5:00  보스전 내내 측면 압박은 유지한다
]

export function targetAliveCount(time: number): number {
  const c = SPAWN_CURVE
  if (time <= c[0]![0]) return c[0]![1]
  for (let i = 1; i < c.length; i++) {
    const [t1, v1] = c[i]!
    if (time <= t1) {
      const [t0, v0] = c[i - 1]!
      const k = (time - t0) / (t1 - t0)
      return v0 + (v1 - v0) * k
    }
  }
  return c[c.length - 1]![1]
}

/**
 * 일반 몬스터의 후반 체력 배율.
 *
 * 첫 1분은 학습 구간이라 원래 체력을 유지하고, 보스 등장 시점까지 1.35배,
 * 제한 시간에는 1.55배가 되도록 완만하게 선형 보간한다. 시간은 양 끝에서
 * 고정되므로 오래 진행해도 체력이 무한히 증가하지 않는다.
 */
export function enemyHealthMultiplier(time: number): number {
  if (Number.isNaN(time) || time <= 60) return 1
  if (time < BOSS_SPAWN_TIME) {
    return 1 + ((time - 60) / (BOSS_SPAWN_TIME - 60)) * 0.35
  }
  if (time < RUN_TIME_LIMIT) {
    return (
      1.35 +
      ((time - BOSS_SPAWN_TIME) / (RUN_TIME_LIMIT - BOSS_SPAWN_TIME)) * 0.2
    )
  }
  return 1.55
}

/**
 * 시각에 따른 적 종류 추첨.
 *
 * 브루트 비율이 낮은 데에는 이유가 있다. 스폰 확률과 화면에 보이는 비율은
 * 전혀 다르다 — 브루트는 잘 안 죽으니 개체군에 계속 쌓인다.
 * 처음에 18%로 잡았더니 화면이 브루트로 뒤덮여 워커·러셔가 안 보였다.
 * 탱커는 "사건"이어야지 "벽"이 되면 안 된다.
 */
function rollType(rng: Rng, time: number): number {
  const r = rng.next()
  if (time < 25) return TYPE_WALKER
  if (time < 70) return r < 0.78 ? TYPE_WALKER : TYPE_RUSHER
  if (time < 150) {
    if (r < 0.6) return TYPE_WALKER
    if (r < 0.95) return TYPE_RUSHER
    return TYPE_BRUTE
  }
  if (r < 0.5) return TYPE_WALKER
  if (r < 0.92) return TYPE_RUSHER
  return TYPE_BRUTE
}

/** 화면 밖에서 스폰시킬 거리. 카메라 시야보다 살짝 넓게. */
const SPAWN_RING = 17

export function spawnEnemy(
  pool: EnemyPool,
  rng: Rng,
  px: number,
  py: number,
  type: number,
  time = 0,
): void {
  if (pool.count >= MAX_ENEMIES) return

  const def = ENEMY_TYPES[type]!
  const i = pool.count++

  // 플레이어 주변 링 위. 아레나를 벗어나면 안쪽으로 접는다.
  const a = rng.next() * Math.PI * 2
  const d = randRange(rng, SPAWN_RING, SPAWN_RING + 4)
  let sx = px + Math.cos(a) * d
  let sy = py + Math.sin(a) * d
  const dist = Math.hypot(sx, sy)
  const limit = ARENA_RADIUS - def.radius - 0.5
  if (dist > limit) {
    const s = limit / dist
    sx *= s
    sy *= s
  }

  pool.x[i] = sx
  pool.y[i] = sy
  pool.prevX[i] = sx
  pool.prevY[i] = sy
  pool.vx[i] = 0
  pool.vy[i] = 0
  const maxHp = type === TYPE_BOSS ? BOSS_MAX_HP : def.hp * enemyHealthMultiplier(time)
  pool.hp[i] = maxHp
  pool.maxHp[i] = maxHp
  pool.type[i] = type
  pool.flash[i] = 0

  // 슬롯 재사용이므로 상태를 반드시 초기화한다.
  // 안 그러면 죽은 적의 둔화·점등이 새로 스폰된 적에게 상속된다.
  pool.markExpire[i] = -1
  pool.slowUntil[i] = -1
  pool.slowMul[i] = 1
  pool.rootUntil[i] = -1
  pool.pushVx[i] = 0
  pool.pushVy[i] = 0
  pool.pullUntil[i] = -1
  pool.pullRing[i] = 0
  pool.pullSpeed[i] = 0
  pool.bossChargeDirX[i] = 0
  pool.bossChargeDirY[i] = 0
  pool.bossChargeCycle[i] = -1
}

/**
 * 고유 보스를 스폰한다.
 *
 * 한 번만이라는 규칙은 World.boss.spawned가 맡고, 이 함수는 풀 용량 때문에
 * 실패했는지만 반환한다. 일반 스폰보다 먼저 호출해 보스 자리를 보장한다.
 */
export function spawnBoss(pool: EnemyPool, rng: Rng, px: number, py: number): boolean {
  const before = pool.count
  spawnEnemy(pool, rng, px, py, TYPE_BOSS)
  return pool.count > before
}

/** 지정 비트에만 등장하는 전리품 정예. 일반 스폰 추첨에는 섞이지 않는다. */
export function spawnElite(
  pool: EnemyPool,
  rng: Rng,
  px: number,
  py: number,
  time: number,
): boolean {
  const before = pool.count
  spawnEnemy(pool, rng, px, py, TYPE_ELITE, time)
  return pool.count > before
}

/**
 * 보스 등장과 동시에 전장을 목표 개체 수까지 비운다.
 *
 * 스폰 목표만 낮추면 이미 살아 있는 100마리는 그대로라 3:30 비트가 실제로
 * 보이지 않는다. 뒤쪽 일반몹부터 제거하면 난수를 추가로 소비하지 않고,
 * 보스 슬롯이 swap-remove로 이동해도 타입을 기준으로 보호할 수 있다.
 */
export function thinEnemiesForBoss(pool: EnemyPool, targetTotal: number): number {
  const target = Math.max(1, Math.floor(targetTotal))
  let removed = 0

  while (pool.count > target) {
    let removeAt = -1
    for (let i = pool.count - 1; i >= 0; i--) {
      if (pool.type[i] !== TYPE_BOSS && pool.type[i] !== TYPE_ELITE) {
        removeAt = i
        break
      }
    }
    if (removeAt < 0) break
    removeEnemy(pool, removeAt)
    removed++
  }

  return removed
}

/** swap-remove. 배열을 조밀하게 유지한다. */
export function removeEnemy(pool: EnemyPool, i: number): void {
  const last = --pool.count
  if (i === last) return
  for (const v of pool.views) {
    // 모든 배열이 같은 레이아웃(인덱스 = 적 슬롯)이라 한 줄로 끝난다.
    ;(v as unknown as { [k: number]: number })[i] = (
      v as unknown as { [k: number]: number }
    )[last]!
  }
}

// ---------------------------------------------------------------------------
// 시뮬레이션
// ---------------------------------------------------------------------------

/** 분리 밀어내기 강도. 너무 크면 적들이 폭발하듯 튕긴다. */
const SEPARATION = 14

/**
 * 동시에 접촉 피해를 넣을 수 있는 적의 수 상한.
 *
 * 이 캡이 게임의 성패를 가른다. 캡이 없으면 밀도가 곧 치사율이 된다 —
 * 플레이어 반경 0.55에 적 반경 0.4면 접촉 원주 위에 8마리가 동시에 붙을 수
 * 있고, 그 전부가 피해를 넣으면 어떤 수치를 넣어도 스킬 쿨다운 한 바퀴를
 * 돌기 전에 죽는다. 특히 파고들어야 하는 근접 클래스는 성립 자체가 불가능해진다.
 *
 * 캡이 있어야 250마리가 "즉사 장치"가 아니라 "읽히는 그림"이 된다.
 * 초과분은 버리지 않고 비례 축소한다 — 마릿수가 늘수록 위험이 커지되
 * 선형으로 커지지는 않게 한다.
 */
const MAX_CONTACT_ATTACKERS = 6

/** 몸 겹침 위로 더 주는 접촉 여유 사거리. 위 주석 참조. */
const CONTACT_REACH = 0.35

const neighborBuf = new Int32Array(96)
const impulseOut = { x: 0, y: 0 }

export interface EnemyStepResult {
  /** 이번 틱에 플레이어가 받은 접촉 피해 합계(캡 적용 후). */
  contactDamage: number
  /** 실제로 붙어 있던 적 수. 캡 적용 전. HUD 위험 표시에 쓸 수 있다. */
  contactCount: number
}

/**
 * 적을 한 틱 진행시킨다.
 *
 * 순서가 중요하다: 격자 재구축 → 조향 → 적분 → 경계 → 접촉.
 * 조향 중에 위치를 바꾸면 같은 틱 안에서 앞 인덱스와 뒤 인덱스가
 * 다른 세계를 보게 되어 결정론은 유지되지만 거동이 비대칭해진다.
 */
export function stepEnemies(
  pool: EnemyPool,
  hash: SpatialHash,
  px: number,
  py: number,
  playerRadius: number,
  now: number,
  bossSpawnedAt = BOSS_SPAWN_TIME,
  relicThreat = 0,
): EnemyStepResult {
  // 격자는 여기서 만들지 않는다. 스킬이 stepEnemies보다 먼저 돌기 때문에
  // 여기서 재구축하면 스킬 질의가 항상 한 틱 낡은(또는 첫 틱엔 빈) 격자를 본다.
  // stepWorld가 틱 맨 앞에서 rebuildEnemyHash를 부른다.
  const n = pool.count

  let contactDamage = 0
  let contactCount = 0
  // 전리품으로 두 랭크씩 강해지는 만큼 균열도 깨어난다. 보상을 먹을수록
  // 다음 웨이브가 빨라지고 아파져 파워 스파이크가 난이도를 삭제하지 않는다.
  const threatStacks = Math.max(0, Math.min(ELITE_SPAWN_TIMES.length, relicThreat))
  // The relic is a reward beat first. Its counter-pressure should be felt as a
  // slightly tighter horde, not erase the power spike the player just earned.
  const threatSpeedMul = 1 + threatStacks * 0.005
  const threatDamageMul = 1 + threatStacks * 0.015

  for (let i = 0; i < n; i++) {
    pool.prevX[i] = pool.x[i]!
    pool.prevY[i] = pool.y[i]!

    if (pool.flash[i]! > 0) {
      pool.flash[i] = Math.max(0, pool.flash[i]! - DT)
    }

    const type = pool.type[i]!
    const def = ENEMY_TYPES[type]!
    const isBoss = type === TYPE_BOSS
    const bossPhase = isBoss ? bossPhaseAt(now, bossSpawnedAt) : null
    const ex = pool.x[i]!
    const ey = pool.y[i]!

    // 보스는 견인으로 패턴이 통째로 취소되지 않는다. 넉백은 타입 저항으로
    // 아주 조금만 남겨 타격 피드백은 유지한다.
    const pulled = !isBoss && pool.pullUntil[i]! > now
    let targetVx: number
    let targetVy: number

    if (pulled) {
      // --- 견인: AI 조향과 분리를 통째로 끈다 ---
      // 그래야 빽빽한 기둥으로 뭉치고 지터가 사라진다. 연출이 공짜로 좋아진다.
      let gx = pool.pullX[i]! - ex
      let gy = pool.pullY[i]! - ey
      const gd = Math.hypot(gx, gy)
      const ring = pool.pullRing[i]!
      if (gd <= ring + 0.05 || gd < 1e-6) {
        targetVx = 0
        targetVy = 0
      } else {
        gx /= gd
        gy /= gd
        // 링을 지나치지 않게 이번 틱 이동량을 잘라낸다.
        const speed = Math.min(pool.pullSpeed[i]!, (gd - ring) / DT)
        targetVx = gx * speed
        targetVy = gy * speed
      }
    } else {
      // --- 조향: 플레이어 추적 ---
      let dx = px - ex
      let dy = py - ey
      const dl = Math.hypot(dx, dy)
      if (dl > 1e-6) {
        dx /= dl
        dy /= dl
      }

      // --- 분리: 겹쳐 쌓이는 것을 막는다 ---
      // 이게 없으면 적이 한 점에 뭉쳐 한 마리처럼 보이고 타격감이 죽는다.
      const reach = def.radius * 2 + 0.6
      const cnt = hash.query(ex, ey, reach, neighborBuf)
      let sx = 0
      let sy = 0
      for (let k = 0; k < cnt; k++) {
        const j = neighborBuf[k]!
        if (j === i || j >= n) continue
        const ox = ex - pool.x[j]!
        const oy = ey - pool.y[j]!
        const d2 = ox * ox + oy * oy
        const min = def.radius + ENEMY_TYPES[pool.type[j]!]!.radius
        if (d2 > 1e-8 && d2 < min * min) {
          const d = Math.sqrt(d2)
          const push = (min - d) / min
          sx += (ox / d) * push
          sy += (oy / d) * push
        }
      }

      // 둔화·속박은 추적 속도에만 걸린다. 분리 밀어냄까지 막으면
      // 속박된 적들이 서로 겹쳐 한 덩어리가 된다.
      // 보스 패턴: 등장 → 반시계 선회 → 정지 예고 → 돌진 → 짧은 회복.
      // 별도 난수나 타이머 배열 없이 월드 시간만 써서 결정론적이다.
      if (isBoss) {
        // 속박·둔화가 패턴을 삭제하지 않게 최저 속도를 보장한다.
        const mul = Math.max(0.72, speedMultiplier(pool, i, now))
        if (bossPhase === 'arrival') {
          targetVx = 0
          targetVy = 0
        } else if (bossPhase === 'orbit') {
          const orbit = 0.78
          const pursue = 0.64
          targetVx = (dx * pursue - dy * orbit) * def.speed * mul + sx * SEPARATION * 0.35
          targetVy = (dy * pursue + dx * orbit) * def.speed * mul + sy * SEPARATION * 0.35
        } else if (bossPhase === 'windup') {
          const cycle = bossCycleIndex(now, bossSpawnedAt)
          if (pool.bossChargeCycle[i] !== cycle) {
            let chargeX = dx
            let chargeY = dy
            if (dl <= 1e-6) {
              const velocityLength = Math.hypot(pool.vx[i]!, pool.vy[i]!)
              chargeX = velocityLength > 1e-6 ? pool.vx[i]! / velocityLength : 1
              chargeY = velocityLength > 1e-6 ? pool.vy[i]! / velocityLength : 0
            }
            pool.bossChargeDirX[i] = chargeX
            pool.bossChargeDirY[i] = chargeY
            pool.bossChargeCycle[i] = cycle
          }
          // 거의 멈춘 채 고정 방향을 바라봐 예고와 실제 궤적이 일치하게 한다.
          targetVx = pool.bossChargeDirX[i]! * 0.02
          targetVy = pool.bossChargeDirY[i]! * 0.02
        } else if (bossPhase === 'charge') {
          const cycle = bossCycleIndex(now, bossSpawnedAt)
          if (pool.bossChargeCycle[i] !== cycle) {
            pool.bossChargeDirX[i] = dl > 1e-6 ? dx : 1
            pool.bossChargeDirY[i] = dl > 1e-6 ? dy : 0
            pool.bossChargeCycle[i] = cycle
          }
          // 직선 도주보다 빨라야 예고를 보고 옆으로 피하는 문법이 성립한다.
          // 둔화 배수를 적용하면 최저 0.72에서 다시 플레이어보다 느려진다.
          targetVx = pool.bossChargeDirX[i]! * BOSS_CHARGE_SPEED
          targetVy = pool.bossChargeDirY[i]! * BOSS_CHARGE_SPEED
        } else {
          const recoverSpeed = def.speed * 0.28 * mul
          targetVx = dx * recoverSpeed
          targetVy = dy * recoverSpeed
        }
      } else {
        const mul = speedMultiplier(pool, i, now)
        targetVx = dx * def.speed * mul * threatSpeedMul + sx * SEPARATION
        targetVy = dy * def.speed * mul * threatSpeedMul + sy * SEPARATION
      }
    }

    // 즉시 목표 속도로 가지 않고 감쇠시켜야 무리가 유체처럼 흐른다.
    // 견인 중에는 즉각 반응해야 "빨려든다"가 읽힌다.
    const k = pulled ? 1 : 1 - Math.exp(-12 * DT)
    pool.vx[i] = pool.vx[i]! + (targetVx - pool.vx[i]!) * k
    pool.vy[i] = pool.vy[i]! + (targetVy - pool.vy[i]!) * k

    // --- 임펄스: 조향과 별개로 더해진다. 속박 중에도 밀린다 ---
    integrateImpulse(pool, i, impulseOut)

    let nx = ex + pool.vx[i]! * DT + impulseOut.x
    let ny = ey + pool.vy[i]! * DT + impulseOut.y

    // --- 아레나 경계 ---
    const dist = Math.hypot(nx, ny)
    const limit = ARENA_RADIUS - def.radius
    if (dist > limit && dist > 1e-6) {
      const s = limit / dist
      nx *= s
      ny *= s
    }

    pool.x[i] = nx
    pool.y[i] = ny

    // --- 플레이어 접촉 ---
    const cdx = nx - px
    const cdy = ny - py
    // 몸이 정확히 겹칠 때만 피해를 주면 접촉이 거의 성립하지 않는다. 적끼리
    // 서로 밀어내는 분리 조향 때문에 플레이어 주위에 고리를 만들고, 그 고리에서
    // 실제로 반경 안에 들어오는 건 한두 마리뿐이다. 계측상 접촉 시간이 전체의
    // 2%였다. 조금의 여유 사거리를 줘야 "둘러싸였다"가 피해로 이어진다.
    const touch = def.radius + playerRadius + CONTACT_REACH
    if (bossPhase !== 'arrival' && cdx * cdx + cdy * cdy < touch * touch) {
      const chargeDamageMul =
        isBoss && bossPhase === 'charge' ? BOSS_CHARGE_DAMAGE_MUL : 1
      const rewardThreatMul = isBoss ? 1 : threatDamageMul
      contactDamage += def.contactDamage * chargeDamageMul * rewardThreatMul * DT
      contactCount++
    }
  }

  // 동시 피격 캡. 붙은 마릿수가 상한을 넘으면 총량을 비례 축소한다.
  // 어느 적을 고를지 정하지 않으므로 순회 순서에 의존하지 않는다 — 결정론 유지.
  if (contactCount > MAX_CONTACT_ATTACKERS) {
    contactDamage *= MAX_CONTACT_ATTACKERS / contactCount
  }

  return { contactDamage, contactCount }
}

/**
 * 목표 마릿수에 맞춰 부족한 만큼 스폰한다.
 * 한 틱에 몰아서 뱉지 않도록 상한을 둔다 — 갑자기 20마리가 나타나면
 * 스폰 링이 눈에 보인다.
 */
export function updateSpawner(
  pool: EnemyPool,
  rng: Rng,
  time: number,
  px: number,
  py: number,
): void {
  const target = targetAliveCount(time)
  const deficit = Math.floor(target) - pool.count
  if (deficit <= 0) return

  const budget = Math.min(deficit, 3)
  for (let k = 0; k < budget; k++) {
    spawnEnemy(pool, rng, px, py, rollType(rng, time), time)
  }
}

/**
 * 공간 격자를 현재 위치로 다시 만든다.
 *
 * 반드시 틱 맨 앞에서 부른다. 스킬 시전이 이동보다 먼저 처리되므로,
 * 격자 재구축이 뒤로 밀리면 스킬이 빈 격자를 질의해 아무것도 못 맞힌다.
 */
export function rebuildEnemyHash(pool: EnemyPool, hash: SpatialHash): void {
  hash.rebuild(pool.count, pool.x, pool.y)
}

export function createEnemyHash(): SpatialHash {
  // 셀 크기는 가장 흔한 질의 반경(분리 reach ≈ 1.5~2.0)과 맞춘다.
  return new SpatialHash(ARENA_RADIUS + 4, 2, MAX_ENEMIES)
}
