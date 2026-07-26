/**
 * 시드 기반 결정론적 난수 생성기 (mulberry32).
 *
 * Math.random()을 시뮬레이션 안에서 절대 쓰지 않는다.
 * 같은 시드 + 같은 입력 시퀀스 = 같은 결과여야 헤드리스 밸런싱이 성립한다.
 */
export interface Rng {
  /** 0 이상 1 미만. */
  next(): number
  /** 현재 내부 상태. 리플레이·디버깅용. */
  state(): number
}

export function createRng(seed: number): Rng {
  let s = seed >>> 0
  return {
    next() {
      s = (s + 0x6d2b79f5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    state() {
      return s
    },
  }
}

/** min 이상 max 미만의 실수. */
export function randRange(rng: Rng, min: number, max: number): number {
  return min + rng.next() * (max - min)
}

/** min 이상 max 이하의 정수. */
export function randInt(rng: Rng, min: number, max: number): number {
  return Math.floor(min + rng.next() * (max - min + 1))
}

/** 0..TAU 범위의 각도. */
export function randAngle(rng: Rng): number {
  return rng.next() * Math.PI * 2
}

/** 배열에서 하나를 균등하게 고른다. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng.next() * items.length)]!
}
