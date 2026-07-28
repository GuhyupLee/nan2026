import { getSkillDef } from '../content/skills.ts'
import {
  UPGRADES,
  applyUpgrade,
  applyRelicUpgrade,
  getUpgrade,
  getUpgradePresentation,
  getUpgradeRank,
  getRelicFusionPreview,
  getRelicUpgradeBurstCount,
  getRelicRollPriority,
  getUpgradeRollPriority,
  type UpgradeFamily,
  type UpgradeRarity,
} from '../content/upgrades.ts'
import { pendingReward, rollUpgrades, type UpgradeCandidate } from '../sim/progression.ts'
import { ELITE_SPAWN_TIMES } from '../sim/enemies.ts'
import {
  MAX_SKILL_RANK,
  MAX_ENDLESS_SKILL_RANK,
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
 * 5분 게임에서 Lv2~26까지 보상이 이어지므로 0.5초라도 굼뜨면 흐름이 죽는다.
 * 그래서 1/2/3 키로 즉시 고를 수 있게 하고 애니메이션을 짧게 잡았다.
 *
 * 보상 종류는 progression.LEVEL_REWARDS가 정한다:
 *   Lv2·4  스킬 해금 (남은 것 중 선택)
 *   Lv7    마지막 스킬 확정 지급 — 카드가 1장뿐인 선택은 선택이 아니다
 *   Lv8    궁극기 확정 지급
 *   지정 레벨  영구 강화 3택
 *   나머지  스킬 랭크업 3택 (반복 가능)
 */

export interface LevelUpCard {
  id: string
  kind: 'unlock' | 'upgrade' | 'skill-rank' | 'relic-upgrade'
  accent: string
  icon?: string
  glyph: string
  slotLabel?: string
  tag: string
  name: string
  desc: string
  rarity?: UpgradeRarity
  family?: UpgradeFamily
  rank?: number
  trait?: string
  badges?: readonly string[]
  familyLabel?: string
  rankProgress?: {
    /** Segments already owned before this choice. */
    current: number
    /** Segments owned after accepting this choice. */
    target: number
    label: 'RANK' | 'FUSION'
  }
}

const ROMAN_RANK = ['', 'I', 'II', 'III'] as const

function upgradeCandidates(world: World, relic = false): UpgradeCandidate[] {
  return UPGRADES.map((upgrade) => {
    const currentRank = getUpgradeRank(world.upgradesTaken, upgrade.id)
    return {
      id: upgrade.id,
      available: upgrade.isAvailable(world),
      // 이미 고른 장비가 다시 눈에 띄어야 "빌드를 완성한다"는 선택이 생긴다.
      weight: upgrade.weight * (currentRank > 0 ? 1.75 : 1),
      classFilter: upgrade.classFilter,
      currentRank,
      maxRank: upgrade.ranks.length,
      priority: relic
        ? getRelicRollPriority(world, upgrade)
        : getUpgradeRollPriority(world, upgrade),
    }
  })
}

function skillCard(world: World, id: SkillId): LevelUpCard | null {
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
function rankCards(world: World): LevelUpCard[] {
  const maxRank = world.endless ? MAX_ENDLESS_SKILL_RANK : MAX_SKILL_RANK
  const ids = rankableSkills(world.skills, maxRank)
  if (ids.length === 0) return []

  // 랭크가 낮은 것부터 보여준다. 몰아주기와 고루 찍기 둘 다 가능하되
  // "아직 안 찍은 스킬"이 먼저 눈에 들어와야 선택이 의미를 갖는다.
  const sorted = [...ids].sort((a, b) => world.skills[a].rank - world.skills[b].rank)

  const out: LevelUpCard[] = []
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
      desc: world.endless
        ? `피해 +20%, 재사용 대기시간 −5% (무한 연마 Lv${next})`
        : `피해 +20%, 재사용 대기시간 −5% (Lv${next}/${MAX_SKILL_RANK})`,
    })
  }
  return out
}

