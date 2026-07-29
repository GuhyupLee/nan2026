import type { RunDifficulty } from '../sim/types.ts'
import {
  MAIN_MENU_STAGE_ORDER,
  STAGE_CAROUSEL_DRAG_THRESHOLD,
  closestStageIndex,
  isMainMenuStageUnlocked,
  stageIndexForNavigation,
  stageIndexForSwipe,
} from './stage-carousel.ts'

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
    const stageOrder = MAIN_MENU_STAGE_ORDER
    const stageUnlocks = {
      hard: hardModeUnlocked,
      fullmoon: fullMoonModeUnlocked,
    }
    const isStageUnlocked = (mode: RunDifficulty): boolean =>
      isMainMenuStageUnlocked(mode, stageUnlocks)
    const stageLabel = (mode: RunDifficulty): string =>
      mode === 'normal' ? '보통' : mode === 'hard' ? '월식' : '만월'
    const stageDescription = (mode: RunDifficulty): string => {
      if (mode === 'normal') return '5:00 제한 · 3:30 보스 · 2페이즈'
      if (mode === 'hard') {
        return isStageUnlocked(mode)
          ? '적 속도 +10% · 접촉 피해 +25% · 점수 ×1.5'
          : '보통 최초 클리어 후 해금'
      }
      return isStageUnlocked(mode)
        ? `10:00 보스 등장 · 12:00 마감 · 3페이즈 · 전승 ${metaRanks}/40`
        : '월식 최초 클리어 후 해금 · 전승 40/40 권장'
    }

    const stagePicker = document.createElement('section')
    stagePicker.className = 'mainmenu-stage-picker'
    stagePicker.setAttribute('aria-label', '도전 스테이지')
    content.appendChild(stagePicker)

    const difficulties = document.createElement('div')
    difficulties.className = 'mainmenu-difficulties'
    difficulties.setAttribute('role', 'region')
    difficulties.setAttribute('aria-roledescription', '캐러셀')
    difficulties.setAttribute('aria-label', '도전 스테이지 카드')
    difficulties.setAttribute('aria-describedby', 'mainmenu-stage-hint')
    stagePicker.appendChild(difficulties)

    const difficultyButtons = new Map<RunDifficulty, HTMLButtonElement>()
    for (const mode of stageOrder) {
      const button = document.createElement('button')
      button.className = 'mainmenu-difficulty'
      button.type = 'button'
      button.dataset.mode = mode
      difficultyButtons.set(mode, button)
      difficulties.appendChild(button)
    }

    const stageNavigation = document.createElement('div')
    stageNavigation.className = 'mainmenu-stage-navigation'
    stagePicker.appendChild(stageNavigation)

    const previousStage = document.createElement('button')
    previousStage.className = 'mainmenu-stage-step previous'
    previousStage.type = 'button'
    previousStage.setAttribute('aria-label', '이전 스테이지 보기')
    previousStage.textContent = '←'
    stageNavigation.appendChild(previousStage)

    const stageGuide = document.createElement('div')
    stageGuide.className = 'mainmenu-stage-guide'
    stageNavigation.appendChild(stageGuide)

    const stageDots = new Map<RunDifficulty, HTMLElement>()
    const stageIndicators = document.createElement('span')
    stageIndicators.className = 'mainmenu-stage-indicators'
    stageIndicators.setAttribute('aria-hidden', 'true')
    for (const mode of stageOrder) {
      const dot = document.createElement('i')
      dot.dataset.mode = mode
      stageDots.set(mode, dot)
      stageIndicators.appendChild(dot)
    }
    stageGuide.appendChild(stageIndicators)

    const stageHint = document.createElement('small')
    stageHint.id = 'mainmenu-stage-hint'
    stageHint.textContent = '01 · 좌우로 넘기기 · 카드를 누르면 즉시 시작'
    stageGuide.appendChild(stageHint)

    const nextStage = document.createElement('button')
    nextStage.className = 'mainmenu-stage-step next'
    nextStage.type = 'button'
    nextStage.setAttribute('aria-label', '다음 스테이지 보기')
    nextStage.textContent = '→'
    stageNavigation.appendChild(nextStage)

    const stageStatus = document.createElement('span')
    stageStatus.className = 'mainmenu-stage-status'
    stageStatus.setAttribute('aria-live', 'polite')
    stageStatus.setAttribute('aria-atomic', 'true')
    stagePicker.appendChild(stageStatus)

    const renderDifficulty = (): void => {
      for (const mode of stageOrder) {
        const button = difficultyButtons.get(mode)!
        const selected = selectedDifficulty === mode
        const unlocked = isStageUnlocked(mode)
        const label = stageLabel(mode)
        const description = stageDescription(mode)
        button.dataset.selected = String(selected)
        button.tabIndex = selected ? 0 : -1
        button.setAttribute('aria-disabled', String(!unlocked))
        button.setAttribute(
          'aria-label',
          `스테이지 ${mode === 'normal' ? '1' : mode === 'hard' ? '2' : '3'}, ${label}. ${description}. ${unlocked ? '누르면 바로 시작합니다.' : '잠겨 있습니다.'}`,
        )
        if (selected) button.setAttribute('aria-current', 'true')
        else button.removeAttribute('aria-current')
        button.innerHTML =
          `<span><small>스테이지 ${mode === 'normal' ? 'I' : mode === 'hard' ? 'II' : 'III'}</small><b>${label}</b></span>` +
          `<em>${description}</em>` +
          `<i aria-hidden="true">${unlocked ? '시작' : '잠김'}</i>`

        const dot = stageDots.get(mode)!
        dot.dataset.selected = String(selected)
        dot.dataset.locked = String(!unlocked)
      }

      const selectedIndex = stageOrder.indexOf(selectedDifficulty)
      previousStage.disabled = selectedIndex <= 0
      nextStage.disabled = selectedIndex >= stageOrder.length - 1
      stageStatus.textContent = `${stageLabel(selectedDifficulty)} 스테이지. ${
        isStageUnlocked(selectedDifficulty)
          ? '카드를 누르면 바로 시작합니다.'
          : '아직 잠겨 있습니다.'
      }`
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
    actions.dataset.count = String(actions.childElementCount)

    let done = false
    let subviewOpen = false

    const finish = (): void => {
      if (
        done ||
        subviewOpen ||
        !isStageUnlocked(selectedDifficulty)
      ) {
        return
      }
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

    let stageScrollTarget: RunDifficulty | null = null
    let stageScrollTargetTimer = 0
    const clearStageScrollTarget = (): void => {
      stageScrollTarget = null
      if (stageScrollTargetTimer !== 0) {
        window.clearTimeout(stageScrollTargetTimer)
        stageScrollTargetTimer = 0
      }
    }

    const scrollStageIntoView = (
      mode: RunDifficulty,
      behavior: ScrollBehavior,
    ): void => {
      clearStageScrollTarget()
      if (behavior === 'smooth') {
        stageScrollTarget = mode
        stageScrollTargetTimer = window.setTimeout(() => {
          stageScrollTarget = null
          stageScrollTargetTimer = 0
          syncStageFromScroll()
        }, 500)
      }
      const button = difficultyButtons.get(mode)!
      const centeredLeft =
        button.offsetLeft - (difficulties.clientWidth - button.offsetWidth) / 2
      difficulties.scrollTo({
        left: Math.max(0, centeredLeft),
        behavior,
      })
    }

    const selectStage = (
      mode: RunDifficulty,
      scroll: boolean,
      focus: boolean,
    ): void => {
      if (done || subviewOpen) return
      if (selectedDifficulty !== mode) {
        selectedDifficulty = mode
        renderDifficulty()
      }
      if (scroll) {
        scrollStageIntoView(
          mode,
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
        )
      }
      if (focus) difficultyButtons.get(mode)!.focus({ preventScroll: true })
    }

    const navigateStage = (code: string, focus = true): boolean => {
      const currentIndex = stageOrder.indexOf(selectedDifficulty)
      const nextIndex = stageIndexForNavigation(
        code,
        currentIndex,
        stageOrder.length,
      )
      if (nextIndex === null) return false
      const mode = stageOrder[nextIndex]
      if (!mode) return false
      selectStage(mode, true, focus)
      return true
    }

    const syncStageFromScroll = (): void => {
      if (done || subviewOpen || difficulties.clientWidth <= 0) return
      const viewport = difficulties.getBoundingClientRect()
      if (stageScrollTarget) {
        const target = difficultyButtons
          .get(stageScrollTarget)!
          .getBoundingClientRect()
        const centerDelta = Math.abs(
          target.left +
            target.width / 2 -
            (viewport.left + viewport.width / 2),
        )
        if (centerDelta > 2) return
        clearStageScrollTarget()
      }
      const cardCenters = stageOrder.map((mode) => {
        const card = difficultyButtons.get(mode)!.getBoundingClientRect()
        return card.left + card.width / 2
      })
      const index = closestStageIndex(
        cardCenters,
        viewport.left + viewport.width / 2,
      )
      const mode = stageOrder[index]
      if (!mode || mode === selectedDifficulty) return
      selectedDifficulty = mode
      renderDifficulty()
    }

    let scrollFrame = 0
    const onStageScroll = (): void => {
      if (scrollFrame !== 0) return
      scrollFrame = window.requestAnimationFrame(() => {
        scrollFrame = 0
        syncStageFromScroll()
      })
    }

    let activePointerId: number | null = null
    let pointerCaptureElement: Element | null = null
    let pointerDownButton: HTMLButtonElement | null = null
    let dragOriginX = 0
    let dragOriginScrollLeft = 0
    let dragOriginStage: RunDifficulty = selectedDifficulty
    let dragTravel = 0
    let draggingStage = false
    let suppressPointerClickButton: HTMLButtonElement | null = null
    let suppressPointerClickTimer = 0

    const clearStageClickSuppression = (): void => {
      suppressPointerClickButton = null
      if (suppressPointerClickTimer !== 0) {
        window.clearTimeout(suppressPointerClickTimer)
        suppressPointerClickTimer = 0
      }
    }

    const armStageClickSuppression = (
      button: HTMLButtonElement | null,
    ): void => {
      clearStageClickSuppression()
      if (!button) return
      suppressPointerClickButton = button
      // 합성 click은 pointerup 직후 발생한다. 발생하지 않는 브라우저에서는
      // 다음 실제 탭을 막지 않도록 짧게 자동 해제한다.
      suppressPointerClickTimer = window.setTimeout(
        clearStageClickSuppression,
        100,
      )
    }

    const resetStagePointer = (releaseCapture: boolean): void => {
      const pointerId = activePointerId
      const captureElement = pointerCaptureElement
      activePointerId = null
      pointerCaptureElement = null
      pointerDownButton = null
      draggingStage = false
      difficulties.classList.remove('dragging')
      if (
        releaseCapture &&
        pointerId !== null &&
        captureElement?.hasPointerCapture(pointerId)
      ) {
        captureElement.releasePointerCapture(pointerId)
      }
    }

    const onStagePointerDown = (event: PointerEvent): void => {
      if (
        done ||
        subviewOpen ||
        !event.isPrimary ||
        event.button !== 0
      ) {
        return
      }
      if (activePointerId !== null) resetStagePointer(true)
      clearStageClickSuppression()
      activePointerId = event.pointerId
      pointerDownButton =
        event.target instanceof Element
          ? event.target.closest<HTMLButtonElement>('.mainmenu-difficulty')
          : null
      pointerCaptureElement = pointerDownButton ?? difficulties
      dragOriginX = event.clientX
      dragOriginScrollLeft = difficulties.scrollLeft
      dragOriginStage = selectedDifficulty
      dragTravel = 0
      draggingStage = false
      clearStageScrollTarget()
      pointerCaptureElement.setPointerCapture(event.pointerId)
    }

    const onStagePointerMove = (event: PointerEvent): void => {
      if (event.pointerId !== activePointerId) return
      if (event.pointerType === 'mouse' && (event.buttons & 1) === 0) {
        resetStagePointer(true)
        return
      }
      const delta = event.clientX - dragOriginX
      dragTravel = Math.max(dragTravel, Math.abs(delta))
      if (dragTravel < STAGE_CAROUSEL_DRAG_THRESHOLD) return
      if (!draggingStage) {
        draggingStage = true
        difficulties.classList.add('dragging')
      }
      event.preventDefault()
      difficulties.scrollLeft = dragOriginScrollLeft - delta
    }

    const endStagePointer = (event: PointerEvent): void => {
      if (event.pointerId !== activePointerId) return
      const wasDragging = draggingStage
      const clickedButton = pointerDownButton
      const swipeDelta = event.clientX - dragOriginX
      const swipeOrigin = dragOriginStage
      const cancelled = event.type === 'pointercancel'
      // pointerup/cancel은 캡처를 자동 해제한다. 여기서 수동 해제하면 뒤따르는
      // click의 타깃이 카드 밖으로 바뀔 수 있으므로 상태만 먼저 정리한다.
      resetStagePointer(false)
      if (!wasDragging) return

      if (!cancelled) armStageClickSuppression(clickedButton)
      window.requestAnimationFrame(() => {
        const swipeIndex = cancelled
          ? null
          : stageIndexForSwipe(
              swipeDelta,
              difficulties.clientWidth,
              stageOrder.indexOf(swipeOrigin),
              stageOrder.length,
            )
        const swipeMode =
          swipeIndex === null ? undefined : stageOrder[swipeIndex]
        if (swipeMode) selectStage(swipeMode, false, false)
        else syncStageFromScroll()
        scrollStageIntoView(
          selectedDifficulty,
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
            ? 'auto'
            : 'smooth',
        )
      })
    }

    const onStageLostPointerCapture = (event: PointerEvent): void => {
      if (event.pointerId !== activePointerId) return
      resetStagePointer(false)
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
        // 카드 밖에 포커스가 있어도 Enter는 중앙 스테이지를 시작한다.
        // 버튼에 포커스가 있으면 해당 버튼의 기본 동작에 맡긴다.
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

    difficulties.addEventListener('scroll', onStageScroll, { passive: true })
    difficulties.addEventListener('pointerdown', onStagePointerDown)
    difficulties.addEventListener('pointermove', onStagePointerMove)
    difficulties.addEventListener('pointerup', endStagePointer)
    difficulties.addEventListener('pointercancel', endStagePointer)
    difficulties.addEventListener(
      'lostpointercapture',
      onStageLostPointerCapture,
    )
    previousStage.addEventListener('click', () => {
      navigateStage('ArrowLeft')
    })
    nextStage.addEventListener('click', () => {
      navigateStage('ArrowRight')
    })

    for (const mode of stageOrder) {
      const button = difficultyButtons.get(mode)!
      button.addEventListener('click', (event) => {
        if (done || subviewOpen) return
        if (
          event.detail > 0 &&
          suppressPointerClickButton === button
        ) {
          clearStageClickSuppression()
          event.preventDefault()
          return
        }
        selectStage(mode, !isStageUnlocked(mode), !isStageUnlocked(mode))
        if (isStageUnlocked(mode)) finish()
      })
      button.addEventListener('keydown', (event) => {
        if (done || subviewOpen) return
        if (!navigateStage(event.code)) return
        event.preventDefault()
      })
    }
    records.addEventListener('click', () => void openRecords())
    settings.addEventListener('click', () => void openSettings())
    meta?.addEventListener('click', () => void openMeta())
    window.addEventListener('keydown', onNumberShortcut)
    parent.appendChild(root)
    difficultyButtons.get(selectedDifficulty)!.focus({ preventScroll: true })
  })
}
