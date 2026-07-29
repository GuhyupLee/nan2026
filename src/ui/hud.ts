import { xpToNext } from '../sim/progression.ts'
import type { World } from '../sim/types.ts'
import { difficultyRules, runDifficultyLabel } from '../sim/difficulty.ts'
import { ELITE_SPAWN_TIMES, TYPE_BOSS } from '../sim/enemies.ts'
import {
  BATTLEFIELD_MAGNET_DURATION,
  BATTLEFIELD_MAGNET_MAX_REMAINING,
} from '../sim/battlefield-pickups.ts'
import {
  SURGE_BEATS,
  SURGE_WARNING_DURATION,
} from '../sim/surges.ts'
import {
  bossIndicatorDirection,
  bossIndicatorPosition,
  type BossIndicatorInsets,
} from './boss-indicator.ts'

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

/**
 * 연참(멀티킬) 티어. 이 게임은 후반에 초당 10마리 가까이 죽으므로,
 * 임계값이 낮으면 배너가 배경이 된다 — "큰 광역 한 방"만 축하하도록
 * 시작점을 10으로 잡고 궁극기급(월아 R 광역, 일현 R 관통)에서 최고 티어가 나온다.
 */
const KILL_STREAK_TIERS: readonly { count: number; label: string }[] = [
  { count: 10, label: '연참' },
  { count: 20, label: '질풍참' },
  { count: 35, label: '월광 일소' },
  { count: 60, label: '월식 학살' },
]