function buildUpgradeCards(world: World, relic = false): LevelUpCard[] {
  const out: LevelUpCard[] = []
  for (const choice of rollUpgrades(
    world.choiceRng,
    upgradeCandidates(world, relic),
    3,
    {
      playerClass: world.playerClass,
      taken: world.upgradesTaken,
      allowRankUps: true,
    },
  )) {
    const upgrade = getUpgrade(choice.id)
    if (!upgrade) continue
    const presentation = getUpgradePresentation(upgrade, world.upgradesTaken)
    const relicBurst = getRelicUpgradeBurstCount(world, upgrade.id)
    const relicFusion = relic ? getRelicFusionPreview(world, upgrade.id) : undefined
    const targetRank = relic
      ? Math.min(presentation.currentRank + relicBurst, presentation.maxRank)
      : presentation.nextRank
    const targetDef = upgrade.ranks[targetRank - 1]!
    const reachesAwakening = !upgrade.fusion && targetRank === 3
    const rarity: UpgradeRarity = upgrade.fusion
      ? 'fusion'
      : reachesAwakening
        ? 'awakening'
        : presentation.rarity
    const accent =
      rarity === 'fusion'
        ? '#e4bd70'
        : rarity === 'awakening'
          ? '#ffd166'
          : world.playerClass === 'melee'
            ? '#ff5a6e'
            : '#4dd0ff'
    const rankProgress = upgrade.fusion
      ? {
          // A fusion card is the capstone after two completed ingredients.
          // Treat those ingredients as the owned segments and the fusion as
          // the offered third segment instead of misleadingly showing 1/3.
          current: 2,
          target: 3,
          label: 'FUSION' as const,
        }
      : {
          current: presentation.currentRank,
          target: targetRank,
          label: 'RANK' as const,
        }
    out.push({
      id: upgrade.id,
      kind: relic ? 'relic-upgrade' : 'upgrade',
      accent,
      glyph: upgrade.glyph,
      tag: relic
        ? upgrade.fusion
          ? '월식 전리품 · 각성 합성'
          : `월식 전리품 · RANK ${ROMAN_RANK[targetRank]}`
        : presentation.rarity === 'fusion'
          ? '각성 합성'
          : `${presentation.familyLabel} · ${presentation.rankLabel}`,
      name: upgrade.fusion ? upgrade.name : `${upgrade.name} · ${targetDef.displayName}`,
      desc: relic
        ? `${targetDef.oneLiner} · 최대 ${relicBurst}랭크를 연속 각인합니다.${
            relicFusion
              ? ` · ${relicFusion.name} 동시 발동: ${relicFusion.ranks[0]!.oneLiner}`
              : ''
          }`
        : presentation.oneLiner,
      rarity,
      family: presentation.family,
      familyLabel: presentation.familyLabel,
      rank: relic ? targetRank : choice.rank ?? presentation.nextRank,
      rankProgress,
      ...(targetDef.trait ? { trait: targetDef.trait } : {}),
      badges: relic
        ? [
            '정예 전리품',
            `${relicBurst}단 연속 각인`,
            relicFusion ? `즉시 융합 · ${relicFusion.name}` : '조합 완성 시 즉시 융합',
            presentation.familyLabel,
            upgrade.fusion ? '융합' : `RANK ${ROMAN_RANK[targetRank]}`,
            ...(reachesAwakening ? ['각성'] : []),
          ]
        : presentation.badges,
    })
  }
  return out
}

