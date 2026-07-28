import { getSkillDamageBreakdown, getSkillDef } from '../content/skills.ts'
import { UPGRADES, hasUpgradeTrait } from '../content/upgrades.ts'
import {
  MAX_SKILL_RANK,
  SKILL_IDS,
  type SkillBook,
  type SkillId,
  cooldownProgress,
  skillDamageMul,
} from '../sim/skills.ts'
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

interface SlotView {
  meta: SlotMeta
  root: HTMLButtonElement
  icon: HTMLImageElement
  fallback: HTMLSpanElement
  cd: HTMLDivElement
  cdText: HTMLDivElement
  /** 직전 프레임에 사용 가능했는가. 쿨다운이 막 끝난 순간을 잡는다. */
  wasReady: boolean
}

export interface SkillBarHandlers {
  start: (id: SkillId) => void
  release: (id: SkillId) => void
  cancel: (id: SkillId) => void
}

export class SkillBar {
  private readonly root: HTMLDivElement
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
  private activeTooltip: SlotView | null = null
  private tooltipBook: SkillBook | null = null
  private tooltipWorld: World | null = null
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

    for (const m of meta) {
      const slot = document.createElement('button')
      slot.className = 'slot'
      slot.type = 'button'
      slot.dataset.kind = m.kind
      slot.dataset.state = 'locked'
      slot.setAttribute('aria-disabled', 'true')

      const glyph = document.createElement('div')
      glyph.className = 'glyph'

      const icon = document.createElement('img')
      icon.className = 'skill-icon'
      icon.alt = ''
      icon.draggable = false
      glyph.appendChild(icon)

      const fallback = document.createElement('span')
      fallback.className = 'glyph-fallback'
      fallback.textContent = m.glyph
      glyph.appendChild(fallback)
      slot.appendChild(glyph)

      const key = document.createElement('div')
      key.className = 'key'
      key.textContent = m.key
      slot.appendChild(key)

      const cd = document.createElement('div')
      cd.className = 'cd'
      slot.appendChild(cd)

      const cdText = document.createElement('div')
      cdText.className = 'cdtext'
      slot.appendChild(cdText)

      const view: SlotView = {
        meta: m,
        root: slot,
        icon,
        fallback,
        cd,
        cdText,
        wasReady: false,
      }
      let activePointerId: number | null = null

      const clearPointer = (cancel: boolean): void => {
        if (activePointerId === null) return
        const pointerId = activePointerId
        activePointerId = null
        delete slot.dataset.targeting
        if (slot.hasPointerCapture(pointerId)) {
          slot.releasePointerCapture(pointerId)
        }
        if (cancel) handlers.cancel(m.id)
      }
      this.cancelPointers.push(() => clearPointer(true))

      slot.addEventListener('pointerdown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.pointerType === 'touch') this.showTooltip(view)
        if (slot.dataset.state !== 'ready' || activePointerId !== null) {
          if (e.pointerType === 'touch') this.scheduleTooltipHide()
          return
        }
        activePointerId = e.pointerId
        slot.setPointerCapture(e.pointerId)
        slot.dataset.targeting = 'true'
        handlers.start(m.id)
      })

      slot.addEventListener('pointerup', (e) => {
        if (e.pointerId !== activePointerId) return
        e.preventDefault()
        e.stopPropagation()
        clearPointer(false)
        handlers.release(m.id)
        if (e.pointerType === 'touch') this.scheduleTooltipHide()
      })

