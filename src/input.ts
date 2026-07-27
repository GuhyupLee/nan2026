import { SKILL_BIT, type SkillId } from './sim/skills.ts'
import type { Input } from './sim/types.ts'
import type { Vec2 } from './sim/vec.ts'

/**
 * 브라우저 입력 어댑터.
 *
 * 마우스·펜은 기존 커서 지면 좌표 방식으로 움직인다. 터치는 전장에 먼저
 * 닿은 손가락 하나만 플로팅 조이스틱으로 점유한다. 다른 손가락은 스킬을
 * 눌러도 이동 포인터나 조준 방향을 바꾸지 않는다.
 */
const SKILL_KEYS: Record<string, SkillId> = {
  KeyQ: 'q',
  KeyW: 'w',
  KeyE: 'e',
  KeyR: 'r',
  KeyD: 'd',
  KeyF: 'f',
}

const MOVE_DEADZONE = 0.6
// 112px 베이스와 48px 노브 안에서 노브가 정확히 가장자리까지 움직인다.
const TOUCH_STICK_RADIUS = 32
const TOUCH_STICK_DEADZONE = 8
const TOUCH_AIM_DISTANCE = 12

export class InputState {
  /** 렌더러가 지면 레이캐스트에 사용하는 현재 커서 좌표. */
  pointerX = 0
  pointerY = 0

  /** 마우스 이동 또는 터치 조이스틱이 눌려 있는가. */
  pointerHeld = false

  /** 첫 조작 안내를 닫기 위한 플래그. */
  hasActed = false

  private readonly held = new Set<string>()
  private pendingSkills = 0
  private readonly surface: HTMLElement
  private readonly previousTouchAction: string

  private mousePointerId: number | null = null
  private touchPointerId: number | null = null
  private touchOriginX = 0
  private touchOriginY = 0
  private touchDirectionX = 0
  private touchDirectionY = 0
  private touchAimX = 1
  private touchAimY = 0

  private readonly touchStick: HTMLDivElement
  private readonly touchStickKnob: HTMLDivElement

  constructor(surface: HTMLElement) {
    this.surface = surface
    this.previousTouchAction = surface.style.touchAction
    surface.style.touchAction = 'none'

    this.touchStick = document.createElement('div')
    this.touchStick.className = 'touchstick'
    this.touchStick.setAttribute('aria-hidden', 'true')
    this.touchStick.dataset.active = 'false'

    this.touchStickKnob = document.createElement('div')
    this.touchStickKnob.className = 'touchstick-knob'
    this.touchStick.appendChild(this.touchStickKnob)
    surface.appendChild(this.touchStick)

    surface.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    surface.addEventListener('contextmenu', this.onContextMenu)

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.target !== this.surface && !this.surface.contains(e.target as Node)) return

    if (e.pointerType === 'touch') {
      // 첫 전장 터치만 이동을 점유한다. 이후 포인터는 스킬용으로 남긴다.
      if (this.touchPointerId !== null) return

      e.preventDefault()
      this.touchPointerId = e.pointerId
      this.touchOriginX = e.clientX
      this.touchOriginY = e.clientY
      this.pointerX = e.clientX
      this.pointerY = e.clientY
      this.pointerHeld = true
      this.hasActed = true

      this.touchStick.style.left = `${e.clientX}px`
      this.touchStick.style.top = `${e.clientY}px`
      this.touchStick.dataset.active = 'true'
      this.updateTouchStick(e.clientX, e.clientY)

      try {
        this.surface.setPointerCapture(e.pointerId)
      } catch {
        // 포인터 캡처가 없는 환경에서도 window 리스너가 이어받는다.
      }
      return
    }

