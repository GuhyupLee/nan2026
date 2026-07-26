import {
  SKILL_AREA,
  SKILL_DASH,
  SKILL_PRIMARY,
  SKILL_ULT,
  type Input,
} from './sim/types.ts'

/**
 * 키/마우스 상태를 시뮬레이션 Input으로 변환한다.
 *
 * 브라우저 의존은 전부 이 파일 안에 갇혀 있다. 시뮬은 Input 구조체만 본다.
 *
 * 바인딩:
 *   이동   WASD / 방향키
 *   주력기 Q
 *   대시   Space
 *   광역기 E
 *   궁극기 R
 *
 * 대시가 W가 아닌 Space인 이유: WASD 이동과 MOBA의 QWER은 W에서 충돌한다.
 * Space는 대시/회피 키로 이미 보편적이라 학습 비용이 없다.
 */
const SKILL_KEYS: Record<string, number> = {
  KeyQ: SKILL_PRIMARY,
  Space: SKILL_DASH,
  KeyE: SKILL_AREA,
  KeyR: SKILL_ULT,
}

export class InputState {
  /** 마지막으로 알려진 마우스 화면 좌표. */
  mouseX = 0
  mouseY = 0

  /** 플레이어가 한 번이라도 이동 입력을 했는가. 안내 문구를 지우는 데 쓴다. */
  hasMoved = false

  private readonly held = new Set<string>()
  private pendingSkills = 0

  constructor() {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('mousemove', this.onMouseMove)
    window.addEventListener('blur', this.onBlur)
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // 스페이스로 페이지가 스크롤되거나 버튼이 눌리는 것을 막는다.
    if (e.code === 'Space') e.preventDefault()

    if (e.repeat) return
    this.held.add(e.code)

    const skill = SKILL_KEYS[e.code]
    if (skill !== undefined) this.pendingSkills |= skill
  }

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code)
  }

  private readonly onMouseMove = (e: MouseEvent): void => {
    this.mouseX = e.clientX
    this.mouseY = e.clientY
  }

  /** 창이 포커스를 잃으면 키가 눌린 채로 남는 것을 막는다. */
  private readonly onBlur = (): void => {
    this.held.clear()
    this.pendingSkills = 0
  }

  /**
   * 한 틱 분량의 입력을 out에 채운다.
   *
   * 스킬은 "눌린 순간" 엣지이므로 한 번 읽으면 소비된다.
   * 한 프레임에 여러 틱이 돌아도 스킬이 중복 발동하지 않는다.
   * aim은 렌더러의 지면 레이캐스트가 필요하므로 호출부에서 채운다.
   */
  sample(out: Input): Input {
    let x = 0
    let y = 0
    if (this.held.has('KeyA') || this.held.has('ArrowLeft')) x -= 1
    if (this.held.has('KeyD') || this.held.has('ArrowRight')) x += 1
    // 화면 위쪽이 월드 -Z 이므로 전진은 y(=z) 감소다.
    if (this.held.has('KeyW') || this.held.has('ArrowUp')) y -= 1
    if (this.held.has('KeyS') || this.held.has('ArrowDown')) y += 1

    out.move.x = x
    out.move.y = y
    out.skillsPressed = this.pendingSkills
    this.pendingSkills = 0

    if (x !== 0 || y !== 0) this.hasMoved = true

    return out
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    window.removeEventListener('blur', this.onBlur)
  }
}
