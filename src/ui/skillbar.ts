import {
  getPassiveDef,
  getSkillDamageBreakdown,
  getSkillDef,
} from '../content/skills.ts'
import { getUpgradeBranchPresentation, hasUpgradeTrait } from '../content/upgrades.ts'
import {
  MAX_SKILL_RANK,
  SKILL_IDS,
  type SkillBook,
  type SkillId,
  cooldownProgress,
  skillDamageMul,
} from '../sim/skills.ts'
import { effectiveAtkDamage } from '../sim/stats.ts'
import type { PlayerClass, World } from '../sim/types.ts'

/**
 * 화면 하단 스킬바.
 *
 * PC에서는 키보드와 클릭 둘 다 먹고, 모바일에서는 이것이 유일한 입력 수단이다.
 * 그래서 모바일 대응이 별도 작업이 아니라 어차피 만들어야 하는 UI가 된다.
 *
 * DOM은 body에 붙인다. 캔버스 컨테이너 밖이어야 슬롯 클릭이
 * 이동 입력으로 새어 들어가지 않는다.
 */

export interface SlotMeta {
  id: SkillId
  /** 표시할 키 라벨. */
  key: string
  /** 주력 스킬인가 소환사 주문인가. 시각적으로 구분한다. */
  kind: 'core' | 'summoner'
  /** 임시 아이콘. 나중에 SVG로 교체된다. */
  glyph: string
  /** 툴팁용 이름. */
  name: string
}

/**
 * 기본 슬롯 구성.
 *
 * 슬롯 역할 규약은 두 클래스 공통이다:
 *   Q 기본공격기 / W 이동기 / E 광역기 / R 궁극기 / D 회복 / F 점멸
 * 클래스가 달라도 역할이 같아서 "W는 언제나 탈출"이 된다 —
 * 두 번째 캐릭터를 배우는 비용이 0이 되는 온보딩 장치다.
 */
export const DEFAULT_SLOTS: SlotMeta[] = [
  { id: 'q', key: 'Q', kind: 'core', glyph: '✦', name: '기본공격기' },
  { id: 'w', key: 'W', kind: 'core', glyph: '⇢', name: '이동기' },
  { id: 'e', key: 'E', kind: 'core', glyph: '◎', name: '광역기' },
  { id: 'r', key: 'R', kind: 'core', glyph: '★', name: '궁극기' },
  { id: 'd', key: 'D', kind: 'summoner', glyph: '✚', name: '회복' },
  { id: 'f', key: 'F', kind: 'summoner', glyph: '⚡', name: '점멸' },
]

const TOUCH_TOOLTIP_HOLD_MS = 500
const TOUCH_TOOLTIP_MOVE_TOLERANCE = 10

interface SlotView {
  meta: SlotMeta
  root: HTMLButtonElement
  icon: HTMLImageElement
  fallback: HTMLSpanElement
  cd: HTMLDivElement
  cdText: HTMLDivElement
  stateLabel: HTMLSpanElement
  /** 직전 프레임에 사용 가능했는가. 쿨다운이 막 끝난 순간을 잡는다. */
  wasReady: boolean
}

interface PassiveView {
  root: HTMLDivElement
  icon: HTMLImageElement
  fallback: HTMLSpanElement
  cd: HTMLDivElement
  cdText: HTMLDivElement
  wasReady: boolean
}

interface PassivePresentation {
  metric: 'count' | 'gauge'
  name: string
  tag: string
  description: string
  detail: string
  actual: string
  status: string
  enhancement: string
  displayValue: string
  ready: boolean
  progress: number
  meterNow: number
  meterMax: number
  meterText: string
}

interface SlotFace {
  icon: HTMLImageElement
  fallback: HTMLSpanElement
  key: HTMLDivElement
  cd: HTMLDivElement
  cdText: HTMLDivElement
}

type TooltipView = SlotView | PassiveView

export interface SkillBarHandlers {
  start: (id: SkillId) => void
  release: (id: SkillId) => void
  cancel: (id: SkillId) => void
  aim: (clientX: number, clientY: number) => void
}

