import { ENEMY_TYPES, MAX_ENEMIES, type EnemyPool } from './enemies.ts'
import type { SpatialHash } from './spatial.ts'

/**
 * 판정 원시연산.
 *
 * 전부 같은 뼈대다: 공간 해시로 후보를 좁히고(broadphase) → 실제 형태로
 * 걸러내고(narrowphase) → 콜백을 부른다.
 *
 * **결과 배열을 만들지 않는다.** 한 프레임에 수십 번 호출되는 코드라
 * 배열을 반환하면 그만큼 GC 압력이 된다. 콜백만 부르면 할당이 0이다.
 *
 * 순회 순서가 그리드 셀 인덱스 오름차순으로 고정되므로 같은 시드에서
 * 항상 같은 결과가 나온다. 헤드리스 밸런싱의 전제다.
 */

/** @param i 적 인덱스 @param dist2 판정 기준점까지 거리 제곱 */
export type EnemyVisitor = (i: number, dist2: number) => void

// EnemyPool의 절대 상한과 같아야 고밀도 엔드리스에서도 뒤쪽 슬롯이 조용히
// 판정에서 누락되지 않는다.
const buf = new Int32Array(MAX_ENEMIES)

/** 원. 가장 흔한 형태 — 폭발, 접촉, 회복 범위. */
export function queryCircle(
  pool: EnemyPool,
  hash: SpatialHash,
  x: number,
  y: number,
  radius: number,
  visit: EnemyVisitor,
): void {
  const n = hash.query(x, y, radius + 1, buf)
  for (let k = 0; k < n; k++) {
    const i = buf[k]!
    if (i >= pool.count) continue
    const dx = pool.x[i]! - x
    const dy = pool.y[i]! - y
    const d2 = dx * dx + dy * dy
    const r = radius + ENEMY_TYPES[pool.type[i]!]!.radius
    if (d2 <= r * r) visit(i, d2)
  }
}

/**
 * 선분(캡슐). 관통 공격·대시 경로·빔이 쓴다.
 *
 * 투사체를 원 판정만으로 처리하면 빠른 투사체가 적을 지나쳐 버린다 —
 * 속도 30이면 한 틱에 0.5유닛을 가는데 적 반경은 0.4다. 반드시 선분으로 본다.
 */
export function querySegment(
  pool: EnemyPool,
  hash: SpatialHash,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  visit: EnemyVisitor,
): void {
  const midX = (x0 + x1) * 0.5
  const midY = (y0 + y1) * 0.5
  const half = Math.hypot(x1 - x0, y1 - y0) * 0.5

  const n = hash.query(midX, midY, half + width + 1, buf)
  const abx = x1 - x0
  const aby = y1 - y0
  const len2 = abx * abx + aby * aby

  for (let k = 0; k < n; k++) {
    const i = buf[k]!
    if (i >= pool.count) continue
    const px = pool.x[i]!
    const py = pool.y[i]!

    let t = len2 > 1e-9 ? ((px - x0) * abx + (py - y0) * aby) / len2 : 0
    if (t < 0) t = 0
    else if (t > 1) t = 1

    const cx = x0 + abx * t - px
    const cy = y0 + aby * t - py
    const d2 = cx * cx + cy * cy
    const r = width + ENEMY_TYPES[pool.type[i]!]!.radius
    if (d2 <= r * r) {
      // 시작점 기준 거리를 넘겨준다 — 관통 상한을 가까운 적부터 소비하려면 필요하다.
      const sx = px - x0
      const sy = py - y0
      visit(i, sx * sx + sy * sy)
    }
  }
}

/**
 * 환형(링). 확장하는 파면이 각 적을 정확히 한 번씩 스치게 한다.
 *
 * 히트 토큰과 붙으면 군중이 도미노처럼 순차적으로 갈라지는 그림이
 * 추가 비용 없이 나온다. "군중이 캔버스다"의 최고 가성비 도구다.
 */
export function queryRing(
  pool: EnemyPool,
  hash: SpatialHash,
  x: number,
  y: number,
  rInner: number,
  rOuter: number,
  visit: EnemyVisitor,
): void {
  const n = hash.query(x, y, rOuter + 1, buf)
  for (let k = 0; k < n; k++) {
    const i = buf[k]!
    if (i >= pool.count) continue
    const dx = pool.x[i]! - x
    const dy = pool.y[i]! - y
    const d2 = dx * dx + dy * dy
    const er = ENEMY_TYPES[pool.type[i]!]!.radius
    const lo = Math.max(0, rInner - er)
    const hi = rOuter + er
    if (d2 >= lo * lo && d2 <= hi * hi) visit(i, d2)
  }
}

/**
 * 부채꼴. 근접 광역 참격이 쓴다.
 * atan2를 피하고 내적으로만 판정한다 — 분기도 삼각함수도 없다.
 * @param cosHalf 반각의 코사인. 100도 부채꼴이면 Math.cos(50도).
 */
export function queryCone(
  pool: EnemyPool,
  hash: SpatialHash,
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  radius: number,
  cosHalf: number,
  visit: EnemyVisitor,
): void {
  const n = hash.query(x, y, radius + 1, buf)
  for (let k = 0; k < n; k++) {
    const i = buf[k]!
    if (i >= pool.count) continue
    const dx = pool.x[i]! - x
    const dy = pool.y[i]! - y
    const d2 = dx * dx + dy * dy
    const er = ENEMY_TYPES[pool.type[i]!]!.radius
    const r = radius + er
    if (d2 > r * r) continue

    const d = Math.sqrt(d2)
    // 발밑에 붙은 적은 각도가 무의미하므로 무조건 포함한다.
    if (d < er + 0.1) {
      visit(i, d2)
      continue
    }
    if ((dx * dirX + dy * dirY) / d >= cosHalf) visit(i, d2)
  }
}

/**
 * 사거리 안에서 가장 가까운 적.
 * 자동 공격 대상 선택, 궁극기 표적 탐색이 공유한다.
 * @returns 적 인덱스, 없으면 -1
 */
export function nearestEnemy(
  pool: EnemyPool,
  hash: SpatialHash,
  x: number,
  y: number,
  maxRange: number,
): number {
  let best = -1
  let bestD2 = Infinity
  queryCircle(pool, hash, x, y, maxRange, (i, d2) => {
    if (d2 < bestD2) {
      bestD2 = d2
      best = i
    }
  })
  return best
}
