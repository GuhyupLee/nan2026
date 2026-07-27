const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((element) => {
    if (element.closest('[hidden], [inert]')) return false
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden'
  })
}

/**
 * 모달 안에서 Tab 포커스를 순환시킨다.
 *
 * document 캡처 단계에서 받아 포커스가 외부로 옮겨진 경우에도 다음 Tab 입력으로
 * 모달 안에 되돌린다. 반환한 정리 함수는 모달을 숨기거나 제거하기 전에 호출한다.
 */
export function trapFocus(root: HTMLElement): () => void {
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Tab' || event.defaultPrevented) return

    const focusable = focusableElements(root)
    if (focusable.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }

    const first = focusable[0]!
    const last = focusable[focusable.length - 1]!
    const active = document.activeElement

    if (!root.contains(active)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
      return
    }

    if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  if (!root.hasAttribute('tabindex')) root.tabIndex = -1
  document.addEventListener('keydown', onKeyDown, true)

  let active = true
  return () => {
    if (!active) return
    active = false
    document.removeEventListener('keydown', onKeyDown, true)
  }
}
