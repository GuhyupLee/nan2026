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

const MOVEMENT_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
])
const MOVE_STOP_RADIUS = 0.55
const MOVE_SLOW_RADIUS = 2.6
// 112px 베이스와 48px 노브 안에서 노브가 정확히 가장자리까지 움직인다.
const TOUCH_STICK_RADIUS = 32
const TOUCH_STICK_DEADZONE = 8
const TOUCH_AIM_DISTANCE = 12
const CAST_MODE_STORAGE_KEY = 'prototype-cast-mode-v1'
const AIM_ASSIST_STORAGE_KEY = 'prototype-aim-assist-v1'

export type CastMode = 'instant' | 'release'

function readCastMode(): CastMode {
  try {
    return localStorage.getItem(CAST_MODE_STORAGE_KEY) === 'release' ? 'release' : 'instant'
  } catch {
    return 'instant'
  }
}

function readAimAssist(): boolean {
  try {
    return localStorage.getItem(AIM_ASSIST_STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export class InputState {
  /** 렌더러가 지면 레이캐스트에 사용하는 현재 커서 좌표. */
  pointerX = 0
  pointerY = 0

  /** 마우스 방향 고정 이동 또는 터치 조이스틱이 활성화되어 있는가. */
  pointerHeld = false

  /** 마우스로 고정한 이동 방향의 화면 앵커. 호버 조준과 독립적이다. */
  movementPointerX = 0
  movementPointerY = 0

  /** 첫 조작 안내를 닫기 위한 플래그. */
  hasActed = false

  private readonly held = new Set<string>()
  private pendingSkills = 0
  private readonly pendingSkillOrder: SkillId[] = []
  private castMode: CastMode = readCastMode()
  private aimAssist = readAimAssist()
  private targetedSkill: SkillId | null = null
  private skillPointerAimActive = false
  private skillPointerAimPending = false
  private sampledSkillPointerAim = false
  private skillPointerX = 0
  private skillPointerY = 0
  private readonly surface: HTMLElement
  private readonly previousTouchAction: string

  private mousePointerId: number | null = null
  private mouseMoveActive = false
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
    const bounds = surface.getBoundingClientRect()
    this.pointerX = bounds.left + bounds.width * 0.5
    this.pointerY = bounds.top + bounds.height * 0.5
    this.movementPointerX = this.pointerX
    this.movementPointerY = this.pointerY

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
    surface.addEventListener('lostpointercapture', this.onLostPointerCapture)
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
      this.mouseMoveActive = false
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

    if (e.button === 2) {
      if (this.targetedSkill !== null) {
        e.preventDefault()
        this.targetedSkill = null
        this.skillPointerAimActive = false
      }
      return
    }
    if (e.button !== 0) return

    this.mousePointerId = e.pointerId
    this.pointerX = e.clientX
    this.pointerY = e.clientY
    this.movementPointerX = e.clientX
    this.movementPointerY = e.clientY
    this.mouseMoveActive = true
    this.pointerHeld = true
    this.hasActed = true
    try {
      this.surface.setPointerCapture(e.pointerId)
    } catch {
      // 창 밖으로 나가도 window 리스너가 해제를 복구한다.
    }
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') {
      if (e.pointerId !== this.touchPointerId) return
      e.preventDefault()
      this.updateTouchStick(e.clientX, e.clientY)
      return
    }

    // pointerdown을 게임 표면에서 받은 포인터만 이동을 소유한다. 눌린 버튼만
    // 보고 여기서 소유권을 되살리면 스킬 슬롯·설정 UI에서 시작한 드래그가
    // 캔버스로 넘어오는 순간 캐릭터 이동으로 바뀐다.
    // 호버 조준은 마우스에서 기존대로 계속 갱신한다.
    const target = e.target
    const overGameSurface =
      target instanceof Node &&
      (target === this.surface || this.surface.contains(target))
    if (this.mousePointerId === null && !overGameSurface) return
    if (
      this.mousePointerId !== null &&
      e.pointerId === this.mousePointerId &&
      e.buttons === 0
    ) {
      this.mousePointerId = null
      this.pointerHeld = this.mouseMoveActive || this.touchPointerId !== null
      return
    }
    this.pointerX = e.clientX
    this.pointerY = e.clientY
    if (this.mousePointerId !== null && e.pointerId === this.mousePointerId) {
      this.movementPointerX = e.clientX
      this.movementPointerY = e.clientY
      this.mouseMoveActive = true
      this.pointerHeld = true
    }
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

    if (e.type !== 'pointercancel' && e.button !== 0) return
    if (this.mousePointerId !== null && e.pointerId !== this.mousePointerId) return
    this.mousePointerId = null
    if (e.type === 'pointercancel') this.mouseMoveActive = false
    this.pointerHeld = this.mouseMoveActive || this.touchPointerId !== null
  }

  private readonly onLostPointerCapture = (e: PointerEvent): void => {
    if (e.pointerId === this.mousePointerId) {
      this.mousePointerId = null
      this.mouseMoveActive = false
      this.pointerHeld = this.touchPointerId !== null
    }
    if (e.pointerId === this.touchPointerId) {
      this.touchPointerId = null
      this.touchDirectionX = 0
      this.touchDirectionY = 0
      this.pointerHeld = this.mousePointerId !== null
      this.touchStick.dataset.active = 'false'
    }
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
    this.targetedSkill = null
    this.skillPointerAimActive = false
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' && this.targetedSkill !== null) {
      this.targetedSkill = null
      this.skillPointerAimActive = false
      e.preventDefault()
      e.stopImmediatePropagation()
      return
    }
    if (
      e.defaultPrevented ||
      e.ctrlKey ||
      e.metaKey ||
      e.altKey ||
      isEditableTarget(e.target)
    ) {
      return
    }
    if (e.repeat) return
    if (MOVEMENT_KEYS.has(e.code) && this.touchPointerId === null) {
      this.mouseMoveActive = false
      this.pointerHeld = false
    }
    this.held.add(e.code)

    const skill = SKILL_KEYS[e.code]
    if (skill !== undefined) this.startSkill(skill)
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code)
    if (isEditableTarget(e.target)) return
    const skill = SKILL_KEYS[e.code]
    if (skill !== undefined) this.releaseSkill(skill)
  }

  private readonly onBlur = (): void => {
    this.held.clear()
    this.pendingSkills = 0
    this.pendingSkillOrder.length = 0
    this.releaseMovement()
  }

  /** 화면 전환·포커스 이탈 때 남은 포인터 점유와 조이스틱을 함께 정리한다. */
  releaseMovement(): void {
    if (this.mousePointerId !== null) {
      try {
        if (this.surface.hasPointerCapture(this.mousePointerId)) {
          this.surface.releasePointerCapture(this.mousePointerId)
        }
      } catch {
        // 캡처를 지원하지 않는 브라우저에서는 상태만 정리하면 된다.
      }
    }
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
    this.mouseMoveActive = false
    this.touchPointerId = null
    this.touchDirectionX = 0
    this.touchDirectionY = 0
    this.pointerHeld = false
    this.held.clear()
    this.pendingSkills = 0
    this.pendingSkillOrder.length = 0
    this.touchStick.dataset.active = 'false'
    this.touchStick.style.setProperty('--stick-x', '0px')
    this.touchStick.style.setProperty('--stick-y', '0px')
    this.targetedSkill = null
    this.skillPointerAimActive = false
    this.skillPointerAimPending = false
    this.sampledSkillPointerAim = false
  }

  /** 화면 중앙을 클릭해 정지하면 이후 밀림이 자동 이동을 되살리지 않게 한다. */
  completePointerMove(): void {
    if (this.touchPointerId !== null) return
    this.mouseMoveActive = false
    this.pointerHeld = false
  }

  get targetingSkill(): SkillId | null {
    return this.targetedSkill
  }

  getCastMode(): CastMode {
    return this.castMode
  }

  setCastMode(mode: CastMode): void {
    if (mode === this.castMode) return
    this.targetedSkill = null
    this.skillPointerAimActive = false
    this.skillPointerAimPending = false
    this.sampledSkillPointerAim = false
    this.castMode = mode
    try {
      localStorage.setItem(CAST_MODE_STORAGE_KEY, mode)
    } catch {
      // 저장소가 막혀 있어도 현재 세션의 입력 모드는 정상 동작한다.
    }
  }

  getAimAssist(): boolean {
    return this.aimAssist
  }

  setAimAssist(enabled: boolean): void {
    if (enabled === this.aimAssist) return
    this.aimAssist = enabled
    try {
      localStorage.setItem(AIM_ASSIST_STORAGE_KEY, enabled ? 'on' : 'off')
    } catch {
      // 저장소가 막혀도 현재 세션의 설정은 유지한다.
    }
  }

  /** 스킬 키·버튼을 누른 순간. 즉시 모드는 여기서, 키업 모드는 releaseSkill에서 발동한다. */
  startSkill(id: SkillId): void {
    this.hasActed = true
    if (this.castMode === 'instant') {
      this.targetedSkill = null
      this.skillPointerAimActive = false
      this.queueSkill(id)
      return
    }
    this.targetedSkill = id
  }

  /** 키업 시전 모드에서 현재 조준 중인 같은 스킬만 발동한다. */
  releaseSkill(id: SkillId): void {
    if (this.castMode !== 'release' || this.targetedSkill !== id) return
    this.targetedSkill = null
    this.skillPointerAimPending = this.skillPointerAimActive
    this.skillPointerAimActive = false
    this.queueSkill(id)
    this.hasActed = true
  }

  /** 포인터 이탈·취소 시 해당 스킬의 키업 시전을 버린다. */
  cancelSkill(id: SkillId): void {
    if (this.targetedSkill === id) {
      this.targetedSkill = null
      this.skillPointerAimActive = false
    }
  }

  setSkillPointerAim(clientX: number, clientY: number): void {
    if (this.targetedSkill === null) return
    this.skillPointerX = clientX
    this.skillPointerY = clientY
    this.skillPointerAimActive = true
  }

  get hasSkillPointerAim(): boolean {
    return this.sampledSkillPointerAim
  }

  get sampledSkillPointerX(): number {
    return this.skillPointerX
  }

  get sampledSkillPointerY(): number {
    return this.skillPointerY
  }

  /** 기존 호출부를 위한 시전 모드 비의존 즉시 큐잉 메서드. */
  pressSkill(id: SkillId): void {
    this.queueSkill(id)
    this.hasActed = true
  }

  private queueSkill(id: SkillId): void {
    const bit = SKILL_BIT[id]
    if ((this.pendingSkills & bit) === 0) this.pendingSkillOrder.push(id)
    this.pendingSkills |= bit
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
    const sequence = out.skillSequence ?? (out.skillSequence = [])
    sequence.length = 0
    sequence.push(...this.pendingSkillOrder)
    out.aimAssist = this.aimAssist
    this.sampledSkillPointerAim =
      this.skillPointerAimActive || this.skillPointerAimPending
    this.skillPointerAimPending = false
    this.pendingSkills = 0
    this.pendingSkillOrder.length = 0

    if (x !== 0 || y !== 0) this.hasActed = true

    return out
  }

  /** 터치가 이동을 점유하면 이동·조준을 채우고 true를 반환한다. */
  applyTouchMove(out: Input, player: Vec2): boolean {
    if (this.touchPointerId === null) return false

    out.move.x = this.touchDirectionX
    out.move.y = this.touchDirectionY

    // 데드존에서 멈춘 동안에도 마지막 유효 방향을 유지한다. 스킬바 드래그의
    // 별도 조준점은 Input.skillAim으로 전달되므로 전장 조준을 덮지 않는다.
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
    this.surface.removeEventListener('lostpointercapture', this.onLostPointerCapture)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.surface.style.touchAction = this.previousTouchAction
    this.touchStick.remove()
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  )
}

/**
 * 활성 포인터를 이동 벡터로 바꾼다. 터치는 화면 기준 조이스틱 방향을
 * 이동과 조준에 함께 쓰고, 마우스·펜은 고정한 화면 방향으로 이동한다.
 */
export function applyPointerMove(
  input: InputState,
  out: Input,
  player: Vec2,
  movementTarget: Vec2 = out.aim,
): void {
  if (!input.pointerHeld) return
  if (input.applyTouchMove(out, player)) return

  const dx = movementTarget.x - player.x
  const dy = movementTarget.y - player.y

  const distance = Math.hypot(dx, dy)
  if (distance <= MOVE_STOP_RADIUS) {
    out.move.x = 0
    out.move.y = 0
    input.completePointerMove()
    return
  }

  const normalizedX = dx / distance
  const normalizedY = dy / distance
  const slowT = Math.min(
    1,
    (distance - MOVE_STOP_RADIUS) / (MOVE_SLOW_RADIUS - MOVE_STOP_RADIUS),
  )
  const speedScale = slowT * slowT * (3 - 2 * slowT)
  out.move.x = normalizedX * speedScale
  out.move.y = normalizedY * speedScale
}
