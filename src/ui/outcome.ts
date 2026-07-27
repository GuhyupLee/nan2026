import type { World } from '../sim/types.ts'
import { trapFocus } from './focus-trap.ts'

export type GameOutcome = Exclude<World['outcome'], 'alive'>
export type OutcomeAction = 'restart' | 'menu'

interface OutcomeCopy {
  eyebrow: string
  title: string
  description: string
}

const COPY: Record<GameOutcome, OutcomeCopy> = {
  dead: {
    eyebrow: 'RUN OVER',
    title: '쓰러졌습니다',
    description: '호흡을 고르고, 같은 전장에 다시 도전하세요.',
  },
  timeout: {
    eyebrow: 'TIME OVER',
    title: '시간이 다 됐습니다',
    description: '5분 안에 보스를 쓰러뜨리지 못했습니다. 같은 전장에 다시 도전하세요.',
  },
  victory: {
    eyebrow: 'VICTORY',
    title: '승리했습니다',
    description: '전장을 지배했습니다. 같은 조건으로 다시 도전할 수 있습니다.',
  },
}

/**
 * 결과 화면을 띄우고 재시작 의사가 들어올 때까지 기다린다.
 *
 * R은 궁극기 입력이므로 결과 화면에서도 쓰지 않는다. Enter/Space는 포커스된
 * 네이티브 버튼이 처리하므로, 메인 메뉴 버튼에서도 올바른 동작을 유지한다.
 */
export function showOutcome(parent: HTMLElement, outcome: GameOutcome): Promise<OutcomeAction> {
  return new Promise((resolve) => {
    const copy = COPY[outcome]
    const root = document.createElement('div')
    root.className = 'outcome'
    root.dataset.result = outcome
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'outcome-title')

    const panel = document.createElement('div')
    panel.className = 'panel'
    panel.innerHTML =
      `<div class="eyebrow">${copy.eyebrow}</div>` +
      `<h2 id="outcome-title">${copy.title}</h2>` +
      `<p>${copy.description}</p>`
    root.appendChild(panel)

    const actions = document.createElement('div')
    actions.className = 'actions'
    panel.appendChild(actions)

    const restart = document.createElement('button')
    restart.className = 'restart'
    restart.type = 'button'
    restart.innerHTML =
      `<span>같은 캐릭터로 재시작</span>` +
      `<small>ENTER 또는 SPACE</small>`
    actions.appendChild(restart)

    const menu = document.createElement('button')
    menu.className = 'menu'
    menu.type = 'button'
    menu.innerHTML =
      `<span>메인 메뉴</span>` +
      `<small>ESC</small>`
    actions.appendChild(menu)

    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = '재시작은 같은 캐릭터 · 같은 시드'
    panel.appendChild(note)

    let done = false
    let releaseFocusTrap = (): void => {}
    const finish = (action: OutcomeAction): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
      releaseFocusTrap()
      root.remove()
      resolve(action)
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat) return
      if (e.key === 'Escape') {
        e.preventDefault()
        finish('menu')
      }
    }

    restart.addEventListener('click', () => finish('restart'))
    menu.addEventListener('click', () => finish('menu'))
    window.addEventListener('keydown', onKey)
    parent.appendChild(root)
    releaseFocusTrap = trapFocus(root)
    restart.focus()
  })
}
