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
  onMeta?: () => Promise<{ moonlight: number }> | { moonlight: number },
  initialMoonlight = 0,
  hardModeUnlocked = false,
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
    rule.innerHTML = '<span>5분 생존 · 보스 격파</span><i></i>'
    content.appendChild(rule)

    let selectedDifficulty: RunDifficulty = 'normal'
    const difficulty = document.createElement('button')
    difficulty.className = 'mainmenu-difficulty'
    difficulty.type = 'button'
    difficulty.disabled = !hardModeUnlocked
    const renderDifficulty = (): void => {
      const hard = selectedDifficulty === 'hard'
      difficulty.dataset.mode = hard ? 'hard' : 'normal'
      difficulty.setAttribute('aria-pressed', String(hard))
      difficulty.innerHTML =
        `<span><small>난이도</small><b>${hard ? '월식' : '일반'}</b></span>` +
        `<em>${
          hardModeUnlocked
            ? hard
              ? '적 속도 +10% · 접촉 피해 +25% · 점수 ×1.5'
              : '기본 난이도의 5분 보스전'
            : '보스 최초 격파 후 해금'
        }</em><i aria-hidden="true">${hardModeUnlocked ? '↔' : '잠김'}</i>`
    }
    renderDifficulty()
    content.appendChild(difficulty)

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
    difficulty.addEventListener('click', () => {
      if (!hardModeUnlocked || done || subviewOpen) return
      selectedDifficulty =
        selectedDifficulty === 'normal' ? 'hard' : 'normal'
      renderDifficulty()
    })
    records.addEventListener('click', () => void openRecords())
    settings.addEventListener('click', () => void openSettings())
    meta?.addEventListener('click', () => void openMeta())
    window.addEventListener('keydown', onNumberShortcut)
    parent.appendChild(root)
    start.focus()
  })
}
