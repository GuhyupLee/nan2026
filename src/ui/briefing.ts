/**
 * 결과 브리핑 연출 — 줄이 하나씩 뜨고 숫자가 올라간다.
 *
 * ## 왜 순차인가
 *
 * 결과를 한꺼번에 던지면 눈이 어디를 볼지 모른다. 한 줄씩 들어오면 시선이
 * 자연히 위에서 아래로 흐르고, 그 사이에 방금 무슨 일이 있었는지 정리된다.
 * 숫자가 0에서 올라가는 건 장식이 아니라 **같은 이유의 연장**이다 — 값이
 * 확정되는 순간을 눈이 따라가면 그 수가 기억에 남는다.
 *
 * ## 연출은 절대 조작을 막지 않는다
 *
 * 결과를 보자마자 다시 하려는 사람을 1초 기다리게 하면 안 된다. 그래서
 * 이 모듈은 **투명도와 위치만** 건드린다. `pointer-events`를 끄지 않고,
 * 버튼은 첫 프레임부터 눌리며 포커스도 즉시 간다. 아무 입력이나 들어오면
 * 남은 연출을 즉시 끝낸다.
 *
 * ## 스크린 리더
 *
 * 올라가는 숫자를 실시간으로 읽으면 소음이다. 카운트업 중인 노드는
 * `aria-hidden`으로 감추고 최종값을 담은 형제 노드를 따로 두어, 보조 기술은
 * 처음부터 확정된 값 하나만 읽는다.
 */

/** 줄 사이 간격(ms). 너무 짧으면 동시에 뜬 것처럼 보이고 길면 지루하다. */
const STEP_MS = 95

/** 큰 수는 오래, 작은 수는 짧게 굴린다. */
const COUNT_MS_LARGE = 680
const COUNT_MS_SMALL = 380
/** 이 값을 넘으면 "큰 수"로 본다. */
const LARGE_THRESHOLD = 400

export type CountFormat = 'number' | 'time' | 'percent'

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

function formatCount(value: number, format: CountFormat): string {
  if (format === 'time') {
    const total = Math.max(0, Math.floor(value))
    const minutes = Math.floor(total / 60)
    const seconds = total % 60
    return `${minutes}:${String(seconds).padStart(2, '0')}`
  }
  if (format === 'percent') return `${Math.round(value)}%`
  return Math.round(value).toLocaleString('ko-KR')
}

/**
 * 카운트업 대상을 표시한다.
 *
 * `data-count`에 목표값, `data-count-format`에 표기 방식을 넣어 두면
 * `runBriefing`이 찾아서 굴린다. 마크업을 만드는 쪽에서 최종 텍스트를 이미
 * 넣어 두므로, 연출이 꺼진 환경에서는 아무것도 하지 않아도 값이 맞다.
 */
export function countAttrs(value: number, format: CountFormat = 'number'): string {
  return ` data-count="${value}" data-count-format="${format}"`
}

interface Countable {
  node: HTMLElement
  target: number
  format: CountFormat
  /** 마크업이 이미 갖고 있던 최종 문자열. 건너뛸 때 그대로 되돌린다. */
  finalText: string
}

export interface BriefingHandle {
  /** 남은 연출을 즉시 끝내고 최종 상태로 만든다. 여러 번 불러도 안전하다. */
  finish(): void
  dispose(): void
}

/**
 * 브리핑을 시작한다.
 *
 * @param root `[data-brief]` 요소들을 담고 있는 컨테이너.
 */
export function runBriefing(root: HTMLElement): BriefingHandle {
  const steps = Array.from(
    root.querySelectorAll<HTMLElement>('[data-brief]'),
  ).sort(
    (a, b) => Number(a.dataset.brief ?? 0) - Number(b.dataset.brief ?? 0),
  )

  const countables: Countable[] = Array.from(
    root.querySelectorAll<HTMLElement>('[data-count]'),
  ).map((node) => ({
    node,
    target: Number(node.dataset.count ?? 0),
    format: (node.dataset.countFormat as CountFormat) ?? 'number',
    finalText: node.textContent ?? '',
  }))

  // 카운트업 중에는 보조 기술이 숫자를 반복해 읽지 않게 감춘다. 최종값은
  // 마크업이 형제 노드나 aria-label로 이미 노출하고 있다.
  for (const item of countables) item.node.setAttribute('aria-hidden', 'true')

  let finished = false
  // setTimeout의 반환 타입이 브라우저(number)와 node(Timeout) 사이에서
  // 갈리므로 반환값 타입을 그대로 받아 둔다.
  const timers: ReturnType<typeof setTimeout>[] = []
  let raf = 0

  const finish = (): void => {
    if (finished) return
    finished = true
    for (const id of timers) clearTimeout(id)
    timers.length = 0
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    for (const step of steps) step.dataset.briefState = 'in'
    for (const item of countables) {
      item.node.textContent = item.finalText
      item.node.removeAttribute('aria-hidden')
    }
  }

  if (prefersReducedMotion()) {
    // 움직임을 줄여 달라고 했으면 연출 자체를 하지 않는다. 값을 천천히
    // 보여 주는 것도 움직임이다.
    finish()
    return { finish, dispose: finish }
  }

  for (const step of steps) step.dataset.briefState = 'out'

  steps.forEach((step, index) => {
    timers.push(
      globalThis.setTimeout(() => {
        step.dataset.briefState = 'in'
      }, index * STEP_MS),
    )
  })

  // 카운트업은 그 줄이 실제로 나타난 뒤에 시작해야 한다. 미리 굴리면
  // 아직 보이지도 않는 숫자가 다 올라가 버린다.
  for (const item of countables) {
    const owner = item.node.closest<HTMLElement>('[data-brief]')
    const stepIndex = owner ? steps.indexOf(owner) : 0
    const delay = Math.max(0, stepIndex) * STEP_MS
    const duration =
      Math.abs(item.target) >= LARGE_THRESHOLD ? COUNT_MS_LARGE : COUNT_MS_SMALL

    item.node.textContent = formatCount(0, item.format)

    const settle = (): void => {
      // 마지막은 보간값이 아니라 원래 문자열을 그대로 쓴다. 반올림 오차로
      // 1이 모자란 총점이 뜨는 것을 원천 차단한다.
      item.node.textContent = item.finalText
      item.node.removeAttribute('aria-hidden')
    }

    timers.push(
      globalThis.setTimeout(() => {
        const startedAt = performance.now()
        const tick = (): void => {
          if (finished) return
          const t = Math.min(1, (performance.now() - startedAt) / duration)
          if (t >= 1) {
            settle()
            return
          }
          // 끝에서 감속. 선형이면 숫자가 툭 멈춰 기계적으로 보인다.
          item.node.textContent = formatCount(item.target * (1 - (1 - t) ** 3), item.format)
          raf = requestAnimationFrame(tick)
        }
        tick()
      }, delay),
    )

    // rAF만 믿으면 안 된다.
    //
    // 브라우저는 탭이 백그라운드로 가면 `requestAnimationFrame`을 멈춘다.
    // 결과 화면을 띄운 채 알트탭했다가 돌아오면 숫자가 **0에 멈춘 채**
    // 남는다 — 연출이 아니라 오류로 보인다. 시간 기반 타이머로 최종값을
    // 한 번 더 확정한다. rAF가 정상이면 이미 같은 값이라 아무 일도 없다.
    timers.push(globalThis.setTimeout(settle, delay + duration + 60))
  }

  return { finish, dispose: finish }
}
