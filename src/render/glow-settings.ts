/**
 * 발광 강도 설정.
 *
 * ## 왜 필요한가
 *
 * 이 게임은 어두운 월식 아레나에서 발광 이펙트로 정보를 전달한다. 스킬 장판,
 * 예광선, 칼날 궤적, 보스 예고, 화면 틴트, 등불이 전부 빛난다. 그 밀도가
 * 연출로는 맞지만 **한 화면에 열 개 넘게 겹치면 눈이 아프다** — 특히 밝은
 * 방에서 오래 하거나 빛 민감성이 있는 사람에게는 그냥 못 하는 게임이 된다.
 *
 * `prefers-reduced-motion`은 움직임을 줄일 뿐 밝기는 건드리지 않으므로 이
 * 문제를 덮지 못한다. 별도 축이 필요하다.
 *
 * ## 왜 끄기가 아니라 슬라이더인가
 *
 * 발광을 0으로 만들면 정보가 사라진다 — 보스 돌진 예고선이 안 보이면 그건
 * 접근성이 아니라 난이도 상승이다. 그래서 **완전히 끌 수 없는 하한**을 둔다.
 * 최소값에서도 경고와 장판은 읽히고, 줄어드는 것은 번짐(블룸)·화면 틴트·
 * 장식성 발광이다.
 */

const STORAGE_KEY = 'myeongwol.glow.v1'

/** 최소 강도. 이보다 낮추면 전투 정보가 사라진다. */
export const GLOW_MIN = 0.35
export const GLOW_MAX = 1
export const GLOW_DEFAULT = 1

function clamp(value: number): number {
  if (!Number.isFinite(value)) return GLOW_DEFAULT
  return Math.min(GLOW_MAX, Math.max(GLOW_MIN, value))
}

let current = GLOW_DEFAULT
let loaded = false
const listeners = new Set<(value: number) => void>()

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (raw !== null && raw !== undefined) current = clamp(Number(raw))
  } catch {
    // 사생활 보호 모드 등에서 localStorage가 막힐 수 있다. 기본값으로 간다.
  }
}

export function getGlowIntensity(): number {
  load()
  return current
}

export function setGlowIntensity(value: number): void {
  load()
  const next = clamp(value)
  if (next === current) return
  current = next
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, String(next))
  } catch {
    /* 저장 실패는 이번 판에만 영향을 준다. */
  }
  for (const listener of listeners) listener(next)
}

/**
 * 값이 바뀔 때 알림을 받는다.
 *
 * 설정 패널은 전투 중(일시정지)에도 열리므로, 슬라이더를 움직이는 즉시
 * 화면이 반응해야 무엇을 조절하는지 알 수 있다. 닫을 때 한 번 적용하면
 * 사용자는 값을 보고 고르는 게 아니라 짐작해서 고르게 된다.
 */
export function onGlowIntensityChange(
  listener: (value: number) => void,
): () => void {
  load()
  listeners.add(listener)
  listener(current)
  return () => listeners.delete(listener)
}
