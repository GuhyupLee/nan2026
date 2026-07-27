import {
  ENEMY_TYPES,
  TYPE_BOSS,
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
  private readonly phase: HTMLDivElement
  private readonly arrival: HTMLDivElement
  private enabled = false
  private wasActive = false

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
      `<div class="boss-phase"></div>` +
      `</div>`

    this.fill = this.root.querySelector('.boss-fill')!
    this.phase = this.root.querySelector('.boss-phase')!
    parent.appendChild(this.root)

    this.arrival = document.createElement('div')
    this.arrival.className = 'boss-arrival'
    this.arrival.hidden = true
    this.arrival.setAttribute('role', 'status')
    this.arrival.setAttribute('aria-live', 'assertive')
    this.arrival.innerHTML =
      `<span>RIFT OPENED</span>` +
      `<strong>${ENEMY_TYPES[TYPE_BOSS]!.name}</strong>` +
      `<small>최종 목표 · 제한 시간 안에 처치</small>`
    parent.appendChild(this.arrival)
  }

  update(world: World): void {
    const boss = world.boss
    const visible = this.enabled && boss.active && world.outcome === 'alive'
    this.root.hidden = !visible
    if (!visible) {
      this.arrival.hidden = true
      this.wasActive = boss.active
      return
    }

    const ratio =
      boss.maxHp > 0 ? Math.max(0, Math.min(1, boss.hp / boss.maxHp)) : 0
    const percent = Math.ceil(ratio * 100)
    const bossPhase = bossPhaseAt(world.time, boss.spawnedAt)

    this.fill.style.width = `${(ratio * 100).toFixed(2)}%`
    this.phase.textContent = `${phaseLabel(bossPhase)} · ${percent}%`
    this.root.dataset.phase = bossPhase
    this.root.setAttribute('aria-valuenow', String(Math.max(0, boss.hp)))
    this.root.setAttribute('aria-valuemax', String(boss.maxHp))
    this.root.setAttribute('aria-valuetext', `${percent}%`)

    const arriving = bossPhase === 'arrival'
    this.arrival.hidden = !arriving
    if (arriving && !this.wasActive) {
      this.arrival.classList.remove('play')
      // 같은 BossBar 인스턴스로 재시작해도 등장 애니메이션을 다시 시작한다.
      void this.arrival.offsetWidth
      this.arrival.classList.add('play')
    }
    this.wasActive = boss.active
  }

  setVisible(visible: boolean): void {
    this.enabled = visible
    if (!visible) {
      this.root.hidden = true
      this.arrival.hidden = true
      this.wasActive = false
    }
  }

  dispose(): void {
    this.root.remove()
    this.arrival.remove()
  }
}

function phaseLabel(phase: BossPhase): string {
  switch (phase) {
    case 'arrival':
      return '균열 개방'
    case 'orbit':
      return '선회'
    case 'windup':
      return '돌진 예고'
    case 'charge':
      return '돌진'
    case 'recover':
      return '경직'
  }
}