/** 이 간격(초) 안에 이어진 처치만 같은 연참으로 센다. */
const KILL_STREAK_GAP = 0.9
/** 배너가 화면에 머무는 시간(초). 전투를 가리지 않게 짧게 끊는다. */
const KILL_STREAK_BANNER_DURATION = 1.15

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
  private readonly bossIndicator: HTMLDivElement
  private readonly bossIndicatorDistance: HTMLElement
  private bossIndicatorDirection = ''
  private bossIndicatorInsets: BossIndicatorInsets = {
    left: 76,
    right: 76,
    top: 96,
    bottom: 96,
  }
  private bossIndicatorInsetWidth = -1
  private bossIndicatorInsetHeight = -1
  private bossIndicatorInsetTick = -30
  private readonly surgeAlert: HTMLDivElement
  private readonly surgeTitle: HTMLElement
  private readonly surgeCountdown: HTMLElement
  private readonly surgeInstruction: HTMLElement
  private readonly runInfo: HTMLDivElement
  private readonly runKills: HTMLElement
  private readonly runRelics: HTMLElement
  private readonly damageVignette: HTMLDivElement

  private readonly screen = { x: 0, y: 0 }
  private readonly bossScreen = { x: 0, y: 0 }
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
  private readonly killStreak: HTMLDivElement
  private readonly killStreakLabel: HTMLElement
  private readonly killStreakCount: HTMLElement
  private streakCount = 0
  private streakLastKillAt = -1
  private streakShownTier = -1
  private streakHideAt = -1
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
    this.clock.setAttribute('role', 'timer')
    parent.appendChild(this.clock)

    this.bossIndicator = document.createElement('div')
    this.bossIndicator.className = 'boss-indicator'
    this.bossIndicator.hidden = true
    this.bossIndicator.setAttribute('role', 'status')
    this.bossIndicator.setAttribute('aria-live', 'polite')
    this.bossIndicator.setAttribute('aria-atomic', 'true')
    this.bossIndicator.innerHTML =
      `<i aria-hidden="true">▶</i>` +
      `<span aria-hidden="true"><b>보스</b><small data-boss-distance></small></span>`
    this.bossIndicatorDistance =
      this.bossIndicator.querySelector('[data-boss-distance]')!
    parent.appendChild(this.bossIndicator)

    this.surgeAlert = document.createElement('div')
    this.surgeAlert.className = 'surge-alert'
    this.surgeAlert.hidden = true
    this.surgeAlert.setAttribute('role', 'status')
    // 매초 바뀌는 카운트다운이 다른 안내를 계속 끊지 않게 polite로 알린다.
    // 시각 경고와 전장 예고 링은 그대로 즉시 나타난다.
    this.surgeAlert.setAttribute('aria-live', 'polite')
    this.surgeAlert.setAttribute('aria-atomic', 'true')
    this.surgeAlert.innerHTML =
      `<span>급습 경고</span>` +
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

    // 연참 배너 — 큰 광역 한 방을 그 순간에 축하한다. 처치 수는 run-info가
    // 이미 스크린리더에 알리므로 이 배너는 순수 장식이다.
    this.killStreak = document.createElement('div')
    this.killStreak.className = 'kill-streak'
    this.killStreak.hidden = true
    this.killStreak.setAttribute('aria-hidden', 'true')
    this.killStreak.innerHTML =
      `<strong data-streak-label></strong><b data-streak-count></b>`
    this.killStreakLabel = this.killStreak.querySelector('[data-streak-label]')!
    this.killStreakCount = this.killStreak.querySelector('[data-streak-count]')!
    parent.appendChild(this.killStreak)

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
      this.streakCount = 0
      this.streakLastKillAt = -1
      this.streakShownTier = -1
      this.streakHideAt = -1
      this.killStreak.hidden = true
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
      // 첫 프레임(-1 → 현재값)은 연참이 아니라 상태 동기화다.
      if (this.lastKills >= 0) {
        this.trackKillStreak(world.kills - this.lastKills, world.time)
      }
      this.lastKills = world.kills
      this.runKills.textContent = String(world.kills).padStart(3, '0')
      runInfoChanged = true
    }
    if (this.streakHideAt >= 0 && world.time >= this.streakHideAt) {
      this.streakHideAt = -1
      this.killStreak.dataset.visible = 'false'
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
    const repeatRanks =
      world.endless ||
      difficultyRules(world.runConfig.difficulty).extendedProgression
    // 만렙이면 Infinity가 온다. 그 경우 바를 가득 채워 "더 없음"을 보여준다.
    this.xpFill.style.width =
      repeatRanks && !Number.isFinite(need)
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
    const rules = difficultyRules(world.runConfig.difficulty)
    const t = world.endless
      ? Math.max(0, world.time - world.endlessStartedAt)
      : Math.max(0, rules.runTimeLimit - world.time)
    const wholeSeconds = Math.ceil(t)
    const mm = Math.floor(wholeSeconds / 60)
    const ss = wholeSeconds % 60
    this.clock.textContent =
      `${world.endless ? '∞ ' : ''}${mm}:${String(ss).padStart(2, '0')}` +
      `${world.endless ? '' : ` · ${runDifficultyLabel(world.runConfig.difficulty)}`}`
    this.clock.dataset.mode = world.endless
      ? 'endless'
      : world.runConfig.difficulty
    this.clock.dataset.phase =
      world.boss.active && t <= 30 ? 'critical' : world.boss.active ? 'boss' : 'normal'
    this.clock.setAttribute(
      'aria-label',
      world.endless
        ? `무한전 생존 시간 ${mm}분 ${ss}초`
        : `남은 시간 ${mm}분 ${ss}초, ${runDifficultyLabel(world.runConfig.difficulty)} 스테이지`,
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

    this.updateBossIndicator(world, project)
  }

  private updateBossIndicator(world: World, project: Projector): void {
    if (!world.boss.active || world.outcome !== 'alive') {
      this.hideBossIndicator()
      return
    }

    let bossIndex = -1
    for (let i = 0; i < world.enemies.count; i += 1) {
      if (
        world.enemies.type[i] === TYPE_BOSS &&
        world.enemies.hp[i]! > 0
      ) {
        bossIndex = i
        break
      }
    }
    if (bossIndex < 0) {
      this.hideBossIndicator()
      return
    }

    const projected = project(
      world.enemies.x[bossIndex]!,
      1.4,
      world.enemies.y[bossIndex]!,
      this.bossScreen,
    )
    const width = Math.max(1, window.innerWidth)
    const height = Math.max(1, window.innerHeight)
    const safeInsets = this.updateBossIndicatorInsets(
      width,
      height,
      world.tick,
    )
    const indicator = bossIndicatorPosition(
      this.bossScreen.x,
      this.bossScreen.y,
      width,
      height,
      projected,
      safeInsets,
    )
    if (!indicator) {
      this.hideBossIndicator()
      return
    }

    const distance = Math.round(
      Math.hypot(
        world.enemies.x[bossIndex]! - world.player.pos.x,
        world.enemies.y[bossIndex]! - world.player.pos.y,
      ),
    )
    const wasHidden = this.bossIndicator.hidden
    const direction = bossIndicatorDirection(indicator.angle)
    this.bossIndicator.hidden = false
    this.bossIndicator.style.transform =
      `translate(-50%, -50%) translate(${indicator.x.toFixed(1)}px, ${indicator.y.toFixed(1)}px)`
    this.bossIndicator.style.setProperty(
      '--boss-arrow-angle',
      `${indicator.angle}deg`,
    )
    this.bossIndicatorDistance.textContent = `${distance}m`
    if (wasHidden || direction !== this.bossIndicatorDirection) {
      this.bossIndicatorDirection = direction
      this.bossIndicator.setAttribute(
        'aria-label',
        `보스가 화면 밖 ${direction}에 있습니다. 거리 약 ${distance}미터`,
      )
    }
  }

  private hideBossIndicator(): void {
    this.bossIndicator.hidden = true
    this.bossIndicatorDirection = ''
  }

  private updateBossIndicatorInsets(
    width: number,
    height: number,
    tick: number,
  ): BossIndicatorInsets {
    if (
      width === this.bossIndicatorInsetWidth &&
      height === this.bossIndicatorInsetHeight &&
      tick - this.bossIndicatorInsetTick < 30
    ) {
      return this.bossIndicatorInsets
    }

    const rootSize =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) ||
      16
    const side = Math.max(24, rootSize * 4.75)
    const gap = Math.max(12, rootSize * 1.15)
    let top = Math.max(82, rootSize * 6.5)
    let bottom = Math.max(
      82,
      rootSize * (width <= 820 || width / height <= 0.75 ? 11 : 7),
    )

    const reserveTop = (element: HTMLElement | null): void => {
      if (!element || element.hidden) return
      const rect = element.getBoundingClientRect()
      if (rect.height > 0 && rect.top < height * 0.5) {
        top = Math.max(top, rect.bottom + gap)
      }
    }
    const reserveBottom = (element: HTMLElement | null): void => {
      if (!element || element.hidden) return
      const rect = element.getBoundingClientRect()
      if (rect.height > 0 && rect.bottom > height * 0.5) {
        bottom = Math.max(bottom, height - rect.top + gap)
      }
    }

    reserveTop(this.clock)
    reserveTop(document.querySelector<HTMLElement>('.bossbar'))
    reserveTop(this.surgeAlert)
    reserveBottom(this.xpBar)
    reserveBottom(document.querySelector<HTMLElement>('.skillbar'))

    this.bossIndicatorInsets = {
      left: side,
      right: side,
      top,
      bottom,
    }
    this.bossIndicatorInsetWidth = width
    this.bossIndicatorInsetHeight = height
    this.bossIndicatorInsetTick = tick
    return this.bossIndicatorInsets
  }

  /**
   * 처치 델타를 연참으로 누적하고, 티어를 새로 넘을 때만 배너를 띄운다.
   * 후반 상시 학살 구간에서는 최고 티어 도달 후 연참이 끊길 때까지 침묵한다 —
   * 배너가 배경이 되는 순간 축하는 소음이 된다.
   */
  private trackKillStreak(delta: number, now: number): void {
    if (delta <= 0) return
    if (now - this.streakLastKillAt > KILL_STREAK_GAP) {
      this.streakCount = 0
      this.streakShownTier = -1
    }
    this.streakCount += delta
    this.streakLastKillAt = now

    let tier = -1
    for (let i = KILL_STREAK_TIERS.length - 1; i >= 0; i--) {
      if (this.streakCount >= KILL_STREAK_TIERS[i]!.count) {
        tier = i
        break
      }
    }
    if (tier <= this.streakShownTier) return
    this.streakShownTier = tier

    const def = KILL_STREAK_TIERS[tier]!
    this.killStreak.hidden = false
    this.killStreak.dataset.tier = String(tier)
    this.killStreak.dataset.visible = 'true'
    this.killStreakLabel.textContent = def.label
    this.killStreakCount.textContent = `×${this.streakCount}`
    // 같은 티어 안에서 숫자만 갱신되도록 재생 트리거는 티어 상승에만 건다.
    if (!this.reducedMotion.matches) {
      this.killStreak.style.animation = 'none'
      void this.killStreak.offsetWidth
      this.killStreak.style.animation = ''
    }
    this.streakHideAt = now + KILL_STREAK_BANNER_DURATION
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
    this.bossIndicator.style.display = d
    this.surgeAlert.style.display = d
    this.runInfo.style.display = d
    this.damageVignette.style.display = d
    this.killStreak.style.display = d
  }
}
