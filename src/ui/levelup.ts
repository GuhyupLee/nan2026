import { getSkillDef } from '../content/skills.ts'
import { UPGRADES, getUpgrade } from '../content/upgrades.ts'
import { pendingReward, rollUpgrades, type UpgradeCandidate } from '../sim/progression.ts'
import { SKILL_IDS, lockedChoosableSkills, unlockSkill, type SkillId } from '../sim/skills.ts'
import type { World } from '../sim/types.ts'

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
 *   나머지  반복 가능한 즉시 전술 3택
 */

interface Card {
  id: string
  kind: 'unlock' | 'upgrade' | 'tactic'
  accent: string
  icon?: string
  glyph: string
  slotLabel?: string
  tag: string
  name: string
  desc: string
}

const TACTIC_CARDS: readonly Card[] = [
  {
    id: 'emergency-repair',
    kind: 'tactic',
    accent: '#6fd39a',
    glyph: '✚',
    tag: '즉시 전술',
    name: '응급 정비',
    desc: '최대 체력의 30%를 즉시 회복합니다.',
  },
  {
    id: 'realign',
    kind: 'tactic',
    accent: '#70b8ee',
    glyph: '↻',
    tag: '즉시 전술',
    name: '재정렬',
    desc: '해금한 모든 스킬의 남은 재사용 대기시간을 65% 줄입니다.',
  },
  {
    id: 'combat-acceleration',
    kind: 'tactic',
    accent: '#e7b85f',
    glyph: '»',
    tag: '즉시 전술',
    name: '전투 가속',
    desc: '기본 공격을 즉시 준비하고 8초 동안 이동 속도가 증가합니다.',
  },
]

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

/** 이번 레벨업에 보여줄 카드를 정한다. */
function buildCards(world: World): Card[] {
  const reward = pendingReward(world.progression)

  if (reward === 'tactic') return TACTIC_CARDS.map((card) => ({ ...card }))

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
    world.rng,
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

  if (card.kind === 'tactic') {
    if (card.id === 'emergency-repair') {
      world.player.hp = Math.min(
        world.stats.maxHp,
        world.player.hp + world.stats.maxHp * 0.3,
      )
    } else if (card.id === 'realign') {
      for (const id of SKILL_IDS) {
        const skill = world.skills[id]
        if (skill.unlocked) skill.cooldown *= 0.35
      }
    } else if (card.id === 'combat-acceleration') {
      world.player.attackCooldown = 0
      world.player.speedBoostUntil = Math.max(world.player.speedBoostUntil, world.time + 8)
    }
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
  const isTactic = cards[0]!.kind === 'tactic'
  const single = cards.length === 1

  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'levelup'

    const banner = document.createElement('div')
    banner.className = 'banner'
    banner.innerHTML =
      `<div class="lv">LEVEL ${world.progression.level}</div>` +
      `<h2>${
        isUnlock
          ? single
            ? '새로운 힘을 얻었다'
            : '스킬을 해금하세요'
          : isTactic
            ? '전술을 선택하세요'
            : '강화를 선택하세요'
      }</h2>`
    root.appendChild(banner)

    const list = document.createElement('div')
    list.className = 'cards'
    root.appendChild(list)

    let done = false
    const pick = (card: Card): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
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
    ;(list.firstElementChild as HTMLElement | null)?.focus()
  })
}