/** 이번 레벨업 또는 정예 전리품에 보여줄 카드와 배지 데이터를 정한다. */
export function buildLevelUpCards(world: World): LevelUpCard[] {
  // 같은 틱에 레벨업이 겹쳐도 정예 보상을 먼저 연다. 레벨업 대기는 그대로 남는다.
  if (world.pendingRelicChoices > 0) return buildUpgradeCards(world, true)
  if (world.pendingEndlessSkillRanks > 0) return rankCards(world)

  const reward = pendingReward(world.progression)

  if (reward === 'skill-rank') {
    const cards = rankCards(world)
    // 전부 만렙이면 영구 강화로 흘려보낸다. 빈 화면을 띄우지 않는다.
    if (cards.length > 0) return cards
  }

  if (reward === 'unlock-choice' || reward === 'unlock-last') {
    const locked = lockedChoosableSkills(world.skills)
    if (locked.length > 0) {
      return locked
        .map((id) => skillCard(world, id))
        .filter((card): card is LevelUpCard => card !== null)
    }
    // 이미 다 갖고 있으면 강화로 흘려보낸다.
  }

  if (reward === 'unlock-ult' && !world.skills.r.unlocked) {
    const c = skillCard(world, 'r')
    if (c) return [c]
  }

  return buildUpgradeCards(world)
}

export function applyLevelUpCard(world: World, card: LevelUpCard): void {
  if (card.kind === 'unlock') {
    const def = getSkillDef(world.playerClass, card.id as SkillId)
    if (def) unlockSkill(world.skills, card.id as SkillId, def.cooldown * world.stats.cooldownMul)
    return
  }

  if (card.kind === 'skill-rank') {
    // id는 "rank:q" 형태다.
    rankUpSkill(
      world.skills,
      card.id.slice(5) as SkillId,
      world.endless ? MAX_ENDLESS_SKILL_RANK : MAX_SKILL_RANK,
    )
    return
  }

  if (card.kind === 'relic-upgrade') {
    applyRelicUpgrade(world, card.id)
    return
  }

  applyUpgrade(world, card.id)
}

/**
 * Three fixed segments make upgrade history readable without opening a tooltip.
 * Flat fill = already owned, hatched glow = this choice, outline = unavailable.
 */
function rankProgressMarkup(card: LevelUpCard): string {
  if (!card.rankProgress) return ''

  const current = Math.max(0, Math.min(3, Math.floor(card.rankProgress.current)))
  const target = Math.max(current, Math.min(3, Math.floor(card.rankProgress.target)))
  const offered = target - current
  const missing = 3 - target
  const accessibleLabel =
    card.rankProgress.label === 'FUSION'
      ? '융합 진행: 재료 각성 2칸 보유, 이번 선택으로 융합 완성'
      : `랭크 진행: 현재 ${current}칸 보유, 이번 선택 ${offered}칸, 미획득 ${missing}칸`

  let pips = ''
  for (let rank = 1; rank <= 3; rank += 1) {
    const state = rank <= current ? 'owned' : rank <= target ? 'offered' : 'locked'
    pips += `<span class="rank-pip" data-state="${state}" aria-hidden="true"></span>`
  }

  return (
    `<div class="rank-progress" role="img" aria-label="${accessibleLabel}">` +
    `<span class="rank-progress-label" aria-hidden="true">${card.rankProgress.label}</span>` +
    `<span class="rank-pips">${pips}</span>` +
    `</div>`
  )
}

/**
 * 카드 화면을 띄우고 고를 때까지 기다린다.
 * 선택 효과는 여기서 적용하고, 호출부가 resolveLevelUp을 부른다.
 */
