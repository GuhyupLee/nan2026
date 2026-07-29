import { getSkillDef } from '../content/skills.ts'
import {
  UPGRADES,
  applyUpgrade,
  applyRelicUpgrade,
  getUpgrade,
  getUpgradeFusionRoute,
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
  /** 카드에서 가장 먼저 읽는 강화 경로 또는 스킬 이름. */
  pathName?: string
  /** 같은 경로 안에서 이번 선택으로 얻는 단계 이름. */
  stepName?: string
  /** 이번 선택이 직접 바꾸는 구체적인 대상. */
  target?: string
  /** 현재 빌드와 이번 선택의 관계. */
  context?: string
  /** 정예 전리품처럼 본 효과와 분리해야 하는 추가 적용 정보. */
  detail?: string
  /** 아직 완성하지 않은 경로의 3단계 규칙 변화. */
  preview?: string
  /** 융합 카드가 요구하는 완성된 두 경로. */
  fusionIngredients?: readonly string[]
  /** 재료 카드에서 미리 보여 주는 다음 융합과 짝 경로 진행도. */
  fusionRoute?: string
  rankProgress?: {
    /** Segments already owned before this choice. */
    current: number
    /** Segments owned after accepting this choice. */
    target: number
    label: 'RANK' | 'FUSION'
  }
}

const ROMAN_RANK = ['', 'I', 'II', 'III'] as const

/**
 * 강화의 세계관 이름과 별개로, 실제로 무엇이 바뀌는지 명시한다.
 * 설명 문자열을 정규식으로 분류하면 "체력 18% 이하 적 처형"이 생존으로
 * 오인되는 식의 조용한 회귀가 생기므로 id·rank에 고정된 UI 계약으로 둔다.
 */
const UPGRADE_TARGETS: Readonly<Record<string, readonly string[]>> = {
  'focused-lens': ['기본 공격', '모든 공격', '기본 공격'],
  'diffraction-prism': ['기본 공격 속도', '기본 공격 속도', '기본 공격'],
  'telescopic-aperture': ['기본 공격 사거리', '기본 공격 사거리', '원거리 기본 공격'],
  'photon-core': ['체력과 공격', '받는 피해', '생존'],
  'orbit-lens': ['Q · 삼중 굴절', 'Q · 삼중 굴절', 'Q · 삼중 굴절'],
  'gravity-prism': ['W · 광도약', 'W · 광도약', 'W · 광도약'],
  'phase-aperture': ['E · 분광', 'E · 분광', 'E · 분광'],
  'heliostat-core': ['R · 일현', 'R · 일현', 'R · 일현'],
  'crescent-honing': ['모든 공격', '모든 공격', '패시브 · 월참'],
  'flowing-footwork': ['이동 속도', '기본 공격 속도', '점멸과 돌진'],
  'ironwall-breath': ['받는 피해', '최대 체력', '생존'],
  'bloodflow-breath': ['D · 회복', 'D · 회복', '초과 회복'],
  'iai-scroll': ['Q · 원월참', 'Q · 원월참', 'Q · 원월참'],
  'watermoon-sheath': ['W · 이합참', 'W · 이합참', 'W · 이합참'],
  'mirror-guard': ['E · 월륜', 'E · 월륜', 'E · 월륜'],
  'fullmoon-form': ['R · 만월난무', 'R · 만월난무', 'R · 만월난무'],
  'interference-filament': ['기본 공격 관통', '기본 공격 관통', '기본 공격 관통'],
  'dual-focus': ['기본 공격', '보조 광선', '보조 광선'],
  'collector-array': ['아이템 획득', '아이템 획득', 'XP 보석'],
  'afterglow-battery': ['D · 회복', 'F · 점멸', 'D와 F'],
  'decapitating-flash': ['기본 공격', '기본 공격', '기본 공격 처형'],
  'moon-drain-breath': ['처치 회복', '처치 회복', '초과 회복'],
  'moonshadow-double': ['기본 공격', '후방 베기', '패시브 · 참흔'],
  'blood-feast-step': ['아이템 획득', '회복 구슬', 'XP 보석'],
  'supernova-specimen': ['기본 공격 각성', '기본 공격 각성', '기본 공격 각성'],
  'eclipse-execution-array': ['처형 각성', '처형 각성', '처형 각성'],
  'singularity-interferometer': ['Q와 W 융합', 'Q와 W 융합', 'Q와 W 융합'],
  'eclipse-sword-codex': ['Q와 R 융합', 'Q와 R 융합', 'Q와 R 융합'],
  'revival-seal': ['생존', '생존', '생존'],
  'wanderer-inscription': ['아이템 획득', '이동', '회복'],
  'executioner-inscription': ['기본 공격 피해', '기본 공격 속도', '기본 공격 관통'],
  'guardian-inscription': ['최대 체력', '받는 피해', '회복'],
  'timekeeper-inscription': ['QWER 재사용', 'D/F 재사용', '점멸'],
}

