import { DT } from './constants.ts'
import { ENEMY_TYPES, type EnemyPool } from './enemies.ts'

/**
 * 적 상태 레이어 — 점등·둔화·속박·임펄스·견인.
 *
 * 스킬 8개가 전부 이 레이어를 호출만 한다. 개별 스킬이 각자 적 배열을
 * 만지기 시작하면 반드시 하나가 규칙을 어긴다.
 *
 * 상태는 전부 "만료 시각" 방식이다. 남은 시간을 매 틱 감산하면 적 수백
 * 마리에 대해 매번 써야 하지만, 만료 시각은 쓰기가 1회뿐이고 판정은 비교 하나다.
 */

/** 임펄스 감쇠 계수(초당). 클수록 빨리 멈춘다. */
export const IMPULSE_DECAY = 8

/**
 * 임펄스 총 변위 = magnitude / IMPULSE_DECAY.
 * 명세가 "임펄스 32 → 변위 4.0"처럼 적혀 있어서 역산이 필요하다.
 */
export function impulseToDisplacement(mag: number): number {
  return mag / IMPULSE_DECAY
}

/** 점등(표식)을 건다. 이미 걸려 있으면 더 긴 쪽으로 연장한다. */
export function applyMark(pool: EnemyPool, i: number, now: number, duration: number): void {
  const until = now + duration
  if (until > pool.markExpire[i]!) pool.markExpire[i] = until
}

export function isMarked(pool: EnemyPool, i: number, now: number): boolean {
  return pool.markExpire[i]! > now
}

/** 둔화. 더 강한 둔화가 약한 것을 덮어쓴다. */
export function applySlow(
  pool: EnemyPool,
  i: number,
  now: number,
  duration: number,
  mul: number,
): void {
  const until = now + duration
  // 이미 더 센 둔화가 걸려 있고 아직 안 끝났으면 유지한다.
  if (pool.slowUntil[i]! > now && pool.slowMul[i]! < mul) {
    if (until > pool.slowUntil[i]!) pool.slowUntil[i] = until
    return
  }
  pool.slowUntil[i] = until
  pool.slowMul[i] = mul
}

/** 속박. 이동이 완전히 멈춘다. 보스는 걸리지 않는다. */
export function applyRoot(pool: EnemyPool, i: number, now: number, duration: number): void {
  const until = now + duration
  if (until > pool.rootUntil[i]!) pool.rootUntil[i] = until
}

/**
 * 임펄스를 준다. 방향은 정규화해서 넣는다.
 *
 * 큰 적일수록 덜 밀린다 — 안 그러면 브루트가 잡몹처럼 날아가서
 * 무게감이 사라진다.
 */
export function applyImpulse(
  pool: EnemyPool,
  i: number,
  dirX: number,
  dirY: number,
  magnitude: number,
): void {
  const d = Math.hypot(dirX, dirY)
  if (d < 1e-6) return
  const resist = ENEMY_TYPES[pool.type[i]!]!.knockbackResist
  const m = (magnitude * (1 - resist)) / d
  pool.pushVx[i] = pool.pushVx[i]! + dirX * m
  pool.pushVy[i] = pool.pushVy[i]! + dirY * m
}

/**
 * 지정 지점으로 견인한다. 견인 중에는 AI 조향과 적-적 분리를 끈다 —
 * 그래야 빽빽한 기둥으로 뭉치고 지터가 사라진다. 연출이 공짜로 좋아진다.
 *
 * @param ring 목표 링 반경. 이 반경까지만 접근한다(중심 겹침 폭발 방지).
 */
export function applyPull(
  pool: EnemyPool,
  i: number,
  now: number,
  x: number,
  y: number,
  duration: number,
  speed: number,
  ring: number,
): void {
  pool.pullX[i] = x
  pool.pullY[i] = y
  pool.pullUntil[i] = now + duration
  pool.pullSpeed[i] = speed
  pool.pullRing[i] = ring
}

/** 현재 이동 속도 배수. 둔화와 속박이 여기 모인다. */
export function speedMultiplier(pool: EnemyPool, i: number, now: number): number {
  if (pool.rootUntil[i]! > now) return 0
  if (pool.slowUntil[i]! > now) return pool.slowMul[i]!
  return 1
}

/**
 * 임펄스를 한 틱 적분하고 감쇠시킨다.
 * @returns 이번 틱의 변위
 */
export function integrateImpulse(pool: EnemyPool, i: number, out: { x: number; y: number }): void {
  const vx = pool.pushVx[i]!
  const vy = pool.pushVy[i]!
  if (vx === 0 && vy === 0) {
    out.x = 0
    out.y = 0
    return
  }
  out.x = vx * DT
  out.y = vy * DT

  const k = Math.exp(-IMPULSE_DECAY * DT)
  const nx = vx * k
  const ny = vy * k
  // 임계 이하는 0으로 눌러 부동소수 잔여가 영원히 남지 않게 한다.
  pool.pushVx[i] = Math.abs(nx) < 0.01 ? 0 : nx
  pool.pushVy[i] = Math.abs(ny) < 0.01 ? 0 : ny
}
