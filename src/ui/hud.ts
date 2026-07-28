import { xpToNext } from '../sim/progression.ts'
import type { World } from '../sim/types.ts'
import { RUN_TIME_LIMIT } from '../sim/constants.ts'
import { ELITE_SPAWN_TIMES } from '../sim/enemies.ts'
import {
  BATTLEFIELD_MAGNET_DURATION,
  BATTLEFIELD_MAGNET_MAX_REMAINING,
} from '../sim/battlefield-pickups.ts'
import {
  SURGE_BEATS,
  SURGE_WARNING_DURATION,
} from '../sim/surges.ts'

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
  private readonly magnetBuff: HTMLDivElement
  private readonly magnetTime: HTMLElement
  private readonly magnetProgress: HTMLElement
  private readonly clock: HTMLDivElement
  private readonly surgeAlert: HTMLDivElement
  private readonly surgeTitle: HTMLElement
  private readonly surgeCountdown: HTMLElement
  private readonly surgeInstruction: HTMLElement
  private readonly runInfo: HTMLDivElement
  private readonly runKills: HTMLElement
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
  private lastMagnetActivations = 0
  private magnetDisplayTenths = -1
  private magnetProgressCeiling = BATTLEFIELD_MAGNET_DURATION
  private magnetWasActive = false
  private surgeDisplayKey = ''
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

    this.magnetBuff = document.createElement('div')
    this.magnetBuff.className = 'pickup-buff'
    this.magnetBuff.dataset.active = 'false'
    this.magnetBuff.dataset.pulse = '0'
    this.magnetBuff.setAttribute('role', 'timer')
    this.magnetBuff.setAttribute('aria-live', 'off')
    this.magnetBuff.setAttribute('aria-hidden', 'true')
    this.magnetBuff.innerHTML =
      `<span class="pickup-buff-mark" aria-hidden="true"></span>` +
      `<span class="pickup-buff-copy"><small>자력장</small><b data-magnet-time>0.0초</b></span>` +
      `<span class="pickup-buff-track" aria-hidden="true"><i></i></span>`
    this.magnetTime = this.magnetBuff.querySelector('[data-magnet-time]')!
    this.magnetProgress = this.magnetBuff.querySelector('.pickup-buff-track i')!
    parent.appendChild(this.magnetBuff)

    this.clock = document.createElement('div')
    this.clock.className = 'clock'
    parent.appendChild(this.clock)

    this.surgeAlert = document.createElement('div')
    this.surgeAlert.className = 'surge-alert'
    this.surgeAlert.hidden = true
    this.surgeAlert.setAttribute('role', 'status')
    this.surgeAlert.setAttribute('aria-live', 'assertive')
    this.surgeAlert.innerHTML =
      `<span>WAVE SURGE</span>` +
      `<strong data-surge-title></strong>` +
      `<b data-surge-countdown></b>` +
      `<small data-surge-instruction></small>`
    this.surgeTitle = this.surgeAlert.querySelector('[data-surge-title]')!
    this.surgeCountdown =
      this.surgeAlert.querySelector('[data-surge-countdown]')!
    this.surgeInstruction =
      this.surgeAlert.querySelector('[data-surge-instruction]')!
    parent.appendChild(this.surgeAlert)

    this.runInfo = document.createElement('div')
    this.runInfo.className = 'run-info'
    // 레벨은 플레이어 머리 위 플로팅 배지가 이미 보여준다. 여기서 중복 표기하지
    // 않고, 라벨은 인게임 표기 원칙대로 국문으로 통일한다.
    this.runInfo.innerHTML =
      `<span><small>처치</small><b data-run-kills>000</b></span>` +
      `<span><small>인장</small><b data-run-relics>0/${ELITE_SPAWN_TIMES.length}</b></span>`
    this.runInfo.setAttribute('aria-label', '런 전황')
    this.runKills = this.runInfo.querySelector('[data-run-kills]')!
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
      this.lastMagnetActivations = world.battlefieldPickups.magnetActivations
      this.magnetDisplayTenths = -1
      this.magnetProgressCeiling = BATTLEFIELD_MAGNET_DURATION
      this.magnetWasActive = false
      this.surgeDisplayKey = ''
      document.body.classList.remove('pickup-buff-active')
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
      runInfoChanged = true
    }
    if (world.kills !== this.lastKills) {
      this.lastKills = world.kills
      this.runKills.textContent = String(world.kills).padStart(3, '0')
      runInfoChanged = true
    }
    if (world.relicsClaimed !== this.lastRelics) {
      this.lastRelics = world.relicsClaimed
      this.runRelics.textContent = world.endless
        ? String(world.relicsClaimed)
        : `${world.relicsClaimed}/${ELITE_SPAWN_TIMES.length}`
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
    this.xpFill.style.width =
      world.endless && !Number.isFinite(need)
        ? `${Math.min(100, (world.endlessXp / 420) * 100).toFixed(1)}%`
        : Number.isFinite(need)
          ? `${Math.min(100, (prog.xp / need) * 100).toFixed(1)}%`
          : '100%'

    // --- 전장 자석 ---
    // 획득 순간만 번쩍이고 사라지면 효과가 언제 끝나는지 알 수 없다.
    // 남은 시간과 소진 바를 스킬바 바로 위에 고정해 이동 경로를 결정할 근거를 준다.
    const pickups = world.battlefieldPickups
    const magnetRemaining = Math.max(0, pickups.magnetUntil - world.time)
    const magnetActive = magnetRemaining > 0
    if (pickups.magnetActivations !== this.lastMagnetActivations) {
      this.lastMagnetActivations = pickups.magnetActivations
      this.magnetProgressCeiling = Math.min(
        BATTLEFIELD_MAGNET_MAX_REMAINING,
        Math.max(BATTLEFIELD_MAGNET_DURATION, magnetRemaining),
      )
      this.magnetBuff.dataset.pulse = String(pickups.magnetActivations & 1)
    }
    this.magnetBuff.dataset.active = String(magnetActive)
    this.magnetBuff.setAttribute('aria-hidden', String(!magnetActive))
    if (magnetActive !== this.magnetWasActive) {
      this.magnetWasActive = magnetActive
      document.body.classList.toggle('pickup-buff-active', magnetActive)
    }
    if (magnetActive) {
      const tenths = Math.ceil(magnetRemaining * 10)
      if (tenths !== this.magnetDisplayTenths) {
        this.magnetDisplayTenths = tenths
        const displaySeconds = (tenths / 10).toFixed(1)
        this.magnetTime.textContent = `${displaySeconds}초`
        this.magnetBuff.setAttribute(
          'aria-label',
          `자력장 남은 시간 ${displaySeconds}초`,
        )
      }
      const progress = Math.min(1, magnetRemaining / this.magnetProgressCeiling)
      this.magnetProgress.style.transform = `scaleX(${progress.toFixed(3)})`
    } else if (this.magnetDisplayTenths !== -1) {
      this.magnetDisplayTenths = -1
      this.magnetProgress.style.transform = 'scaleX(0)'
      this.magnetBuff.removeAttribute('aria-label')
    }

    // --- 제한 시간 ---
    // 경과 시간보다 "얼마나 남았는가"가 보스전의 의사결정에 직접 필요하다.
    // 마지막 30초에는 색과 점멸로 시선을 끌되, 보스 등장 전에는 조용히 둔다.
    const t = world.endless
      ? Math.max(0, world.time - world.endlessStartedAt)
      : Math.max(0, RUN_TIME_LIMIT - world.time)
    const wholeSeconds = Math.ceil(t)
    const mm = Math.floor(wholeSeconds / 60)
    const ss = wholeSeconds % 60
    this.clock.textContent =
      `${world.endless ? '∞ ' : ''}${mm}:${String(ss).padStart(2, '0')}` +
      `${world.runConfig.difficulty === 'hard' ? ' · 하드' : ''}`
    this.clock.dataset.mode = world.endless
      ? 'endless'
      : world.runConfig.difficulty
    this.clock.dataset.phase =
      world.boss.active && t <= 30 ? 'critical' : world.boss.active ? 'boss' : 'normal'
    this.clock.setAttribute(
      'aria-label',
      world.endless
        ? `무한전 생존 시간 ${mm}분 ${ss}초`
        : `남은 시간 ${mm}분 ${ss}초`,
    )

    // --- 웨이브 서지 ---
    // 정해진 편대가 갑자기 솟으면 억울한 스폰으로 읽힌다. 3초 예고 동안
    // 편대 이름과 회피 문법을 한 줄로 보여 주고, 시작 뒤에는 짧게 충격만 남긴다.
    const nextSurge = SURGE_BEATS[world.surgeBeatIndex]
    const previousSurge =
      world.surgeBeatIndex > 0
        ? SURGE_BEATS[world.surgeBeatIndex - 1]
        : undefined
    const warningRemaining = nextSurge
      ? nextSurge.at - world.time
      : Number.POSITIVE_INFINITY
    const warning =
      nextSurge !== undefined &&
      warningRemaining <= SURGE_WARNING_DURATION &&
      warningRemaining > 0
    const impact =
      previousSurge !== undefined &&
      world.surgeStartedAt >= 0 &&
      world.time - world.surgeStartedAt < 1.25
    if (warning) {
      const countdown = Math.max(1, Math.ceil(warningRemaining))
      this.updateSurgeAlert(
        `warning:${world.surgeBeatIndex}:${countdown}`,
        nextSurge.label,
        String(countdown),
        nextSurge.instruction,
        nextSurge.kind,
        'warning',
      )
    } else if (impact) {
      this.updateSurgeAlert(
        `impact:${world.surgeBeatIndex}`,
        previousSurge.label,
        '진입',
        previousSurge.instruction,
        previousSurge.kind,
        'impact',
      )
    } else {
      this.surgeAlert.hidden = true
      this.surgeDisplayKey = ''
    }

  }

  private updateSurgeAlert(
    key: string,
    title: string,
    countdown: string,
    instruction: string,
    kind: number,
    phase: 'warning' | 'impact',
  ): void {
    this.surgeAlert.hidden = false
    this.surgeAlert.dataset.kind = String(kind)
    this.surgeAlert.dataset.phase = phase
    if (key === this.surgeDisplayKey) return
    this.surgeDisplayKey = key
    this.surgeTitle.textContent = title
    this.surgeCountdown.textContent = countdown
    this.surgeInstruction.textContent = instruction
    this.surgeAlert.setAttribute(
      'aria-label',
      phase === 'warning'
        ? `${title} ${countdown}초 전. ${instruction}`
        : `${title} 시작. ${instruction}`,
    )
  }

  setVisible(visible: boolean): void {
    const d = visible ? '' : 'none'
    this.floatBar.style.display = d
    this.xpBar.style.display = d
    this.magnetBuff.style.display = d
    this.clock.style.display = d
    this.surgeAlert.style.display = d
    this.runInfo.style.display = d
    this.damageVignette.style.display = d
  }
}
