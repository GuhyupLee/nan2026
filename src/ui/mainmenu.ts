import type { RunDifficulty } from '../sim/types.ts'

/**
 * 키아트를 전면에 둔 메인 메뉴.
 *
 * 월식 포스터 위에 얇은 편집선과 활자만 얹는다. 정보 패널을 따로 만들지
 * 않아 새 키아트가 첫인상을 주도하도록 한다.
 */
export function showMainMenu(
  parent: HTMLElement,
  onSettings: () => Promise<void> | void,
  onRecords: () => Promise<void> | void,
  onMeta?: () =>
    | Promise<{ moonlight: number; metaRanks?: number }>
    | { moonlight: number; metaRanks?: number },
  initialMoonlight = 0,
  hardModeUnlocked = false,
  fullMoonModeUnlocked = false,
  initialMetaRanks = 0,
): Promise<RunDifficulty> {
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'mainmenu'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'mainmenu-title')

    const keyart = document.createElement('img')
    keyart.className = 'mainmenu-keyart'
    keyart.src = `${import.meta.env.BASE_URL}art/main-menu-keyart-v2.webp`
    keyart.alt = ''
    keyart.decoding = 'async'
    keyart.fetchPriority = 'high'
    root.appendChild(keyart)

    const shade = document.createElement('div')
    shade.className = 'mainmenu-shade'
    shade.setAttribute('aria-hidden', 'true')
    root.appendChild(shade)

    const content = document.createElement('main')
    content.className = 'mainmenu-content'
    root.appendChild(content)

    const eyebrow = document.createElement('div')
    eyebrow.className = 'mainmenu-eyebrow'
    eyebrow.textContent = 'ACTION SURVIVAL'
    content.appendChild(eyebrow)

    const titleRow = document.createElement('div')
    titleRow.className = 'mainmenu-title-row'
    content.appendChild(titleRow)

    const mark = document.createElement('img')
    mark.className = 'mainmenu-mark'
    mark.src = `${import.meta.env.BASE_URL}art/myeongwol-mark.webp`
    mark.alt = ''
    mark.decoding = 'async'
    const title = document.createElement('h1')
    title.id = 'mainmenu-title'
    title.textContent = '명월'
    titleRow.appendChild(title)
    titleRow.appendChild(mark)

    const tagline = document.createElement('p')
    tagline.className = 'mainmenu-tagline'
    tagline.textContent = '달은 원을 파고, 해는 선을 긋는다.'
    content.appendChild(tagline)

    const rule = document.createElement('div')
    rule.className = 'mainmenu-rule'
    rule.setAttribute('aria-hidden', 'true')
    rule.innerHTML = '<span>5분 생존 · 3:30 보스 · 2페이즈</span><i></i>'
    content.appendChild(rule)

    let selectedDifficulty: RunDifficulty = 'normal'
    let metaRanks = initialMetaRanks
    const difficulties = document.createElement('div')
    difficulties.className = 'mainmenu-difficulties'
    difficulties.setAttribute('role', 'radiogroup')
    difficulties.setAttribute('aria-label', '도전 스테이지')
    content.appendChild(difficulties)
    const difficultyButtons = new Map<RunDifficulty, HTMLButtonElement>()
    const stageOrder: readonly RunDifficulty[] = ['normal', 'hard', 'fullmoon']
    const isStageUnlocked = (mode: RunDifficulty): boolean =>
      mode === 'normal' ||
      (mode === 'hard' ? hardModeUnlocked : fullMoonModeUnlocked)

    for (const mode of stageOrder) {
      const button = document.createElement('button')
      button.className = 'mainmenu-difficulty'
      button.type = 'button'
      button.dataset.mode = mode
      button.setAttribute('role', 'radio')
      difficultyButtons.set(mode, button)
      difficulties.appendChild(button)
    }

    const renderDifficulty = (): void => {
      for (const mode of stageOrder) {
        const button = difficultyButtons.get(mode)!
        const selected = selectedDifficulty === mode
        const unlocked = isStageUnlocked(mode)
        const label =
          mode === 'normal' ? '보통' : mode === 'hard' ? '월식' : '만월'
        const description =
          mode === 'normal'
            ? '5:00 제한 · 3:30 보스 · 2페이즈'
            : mode === 'hard'
              ? unlocked
                ? '적 속도 +10% · 접촉 피해 +25% · 점수 ×1.5'
                : '보통 최초 클리어 후 해금'
              : unlocked
                ? `10:00 보스 등장 · 12:00 마감 · 3페이즈 · 전승 ${metaRanks}/40`
                : '월식 최초 클리어 후 해금 · 전승 40/40 권장'
        button.dataset.selected = String(selected)
        button.tabIndex = selected ? 0 : -1
        button.setAttribute('aria-checked', String(selected))
        button.setAttribute('aria-disabled', String(!unlocked))
        button.innerHTML =
          `<span><small>스테이지 ${mode === 'normal' ? 'I' : mode === 'hard' ? 'II' : 'III'}</small><b>${label}</b></span>` +
          `<em>${description}</em>` +
          `<i aria-hidden="true">${unlocked ? (selected ? '선택됨' : '도전') : '잠김'}</i>`
      }
      rule.innerHTML =
        selectedDifficulty === 'fullmoon'
          ? '<span>10:00 보스 등장 · 12:00 마감 · 3페이즈</span><i></i>'
          : selectedDifficulty === 'hard'
            ? '<span>5분 월식 · 강화된 적 · 보스 2페이즈</span><i></i>'
            : '<span>5분 생존 · 3:30 보스 · 2페이즈</span><i></i>'
    }
    renderDifficulty()

    const actions = document.createElement('div')
    actions.className = 'mainmenu-actions'
    content.appendChild(actions)

    const start = document.createElement('button')
    start.className = 'mainmenu-action primary'
    start.type = 'button'
    start.innerHTML =
      '<span class="action-index">01</span>' +
      '<span class="action-copy"><b>게임 시작</b><small>ENTER</small></span>' +
      '<span class="action-arrow" aria-hidden="true">↗</span>'
    actions.appendChild(start)

    const records = document.createElement('button')
    records.className = 'mainmenu-action'
    records.type = 'button'
    records.innerHTML =
      '<span class="action-index">02</span>' +
      '<span class="action-copy"><b>점수 기록</b><small>최고 기록</small></span>' +
      '<span class="action-arrow" aria-hidden="true">＋</span>'
    actions.appendChild(records)

    const settings = document.createElement('button')
    settings.className = 'mainmenu-action'
    settings.type = 'button'
    settings.innerHTML =
      '<span class="action-index">03</span>' +
      '<span class="action-copy"><b>설정</b><small>오디오 · 조작</small></span>' +
      '<span class="action-arrow" aria-hidden="true">＋</span>'
    actions.appendChild(settings)

    let meta: HTMLButtonElement | null = null
    let metaBalance: HTMLElement | null = null
    if (onMeta) {
      meta = document.createElement('button')
      meta.className = 'mainmenu-action legacy'
      meta.type = 'button'
      meta.innerHTML =
        '<span class="action-index">04</span>' +
        '<span class="action-copy"><b>월광 전승</b>' +
        `<small data-meta-balance>월광 ${initialMoonlight.toLocaleString('ko-KR')}</small></span>` +
        '<span class="action-arrow" aria-hidden="true">＋</span>'
      metaBalance = meta.querySelector('[data-meta-balance]')
      actions.appendChild(meta)
    }

    let done = false
    let subviewOpen = false

    const finish = (): void => {
      if (done || subviewOpen) return
      done = true
      window.removeEventListener('keydown', onNumberShortcut)
      // 모션 감소 설정에서는 퇴장 애니메이션이 없으므로 220ms를 기다리지 않는다.
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        root.remove()
        resolve(selectedDifficulty)
        return
      }
      root.classList.add('closing')
      window.setTimeout(() => {
        root.remove()
        resolve(selectedDifficulty)
      }, 220)
    }

    const openSettings = async (): Promise<void> => {
      if (done || subviewOpen) return
      subviewOpen = true
      try {
        await onSettings()
      } finally {
        subviewOpen = false
        if (!done) settings.focus()
      }
    }

    const openRecords = async (): Promise<void> => {
      if (done || subviewOpen) return
      subviewOpen = true
      try {
        await onRecords()
      } finally {
        subviewOpen = false
        if (!done) records.focus()
      }
    }

    const openMeta = async (): Promise<void> => {
      if (!onMeta || !meta || done || subviewOpen) return
      subviewOpen = true
      try {
        const next = await onMeta()
        if (metaBalance) {
          metaBalance.textContent = `월광 ${next.moonlight.toLocaleString('ko-KR')}`
        }
        if (typeof next.metaRanks === 'number') {
          metaRanks = next.metaRanks
          renderDifficulty()
        }
      } finally {
        subviewOpen = false
        if (!done) meta.focus()
      }
    }

    const onNumberShortcut = (event: KeyboardEvent): void => {
      if (
        done ||
        subviewOpen ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return
      }

      if (event.code === 'Digit1' || event.code === 'Numpad1') {
        event.preventDefault()
        finish()
      } else if (
        (event.code === 'Enter' || event.code === 'NumpadEnter') &&
        !(document.activeElement instanceof HTMLButtonElement)
      ) {
        // "게임 시작 · ENTER" 안내의 약속. 배경 클릭으로 버튼 포커스를 잃어도
        // Enter는 항상 시작으로 이어져야 한다. 버튼에 포커스가 있으면 기본
        // 동작(해당 버튼 활성화)에 맡긴다.
        event.preventDefault()
        finish()
      } else if (event.code === 'Digit2' || event.code === 'Numpad2') {
        event.preventDefault()
        void openRecords()
      } else if (event.code === 'Digit3' || event.code === 'Numpad3') {
        event.preventDefault()
        void openSettings()
      } else if (
        onMeta &&
        (event.code === 'Digit4' || event.code === 'Numpad4')
      ) {
        event.preventDefault()
        void openMeta()
      }
    }

    start.addEventListener('click', finish)
    for (const mode of stageOrder) {
      const button = difficultyButtons.get(mode)!
      button.addEventListener('click', () => {
        if (done || subviewOpen) return
        if (!isStageUnlocked(mode)) return
        selectedDifficulty = mode
        renderDifficulty()
      })
      button.addEventListener('keydown', (event) => {
        if (done || subviewOpen) return
        const available = stageOrder.filter(isStageUnlocked)
        const current = Math.max(0, available.indexOf(selectedDifficulty))
        let next = -1
        if (event.code === 'ArrowRight' || event.code === 'ArrowDown') {
          next = (current + 1) % available.length
        } else if (event.code === 'ArrowLeft' || event.code === 'ArrowUp') {
          next = (current - 1 + available.length) % available.length
        } else if (event.code === 'Home') {
          next = 0
        } else if (event.code === 'End') {
          next = available.length - 1
        }
        if (next < 0) return
        event.preventDefault()
        selectedDifficulty = available[next]!
        renderDifficulty()
        difficultyButtons.get(selectedDifficulty)!.focus()
      })
    }
    records.addEventListener('click', () => void openRecords())
    settings.addEventListener('click', () => void openSettings())
    meta?.addEventListener('click', () => void openMeta())
    window.addEventListener('keydown', onNumberShortcut)
    parent.appendChild(root)
    start.focus()
  })
}
