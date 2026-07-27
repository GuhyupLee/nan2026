import { getSkillDef } from '../content/skills.ts'
import { UPGRADES, getUpgrade } from '../content/upgrades.ts'
import { pendingReward, rollUpgrades, type UpgradeCandidate } from '../sim/progression.ts'
import {
  MAX_SKILL_RANK,
  lockedChoosableSkills,
  rankUpSkill,
  rankableSkills,
  unlockSkill,
  type SkillId,
} from '../sim/skills.ts'
import type { World } from '../sim/types.ts'
import { trapFocus } from './focus-trap.ts'

/**
 * 레벨업 보상 화면.
 *
 * 뱀서 문법 그대로 — 게임이 멈추고, 카드가 뜨고, 하나를 고르면 재개된다.
 * 5분 게임에서 Lv2~20까지 19번 뜨므로 0.5초라도 굼뜨면 흐름이 죽는다.
 * 그래서 1/2/3 키로 즉시 고를 수 있게 하고 애니메이션을 짧게 잡았다.
 *
 * 보상 종류는 progression.LEVEL_REWARDS가 정한다:
 *   Lv2·4  스킬 해금 (남은 것 중 선택)
 *   Lv7    마지막 스킬 확정 지급 — 카드가 1장뿐인 선택은 선택이 아니다
 *   Lv8    궁극기 확정 지급
 *   지정 레벨  영구 강화 3택
 *   나머지  스킬 랭크업 3택 (반복 가능)
 */

interface Card {
  id: string
  kind: 'unlock' | 'upgrade' | 'skill-rank'
  accent: string
  icon?: string
  glyph: string
  slotLabel?: string
  tag: string
  name: string
  desc: string
}


function upgradeCandidates(world: World): UpgradeCandidate[] {
  return UPGRADES.map((u) => ({
    id: u.id,
    available: u.isAvailable ? u.isAvailable(world) : true,
    weight: u.weight,
  }))
}

function skillCard(world: World, id: SkillId): Card | null {
  const def = getSkillDef(world.playerClass, id)
  if (!def) return null
  return {
    id,
    kind: 'unlock',
    accent: world.playerClass === 'melee' ? '#ff5a6e' : '#4dd0ff',
    icon: def.icon,
    glyph: def.glyph,
    slotLabel: def.key,
    tag: def.tag,
    name: def.name,
    desc: def.oneLiner,
  }
}

/**
 * 스킬 랭크업 카드.
 *
 * 즉시 전술(체력 회복·쿨다운 초기화 같은 일회성 효과)을 대체한다.
 * 전술은 8번 등장하는데 항상 같은 카드 3장이라 세 번째부터 노이즈였고,
 * 무엇보다 소모품이라 "영구히 강해진다"는 이 장르의 도파민이 없었다.
 *
 * QWER을 찍어 올리는 건 롤·이터널 리턴의 핵심 문법이기도 하다.
 * 지금까지 스킬은 해금된 뒤 영원히 그대로였다.
 */
function rankCards(world: World): Card[] {
  const ids = rankableSkills(world.skills)
  if (ids.length === 0) return []

  // 랭크가 낮은 것부터 보여준다. 몰아주기와 고루 찍기 둘 다 가능하되
  // "아직 안 찍은 스킬"이 먼저 눈에 들어와야 선택이 의미를 갖는다.
  const sorted = [...ids].sort((a, b) => world.skills[a].rank - world.skills[b].rank)

  const out: Card[] = []
  for (const id of sorted.slice(0, 3)) {
    const def = getSkillDef(world.playerClass, id)
    if (!def) continue
    const next = world.skills[id].rank + 1
    out.push({
      id: `rank:${id}`,
      kind: 'skill-rank',
      accent: world.playerClass === 'melee' ? '#ff5a6e' : '#4dd0ff',
      icon: def.icon,
      glyph: def.glyph,
      slotLabel: def.key,
      tag: `스킬 강화 · Lv${next}`,
      name: `${def.name} +1`,
      desc: `피해 +20%, 재사용 대기시간 −5% (Lv${next}/${MAX_SKILL_RANK})`,
    })
  }
  return out
}

