import {
  BOSS_CHARGE_AT,
  ENEMY_TYPES,
  TYPE_BOSS,
  bossCycleTime,
  bossPhaseAt,
  type BossPhase,
} from '../sim/enemies.ts'
import type { World } from '../sim/types.ts'

/**
 * 보스가 살아 있을 때만 나타나는 상단 체력바.
 *
 * 월드의 적 인덱스를 직접 보지 않는다. 적 풀은 swap-remove를 쓰므로
 * UI는 World.boss의 안정된 스냅샷만 읽는다.
 */
export class BossBar {
  private readonly root: HTMLDivElement
  private readonly fill: HTMLDivElement
  private readonly stage: HTMLElement
  private readonly action: HTMLElement
  private readonly percent: HTMLElement
  private readonly arrival: HTMLDivElement
  private readonly phaseShift: HTMLDivElement
  private enabled = false
  private wasActive = false
  private wasPhaseTwo = false

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'bossbar'
    this.root.hidden = true
    this.root.setAttribute('role', 'progressbar')
    this.root.setAttribute('aria-label', `${ENEMY_TYPES[TYPE_BOSS]!.name} 체력`)
    this.root.setAttribute('aria-valuemin', '0')
    this.root.innerHTML =
      `<div class="boss-name">${ENEMY_TYPES[TYPE_BOSS]!.name}</div>` +
      `<div class="boss-track">` +
      `<div class="boss-fill"></div>` +
      `<div class="boss-phase">` +
      `<span class="boss-stage"></span>` +
      `<strong class="boss-action"></strong>` +
      `<span class="boss-percent"></span>` +
      `</div>` +
      `</div>`

    this.fill = this.root.querySelector('.boss-fill')!
    this.stage = this.root.querySelector('.boss-stage')!
    this.action = this.root.querySelector('.boss-action')!
    this.percent = this.root.querySelector('.boss-percent')!
    parent.appendChild(this.root)

    this.arrival = document.createElement('div')
    this.arrival.className = 'boss-arrival'
    this.arrival.hidden = true
    this.arrival.setAttribute('role', 'status')
    this.arrival.setAttribute('aria-live', 'assertive')
    this.arrival.innerHTML =
      `<span>균열 개방</span>` +
      `<strong>${ENEMY_TYPES[TYPE_BOSS]!.name}</strong>` +
      `<small>최종 목표 · 제한 시간 안에 처치</small>`
    parent.appendChild(this.arrival)

    this.phaseShift = document.createElement('div')
    this.phaseShift.className = 'boss-arrival boss-phase-shift'
    this.phaseShift.hidden = true
    this.phaseShift.setAttribute('role', 'status')
    this.phaseShift.setAttribute('aria-live', 'assertive')
    this.phaseShift.innerHTML =
      `<span>월식 전환</span>` +
      `<strong>2단계</strong>` +
      `<small>예측 균열 활성화 · 붉은 원에서 이탈</small>`
    parent.appendChild(this.phaseShift)
  }

  update(world: World): void {
    const boss = world.boss
    const visible = this.enabled && boss.active && world.outcome === 'alive'
    this.root.hidden = !visible
    if (!visible) {
      this.arrival.hidden = true
      this.phaseShift.hidden = true
      this.wasActive = boss.active
      this.wasPhaseTwo = boss.phaseTwoAt >= 0
      return
    }

    const ratio =
      boss.maxHp > 0 ? Math.max(0, Math.min(1, boss.hp / boss.maxHp)) : 0
    const percent = Math.ceil(ratio * 100)
    const phaseTwo = boss.phaseTwoAt >= 0
    const bossPhase = bossPhaseAt(world.time, boss.spawnedAt, boss.phaseTwoAt)
    const presentation = phasePresentation(
      bossPhase,
      world.time,
      boss.spawnedAt,
      boss.phaseTwoAt,
    )

    this.fill.style.width = `${(ratio * 100).toFixed(2)}%`
    this.stage.textContent = `${phaseTwo ? '2' : '1'}단계`
    this.action.textContent = presentation.label
    this.percent.textContent = `체력 ${percent}%`
    this.root.dataset.phase = bossPhase
    this.root.dataset.stage = phaseTwo ? '2' : '1'
    this.root.dataset.action = presentation.tone
    this.root.setAttribute('aria-valuenow', String(Math.max(0, boss.hp)))
    this.root.setAttribute('aria-valuemax', String(boss.maxHp))
    this.root.setAttribute(
      'aria-valuetext',
      `${phaseTwo ? '2' : '1'}단계, ${presentation.label}, 체력 ${percent}%`,
    )

    const arriving = bossPhase === 'arrival'
    this.arrival.hidden = !arriving
    if (arriving && !this.wasActive) {
      this.arrival.classList.remove('play')
      // 같은 BossBar 인스턴스로 재시작해도 등장 애니메이션을 다시 시작한다.
      void this.arrival.offsetWidth
      this.arrival.classList.add('play')
    }
    const transitioning = bossPhase === 'transition'
    this.phaseShift.hidden = !transitioning
    if (transitioning && !this.wasPhaseTwo) {
      this.phaseShift.classList.remove('play')
      void this.phaseShift.offsetWidth
      this.phaseShift.classList.add('play')
    }
    this.wasActive = boss.active
    this.wasPhaseTwo = phaseTwo
  }

  setVisible(visible: boolean): void {
    this.enabled = visible
    if (!visible) {
      this.root.hidden = true
      this.arrival.hidden = true
      this.phaseShift.hidden = true
      this.wasActive = false
      this.wasPhaseTwo = false
    }
  }

  dispose(): void {
    this.root.remove()
    this.arrival.remove()
    this.phaseShift.remove()
  }
}

interface PhasePresentation {
  label: string
  tone: 'intro' | 'tracking' | 'warning' | 'danger' | 'opening' | 'transition'
}

function phasePresentation(
  phase: BossPhase,
  now: number,
  spawnedAt: number,
  phaseTwoAt: number,
): PhasePresentation {
  switch (phase) {
    case 'arrival':
      return { label: '출현 중', tone: 'intro' }
    case 'transition':
      return { label: '2단계 전환', tone: 'transition' }
    case 'orbit':
      return { label: '추적 중', tone: 'tracking' }
    case 'windup': {
      const remaining = Math.max(
        0,
        BOSS_CHARGE_AT - bossCycleTime(now, spawnedAt, phaseTwoAt),
      )
      return {
        label: `돌진까지 ${remaining.toFixed(1)}초`,
        tone: 'warning',
      }
    }
    case 'charge':
      return { label: '돌진 중 · 측면 회피', tone: 'danger' }
    case 'recover':
      return { label: '공격 기회', tone: 'opening' }
  }
}