      const cancelPointer = (e: PointerEvent): void => {
        if (e.pointerId !== activePointerId) return
        e.preventDefault()
        e.stopPropagation()
        clearPointer(true)
      }
      slot.addEventListener('pointercancel', cancelPointer)
      slot.addEventListener('pointerleave', cancelPointer)
      slot.addEventListener('lostpointercapture', (e) => {
        if (e.pointerId !== activePointerId) return
        activePointerId = null
        delete slot.dataset.targeting
        handlers.cancel(m.id)
      })
      // 터치는 브라우저의 암시적 포인터 캡처 때문에 pointerleave가 생략될 수
      // 있다. 캡처 중에도 좌표를 직접 검사해 버튼 밖 드래그를 취소한다.
      slot.addEventListener('pointermove', (e) => {
        if (e.pointerId !== activePointerId) return
        const bounds = slot.getBoundingClientRect()
        if (
          e.clientX < bounds.left ||
          e.clientX > bounds.right ||
          e.clientY < bounds.top ||
          e.clientY > bounds.bottom
        ) {
          cancelPointer(e)
        }
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
      slot.addEventListener('focus', () => this.showTooltip(view))
      slot.addEventListener('blur', () => this.hideTooltip(view))

      this.root.appendChild(slot)
      this.slots.push(view)
    }

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
      view.root.setAttribute('aria-disabled', String(!ready))

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
        view.cd.style.setProperty('--p', String(cooldownProgress(book, view.meta.id)))
        // 롤과 같은 관습: 1초 미만은 소수점 한 자리.
        view.cdText.textContent =
          s.cooldown >= 1 ? String(Math.ceil(s.cooldown)) : s.cooldown.toFixed(1)
      }

      view.wasReady = ready
    }

    if (this.activeTooltip) this.renderTooltip(this.activeTooltip)
  }

  /** QWER 아이콘과 슬롯 강조색을 선택한 클래스에 맞춘다. */
  setClass(playerClass: PlayerClass): void {
    if (playerClass === this.currentClass) return
    this.currentClass = playerClass
    this.root.dataset.class = playerClass

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

  private showTooltip(view: SlotView): void {
    window.clearTimeout(this.tooltipHideTimer)
    this.activeTooltip = view
    this.tooltipSignature = ''
    this.tooltip.hidden = false
    this.renderTooltip(view)
    this.positionTooltip(view)
  }

  private hideTooltip(view?: SlotView): void {
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

  private renderTooltip(view: SlotView): void {
    const playerClass = this.currentClass ?? 'ranged'
    const def = getSkillDef(playerClass, view.meta.id)
    if (!def) return

    const runtime = this.tooltipBook?.[view.meta.id]
    const world = this.tooltipWorld
    const damageMultiplier =
      runtime && view.meta.kind === 'core'
        ? skillDamageMul(this.tooltipBook!, view.meta.id) * (world?.stats.atkDamageMul ?? 1)
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
    const status = !runtime?.unlocked
      ? '미해금'
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
      const rankBonus = Math.round((skillDamageMul(this.tooltipBook!, view.meta.id) - 1) * 100)
      const attackBonus = Math.round(((world?.stats.atkDamageMul ?? 1) - 1) * 100)
      enhancement =
        `강화 ${runtime.rank}/${MAX_SKILL_RANK} · 랭크 피해 +${rankBonus}%` +
        (attackBonus !== 0 ? ` · 공격 강화 ${attackBonus > 0 ? '+' : ''}${attackBonus}%` : '') +
        ` · 재사용 ${formatSeconds(cooldown)}`
      if (runtime.branch) enhancement += ` · ${describeBranch(runtime.branch)}`
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

  private positionTooltip(view: SlotView): void {
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

  private flash(view: SlotView): void {
    view.root.classList.remove('flash')
    // 클래스를 다시 붙이기 전에 리플로우를 강제해야 애니메이션이 재생된다.
    void view.root.offsetWidth
    view.root.classList.add('flash')
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none'
    if (!visible) this.hideTooltip()
  }

  dispose(): void {
    window.clearTimeout(this.tooltipHideTimer)
    window.removeEventListener('keydown', this.onEscape)
    this.tooltip.remove()
    this.root.remove()
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

function describeBranch(branch: string): string {
  for (const upgrade of UPGRADES) {
    const rank = upgrade.ranks.find((candidate) => candidate.trait === branch)
    if (!rank) continue
    return `${rank.awakeningName ?? upgrade.name}: ${rank.oneLiner}`
  }
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