export function getUpgradeChoiceTarget(id: string, rank: number): string {
  const targets = UPGRADE_TARGETS[id]
  if (!targets || targets.length === 0) return '전투 능력'
  const index = Math.max(0, Math.min(targets.length - 1, Math.floor(rank) - 1))
  return targets[index] ?? targets[0] ?? '전투 능력'
}

function plainEffect(copy: string): string {
  return copy
    .replace(/ \(평타·QWER\)$/u, '')
    .replaceAll('평타', '기본 공격')
    .replaceAll('획득 반경', '아이템 획득 범위')
    .replaceAll('처치 회복 상한', '연속 처치 시 회복 가능한 체력')
    .replaceAll('처치 회복 속도', '처치 회복 충전 속도')
    .replace(/ \+(\d+(?:\.\d+)?%?)/gu, ' $1 증가')
    .replace(/ -(\d+(?:\.\d+)?%?)/gu, ' $1 감소')
}

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
    pathName: def.name,
    stepName: def.tag,
    target: `신규 ${def.key} 스킬`,
    context: '신규',
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
  for (const id of sorted) {
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
      desc:
        world.playerClass === 'ranged' && id === 'q'
          ? '양옆 광선 피해 20% 증가 · 재사용 대기시간 5% 감소'
          : world.playerClass === 'ranged' && id === 'w'
            ? '렌즈 피해 20% 증가 · 재사용 대기시간 5% 감소'
            : '피해 20% 증가 · 재사용 대기시간 5% 감소',
      pathName: def.name,
      stepName: `Lv${world.skills[id].rank} → Lv${next}`,
      target: `${def.key} · ${def.name}`,
      context: '계속',
    })
  }
  return out
}

