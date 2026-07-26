import { xpToNext } from '../sim/progression.ts'
import type { World } from '../sim/types.ts'

/**
 * HUD — 캐릭터 위 체력바 + 하단 경험치 바 + 타이머.
 *
 * 이터널 리턴 문법을 따른다: 레벨 뱃지와 분절된 체력바가 캐릭터를 따라다닌다.
 * 화면 구석의 고정 HUD보다 이쪽이 시선 이동이 적다 — 전투 중에 눈이
 * 캐릭터를 떠나지 않아도 자기 상태가 보인다.
 */

/** 월드 좌표를 화면 픽셀로 바꾸는 함수. 렌더러가 제공한다. */
export type Projector = (
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number },
) => boolean

export class Hud {
  private readonly floatBar: HTMLDivElement
  private readonly fill: HTMLDivElement
  private readonly ghost: HTMLDivElement
  private readonly lv: HTMLDivElement
  private readonly xpFill: HTMLDivElement
  private readonly xpBar: HTMLDivElement
  private readonly clock: HTMLDivElement

  private readonly screen = { x: 0, y: 0 }
  /** 화면에 남아 흐르는 붉은 잔상 비율. 실제 체력보다 천천히 따라간다. */
  private ghostRatio = 1
  private lastLevel = 0

  constructor(parent: HTMLElement) {
    this.floatBar = document.createElement('div')
    this.floatBar.className = 'floatbar'
    this.floatBar.innerHTML =
      `<div class="lv">1</div>` +
      `<div class="track"><div class="ghost"></div><div class="fill"></div></div>`
    this.lv = this.floatBar.querySelector('.lv')!
    this.ghost = this.floatBar.querySelector('.ghost')!
    this.fill = this.floatBar.querySelector('.fill')!
    parent.appendChild(this.floatBar)

    this.xpBar = document.createElement('div')
    this.xpBar.className = 'xpbar'
    this.xpBar.innerHTML = `<div class="fill"></div>`
    this.xpFill = this.xpBar.querySelector('.fill')!
    parent.appendChild(this.xpBar)

    this.clock = document.createElement('div')
    this.clock.className = 'clock'
    parent.appendChild(this.clock)

    this.setVisible(false)
  }

  update(world: World, project: Projector, dt: number): void {
    const p = world.player
    const s = world.stats
    const ratio = s.maxHp > 0 ? Math.max(0, Math.min(1, p.hp / s.maxHp)) : 0

    // --- 캐릭터 위 체력바 ---
    // 머리 위 약간(1.95)에 띄운다. 캐릭터 신장이 1.75다.
    const visible = project(p.pos.x, 1.95, p.pos.y, this.screen)
    if (visible) {
      this.floatBar.style.transform = `translate(-50%, -100%) translate(${this.screen.x.toFixed(1)}px, ${this.screen.y.toFixed(1)}px)`
      this.floatBar.style.visibility = ''
    } else {
      this.floatBar.style.visibility = 'hidden'
    }

    this.fill.style.width = `${(ratio * 100).toFixed(1)}%`

    // 붉은 잔상은 아래로만 천천히 따라가고, 회복할 때는 즉시 맞춘다.
    // 얼마나 크게 맞았는지가 눈에 남는다.
    if (ratio > this.ghostRatio) this.ghostRatio = ratio
    else this.ghostRatio = Math.max(ratio, this.ghostRatio - dt * 0.5)
    this.ghost.style.width = `${(this.ghostRatio * 100).toFixed(1)}%`

    this.floatBar.dataset.danger = ratio <= 0.25 ? 'crit' : ratio <= 0.5 ? 'warn' : 'ok'

    const level = world.progression.level
    if (level !== this.lastLevel) {
      this.lastLevel = level
      this.lv.textContent = String(level)
    }

    // --- 경험치 ---
    const prog = world.progression
    const need = xpToNext(prog.level)
    // 만렙이면 Infinity가 온다. 그 경우 바를 가득 채워 "더 없음"을 보여준다.
    this.xpFill.style.width = Number.isFinite(need)
      ? `${Math.min(100, (prog.xp / need) * 100).toFixed(1)}%`
      : '100%'

    // --- 타이머 ---
    const t = Math.max(0, world.time)
    const mm = Math.floor(t / 60)
    const ss = Math.floor(t % 60)
    this.clock.textContent = `${mm}:${String(ss).padStart(2, '0')}`
  }

  setVisible(visible: boolean): void {
    const d = visible ? '' : 'none'
    this.floatBar.style.display = d
    this.xpBar.style.display = d
    this.clock.style.display = d
  }
}
