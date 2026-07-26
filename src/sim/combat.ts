import { DT } from './constants.ts'
import { ENEMY_TYPES, type EnemyPool, removeEnemy } from './enemies.ts'
import type { SpatialHash } from './spatial.ts'
import type { TracerEvent, World } from './types.ts'

/**
 * 자동 공격.
 *
 * 투사체가 아니라 히트스캔이다. 투사체 풀·이동 적분·매 틱 충돌을 통째로
 * 없애서 예산을 아끼고, 부작용도 유리하다 — 250마리 화면에서 점탄은 시각적으로
 * 소실되지만 즉발 예광선은 남고, 피드백 지연이 0이 된다.
 *
 * 타겟 선정이 이 게임의 조작 문법과 맞물린 핵심 설계다.
 * 이동이 마우스 전용이라 커서는 조준점인 동시에 이동 목표다.
 * 순수 콘 조준이면 도망칠 때 항상 등 뒤의 적을 못 쏘고 화면에 아무 일도
 * 일어나지 않는다. 그래서 "콘 우선 + 전방위 폴백"으로 간다 —
 * 커서는 계속 의미를 갖되(콘 안이 항상 이긴다) 헛발은 구조적으로 0이다.
 */

export const ATTACK_INTERVAL = 0.28
export const ATTACK_DAMAGE = 13
export const ATTACK_RANGE = 15
/** 관통 수. 선 위의 적을 몇 명까지 뚫는가. */
export const ATTACK_PIERCE = 3
/** 히트스캔 선의 두께(반경). */
const ATTACK_WIDTH = 0.35
/** 커서 방향 우선 판정 각도(반각, 라디안). 55도. */
const CONE_HALF = 0.96

const hitBuf: number[] = []

/**
 * 타겟을 고른다.
 * 1) 콘 안의 브루트(대형) 우선 — 없으면
 * 2) 콘 안 최근접 — 없으면
 * 3) 사거리 내 최근접(방향 무관)
 * @returns 적 인덱스, 없으면 -1
 */
function pickTarget(
  pool: EnemyPool,
  px: number,
  py: number,
  aimX: number,
  aimY: number,
): number {
  let ax = aimX - px
  let ay = aimY - py
  const al = Math.hypot(ax, ay)
  if (al > 1e-6) {
    ax /= al
    ay /= al
  } else {
    ax = 1
    ay = 0
  }

  let bigInCone = -1
  let bigDist = Infinity
  let inCone = -1
  let coneDist = Infinity
  let anyNear = -1
  let anyDist = Infinity

  const r2 = ATTACK_RANGE * ATTACK_RANGE

  for (let i = 0; i < pool.count; i++) {
    const dx = pool.x[i]! - px
    const dy = pool.y[i]! - py
    const d2 = dx * dx + dy * dy
    if (d2 > r2) continue

    if (d2 < anyDist) {
      anyDist = d2
      anyNear = i
    }

    const d = Math.sqrt(d2)
    if (d < 1e-6) continue
    // 내적으로 콘 안쪽인지 판정
    if ((dx / d) * ax + (dy / d) * ay < Math.cos(CONE_HALF)) continue

    if (d2 < coneDist) {
      coneDist = d2
      inCone = i
    }
    // 큰 적은 우선순위를 올린다. 없으면 자동 공격이 브루트를 거의 안 때린다.
    if (ENEMY_TYPES[pool.type[i]!]!.radius >= 0.6 && d2 < bigDist) {
      bigDist = d2
      bigInCone = i
    }
  }

  if (bigInCone >= 0) return bigInCone
  if (inCone >= 0) return inCone
  return anyNear
}

/** 점 p에서 선분 ab까지의 거리 제곱. */
function distSqToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax
  const aby = by - ay
  const len2 = abx * abx + aby * aby
  let t = len2 > 1e-9 ? ((px - ax) * abx + (py - ay) * aby) / len2 : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const cx = ax + abx * t - px
  const cy = ay + aby * t - py
  return cx * cx + cy * cy
}

/**
 * 자동 공격을 한 틱 진행시킨다.
 * 죽은 적은 여기서 제거하고 XP를 반환한다.
 * @returns 이번 틱에 획득한 XP
 */
export function stepAutoAttack(
  world: World,
  pool: EnemyPool,
  _hash: SpatialHash,
  tracers: TracerEvent[],
): number {
  const p = world.player
  p.attackCooldown -= DT
  if (p.attackCooldown > 0 || pool.count === 0) return 0

  const target = pickTarget(pool, p.pos.x, p.pos.y, world.lastAim.x, world.lastAim.y)
  if (target < 0) return 0

  p.attackCooldown = ATTACK_INTERVAL

  // 타겟 방향으로 사거리 끝까지 뻗는 선분
  const tx = pool.x[target]!
  const ty = pool.y[target]!
  let dx = tx - p.pos.x
  let dy = ty - p.pos.y
  const dl = Math.hypot(dx, dy)
  if (dl < 1e-6) return 0
  dx /= dl
  dy /= dl

  const ex = p.pos.x + dx * ATTACK_RANGE
  const ey = p.pos.y + dy * ATTACK_RANGE

  if (tracers.length < 64) {
    tracers.push({ x0: p.pos.x, y0: p.pos.y, x1: ex, y1: ey })
  }

  // 선분에 걸리는 적을 가까운 순으로 모은다
  hitBuf.length = 0
  for (let i = 0; i < pool.count; i++) {
    const r = ENEMY_TYPES[pool.type[i]!]!.radius + ATTACK_WIDTH
    if (distSqToSegment(pool.x[i]!, pool.y[i]!, p.pos.x, p.pos.y, ex, ey) <= r * r) {
      hitBuf.push(i)
    }
  }
  // 거리순 정렬 — 관통 상한을 가까운 적부터 소비해야 자연스럽다.
  hitBuf.sort((a, b) => {
    const da = (pool.x[a]! - p.pos.x) ** 2 + (pool.y[a]! - p.pos.y) ** 2
    const db = (pool.x[b]! - p.pos.x) ** 2 + (pool.y[b]! - p.pos.y) ** 2
    return da - db
  })

  let xp = 0
  const n = Math.min(hitBuf.length, ATTACK_PIERCE)
  // 뒤에서부터 지워야 swap-remove가 앞쪽 인덱스를 흔들지 않는다.
  const killed: number[] = []
  for (let k = 0; k < n; k++) {
    const i = hitBuf[k]!
    pool.hp[i] = pool.hp[i]! - ATTACK_DAMAGE
    pool.flash[i] = 0.08
    if (pool.hp[i]! <= 0) killed.push(i)
  }

  killed.sort((a, b) => b - a)
  for (const i of killed) {
    const def = ENEMY_TYPES[pool.type[i]!]!
    xp += def.xp
    if (world.deaths.length < 128) {
      world.deaths.push({ x: pool.x[i]!, y: pool.y[i]!, type: pool.type[i]! })
    }
    removeEnemy(pool, i)
  }

  return xp
}
