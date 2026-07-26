import { ARENA_RADIUS, DT } from './constants.ts'
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
  { id: 'walker', name: '워커', hp: 20, speed: 3.4, radius: 0.42, contactDamage: 3, xp: 1, knockbackResist: 0 },
  { id: 'rusher', name: '러셔', hp: 12, speed: 6.4, radius: 0.33, contactDamage: 4, xp: 1, knockbackResist: 0 },
  { id: 'brute', name: '브루트', hp: 90, speed: 2.1, radius: 0.62, contactDamage: 9, xp: 4, knockbackResist: 0.55 },
]

export const TYPE_WALKER = 0
export const TYPE_RUSHER = 1
export const TYPE_BRUTE = 2

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

  /**
   * 한 시전이 같은 적을 두 번 때리지 않게 하는 토큰.
   * 링 확장처럼 여러 틱에 걸친 판정이 이걸 쓴다.
   */
  hitToken: Int32Array

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

    hitToken: new Int32Array(MAX_ENEMIES),
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
  [0, 4], // 0:00  조작 학습
  [20, 12], // 0:20  첫 스킬 해금
  [50, 20], // 0:50  두번째 해금
  [100, 40], // 1:40  마지막 스킬 → 파워스파이크 시작
  [160, 72], // 2:40  압박 구간 진입
  [200, 100], // 3:20  밀도 최대
  [210, 62], // 3:30  보스 등장 — 잡몹을 한 번 정리해 무대를 비운다
  [300, 78], // 5:00  보스전 내내 압박 유지
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

export function spawnEnemy(pool: EnemyPool, rng: Rng, px: number, py: number, type: number): void {
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
  pool.hp[i] = def.hp
  pool.maxHp[i] = def.hp
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
  pool.hitToken[i] = 0
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
const MAX_CONTACT_ATTACKERS = 4

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
): EnemyStepResult {
  // 격자는 여기서 만들지 않는다. 스킬이 stepEnemies보다 먼저 돌기 때문에
  // 여기서 재구축하면 스킬 질의가 항상 한 틱 낡은(또는 첫 틱엔 빈) 격자를 본다.
  // stepWorld가 틱 맨 앞에서 rebuildEnemyHash를 부른다.
  const n = pool.count

  let contactDamage = 0
  let contactCount = 0

  for (let i = 0; i < n; i++) {
    pool.prevX[i] = pool.x[i]!
    pool.prevY[i] = pool.y[i]!

    if (pool.flash[i]! > 0) {
      pool.flash[i] = Math.max(0, pool.flash[i]! - DT)
    }

    const def = ENEMY_TYPES[pool.type[i]!]!
    const ex = pool.x[i]!
    const ey = pool.y[i]!

    const pulled = pool.pullUntil[i]! > now
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
      const mul = speedMultiplier(pool, i, now)
      targetVx = dx * def.speed * mul + sx * SEPARATION
      targetVy = dy * def.speed * mul + sy * SEPARATION
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
    const touch = def.radius + playerRadius
    if (cdx * cdx + cdy * cdy < touch * touch) {
      contactDamage += def.contactDamage * DT
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
    spawnEnemy(pool, rng, px, py, rollType(rng, time))
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
