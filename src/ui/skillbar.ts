import { getSkillDef } from '../content/skills.ts'
import { SKILL_IDS, type SkillBook, type SkillId, cooldownProgress } from '../sim/skills.ts'
import type { PlayerClass } from '../sim/types.ts'

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
  private currentClass: PlayerClass | null = null

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
      slot.disabled = true
      slot.title = `${m.name} (${m.key})`

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
        if (slot.dataset.state === 'locked' || activePointerId !== null) return
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
        if (e.detail !== 0 || slot.dataset.state === 'locked') return
        handlers.start(m.id)
        handlers.release(m.id)
      })

      this.root.appendChild(slot)
      this.slots.push({ meta: m, root: slot, icon, fallback, cd, cdText, wasReady: false })
    }

    parent.appendChild(this.root)
    this.setClass('ranged')
  }

  /** Clears any held pointer before an overlay, restart, or menu takes control. */
  cancelTargeting(): void {
    for (const cancel of this.cancelPointers) cancel()
  }

  /** 매 프레임 호출한다. DOM 쓰기는 값이 바뀔 때만 일어나게 막아뒀다. */
  update(book: SkillBook, playerClass?: PlayerClass): void {
    if (playerClass && playerClass !== this.currentClass) this.setClass(playerClass)

    for (const view of this.slots) {
      const s = book[view.meta.id]

      if (!s.unlocked) {
        view.root.disabled = true
        if (view.root.dataset.state !== 'locked') {
          view.root.dataset.state = 'locked'
          view.cd.style.setProperty('--p', '0')
          view.cdText.textContent = ''
        }
        view.wasReady = false
        continue
      }

      view.root.disabled = false
      const ready = s.cooldown <= 0

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
  }

  /** QWER 아이콘과 슬롯 강조색을 선택한 클래스에 맞춘다. */
  setClass(playerClass: PlayerClass): void {
    if (playerClass === this.currentClass) return
    this.currentClass = playerClass
    this.root.dataset.class = playerClass

    for (const view of this.slots) {
      const def = getSkillDef(playerClass, view.meta.id)
      if (!def) continue

      view.root.title = `${def.name} (${view.meta.key})`
      view.root.setAttribute('aria-label', `${def.name} — ${view.meta.key}`)
      view.icon.src = `${import.meta.env.BASE_URL}${def.icon}`
      view.icon.hidden = false
      view.fallback.textContent = def.glyph
      view.fallback.hidden = true
      view.icon.onerror = () => {
        view.icon.hidden = true
        view.fallback.hidden = false
      }
    }
  }

  private flash(view: SlotView): void {
    view.root.classList.remove('flash')
    // 클래스를 다시 붙이기 전에 리플로우를 강제해야 애니메이션이 재생된다.
    void view.root.offsetWidth
    view.root.classList.add('flash')
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none'
  }

  dispose(): void {
    this.root.remove()
  }
}

/** SKILL_IDS 순서와 슬롯 구성이 어긋나지 않았는지 개발 중에 확인한다. */
export function assertSlotsCoverAllSkills(meta: readonly SlotMeta[]): void {
  const covered = new Set(meta.map((m) => m.id))
  const missing = SKILL_IDS.filter((id) => !covered.has(id))
  if (missing.length > 0) {
    throw new Error(`스킬바에 빠진 슬롯: ${missing.join(', ')}`)
  }
}