export class SkillBar {
  private readonly root: HTMLDivElement
  private readonly passive: PassiveView
  private readonly slots: SlotView[] = []
  private readonly cancelPointers: Array<() => void> = []
  private readonly tooltip: HTMLDivElement
  private readonly tooltipKey: HTMLElement
  private readonly tooltipTag: HTMLElement
  private readonly tooltipName: HTMLElement
  private readonly tooltipDescription: HTMLElement
  private readonly tooltipDetail: HTMLElement
  private readonly tooltipDamage: HTMLElement
  private readonly tooltipEnhancement: HTMLElement
  private readonly tooltipStatus: HTMLElement
  private activeTooltip: TooltipView | null = null
  private tooltipBook: SkillBook | null = null
  private tooltipWorld: World | null = null
  private passiveWorld: World | null = null
  private passivePresentation: PassivePresentation | null = null
  private passiveRenderSignature = ''
  private nextPassivePollAt = -Infinity
  private markedEnemies = 0
  private tooltipSignature = ''
  private tooltipHideTimer = 0
  private currentClass: PlayerClass | null = null
  private readonly onEscape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.hideTooltip()
  }

  constructor(
    parent: HTMLElement,
    meta: readonly SlotMeta[],
    handlers: SkillBarHandlers,
  ) {
    this.root = document.createElement('div')
    this.root.className = 'skillbar'

    const passiveRoot = document.createElement('div')
    passiveRoot.className = 'slot passive-slot'
    passiveRoot.dataset.kind = 'passive'
    passiveRoot.dataset.state = 'inactive'
    passiveRoot.dataset.activation = 'automatic'
    passiveRoot.dataset.metric = 'count'
    // 자동 상태지만 live region은 아니다. 표식 수가 빠르게 바뀌는 전투에서
    // 스크린리더가 다른 경고를 계속 덮지 않게, 포커스했을 때만 읽힌다.
    passiveRoot.setAttribute('role', 'img')
    passiveRoot.setAttribute('aria-label', 'P 패시브, 전투 시작 후 상태가 표시됩니다.')
    passiveRoot.tabIndex = 0
    const passiveFace = appendSlotFace(passiveRoot, 'P', 'P')
    passiveFace.key.textContent = ''
    const passiveKey = document.createElement('span')
    passiveKey.className = 'passive-key-label'
    passiveKey.textContent = 'P'
    const passiveMode = document.createElement('span')
    passiveMode.className = 'passive-mode-badge'
    passiveMode.textContent = '자동'
    passiveFace.key.append(passiveKey, passiveMode)
    passiveFace.icon.src = `${import.meta.env.BASE_URL}${getPassiveDef('ranged').icon}`
    passiveFace.icon.hidden = false
    passiveFace.fallback.hidden = true
    passiveFace.icon.onerror = () => {
      passiveFace.icon.hidden = true
      passiveFace.fallback.hidden = false
    }
    this.passive = {
      root: passiveRoot,
      ...passiveFace,
      wasReady: false,
    }
    let passivePointerId: number | null = null
    let passiveLongPressTimer = 0
    let passiveLongPressTriggered = false
    let passiveStartX = 0
    let passiveStartY = 0

    const clearPassiveLongPressTimer = (): void => {
      window.clearTimeout(passiveLongPressTimer)
      passiveLongPressTimer = 0
    }

    const clearPassivePointer = (hideLongPress: boolean): void => {
      clearPassiveLongPressTimer()
      if (passivePointerId === null) return
      const pointerId = passivePointerId
      const didLongPress = passiveLongPressTriggered
      passivePointerId = null
      passiveLongPressTriggered = false
      if (passiveRoot.hasPointerCapture(pointerId)) {
        passiveRoot.releasePointerCapture(pointerId)
      }
      if (hideLongPress && didLongPress) this.hideTooltip(this.passive)
    }
    this.cancelPointers.push(() => clearPassivePointer(true))

    passiveRoot.addEventListener('pointerdown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.pointerType !== 'touch') {
        this.showTooltip(this.passive)
        return
      }
      if (passivePointerId !== null) return

      this.hideTooltip()
      passivePointerId = event.pointerId
      passiveLongPressTriggered = false
      passiveStartX = event.clientX
      passiveStartY = event.clientY
      passiveRoot.setPointerCapture(event.pointerId)
      const pointerId = event.pointerId
      passiveLongPressTimer = window.setTimeout(() => {
        passiveLongPressTimer = 0
        if (passivePointerId !== pointerId) return
        passiveLongPressTriggered = true
        this.showTooltip(this.passive)
      }, TOUCH_TOOLTIP_HOLD_MS)
    })
    passiveRoot.addEventListener('pointermove', (event) => {
      if (event.pointerId !== passivePointerId) return
      if (
        Math.hypot(event.clientX - passiveStartX, event.clientY - passiveStartY) <=
        TOUCH_TOOLTIP_MOVE_TOLERANCE
      ) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      clearPassivePointer(true)
    })
    passiveRoot.addEventListener('pointerup', (event) => {
      if (event.pointerId !== passivePointerId) return
      event.preventDefault()
      event.stopPropagation()
      const didLongPress = passiveLongPressTriggered
      clearPassivePointer(false)
      if (didLongPress) this.scheduleTooltipHide()
    })
    passiveRoot.addEventListener('pointercancel', (event) => {
      if (event.pointerId !== passivePointerId) return
      event.preventDefault()
      event.stopPropagation()
      clearPassivePointer(true)
    })
    passiveRoot.addEventListener('lostpointercapture', (event) => {
      if (event.pointerId === passivePointerId) clearPassivePointer(true)
    })
    passiveRoot.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
    passiveRoot.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') this.showTooltip(this.passive)
    })
    passiveRoot.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'touch' && event.pointerId === passivePointerId) {
        clearPassivePointer(true)
        return
      }
      if (event.pointerType !== 'touch' && document.activeElement !== passiveRoot) {
        this.hideTooltip(this.passive)
      }
    })
    passiveRoot.addEventListener('focus', () => {
      if (passivePointerId === null) this.showTooltip(this.passive)
    })
    passiveRoot.addEventListener('blur', () => this.hideTooltip(this.passive))
    let passiveInserted = false
    for (const m of meta) {
      if (!passiveInserted && m.kind === 'summoner') {
        this.root.appendChild(passiveRoot)
        passiveInserted = true
      }

      const slot = document.createElement('button')
      slot.className = 'slot'
      slot.type = 'button'
      slot.dataset.kind = m.kind
      slot.dataset.skill = m.id
      slot.dataset.state = 'locked'
      slot.setAttribute('aria-disabled', 'true')
      slot.setAttribute('aria-keyshortcuts', m.key)

      const face = appendSlotFace(slot, m.key, m.glyph)
      const stateLabel = document.createElement('span')
      stateLabel.className = 'skill-state-label'
      stateLabel.hidden = true
      slot.appendChild(stateLabel)

      const view: SlotView = {
        meta: m,
        root: slot,
        ...face,
        stateLabel,
        wasReady: false,
      }
      let activePointerId: number | null = null
      let activePointerIsTouch = false
      let pointerCanCast = false
      let pointerCastStarted = false
      let longPressTimer = 0
      let longPressTriggered = false
      let touchStartX = 0
      let touchStartY = 0

      const clearLongPressTimer = (): void => {
        window.clearTimeout(longPressTimer)
        longPressTimer = 0
      }

      const beginPointerCast = (): void => {
        if (pointerCastStarted || !pointerCanCast) return
        pointerCastStarted = true
        slot.dataset.targeting = 'true'
        handlers.start(m.id)
      }

      const clearPointer = (cancel: boolean): void => {
        clearLongPressTimer()
        if (activePointerId === null) return
        const pointerId = activePointerId
        const didStartCast = pointerCastStarted
        const didLongPress = longPressTriggered
        activePointerId = null
        activePointerIsTouch = false
        pointerCanCast = false
        pointerCastStarted = false
        longPressTriggered = false
        delete slot.dataset.targeting
        if (slot.hasPointerCapture(pointerId)) {
          slot.releasePointerCapture(pointerId)
        }
        if (cancel && didStartCast) handlers.cancel(m.id)
        if (cancel && didLongPress) this.hideTooltip(view)
      }
      this.cancelPointers.push(() => clearPointer(true))

      slot.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (activePointerId !== null) return

        const isTouch = e.pointerType === 'touch'
        const canCast =
          slot.dataset.state === 'ready' &&
          slot.dataset.busy !== 'true'
        if (!isTouch && !canCast) return

        activePointerId = e.pointerId
        activePointerIsTouch = isTouch
        pointerCanCast = canCast
        pointerCastStarted = false
        longPressTriggered = false
        slot.setPointerCapture(e.pointerId)

        if (!isTouch) {
          beginPointerCast()
          return
        }

        this.hideTooltip()
        touchStartX = e.clientX
        touchStartY = e.clientY
        const pointerId = e.pointerId
        longPressTimer = window.setTimeout(() => {
          longPressTimer = 0
          if (
            activePointerId !== pointerId ||
            !activePointerIsTouch ||
            pointerCastStarted
          ) {
            return
          }
          longPressTriggered = true
          this.showTooltip(view)
        }, TOUCH_TOOLTIP_HOLD_MS)
      })

      slot.addEventListener('pointerup', (e) => {
        if (e.pointerId !== activePointerId) return
        e.preventDefault()
        e.stopPropagation()
        const wasTouch = activePointerIsTouch
        const canCast = pointerCanCast
        const didStartCast = pointerCastStarted
        const didLongPress = longPressTriggered
        clearPointer(false)

        if (didLongPress) {
          this.scheduleTooltipHide()
          return
        }
        if (!canCast) return

        if (wasTouch && !didStartCast) handlers.start(m.id)
        if (wasTouch || didStartCast) handlers.release(m.id)
      })

      const cancelPointer = (e: PointerEvent): void => {
        if (e.pointerId !== activePointerId) return
        e.preventDefault()
        e.stopPropagation()
        clearPointer(true)
      }
      slot.addEventListener('pointercancel', cancelPointer)
      slot.addEventListener('lostpointercapture', (e) => {
        if (e.pointerId !== activePointerId) return
        clearPointer(true)
      })
      // 터치는 브라우저의 암시적 포인터 캡처 때문에 pointerleave가 생략될 수
      // 있다. 캡처 중에도 좌표를 직접 검사해 버튼 밖 드래그를 취소한다.
      slot.addEventListener('pointermove', (e) => {
        if (e.pointerId !== activePointerId) return
        if (
          activePointerIsTouch &&
          Math.hypot(e.clientX - touchStartX, e.clientY - touchStartY) >
            TOUCH_TOOLTIP_MOVE_TOLERANCE
        ) {
          e.preventDefault()
          e.stopPropagation()
          if (longPressTriggered) {
            clearPointer(true)
            return
          }
          clearLongPressTimer()
          beginPointerCast()
        }
        if (pointerCastStarted) handlers.aim(e.clientX, e.clientY)
      })

      // 포인터 click은 pointerdown/up에서 이미 처리했다. 키보드와 보조기술이
      // 만드는 detail=0 click만 한 번의 완결된 시전으로 바꾼다.
      slot.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.detail !== 0 || slot.dataset.state !== 'ready') return
        handlers.start(m.id)
        handlers.release(m.id)
      })

      slot.addEventListener('pointerenter', (event) => {
        if (event.pointerType !== 'touch') this.showTooltip(view)
      })
      slot.addEventListener('pointerleave', (event) => {
        if (event.pointerType !== 'touch' && document.activeElement !== slot) {
          this.hideTooltip(view)
        }
      })
      slot.addEventListener('focus', () => {
        if (!activePointerIsTouch) this.showTooltip(view)
      })
      slot.addEventListener('blur', () => this.hideTooltip(view))

      this.root.appendChild(slot)
      this.slots.push(view)
    }
    if (!passiveInserted) this.root.appendChild(passiveRoot)

    this.tooltip = document.createElement('div')
    this.tooltip.id = 'skillbar-tooltip'
    this.tooltip.className = 'skill-tooltip'
    this.tooltip.role = 'tooltip'
    this.tooltip.hidden = true
    this.tooltip.innerHTML =
      `<div class="skill-tooltip-head">` +
      `<span class="skill-tooltip-key"></span>` +
      `<div><strong class="skill-tooltip-name"></strong><small class="skill-tooltip-tag"></small></div>` +
      `</div>` +
      `<p class="skill-tooltip-description"></p>` +
      `<p class="skill-tooltip-detail"></p>` +
      `<div class="skill-tooltip-stats">` +
      `<span class="skill-tooltip-damage"></span>` +
      `<span class="skill-tooltip-status"></span>` +
      `</div>` +
      `<div class="skill-tooltip-enhancement"></div>`
    this.tooltipKey = this.tooltip.querySelector('.skill-tooltip-key')!
    this.tooltipTag = this.tooltip.querySelector('.skill-tooltip-tag')!
    this.tooltipName = this.tooltip.querySelector('.skill-tooltip-name')!
    this.tooltipDescription = this.tooltip.querySelector('.skill-tooltip-description')!
    this.tooltipDetail = this.tooltip.querySelector('.skill-tooltip-detail')!
    this.tooltipDamage = this.tooltip.querySelector('.skill-tooltip-damage')!
    this.tooltipStatus = this.tooltip.querySelector('.skill-tooltip-status')!
    this.tooltipEnhancement = this.tooltip.querySelector('.skill-tooltip-enhancement')!
    for (const view of this.slots) {
      view.root.setAttribute('aria-describedby', this.tooltip.id)
    }
    this.passive.root.setAttribute('aria-describedby', this.tooltip.id)
    parent.appendChild(this.root)
    // transform이 있는 skillbar 안에 fixed 툴팁을 넣으면 좌표계가 슬롯바 기준으로
    // 바뀐다. body 형제여야 viewport 좌표와 getBoundingClientRect가 일치한다.
    parent.appendChild(this.tooltip)
    window.addEventListener('keydown', this.onEscape)
    this.setClass('ranged')
  }

  /** Clears any held pointer before an overlay, restart, or menu takes control. */
  cancelTargeting(): void {
    for (const cancel of this.cancelPointers) cancel()
  }

  /** 매 프레임 호출한다. DOM 쓰기는 값이 바뀔 때만 일어나게 막아뒀다. */
  update(book: SkillBook, playerClass?: PlayerClass, world?: World): void {
    this.tooltipBook = book
    this.tooltipWorld = world ?? null
    if (playerClass && playerClass !== this.currentClass) this.setClass(playerClass)

    for (const view of this.slots) {
      const s = book[view.meta.id]
      const queued = world?.bufferedSkill?.slot === view.meta.id
      const qRemaining =
        world?.playerClass === 'ranged' && view.meta.id === 'q'
          ? Math.max(0, world.player.rangedVolleyUntil - world.time)
          : 0
      const wDashing =
        view.meta.id === 'w' &&
        world?.playerAction?.slot === 'w' &&
        world.playerAction.skillDash !== undefined &&
        world.time <
          world.playerAction.startedAt +
            world.playerAction.skillDash.moveEnd
      const wGuardRemaining =
        world?.playerClass === 'ranged' && view.meta.id === 'w'
          ? Math.max(0, world.player.rangedDashInvulnUntil - world.time)
          : 0
      const busy =
        world?.ult.active === true &&
        view.meta.id !== 'd'
      view.root.dataset.queued = String(queued)
      view.root.dataset.active = String(
        qRemaining > 0 || wDashing || wGuardRemaining > 0,
      )
      view.root.dataset.busy = String(busy)
      if (qRemaining > 0) {
        view.stateLabel.textContent = `3갈래 ${qRemaining.toFixed(1)}`
        view.stateLabel.hidden = false
      } else if (wDashing) {
        view.stateLabel.textContent = '도약 중'
        view.stateLabel.hidden = false
      } else if (wGuardRemaining > 0) {
        view.stateLabel.textContent = `잔광 ${wGuardRemaining.toFixed(1)}`
        view.stateLabel.hidden = false
      } else if (queued) {
        view.stateLabel.textContent = '예약'
        view.stateLabel.hidden = false
      } else if (busy) {
        view.stateLabel.textContent = '동작 중'
        view.stateLabel.hidden = false
      } else {
        view.stateLabel.hidden = true
        view.stateLabel.textContent = ''
      }

      if (!s.unlocked) {
        view.root.setAttribute('aria-disabled', 'true')
        if (view.root.dataset.state !== 'locked') {
          view.root.dataset.state = 'locked'
          view.cd.style.setProperty('--p', '0')
          view.cdText.textContent = ''
        }
        view.wasReady = false
        continue
      }

      const ready = s.cooldown <= 0
      view.root.setAttribute('aria-disabled', String(!ready || busy))

      if (ready) {
        if (view.root.dataset.state !== 'ready') {
          view.root.dataset.state = 'ready'
          view.cd.style.setProperty('--p', '0')
          view.cdText.textContent = ''
        }
        // 쿨다운이 막 끝난 순간에만 번쩍인다.
        if (!view.wasReady) this.flash(view)
      } else {
        view.root.dataset.state = 'cooling'
        if (qRemaining > 0) {
          // 강화 중에는 재사용 시계가 정지한다. 꽉 찬 쿨다운 마스크와 숫자를
          // 보여 주면 이미 시간이 흐르는 것처럼 읽히므로 활성 상태만 남긴다.
          view.cd.style.setProperty('--p', '0')
          view.cdText.textContent = ''
        } else {
          view.cd.style.setProperty('--p', String(cooldownProgress(book, view.meta.id)))
          // 롤과 같은 관습: 1초 미만은 소수점 한 자리.
          view.cdText.textContent =
            s.cooldown >= 1 ? String(Math.ceil(s.cooldown)) : s.cooldown.toFixed(1)
        }
      }

      view.wasReady = ready
    }

    if (world) this.updatePassive(world)
    if (this.activeTooltip) this.renderTooltip(this.activeTooltip)
  }

  private updatePassive(world: World): void {
    if (this.passiveWorld !== world) {
      this.passiveWorld = world
      this.markedEnemies = 0
      this.nextPassivePollAt = -Infinity
      this.passive.wasReady = false
      this.passiveRenderSignature = ''
    }

    if (world.playerClass === 'ranged' && world.time >= this.nextPassivePollAt) {
      this.nextPassivePollAt = world.time + 0.12
      let marked = 0
      for (let i = 0; i < world.enemies.count; i++) {
        if (world.enemies.markExpire[i]! > world.time) marked += 1
      }
      this.markedEnemies = marked
    }

    const presentation = passivePresentation(world, this.markedEnemies)
    this.passivePresentation = presentation
    const signature = [
      world.playerClass,
      presentation.name,
      presentation.metric,
      presentation.detail,
      presentation.actual,
      presentation.status,
      presentation.displayValue,
      presentation.ready,
      Math.round(presentation.progress * 100),
      presentation.meterNow,
      presentation.meterMax,
      presentation.meterText,
    ].join('|')

    if (signature !== this.passiveRenderSignature) {
      this.passiveRenderSignature = signature
      this.passive.root.dataset.state = presentation.ready ? 'active' : 'inactive'
      this.passive.root.dataset.metric = presentation.metric
      this.passive.cd.style.setProperty('--p', String(1 - presentation.progress))
      this.passive.cdText.textContent = presentation.displayValue
      if (presentation.metric === 'gauge') {
        this.passive.root.setAttribute('role', 'meter')
        this.passive.root.setAttribute('aria-valuemin', '0')
        this.passive.root.setAttribute('aria-valuemax', String(presentation.meterMax))
        this.passive.root.setAttribute('aria-valuenow', String(presentation.meterNow))
        this.passive.root.setAttribute('aria-valuetext', presentation.meterText)
      } else {
        this.passive.root.setAttribute('role', 'img')
        this.passive.root.removeAttribute('aria-valuemin')
        this.passive.root.removeAttribute('aria-valuemax')
        this.passive.root.removeAttribute('aria-valuenow')
        this.passive.root.removeAttribute('aria-valuetext')
      }
      this.passive.root.setAttribute(
        'aria-label',
        `P 패시브 ${presentation.name}. ${presentation.detail}. ${presentation.status}`,
      )
      this.passive.root.removeAttribute('title')
    }

    if (presentation.ready && !this.passive.wasReady) this.flash(this.passive)
    this.passive.wasReady = presentation.ready
  }

  /** QWER 아이콘과 슬롯 강조색을 선택한 클래스에 맞춘다. */
  setClass(playerClass: PlayerClass): void {
    if (playerClass === this.currentClass) return
    this.currentClass = playerClass
    this.root.dataset.class = playerClass

    const passiveDef = getPassiveDef(playerClass)
    this.passive.icon.src = `${import.meta.env.BASE_URL}${passiveDef.icon}`
    this.passive.icon.hidden = false
    this.passive.fallback.textContent = passiveDef.glyph
    this.passive.fallback.hidden = true
    this.passive.root.setAttribute(
      'aria-label',
      `P 패시브 ${passiveDef.name}. ${passiveDef.oneLiner}`,
    )

    for (const view of this.slots) {
      const def = getSkillDef(playerClass, view.meta.id)
      if (!def) continue

      view.root.setAttribute('aria-label', `${view.meta.key} ${def.name} — ${def.tag}`)
      view.icon.src = `${import.meta.env.BASE_URL}${def.icon}`
      view.icon.hidden = false
      view.fallback.textContent = def.glyph
      view.fallback.hidden = true
      view.icon.onerror = () => {
        view.icon.hidden = true
        view.fallback.hidden = false
      }
    }
    this.tooltipSignature = ''
    if (this.activeTooltip) this.renderTooltip(this.activeTooltip)
  }

  private showTooltip(view: TooltipView): void {
    window.clearTimeout(this.tooltipHideTimer)
    this.activeTooltip = view
    this.tooltipSignature = ''
    this.tooltip.hidden = false
    this.renderTooltip(view)
    this.positionTooltip(view)
  }

  private hideTooltip(view?: TooltipView): void {
    if (view && this.activeTooltip !== view) return
    window.clearTimeout(this.tooltipHideTimer)
    this.activeTooltip = null
    this.tooltipSignature = ''
    this.tooltip.hidden = true
  }

  private scheduleTooltipHide(): void {
    window.clearTimeout(this.tooltipHideTimer)
    this.tooltipHideTimer = window.setTimeout(() => this.hideTooltip(), 1800)
  }

  private renderTooltip(view: TooltipView): void {
    if (!('meta' in view)) {
      this.renderPassiveTooltip()
      return
    }

    const playerClass = this.currentClass ?? 'ranged'
    const def = getSkillDef(playerClass, view.meta.id)
    if (!def) return

    const runtime = this.tooltipBook?.[view.meta.id]
    const world = this.tooltipWorld
    const rankMultiplier =
      runtime && view.meta.kind === 'core'
        ? skillDamageMul(this.tooltipBook!, view.meta.id)
        : 1
    const damageMultiplier =
      runtime && view.meta.kind === 'core'
        ? playerClass === 'ranged' && view.meta.id === 'q'
          ? rankMultiplier
          : rankMultiplier * (world?.stats.atkDamageMul ?? 1)
        : 1
    const damage = getSkillDamageBreakdown(playerClass, view.meta.id, {
      damageMultiplier,
      attackDamage: world
        ? world.stats.atkDamage * world.stats.atkDamageMul
        : 0,
      hasTrait: (trait) =>
        runtime?.branch === trait ||
        (world !== null && hasUpgradeTrait(world, trait)),
    })
    const cooldown = runtime?.maxCooldown ?? def.cooldown
    const cooldownLeft = runtime?.cooldown ?? 0
    const qActiveRemaining =
      playerClass === 'ranged' && view.meta.id === 'q' && world
        ? Math.max(0, world.player.rangedVolleyUntil - world.time)
        : 0
    const wDashing =
      view.meta.id === 'w' &&
      world?.playerAction?.slot === 'w' &&
      world.playerAction.skillDash !== undefined &&
      world.time <
        world.playerAction.startedAt +
          world.playerAction.skillDash.moveEnd
    const wGuardRemaining =
      playerClass === 'ranged' && view.meta.id === 'w' && world
        ? Math.max(0, world.player.rangedDashInvulnUntil - world.time)
        : 0
    const status = !runtime?.unlocked
      ? '미해금'
      : qActiveRemaining > 0
        ? `3갈래 강화 ${formatSeconds(qActiveRemaining)} · 종료 후 재사용 ${formatSeconds(cooldownLeft)}`
      : wDashing
        ? '도약 중 · 무적'
      : wGuardRemaining > 0
        ? `잔광 무적 ${formatSeconds(wGuardRemaining)}`
      : cooldownLeft > 0
        ? `재사용 ${formatSeconds(cooldownLeft)}`
        : '사용 가능'

    let actual = damage ? `피해 ${damage}` : ''
    if (view.meta.id === 'd') {
      actual = `회복 ${formatValue(world?.stats.healAmount ?? 35)}`
    } else if (view.meta.id === 'f') {
      actual =
        `거리 ${formatValue(world?.stats.flashRange ?? 8)}` +
        (damage ? ` · 피해 ${damage}` : '')
    }

    let enhancement = `재사용 대기시간 ${formatSeconds(cooldown)}`
    if (view.meta.kind === 'core' && runtime) {
      const rankBonus = Math.round((rankMultiplier - 1) * 100)
      const attackBonus = Math.round(((world?.stats.atkDamageMul ?? 1) - 1) * 100)
      const damageLabel =
        playerClass === 'ranged' && view.meta.id === 'q'
          ? '양옆 광선 피해'
          : playerClass === 'ranged' && view.meta.id === 'w'
            ? '렌즈 피해'
            : '스킬 피해'
      enhancement =
        `강화 ${runtime.rank}/${MAX_SKILL_RANK} · ${damageLabel} +${rankBonus}%` +
        (attackBonus !== 0 ? ` · 공격 강화 ${attackBonus > 0 ? '+' : ''}${attackBonus}%` : '') +
        ` · 재사용 ${formatSeconds(cooldown)}`
      if (runtime.branch) enhancement += ` · ${describeBranch(runtime.branch, view.meta.id)}`
    }

    const signature = [
      playerClass,
      view.meta.id,
      runtime?.unlocked,
      runtime?.rank,
      runtime?.branch,
      Math.round(cooldownLeft * 10),
      cooldown,
      damage,
      actual,
      enhancement,
    ].join('|')
    if (signature === this.tooltipSignature) return
    this.tooltipSignature = signature

    this.tooltip.dataset.class = playerClass
    this.tooltip.dataset.state = runtime?.unlocked ? (cooldownLeft > 0 ? 'cooling' : 'ready') : 'locked'
    this.tooltipKey.textContent = def.key
    this.tooltipTag.textContent = def.tag
    this.tooltipName.textContent = def.name
    this.tooltipDescription.textContent = def.oneLiner
    this.tooltipDetail.textContent = def.detail
    this.tooltipDamage.textContent = actual
    this.tooltipDamage.hidden = actual.length === 0
    this.tooltipStatus.textContent = status
    this.tooltipEnhancement.textContent = enhancement
    this.tooltip.setAttribute(
      'aria-label',
      `${def.key} ${def.name}. ${def.oneLiner}. ${actual}. ${enhancement}. ${status}`,
    )
  }

  private renderPassiveTooltip(): void {
    const presentation = this.passivePresentation
    if (!presentation) return

    const playerClass = this.currentClass ?? 'ranged'
    const signature = [
      'passive',
      playerClass,
      presentation.name,
      presentation.detail,
      presentation.actual,
      presentation.status,
      presentation.enhancement,
    ].join('|')
    if (signature === this.tooltipSignature) return
    this.tooltipSignature = signature

    this.tooltip.dataset.class = playerClass
    this.tooltip.dataset.state = presentation.ready ? 'ready' : 'cooling'
    this.tooltipKey.textContent = 'P'
    this.tooltipTag.textContent = presentation.tag
    this.tooltipName.textContent = presentation.name
    this.tooltipDescription.textContent = presentation.description
    this.tooltipDetail.textContent = presentation.detail
    this.tooltipDamage.textContent = presentation.actual
    this.tooltipDamage.hidden = presentation.actual.length === 0
    this.tooltipStatus.textContent = presentation.status
    this.tooltipEnhancement.textContent = presentation.enhancement
    this.tooltip.setAttribute(
      'aria-label',
      `P ${presentation.name}. ${presentation.description}. ${presentation.actual}. ${presentation.enhancement}. ${presentation.status}`,
    )
  }

  private positionTooltip(view: TooltipView): void {
    const slot = view.root.getBoundingClientRect()
    const tip = this.tooltip.getBoundingClientRect()
    const margin = 8
    const left = Math.max(
      margin,
      Math.min(window.innerWidth - tip.width - margin, slot.left + slot.width * 0.5 - tip.width * 0.5),
    )
    let top = slot.top - tip.height - 10
    if (top < margin) top = slot.bottom + 10
    this.tooltip.style.left = `${Math.round(left)}px`
    this.tooltip.style.top = `${Math.round(top)}px`
  }

  private flash(view: TooltipView): void {
    const className = 'meta' in view ? 'flash' : 'status-flash'
    view.root.classList.remove(className)
    // 클래스를 다시 붙이기 전에 리플로우를 강제해야 애니메이션이 재생된다.
    void view.root.offsetWidth
    view.root.classList.add(className)
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none'
    if (!visible) {
      this.cancelTargeting()
      this.hideTooltip()
    }
  }

  dispose(): void {
    this.cancelTargeting()
    window.clearTimeout(this.tooltipHideTimer)
    window.removeEventListener('keydown', this.onEscape)
    this.tooltip.remove()
    this.root.remove()
  }
}