function buildUpgradeCards(world: World, relic = false): LevelUpCard[] {
  const out: LevelUpCard[] = []
  for (const choice of rollUpgrades(
    world.choiceRng,
    upgradeCandidates(world, relic),
    relic ? 3 : 4,
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
    const completesLegacy =
      !upgrade.fusion &&
      upgrade.family === 'legacy' &&
      targetRank === upgrade.ranks.length &&
      upgrade.ranks.length > 1
    const reachesAwakening =
      !upgrade.fusion &&
      upgrade.family !== 'legacy' &&
      targetRank === 3
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
      ? undefined
      : {
          current: presentation.currentRank,
          target: targetRank,
          label: 'RANK' as const,
        }
    const detail = relic
      ? `${relicBurst}단계를 한 번에 강화합니다.${
          relicFusion
            ? ` 선택 즉시 「${relicFusion.name}」도 함께 완성됩니다.`
            : ' 조합 재료가 완성되면 융합이 자동으로 열립니다.'
        }`
      : undefined
    const context = upgrade.fusion
      ? '융합'
      : reachesAwakening
        ? '각성'
        : relic
          ? `+${relicBurst}단계`
          : completesLegacy
            ? '완성'
            : presentation.currentRank > 0
              ? '계속'
              : '신규'
    const finalRank =
      !upgrade.fusion && upgrade.ranks.length >= 3 ? upgrade.ranks[2] : undefined
    const preview =
      finalRank && targetRank < 3
        ? `III · ${plainEffect(finalRank.oneLiner)}`
        : reachesAwakening
          ? 'III · 각성 완성'
          : completesLegacy
            ? 'III · 전승 경로 완성'
            : undefined
    const fusionIngredients = upgrade.fusion
      ? upgrade.fusion.requires.map((id) => getUpgrade(id)?.name ?? id)
      : undefined
    const fusionRoute = upgrade.fusion
      ? undefined
      : getUpgradeFusionRoute(world, upgrade.id)

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
        ? plainEffect(targetDef.oneLiner)
        : plainEffect(presentation.oneLiner),
      rarity,
      family: presentation.family,
      familyLabel: presentation.familyLabel,
      rank: relic ? targetRank : choice.rank ?? presentation.nextRank,
      ...(rankProgress ? { rankProgress } : {}),
      pathName: upgrade.name,
      stepName: targetDef.displayName,
      target: getUpgradeChoiceTarget(upgrade.id, targetRank),
      context,
      ...(detail ? { detail } : {}),
      ...(preview ? { preview } : {}),
      ...(fusionIngredients ? { fusionIngredients } : {}),
      ...(fusionRoute
        ? {
            fusionRoute:
              `이어지는 빌드 · ${fusionRoute.partnerName} ` +
              `${fusionRoute.partnerRank}/III → ${fusionRoute.name}`,
          }
        : {}),
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
    `<span class="rank-progress-copy" aria-hidden="true">` +
    `<span class="rank-progress-label">${
      card.rankProgress.label === 'FUSION' ? '융합 진행' : '경로 진행'
    }</span>` +
    `<strong>${current} → ${target} / 3</strong></span>` +
    `<span class="rank-pips">${pips}</span>` +
    `</div>`
  )
}

/**
 * 카드 화면을 띄우고 고를 때까지 기다린다.
 * 선택 효과는 여기서 적용하고, 호출부가 resolveLevelUp을 부른다.
 */
export function showLevelUp(
  parent: HTMLElement,
  world: World,
  onSelect?: () => void,
): Promise<void> {
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
    root.dataset.cardCount = String(cards.length)
    root.dataset.mode = isRelic ? 'relic' : isUnlock ? 'unlock' : isRank ? 'skill-rank' : 'upgrade'
    // 프로젝트의 다른 모달(결과·일시정지·메인메뉴·캐릭터선택)은 전부
    // 다이얼로그 시맨틱과 포커스 트랩을 갖는데 여기만 빠져 있었다.
    // 트랩이 없으면 Tab이 뒤에 깔린 스킬바 버튼으로 새어 나간다.
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'levelup-title')
    root.setAttribute('aria-describedby', 'levelup-guide')

    const banner = document.createElement('div')
    banner.className = 'banner'
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches
    const title = isRelic
      ? '정예 전리품'
      : isUnlock
        ? '스킬 해금'
        : isRank
          ? '스킬 강화'
          : '강화 선택'
    const guide = single
      ? '확인하면 즉시 적용되고 전투가 계속됩니다.'
      : '효과와 다음 단계를 비교하세요.'
    const keyRange = cards.length === 1 ? '1' : `1–${cards.length}`
    banner.innerHTML =
      `<div class="banner-copy"><div class="lv">${
        isRelic
          ? `정예 전리품 · 인장 ${world.relicsClaimed}/${ELITE_SPAWN_TIMES.length}`
          : `레벨 ${world.progression.level} · 전투 일시정지`
      }</div>` +
      `<h2 id="levelup-title">${title}</h2>` +
      `<p id="levelup-guide">${guide}</p></div>` +
      `<div class="levelup-controls">${
        coarsePointer ? '카드를 눌러 선택' : `${keyRange} 선택 · ← → 이동 · Enter`
      }</div>`
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
      // 선택 피드백은 확인 연출이 끝날 때가 아니라 누른 순간 나와야 한다.
      onSelect?.()
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

      const rankProgress = rankProgressMarkup(card)
      const fusionProgress = card.fusionIngredients
        ? `<div class="fusion-progress" aria-label="융합 재료 완성">` +
          card.fusionIngredients
            .map((ingredient) => `<span>${ingredient} 3단계 <b>완성</b></span>`)
            .join('<i aria-hidden="true">＋</i>') +
          `<strong>융합 완성</strong></div>`
        : ''
      const pathName = card.pathName ?? card.familyLabel ?? card.name
      const stepName = card.stepName
      const target = card.target ?? '전투 능력'
      const context = card.context ?? '즉시 적용'
      const accessibleBuildDetails = [
        card.preview,
        card.fusionRoute,
        card.fusionIngredients
          ? `융합 재료 ${card.fusionIngredients.join(' 그리고 ')}`
          : undefined,
        card.rankProgress
          ? `경로 진행 ${card.rankProgress.current}에서 ${card.rankProgress.target}, 총 3단계`
          : undefined,
      ]
        .filter((value): value is string => Boolean(value))
        .join('. ')
      el.setAttribute(
        'aria-label',
        `${i + 1}번. ${target}. ${pathName}. ${stepName ?? ''}. ` +
          `선택 효과: ${card.desc}. ${context}. ${accessibleBuildDetails}`,
      )
      el.innerHTML =
        `<div class="hotkey"><b>${i + 1}</b></div>` +
        `<div class="top">` +
        `<div class="icon">${
          card.icon
            ? `<img class="skill-icon" src="${import.meta.env.BASE_URL}${card.icon}" alt="">`
            : card.glyph
        }</div>` +
        (card.slotLabel ? `<span class="slot-label">${card.slotLabel}</span>` : '') +
        `<div class="choice-meta"><span class="target">${target}</span>` +
        `<span class="context">${context}</span></div>` +
        `</div>` +
        `<div class="choice-heading"><h3>${pathName}</h3>` +
        (stepName ? `<span>${stepName}</span>` : '') +
        `</div>` +
        `<div class="choice-effect"><strong>${card.desc}</strong></div>` +
        (card.detail ? `<p class="choice-detail">${card.detail}</p>` : '') +
        (card.preview ? `<p class="choice-preview">${card.preview}</p>` : '') +
        (card.fusionRoute ? `<p class="choice-route">${card.fusionRoute}</p>` : '') +
        rankProgress +
        fusionProgress

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
