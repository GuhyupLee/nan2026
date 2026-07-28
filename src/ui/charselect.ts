import { getPassiveDef } from '../content/skills.ts'
import type { PlayerClass } from '../sim/types.ts'

/**
 * 캐릭터 선택 화면.
 *
 * 심사자가 보는 첫 화면이다. 두 클래스의 색 대비(시안 vs 크림슨)가
 * 그대로 정체성이므로 UI가 그걸 증폭한다.
 *
 * 5분 게임에서 두 번째 판을 돌릴 이유가 여기서 나온다 —
 * 고르지 않은 쪽이 계속 눈에 남아야 한다.
 */

export interface ClassOption {
  id: PlayerClass
  /** 표시 이름. */
  name: string
  /** 부제. */
  epithet: string
  /** 역할 배지. */
  role: string
  /** 한 줄 소개. 어떻게 노는 캐릭터인지가 즉시 와야 한다. */
  tagline: string
  /** 특성 태그 3개 정도. */
  traits: string[]
  /** 초상 파일명 (public/art 기준). */
  portrait: string
  /** 클래스 강조색. 인게임 이펙트도 이 색을 따른다. */
  accent: string
  /** 단축키 라벨. */
  hotkey: string
}

/**
 * 기본 클래스 구성.
 *
 * 팔레트는 생성된 초상에서 뽑았다. 인게임 저폴리 모델과 스킬 이펙트가
 * 같은 색을 쓰면 2D 초상과 3D 모델의 정밀도가 달라도 같은 캐릭터로 읽힌다.
 */
export const CLASS_OPTIONS: ClassOption[] = [
  {
    id: 'ranged',
    name: '루멘',
    epithet: '빛의 마법사',
    role: '원거리',
    tagline: '거리를 두고 빛으로 지운다. 몰려드는 적을 한 점에 모아 터뜨린다.',
    traits: ['안전한 거리', '광역 섬멸', '느린 시작'],
    portrait: 'lumen-portrait-v2.webp',
    accent: '#b8d2cf',
    hotkey: '1',
  },
  {
    id: 'melee',
    name: '월아',
    epithet: '초승달의 검사',
    role: '근접',
    tagline: '파고들어 베어낸다. 벨수록 빨라지고, 멈추면 죽는다.',
    traits: ['높은 체력', '연속 처치', '높은 위험'],
    portrait: 'wola-portrait-v2.webp',
    accent: '#c47870',
    hotkey: '2',
  },
]

function createDecisionSummary(option: ClassOption): HTMLElement {
  const summary = document.createElement('div')
  summary.className = 'character-summary'

  const playstyle = document.createElement('div')
  playstyle.className = 'playstyle-summary'
  const playstyleLabel = document.createElement('span')
  playstyleLabel.className = 'summary-label'
  playstyleLabel.textContent = '플레이 스타일'
  const playstyleCopy = document.createElement('p')
  playstyleCopy.textContent = option.tagline
  playstyle.append(playstyleLabel, playstyleCopy)
  summary.appendChild(playstyle)

  const strengths = document.createElement('div')
  strengths.className = 'strengths-summary'
  const strengthsLabel = document.createElement('span')
  strengthsLabel.className = 'summary-label'
  strengthsLabel.textContent = '강점'
  const strengthsList = document.createElement('div')
  strengthsList.className = 'traits strengths-list'
  strengthsList.setAttribute('role', 'list')
  for (const strength of option.traits.slice(0, 2)) {
    const item = document.createElement('span')
    item.setAttribute('role', 'listitem')
    item.textContent = strength
    strengthsList.appendChild(item)
  }
  strengths.append(strengthsLabel, strengthsList)
  summary.appendChild(strengths)

  const passiveDef = getPassiveDef(option.id)
  const passive = document.createElement('div')
  passive.className = 'passive-preview passive-summary'
  const passiveLabel = document.createElement('span')
  passiveLabel.className = 'summary-label'
  passiveLabel.textContent = '패시브'
  const passiveName = document.createElement('strong')
  passiveName.textContent = passiveDef.name
  const passiveCopy = document.createElement('p')
  passiveCopy.textContent = passiveDef.oneLiner
  passive.append(passiveLabel, passiveName, passiveCopy)
  summary.appendChild(passive)

  return summary
}

/**
 * 선택 화면을 띄우고 고를 때까지 기다린다.
 * 고른 클래스를 resolve하고 화면은 스스로 사라진다.
 */
