import { xpToNext } from '../sim/progression.ts'
import type { World } from '../sim/types.ts'
import { RUN_TIME_LIMIT } from '../sim/constants.ts'
import { ELITE_SPAWN_TIMES } from '../sim/enemies.ts'

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
  private readonly runInfo: HTMLDivElement
  private readonly runKills: HTMLElement
  private readonly runLevel: HTMLElement
  private readonly runRelics: HTMLElement
  private readonly damageVignette: HTMLDivElement

  private readonly screen = { x: 0, y: 0 }
  /** 화면에 남아 흐르는 붉은 잔상 비율. 실제 체력보다 천천히 따라간다. */
  private ghostRatio = 1
  private lastLevel = 0
  private lastKills = -1
  private lastRelics = -1
  private renderedWorld: World | null = null
  private lastHp = 0
  private pendingDamage = 0
  private damagePulse = 0
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

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

    this.runInfo = document.createElement('div')
    this.runInfo.className = 'run-info'
    this.runInfo.innerHTML =
      `<span><small>KOs</small><b data-run-kills>000</b></span>` +
      `<span><small>LV</small><b data-run-level>01</b></span>` +
      `<span><small>SEAL</small><b data-run-relics>0/${ELITE_SPAWN_TIMES.length}</b></span>`
    this.runInfo.setAttribute('aria-label', '런 전황')
    this.runKills = this.runInfo.querySelector('[data-run-kills]')!
    this.runLevel = this.runInfo.querySelector('[data-run-level]')!
    this.runRelics = this.runInfo.querySelector('[data-run-relics]')!
    parent.appendChild(this.runInfo)

    this.damageVignette = document.createElement('div')
    this.damageVignette.className = 'damage-vignette'
    this.damageVignette.setAttribute('aria-hidden', 'true')
    parent.appendChild(this.damageVignette)

    this.setVisible(false)
  }

  update(world: World, project: Projector, dt: number): void {
    const p = world.player
    const s = world.stats
    const ratio = s.maxHp > 0 ? Math.max(0, Math.min(1, p.hp / s.maxHp)) : 0

    if (this.renderedWorld !== world) {
      this.renderedWorld = world
      this.lastHp = p.hp
      this.pendingDamage = 0
      this.damagePulse = 0
      this.lastKills = -1
      this.lastRelics = -1
      this.lastLevel = 0
    }

    // 지속 접촉 피해는 작은 값이 매 틱 들어온다. 그대로 번쩍이면 붉은 화면이
    // 배경이 되므로, 읽을 만한 덩어리가 됐을 때만 가장자리를 짧게 울린다.
    if (p.hp < this.lastHp && !this.reducedMotion.matches) {
      this.pendingDamage += this.lastHp - p.hp
      if (this.pendingDamage >= 5) {
        this.damagePulse = Math.max(
          this.damagePulse,
          Math.min(0.72, 0.24 + (this.pendingDamage / Math.max(1, s.maxHp)) * 2.4),
        )
        this.pendingDamage = 0
      }
    } else if (p.hp > this.lastHp) {
      this.pendingDamage = 0
    }
    this.lastHp = p.hp
    this.damagePulse = Math.max(0, this.damagePulse - dt * 1.7)
    const criticalVignette = ratio <= 0.28 ? (0.28 - ratio) * 1.15 : 0
    const vignette = this.reducedMotion.matches
      ? criticalVignette
      : Math.max(criticalVignette, this.damagePulse)
    this.damageVignette.style.setProperty('--damage-alpha', vignette.toFixed(3))
    this.damageVignette.dataset.critical = String(ratio <= 0.25)

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
    let runInfoChanged = false
    if (level !== this.lastLevel) {
      this.lastLevel = level
      this.lv.textContent = String(level)
      this.runLevel.textContent = String(level).padStart(2, '0')
      runInfoChanged = true
    }
    if (world.kills !== this.lastKills) {
      this.lastKills = world.kills
      this.runKills.textContent = String(world.kills).padStart(3, '0')
      runInfoChanged = true
    }
    if (world.relicsClaimed !== this.lastRelics) {
      this.lastRelics = world.relicsClaimed
      this.runRelics.textContent = `${world.relicsClaimed}/${ELITE_SPAWN_TIMES.length}`
      runInfoChanged = true
    }
    if (runInfoChanged) {
      this.runInfo.setAttribute(
        'aria-label',
        `처치 ${world.kills}, 레벨 ${level}, 월식 인장 ${world.relicsClaimed}/${ELITE_SPAWN_TIMES.length}`,
      )
    }

    // --- 경험치 ---
    const prog = world.progression
    const need = xpToNext(prog.level)
    // 만렙이면 Infinity가 온다. 그 경우 바를 가득 채워 "더 없음"을 보여준다.
    this.xpFill.style.width = Number.isFinite(need)
      ? `${Math.min(100, (prog.xp / need) * 100).toFixed(1)}%`
      : '100%'

    // --- 제한 시간 ---
    // 경과 시간보다 "얼마나 남았는가"가 보스전의 의사결정에 직접 필요하다.
    // 마지막 30초에는 색과 점멸로 시선을 끌되, 보스 등장 전에는 조용히 둔다.
    const t = Math.max(0, RUN_TIME_LIMIT - world.time)
    const wholeSeconds = Math.ceil(t)
    const mm = Math.floor(wholeSeconds / 60)
    const ss = wholeSeconds % 60
    this.clock.textContent = `${mm}:${String(ss).padStart(2, '0')}`
    this.clock.dataset.phase =
      world.boss.active && t <= 30 ? 'critical' : world.boss.active ? 'boss' : 'normal'
    this.clock.setAttribute('aria-label', `남은 시간 ${mm}분 ${ss}초`)

  }

  setVisible(visible: boolean): void {
    const d = visible ? '' : 'none'
    this.floatBar.style.display = d
    this.xpBar.style.display = d
    this.clock.style.display = d
    this.runInfo.style.display = d
    this.damageVignette.style.display = d
  }
}
