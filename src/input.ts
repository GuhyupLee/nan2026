import { SKILL_BIT, type SkillId } from './sim/skills.ts'
import type { Input } from './sim/types.ts'
import type { Vec2 } from './sim/vec.ts'

/**
 * 입력.
 *
 * 브라우저 의존은 전부 이 파일 안에 갇혀 있다. 시뮬은 Input 구조체만 본다.
 *
 * 바인딩:
 *   이동   마우스 좌/우클릭 홀드 · 터치 홀드 (커서 방향으로 연속 이동)
 *          방향키 (접근성 대체)
 *   스킬   Q W E R D F  — 또는 화면 하단 스킬바 버튼
 *
 * WASD를 쓰지 않는 이유: QWERDF가 전부 스킬에 묶여 W와 D가 충돌한다.
 * 이동을 마우스 전용으로 정한 결과이기도 하다.
 *
 * 클릭 이동(길찾기)이 아니라 홀드 연속 이동이다. 적 250마리 밀도에서
 * 클릭 이동은 반응이 느려 이 장르와 맞지 않는다. 디아블로4·PoE·이터널 리턴 방식.
 */

const SKILL_KEYS: Record<string, SkillId> = {
  KeyQ: 'q',
  KeyW: 'w',
  KeyE: 'e',
  KeyR: 'r',
  KeyD: 'd',
  KeyF: 'f',
}

/**
 * 커서가 이 거리(월드 단위)보다 가까우면 멈춘다.
 * 없으면 커서 위에서 좌우로 떠는 지터가 생긴다.
 */
const MOVE_DEADZONE = 0.6

export class InputState {
  /** 활성 포인터의 화면 좌표. 조준의 기준이자 이동 목표다. */
  pointerX = 0
  pointerY = 0

  /** 포인터가 눌린 채인가. 눌려 있으면 커서 방향으로 이동한다. */
  pointerHeld = false

  /** 한 번이라도 조작했는가. 안내 문구를 지우는 데 쓴다. */
  hasActed = false

  private readonly held = new Set<string>()
  private pendingSkills = 0
  private readonly surface: HTMLElement

  constructor(surface: HTMLElement) {
    this.surface = surface

    surface.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
    // 우클릭 이동 중에 컨텍스트 메뉴가 뜨면 조작이 끊긴다.
    surface.addEventListener('contextmenu', this.onContextMenu)

    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
  }

  // --- 포인터 ---

  private readonly onPointerDown = (e: PointerEvent): void => {
    // 스킬바 버튼 등 UI 위에서 시작한 입력은 이동으로 해석하지 않는다.
    // (리스너가 surface에 달려 있어 대부분 걸러지지만 방어적으로 한 번 더 본다.)
    if (e.target !== this.surface && !this.surface.contains(e.target as Node)) return

    this.pointerX = e.clientX
    this.pointerY = e.clientY
    this.pointerHeld = true
    this.hasActed = true
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.pointerX = e.clientX
    this.pointerY = e.clientY
  }

  private readonly onPointerUp = (): void => {
    this.pointerHeld = false
  }

  private readonly onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
  }

  // --- 키보드 ---

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

  /** 창이 포커스를 잃으면 키가 눌린 채로 남는 것을 막는다. */
  private readonly onBlur = (): void => {
    this.held.clear()
    this.pendingSkills = 0
    this.pointerHeld = false
  }

  // --- 외부에서 스킬 발동 (스킬바 버튼·터치) ---

  pressSkill(id: SkillId): void {
    this.pendingSkills |= SKILL_BIT[id]
    this.hasActed = true
  }

  /**
   * 한 틱 분량의 입력을 out에 채운다.
   *
   * 이동은 방향키만 여기서 처리한다. 포인터 이동은 월드 좌표가 필요해서
   * applyPointerMove()가 이어받는다 — 렌더러의 지면 레이캐스트가 선행되어야 하기 때문이다.
   *
   * 스킬은 "눌린 순간" 엣지라 한 번 읽으면 소비된다.
   * 한 프레임에 여러 틱이 돌아도 중복 발동하지 않는다.
   */
  sample(out: Input): Input {
    let x = 0
    let y = 0
    if (this.held.has('ArrowLeft')) x -= 1
    if (this.held.has('ArrowRight')) x += 1
    // 화면 위쪽이 월드 -Z 이므로 전진은 y(=z) 감소다.
    if (this.held.has('ArrowUp')) y -= 1
    if (this.held.has('ArrowDown')) y += 1

    out.move.x = x
    out.move.y = y
    out.skillsPressed = this.pendingSkills
    this.pendingSkills = 0

    if (x !== 0 || y !== 0) this.hasActed = true

    return out
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
  }
}

/**
 * 포인터가 눌려 있으면 커서 쪽으로 향하는 이동 벡터를 넣는다.
 *
 * out.aim(월드 좌표)이 이미 채워져 있어야 한다 — 호출 전에
 * renderer.screenToGround()를 돌려야 한다는 뜻이다.
 * 포인터 이동은 방향키 입력을 덮어쓴다.
 */
export function applyPointerMove(input: InputState, out: Input, player: Vec2): void {
  if (!input.pointerHeld) return

  const dx = out.aim.x - player.x
  const dy = out.aim.y - player.y

  // 커서가 발밑에 있으면 멈춘다. 정규화하면 미세한 오차가 방향으로 증폭된다.
  if (dx * dx + dy * dy < MOVE_DEADZONE * MOVE_DEADZONE) {
    out.move.x = 0
    out.move.y = 0
    return
  }

  out.move.x = dx
  out.move.y = dy
}