export function showCharacterSelect(
  parent: HTMLElement,
  options: readonly ClassOption[] = CLASS_OPTIONS,
  onSettings?: () => Promise<void> | void,
  onPreview?: (id: PlayerClass) => void,
): Promise<PlayerClass> {
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'charselect charselect-guided'
    root.dataset.selectionMode = 'confirm'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'charselect-title')

    const title = document.createElement('div')
    title.className = 'title'

    const titleCopy = document.createElement('div')
    titleCopy.className = 'title-copy'
    titleCopy.innerHTML =
      `<span class="charselect-kicker">전투 준비</span>` +
      `<h2 id="charselect-title">캐릭터 선택</h2>` +
      `<p>플레이 스타일을 비교한 뒤 시작할 캐릭터를 고르세요.</p>`
    title.appendChild(titleCopy)

    let done = false
    let previewTimer: number | null = null
    let previewTarget: PlayerClass | null = null
    let suppressInitialFocusPreview = true

    const cancelPreview = (id?: PlayerClass): void => {
      if (id && previewTarget !== id) return
      if (previewTimer !== null) window.clearTimeout(previewTimer)
      previewTimer = null
      previewTarget = null
    }

    const schedulePreview = (id: PlayerClass): void => {
      if (done || settingsOpen || suppressInitialFocusPreview || !onPreview) return
      cancelPreview()
      previewTarget = id
      previewTimer = window.setTimeout(() => {
        previewTimer = null
        previewTarget = null
        if (!done && !settingsOpen) onPreview(id)
      }, 140)
    }

    let settingsOpen = false
    if (onSettings) {
      const settings = document.createElement('button')
      settings.className = 'charselect-settings'
      settings.type = 'button'
      settings.textContent = '설정'

      const openSettings = async (): Promise<void> => {
        if (done || settingsOpen) return
        settingsOpen = true
        cancelPreview()
        window.removeEventListener('keydown', onKey)
        try {
          await onSettings()
        } finally {
          settingsOpen = false
          if (!done) {
            window.addEventListener('keydown', onKey)
            settings.focus()
          }
        }
      }

      settings.addEventListener('click', () => void openSettings())
      title.appendChild(settings)
    }
    root.appendChild(title)

    const cards = document.createElement('div')
    cards.className = 'cards character-choice-list'
    cards.setAttribute('role', 'list')
    root.appendChild(cards)

    const foot = document.createElement('div')
    foot.className = 'footnote'
    foot.textContent = window.matchMedia('(pointer: coarse)').matches
      ? '카드를 고른 뒤 스킬을 확인하고 전투 시작'
      : '카드 선택 → 스킬 확인 → 전투 시작 · 숫자 1 / 2 빠른 선택'
    root.appendChild(foot)

    const choose = (id: PlayerClass): void => {
      if (done || settingsOpen) return
      done = true
      cancelPreview()
      window.removeEventListener('keydown', onKey)
      const finish = (): void => {
        root.remove()
        resolve(id)
      }
      // 다음 모달은 이 선택창이 완전히 사라진 뒤 연다. 두 aria-modal과 같은
      // 제목 ID가 잠시라도 겹치면 빠른 Escape에서 포커스가 이전 창으로 샌다.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        finish()
      } else {
        const active = document.activeElement
        if (active instanceof HTMLElement && root.contains(active)) active.blur()
        root.inert = true
        root.setAttribute('aria-hidden', 'true')
        root.removeAttribute('aria-modal')
        root.classList.add('closing')
        window.setTimeout(finish, 280)
      }
    }

    const cardControls = new Map<
      PlayerClass,
      { card: HTMLElement; confirm: HTMLButtonElement; selectLabel: HTMLElement }
    >()
    let pendingSelection: PlayerClass | null = null

    const selectForConfirmation = (id: PlayerClass, focusConfirm = false): void => {
      if (done || settingsOpen) return
      const next = cardControls.get(id)
      if (!next) return

      const changed = pendingSelection !== id
      pendingSelection = id
      root.classList.add('has-pending-selection')
      root.dataset.selectedClass = id

      for (const [optionId, control] of cardControls) {
        const selected = optionId === id
        control.card.classList.toggle('is-selected', selected)
        control.card.dataset.selected = selected ? 'true' : 'false'
        control.confirm.disabled = !selected
        control.selectLabel.textContent = selected ? '선택됨' : '선택'
        if (selected) control.card.setAttribute('aria-current', 'true')
        else control.card.removeAttribute('aria-current')
      }

      if (focusConfirm) next.confirm.focus()
      if (changed) {
        cancelPreview()
        if (onPreview) onPreview(id)
      }
    }

    for (const [index, opt] of options.entries()) {
      const card = document.createElement('article')
      card.className = 'charcard character-choice'
      card.tabIndex = 0
      card.setAttribute('role', 'listitem')
      card.style.setProperty('--accent', opt.accent)
      card.dataset.class = opt.id
      const passive = getPassiveDef(opt.id)
      const strengths = opt.traits.slice(0, 2)
      card.setAttribute(
        'aria-label',
        `${opt.name}, ${opt.epithet}. 플레이 스타일: ${opt.tagline}. ` +
          `강점: ${strengths.join(', ')}. ` +
          `패시브 ${passive.name}: ${passive.oneLiner}. ` +
          `선택한 뒤 스킬을 확인하고 전투를 시작합니다.`,
      )

      const img = document.createElement('img')
      img.className = 'portrait'
      img.src = `${import.meta.env.BASE_URL}art/${opt.portrait}`
      img.alt = ''
      // 첫 화면이라 지연 로드하지 않는다. 여기서 늦으면 첫인상이 무너진다.
      img.decoding = 'async'
      card.appendChild(img)

      const veil = document.createElement('div')
      veil.className = 'veil'
      card.appendChild(veil)

      const hotkey = document.createElement('div')
      hotkey.className = 'hotkey'
      hotkey.setAttribute('aria-hidden', 'true')
      hotkey.innerHTML =
        `<small>0${index + 1}</small>` +
        `<span>${opt.hotkey}</span>`
      card.appendChild(hotkey)

      const info = document.createElement('div')
      info.className = 'info character-choice-copy'
      info.innerHTML =
        `<span class="role">${opt.role}</span>` +
        `<h3>${opt.name}</h3>` +
        `<div class="epithet">${opt.epithet}</div>`
      info.appendChild(createDecisionSummary(opt))
      card.appendChild(info)

      const selectLabel = document.createElement('div')
      selectLabel.className = 'select-label'
      selectLabel.setAttribute('aria-hidden', 'true')
      selectLabel.textContent = '선택'
      card.appendChild(selectLabel)

      const confirm = document.createElement('button')
      confirm.className = 'character-confirm'
      confirm.type = 'button'
      confirm.disabled = true
      confirm.textContent = `${opt.name} 선택 · 스킬 확인`
      confirm.setAttribute('aria-label', `${opt.name} 선택 후 스킬 확인`)
      confirm.addEventListener('click', (event) => {
        event.stopPropagation()
        choose(opt.id)
      })
      card.appendChild(confirm)

      cardControls.set(opt.id, { card, confirm, selectLabel })
      card.addEventListener('pointerenter', () => schedulePreview(opt.id))
      card.addEventListener('pointerleave', () => cancelPreview(opt.id))
      card.addEventListener('focusin', () => schedulePreview(opt.id))
      card.addEventListener('focusout', (event) => {
        if (!(event.relatedTarget instanceof Node) || !card.contains(event.relatedTarget)) {
          cancelPreview(opt.id)
        }
      })
      card.addEventListener('click', () => {
        card.focus({ preventScroll: true })
        selectForConfirmation(opt.id)
      })
      card.addEventListener('keydown', (event) => {
        if (event.target !== card) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          selectForConfirmation(opt.id, true)
          return
        }

        const direction =
          event.key === 'ArrowRight' || event.key === 'ArrowDown'
            ? 1
            : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
              ? -1
              : 0
        if (direction === 0) return
        event.preventDefault()
        const nextIndex = (index + direction + options.length) % options.length
        const nextOption = options[nextIndex]
        if (nextOption) cardControls.get(nextOption.id)?.card.focus()
      })
      cards.appendChild(card)
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || settingsOpen) return
      const hit = options.find((o) => o.hotkey === e.key)
      if (hit) choose(hit.id)
    }
    window.addEventListener('keydown', onKey)

    parent.appendChild(root)
    ;(cards.firstElementChild as HTMLElement | null)?.focus()
    // The accessibility focus is not download intent; later keyboard/pointer dwell is.
    suppressInitialFocusPreview = false
  })
}