export function showLevelUp(parent: HTMLElement, world: World): Promise<void> {
  const cards = buildLevelUpCards(world)

  // 낼 카드가 하나도 없으면 화면을 띄우지 않고 조용히 넘어간다.
  // 빈 화면에서 심사자가 멈추는 것보다 낫다.
  if (cards.length === 0) return Promise.resolve()

  const isUnlock = cards[0]!.kind === 'unlock'
  const isRank = cards[0]!.kind === 'skill-rank'
  const isRelic = cards[0]!.kind === 'relic-upgrade'
  const single = cards.length === 1
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const confirmationMs = reducedMotion ? 45 : isRelic ? 260 : 190

  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'levelup'
    if (isRelic) root.classList.add('relic-reward')
    // 프로젝트의 다른 모달(결과·일시정지·메인메뉴·캐릭터선택)은 전부
    // 다이얼로그 시맨틱과 포커스 트랩을 갖는데 여기만 빠져 있었다.
    // 트랩이 없으면 Tab이 뒤에 깔린 스킬바 버튼으로 새어 나간다.
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'levelup-title')

    const banner = document.createElement('div')
    banner.className = 'banner'
    banner.innerHTML =
      `<div class="lv">${
        isRelic
          ? `ELITE TROVE · MOON SEAL ${world.relicsClaimed}/${ELITE_SPAWN_TIMES.length}`
          : `LEVEL ${world.progression.level}`
      }</div>` +
      `<h2 id="levelup-title">${
        isRelic
          ? '월식 전리품을 각인하세요'
          : isUnlock
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
    const cardElements: HTMLButtonElement[] = []
    let releaseFocusTrap = (): void => {}
    const pick = (card: LevelUpCard, selected: HTMLButtonElement): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
      releaseFocusTrap()
      root.setAttribute('aria-busy', 'true')
      root.classList.add('resolving')
      for (const candidate of cardElements) {
        candidate.disabled = true
        candidate.classList.toggle('selected', candidate === selected)
        candidate.classList.toggle('rejected', candidate !== selected)
      }
      applyLevelUpCard(world, card)
      window.setTimeout(() => {
        root.remove()
        resolve()
      }, confirmationMs)
    }

    cards.forEach((card, i) => {
      const el = document.createElement('button')
      el.className = 'lvcard'
      el.type = 'button'
      el.dataset.kind = card.kind
      if (card.rarity) el.dataset.rarity = card.rarity
      if (card.family) el.dataset.family = card.family
      if (card.rank) el.dataset.rank = String(card.rank)
      if (card.trait) el.dataset.trait = card.trait
      el.style.setProperty('--accent', card.accent)

      const badges =
        card.badges && card.badges.length > 0
          ? `<div class="card-badges">${card.badges
              .map(
                (badge) => {
                  const badgeClass =
                    badge === card.familyLabel
                      ? 'card-badge family-badge'
                      : badge.startsWith('RANK') || badge === '합성' || badge === '융합'
                        ? 'rank-badge'
                        : 'card-badge'
                  return `<span class="${badgeClass}">${badge}</span>`
                },
              )
              .join('')}</div>`
          : ''
      const rankProgress = rankProgressMarkup(card)
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
        rankProgress +
        badges +
        `<h3>${card.name}</h3>` +
        `<p>${card.desc}</p>`

      el.addEventListener('click', () => pick(card, el))
      cardElements.push(el)
      list.appendChild(el)
    })

    const onKey = (e: KeyboardEvent): void => {
      // 카드가 1장뿐이면 아무 키로나 넘어간다 — 확인 화면에서 막히지 않게.
      if (single && (e.key === 'Enter' || e.key === ' ' || e.key === '1')) {
        pick(cards[0]!, cardElements[0]!)
        return
      }

      const direction =
        e.key === 'ArrowRight' || e.key === 'ArrowDown'
          ? 1
          : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
            ? -1
            : 0
      if (direction !== 0 || e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        const focused = cardElements.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? cardElements.length - 1
              : (Math.max(0, focused) + direction + cardElements.length) %
                cardElements.length
        cardElements[next]?.focus()
        return
      }

      const n = Number.parseInt(e.key, 10)
      if (Number.isFinite(n) && n >= 1 && n <= cards.length) {
        pick(cards[n - 1]!, cardElements[n - 1]!)
      }
    }
    window.addEventListener('keydown', onKey)

    parent.appendChild(root)
    releaseFocusTrap = trapFocus(root)
    ;(list.firstElementChild as HTMLElement | null)?.focus()
  })
}