/** 이번 레벨업에 보여줄 카드를 정한다. */
function buildCards(world: World): Card[] {
  const reward = pendingReward(world.progression)

  if (reward === 'skill-rank') {
    const cards = rankCards(world)
    // 전부 만렙이면 영구 강화로 흘려보낸다. 빈 화면을 띄우지 않는다.
    if (cards.length > 0) return cards
  }

  if (reward === 'unlock-choice' || reward === 'unlock-last') {
    const locked = lockedChoosableSkills(world.skills)
    if (locked.length > 0) {
      return locked.map((id) => skillCard(world, id)).filter((c): c is Card => c !== null)
    }
    // 이미 다 갖고 있으면 강화로 흘려보낸다.
  }

  if (reward === 'unlock-ult' && !world.skills.r.unlocked) {
    const c = skillCard(world, 'r')
    if (c) return [c]
  }

  const out: Card[] = []
  for (const choice of rollUpgrades(
    world.choiceRng,
    upgradeCandidates(world),
    3,
    world.upgradesTaken,
  )) {
    const u = getUpgrade(choice.id)
    if (!u) continue
    out.push({
      id: u.id,
      kind: 'upgrade',
      accent: '#4dd0ff',
      glyph: u.glyph,
      tag: '강화',
      name: u.name,
      desc: u.oneLiner,
    })
  }
  return out
}

function applyCard(world: World, card: Card): void {
  if (card.kind === 'unlock') {
    const def = getSkillDef(world.playerClass, card.id as SkillId)
    if (def) unlockSkill(world.skills, card.id as SkillId, def.cooldown * world.stats.cooldownMul)
    return
  }

  if (card.kind === 'skill-rank') {
    // id는 "rank:q" 형태다.
    rankUpSkill(world.skills, card.id.slice(5) as SkillId)
    return
  }

  const u = getUpgrade(card.id)
  if (u) {
    u.apply(world)
    world.upgradesTaken.add(card.id)
  }
}

/**
 * 카드 화면을 띄우고 고를 때까지 기다린다.
 * 선택 효과는 여기서 적용하고, 호출부가 resolveLevelUp을 부른다.
 */
export function showLevelUp(parent: HTMLElement, world: World): Promise<void> {
  const cards = buildCards(world)

  // 낼 카드가 하나도 없으면 화면을 띄우지 않고 조용히 넘어간다.
  // 빈 화면에서 심사자가 멈추는 것보다 낫다.
  if (cards.length === 0) return Promise.resolve()

  const isUnlock = cards[0]!.kind === 'unlock'
  const isRank = cards[0]!.kind === 'skill-rank'
  const single = cards.length === 1

  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'levelup'
    // 프로젝트의 다른 모달(결과·일시정지·메인메뉴·캐릭터선택)은 전부
    // 다이얼로그 시맨틱과 포커스 트랩을 갖는데 여기만 빠져 있었다.
    // 트랩이 없으면 Tab이 뒤에 깔린 스킬바 버튼으로 새어 나간다.
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'levelup-title')

    const banner = document.createElement('div')
    banner.className = 'banner'
    banner.innerHTML =
      `<div class="lv">LEVEL ${world.progression.level}</div>` +
      `<h2 id="levelup-title">${
        isUnlock
          ? single
            ? '새로운 힘을 얻었다'
            : '스킬을 해금하세요'
          : isRank
            ? '스킬을 강화하세요'
            : '강화를 선택하세요'
      }</h2>`
    root.appendChild(banner)

    const list = document.createElement('div')
    list.className = 'cards'
    root.appendChild(list)

    let done = false
    let releaseFocusTrap = (): void => {}
    const pick = (card: Card): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
      releaseFocusTrap()
      applyCard(world, card)
      root.remove()
      resolve()
    }

    cards.forEach((card, i) => {
      const el = document.createElement('button')
      el.className = 'lvcard'
      el.type = 'button'
      el.dataset.kind = card.kind
      el.style.setProperty('--accent', card.accent)

      el.innerHTML =
        `<div class="hotkey">${i + 1}</div>` +
        `<div class="top">` +
        `<div class="icon">${
          card.icon
            ? `<img class="skill-icon" src="${import.meta.env.BASE_URL}${card.icon}" alt="">`
            : card.glyph
        }</div>` +
        (card.slotLabel ? `<span class="slot-label">${card.slotLabel}</span>` : '') +
        `<span class="tag">${card.tag}</span>` +
        `</div>` +
        `<h3>${card.name}</h3>` +
        `<p>${card.desc}</p>`

      el.addEventListener('click', () => pick(card))
      list.appendChild(el)
    })

    const onKey = (e: KeyboardEvent): void => {
      // 카드가 1장뿐이면 아무 키로나 넘어간다 — 확인 화면에서 막히지 않게.
      if (single && (e.key === 'Enter' || e.key === ' ' || e.key === '1')) {
        pick(cards[0]!)
        return
      }
      const n = Number.parseInt(e.key, 10)
      if (Number.isFinite(n) && n >= 1 && n <= cards.length) pick(cards[n - 1]!)
    }
    window.addEventListener('keydown', onKey)

    parent.appendChild(root)
    releaseFocusTrap = trapFocus(root)
    ;(list.firstElementChild as HTMLElement | null)?.focus()
  })
}