    this.mousePointerId = e.pointerId
    this.pointerX = e.clientX
    this.pointerY = e.clientY
    this.pointerHeld = true
    this.hasActed = true
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      if (e.pointerId !== this.touchPointerId) return
      e.preventDefault()
      this.updateTouchStick(e.clientX, e.clientY)
      return
    }

    // 호버 조준은 마우스에서 기존대로 계속 갱신한다.
    this.pointerX = e.clientX
    this.pointerY = e.clientY
  }

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      if (e.pointerId !== this.touchPointerId) return

      this.touchPointerId = null
      this.touchDirectionX = 0
      this.touchDirectionY = 0
      this.pointerHeld = this.mousePointerId !== null
      this.touchStick.dataset.active = 'false'
      this.touchStick.style.setProperty('--stick-x', '0px')
      this.touchStick.style.setProperty('--stick-y', '0px')
      return
    }

    if (this.mousePointerId !== null && e.pointerId !== this.mousePointerId) return
    this.mousePointerId = null
    this.pointerHeld = this.touchPointerId !== null
  }

  private updateTouchStick(clientX: number, clientY: number): void {
    const rawX = clientX - this.touchOriginX
    const rawY = clientY - this.touchOriginY
    const length = Math.hypot(rawX, rawY)
    const scale = length > TOUCH_STICK_RADIUS ? TOUCH_STICK_RADIUS / length : 1
    const knobX = rawX * scale
    const knobY = rawY * scale

    this.pointerX = this.touchOriginX + knobX
    this.pointerY = this.touchOriginY + knobY
    this.touchStick.style.setProperty('--stick-x', `${knobX}px`)
    this.touchStick.style.setProperty('--stick-y', `${knobY}px`)

    if (length <= TOUCH_STICK_DEADZONE) {
      this.touchDirectionX = 0
      this.touchDirectionY = 0
      return
    }

    this.touchDirectionX = rawX / length
    this.touchDirectionY = rawY / length
    this.touchAimX = this.touchDirectionX
    this.touchAimY = this.touchDirectionY
  }

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return
    this.held.add(e.code)

    const skill = SKILL_KEYS[e.code]
    if (skill !== undefined) {
      this.pendingSkills |= SKILL_BIT[skill]
      this.hasActed = true
    }
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code)
  }

  private readonly onBlur = (): void => {
    this.held.clear()
    this.pendingSkills = 0
    this.releaseMovement()
  }

  /** 화면 전환·포커스 이탈 때 남은 포인터 점유와 조이스틱을 함께 정리한다. */
  releaseMovement(): void {
    if (this.touchPointerId !== null) {
      try {
        if (this.surface.hasPointerCapture(this.touchPointerId)) {
          this.surface.releasePointerCapture(this.touchPointerId)
        }
      } catch {
        // 캡처를 지원하지 않는 브라우저에서는 상태만 정리하면 된다.
      }
    }

    this.mousePointerId = null
    this.touchPointerId = null
    this.touchDirectionX = 0
    this.touchDirectionY = 0
    this.pointerHeld = false
    this.touchStick.dataset.active = 'false'
    this.touchStick.style.setProperty('--stick-x', '0px')
    this.touchStick.style.setProperty('--stick-y', '0px')
  }

  pressSkill(id: SkillId): void {
    this.pendingSkills |= SKILL_BIT[id]
    this.hasActed = true
  }

  sample(out: Input): Input {
    let x = 0
    let y = 0
    if (this.held.has('ArrowLeft')) x -= 1
    if (this.held.has('ArrowRight')) x += 1
    if (this.held.has('ArrowUp')) y -= 1
    if (this.held.has('ArrowDown')) y += 1

    out.move.x = x
    out.move.y = y
    out.skillsPressed = this.pendingSkills
    this.pendingSkills = 0

    if (x !== 0 || y !== 0) this.hasActed = true

    return out
  }

  /** 터치가 이동을 점유하면 이동·조준을 채우고 true를 반환한다. */
  applyTouchMove(out: Input, player: Vec2): boolean {
    if (this.touchPointerId === null) return false

    out.move.x = this.touchDirectionX
    out.move.y = this.touchDirectionY

    // 데드존에서 멈춘 동안에도 마지막 유효 방향을 유지한다. 그렇지 않으면
    // 두 번째 손가락으로 스킬을 누르는 순간 조준이 조이스틱 원점으로 튄다.
    out.aim.x = player.x + this.touchAimX * TOUCH_AIM_DISTANCE
    out.aim.y = player.y + this.touchAimY * TOUCH_AIM_DISTANCE

    return true
  }

  dispose(): void {
    this.surface.removeEventListener('pointerdown', this.onPointerDown)
    this.surface.removeEventListener('contextmenu', this.onContextMenu)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.surface.style.touchAction = this.previousTouchAction
    this.touchStick.remove()
  }
}

/**
 * 눌린 포인터를 이동 벡터로 바꾼다. 터치는 화면 기준 조이스틱 방향을
 * 이동과 조준에 함께 쓰고, 마우스·펜은 기존 지면 좌표 방식을 유지한다.
 */
export function applyPointerMove(input: InputState, out: Input, player: Vec2): void {
  if (!input.pointerHeld) return
  if (input.applyTouchMove(out, player)) return

  const dx = out.aim.x - player.x
  const dy = out.aim.y - player.y

  if (dx * dx + dy * dy < MOVE_DEADZONE * MOVE_DEADZONE) {
    out.move.x = 0
    out.move.y = 0
    return
  }

  out.move.x = dx
  out.move.y = dy
}
