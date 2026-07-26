import { UPGRADES, getUpgrade } from '../content/upgrades.ts'
import { rollUpgrades, type UpgradeCandidate } from '../sim/progression.ts'
import type { World } from '../sim/types.ts'

/**
 * 레벨업 3택 카드.
 *
 * 뱀서 문법 그대로 — 게임이 멈추고, 카드 3장이 뜨고, 하나를 고르면 재개된다.
 * 5분 게임에서 이 화면이 5~6번 뜨므로 0.5초라도 굼뜨면 흐름이 죽는다.
 * 그래서 1/2/3 키로 즉시 고를 수 있게 하고 애니메이션을 짧게 잡았다.
 *
 * 카드가 뜨는 동안 world.awaitingChoice가 true라 시뮬은 한 틱도 진행하지 않는다.
 * 카드를 읽는 시간이 5분 시계에 섞이면 비트 시트 검증이 무의미해진다.
 */

/**
 * QWER 스킬 해금 카드를 낼 것인가.
 *
 * 스킬 구현이 끝나기 전에 켜면 D/F 때와 같은 문제가 생긴다 —
 * 해금은 되는데 눌러도 아무 일이 없는 카드가 나온다. 그건 잠긴 것보다 나쁘다.
 * QWER 킷이 붙는 순간 true로 바꾼다.
 */
export const SKILL_UNLOCKS_ENABLED = false

function buildCandidates(world: World): UpgradeCandidate[] {
  return UPGRADES.map((u) => ({
    id: u.id,
    available: u.isAvailable ? u.isAvailable(world) : true,
    weight: u.weight,
  }))
}

/**
 * 카드 화면을 띄우고 고를 때까지 기다린다.
 * 선택 효과는 여기서 적용하고, 호출부가 resolveLevelUp을 부른다.
 */
export function showLevelUp(parent: HTMLElement, world: World): Promise<void> {
  const choices = rollUpgrades(world.rng, buildCandidates(world), 3, world.upgradesTaken)

  // 뽑을 카드가 하나도 없으면(전부 획득) 화면을 띄우지 않고 넘어간다.
  // 빈 화면에서 심사자가 멈추는 것보다 조용히 지나가는 게 낫다.
  if (choices.length === 0) return Promise.resolve()

  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'levelup'

    const banner = document.createElement('div')
    banner.className = 'banner'
    banner.innerHTML = `<div class="lv">LEVEL ${world.progression.level}</div><h2>강화를 선택하세요</h2>`
    root.appendChild(banner)

    const cards = document.createElement('div')
    cards.className = 'cards'
    root.appendChild(cards)

    let done = false
    const pick = (id: string): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)

      const def = getUpgrade(id)
      if (def) {
        def.apply(world)
        world.upgradesTaken.add(id)
      }
      root.remove()
      resolve()
    }

    choices.forEach((choice, i) => {
      const def = getUpgrade(choice.id)
      if (!def) return

      const card = document.createElement('button')
      card.className = 'lvcard'
      card.type = 'button'
      card.dataset.kind = choice.kind

      card.innerHTML =
        `<div class="hotkey">${i + 1}</div>` +
        `<div class="top"><div class="icon">${def.glyph}</div><span class="tag">강화</span></div>` +
        `<h3>${def.name}</h3>` +
        `<p>${def.oneLiner}</p>`

      card.addEventListener('click', () => pick(def.id))
      cards.appendChild(card)
    })

    const onKey = (e: KeyboardEvent): void => {
      const n = Number.parseInt(e.key, 10)
      if (Number.isFinite(n) && n >= 1 && n <= choices.length) {
        pick(choices[n - 1]!.id)
      }
    }
    window.addEventListener('keydown', onKey)

    parent.appendChild(root)
    // 첫 카드에 포커스를 줘서 키보드만으로도 흐름이 끊기지 않게 한다.
    ;(cards.firstElementChild as HTMLElement | null)?.focus()
  })
}
