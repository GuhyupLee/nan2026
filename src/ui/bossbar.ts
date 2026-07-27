import {
  BOSS_CHARGE_AT,
  ENEMY_TYPES,
  TYPE_BOSS,
  bossCycleTime,
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
  private enabled = false

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
  }

  update(world: World): void {
    const boss = world.boss
    const visible = this.enabled && boss.active && world.outcome === 'alive'
    this.root.hidden = !visible
    if (!visible) return

    const ratio =
      boss.maxHp > 0 ? Math.max(0, Math.min(1, boss.hp / boss.maxHp)) : 0
    const percent = Math.ceil(ratio * 100)
    const charging = bossCycleTime(world.time) >= BOSS_CHARGE_AT

    this.fill.style.width = `${(ratio * 100).toFixed(2)}%`
    this.phase.textContent = charging ? `돌진 · ${percent}%` : `${percent}%`
    this.root.dataset.phase = charging ? 'charge' : 'orbit'
    this.root.setAttribute('aria-valuenow', String(Math.max(0, boss.hp)))
    this.root.setAttribute('aria-valuemax', String(boss.maxHp))
    this.root.setAttribute('aria-valuetext', `${percent}%`)
  }

  setVisible(visible: boolean): void {
    this.enabled = visible
    if (!visible) this.root.hidden = true
  }

  dispose(): void {
    this.root.remove()
  }
}
