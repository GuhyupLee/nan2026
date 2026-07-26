/** 2D 벡터. 시뮬레이션은 XZ 평면(높이 없음)에서만 돌아간다. */
export interface Vec2 {
  x: number
  y: number
}

export function vec2(x = 0, y = 0): Vec2 {
  return { x, y }
}

export function copy(out: Vec2, v: Vec2): Vec2 {
  out.x = v.x
  out.y = v.y
  return out
}

export function length(v: Vec2): number {
  return Math.hypot(v.x, v.y)
}

export function lengthSq(v: Vec2): number {
  return v.x * v.x + v.y * v.y
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function distanceSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

/** 제자리 정규화. 길이가 0이면 0벡터를 유지한다. */
export function normalize(out: Vec2): Vec2 {
  const l = Math.hypot(out.x, out.y)
  if (l > 1e-9) {
    out.x /= l
    out.y /= l
  }
  return out
}

/** a를 b 쪽으로 t만큼 선형 보간. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v
}

/**
 * 각도를 -PI..PI 범위로 정규화.
 * 캐릭터 회전 보간에서 -179도 → 179도 이동이 한 바퀴 도는 것을 막는다.
 */
export function wrapAngle(a: number): number {
  const TAU = Math.PI * 2
  let r = (a + Math.PI) % TAU
  if (r < 0) r += TAU
  return r - Math.PI
}

/** 각도 보간. 최단 방향으로 돈다. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t
}