function appendSlotFace(
  root: HTMLButtonElement | HTMLDivElement,
  keyLabel: string,
  fallbackGlyph: string,
): SlotFace {
  const glyph = document.createElement('div')
  glyph.className = 'glyph'

  const icon = document.createElement('img')
  icon.className = 'skill-icon'
  icon.alt = ''
  icon.draggable = false
  icon.hidden = true
  glyph.appendChild(icon)

  const fallback = document.createElement('span')
  fallback.className = 'glyph-fallback'
  fallback.textContent = fallbackGlyph
  glyph.appendChild(fallback)
  root.appendChild(glyph)

  const key = document.createElement('div')
  key.className = 'key'
  key.textContent = keyLabel
  root.appendChild(key)

  const cd = document.createElement('div')
  cd.className = 'cd'
  root.appendChild(cd)

  const cdText = document.createElement('div')
  cdText.className = 'cdtext'
  root.appendChild(cdText)

  return { icon, fallback, key, cd, cdText }
}

function passivePresentation(world: World, markedEnemies: number): PassivePresentation {
  const stats = world.stats
  const passiveDef = getPassiveDef(world.playerClass)
  if (world.playerClass === 'ranged') {
    const marked = Math.max(0, markedEnemies)
    const litDamage = effectiveAtkDamage(stats) + stats.markBonus
    return {
      metric: 'count',
      name: passiveDef.name,
      tag: '원거리 패시브',
      description: passiveDef.oneLiner,
      detail:
        marked > 0
          ? `점등 평타 ${formatValue(litDamage)} · 처치 회복 ${formatValue(stats.markKillHeal)}`
          : `스킬 적중으로 표식 · 점등 평타 ${formatValue(litDamage)}`,
      actual: `점등 평타 ${formatValue(litDamage)} · 처치 회복 ${formatValue(stats.markKillHeal)}`,
      status: marked > 0 ? `표식 ${marked}체` : '표식 대기',
      enhancement: '상시 효과 · 재사용 대기시간 없음',
      displayValue: marked > 0 ? String(marked) : '',
      ready: marked > 0,
      // 표식은 한 체만 있어도 점등이 준비된다. 8칸 충전처럼 보이던 임의
      // 분모를 없애고, 링은 준비 여부만 표시하며 중앙 숫자는 대상 수를 맡는다.
      progress: marked > 0 ? 1 : 0,
      meterNow: marked,
      meterMax: Math.max(1, marked),
      meterText: `${marked}체 표식`,
    }
  }

  const gauge = Math.max(0, Math.min(100, world.player.gauge))
  const empowered = world.player.empowered
  const swipeDamage = effectiveAtkDamage(stats) * 1.45
  return {
    metric: 'gauge',
    name: empowered ? '월참' : passiveDef.name,
    tag: '근거리 패시브',
    description: passiveDef.oneLiner,
    detail: empowered
      ? `다음 평타 광역 ${formatValue(swipeDamage)} · QWE 재사용 단축`
      : `적 가까이에서 자동 충전 · 월참 ${formatValue(swipeDamage)}`,
    actual: `월참 피해 ${formatValue(swipeDamage)}`,
    status: empowered ? '월참 준비 완료' : `참흔 ${Math.round(gauge)}%`,
    enhancement: empowered
      ? '다음 평타 광역 · QWE 재사용 단축'
      : '적 가까이에서 참흔 자동 충전',
    displayValue: empowered ? '준비' : String(Math.round(gauge)),
    ready: empowered,
    progress: empowered ? 1 : gauge / 100,
    meterNow: empowered ? 100 : gauge,
    meterMax: 100,
    meterText: empowered ? '월참 준비 완료' : `참흔 ${Math.round(gauge)}%`,
  }
}

function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return value >= 10 ? `${Math.round(value)}초` : `${Math.round(value * 10) / 10}초`
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

function describeBranch(branch: string, slot: SkillId): string {
  const presentation = getUpgradeBranchPresentation(branch, slot)
  if (presentation) return `${presentation.name}: ${presentation.oneLiner}`
  return '각성 효과 활성'
}

/** SKILL_IDS 순서와 슬롯 구성이 어긋나지 않았는지 개발 중에 확인한다. */
export function assertSlotsCoverAllSkills(meta: readonly SlotMeta[]): void {
  const covered = new Set(meta.map((m) => m.id))
  const missing = SKILL_IDS.filter((id) => !covered.has(id))
  if (missing.length > 0) {
    throw new Error(`스킬바에 빠진 슬롯: ${missing.join(', ')}`)
  }
}
