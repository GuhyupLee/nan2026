import {
  getClassSkills,
  getPassiveDef,
  getSkillDef,
} from '../content/skills.ts'
import type { SkillId } from '../sim/skills.ts'
import type { PlayerClass } from '../sim/types.ts'
import { CLASS_OPTIONS } from './charselect.ts'
import { trapFocus } from './focus-trap.ts'

export type LoadoutBriefingDecision = 'start' | 'back'
export type LoadoutBriefingKey = 'Q' | 'W' | 'E' | 'R' | 'P' | 'D' | 'F'

export interface LoadoutBriefingItem {
  id: SkillId | 'p'
  key: LoadoutBriefingKey
  name: string
  tag: string
  oneLiner: string
  icon: string
  glyph: string
  group: 'core' | 'utility'
  availability: 'level-up' | 'automatic' | 'ready'
  availabilityLabel: string
}

const UTILITY_IDS = ['d', 'f'] as const

/**
 * 시작 브리핑과 검증 코드가 함께 읽는 Q W E R · P · D F 순서.
 * 화면에서 보이는 문구는 스킬바와 레벨업 카드가 쓰는 원본 데이터에서 가져온다.
 */
export function getLoadoutBriefingItems(
  playerClass: PlayerClass,
): LoadoutBriefingItem[] {
  const core: LoadoutBriefingItem[] = getClassSkills(playerClass).map((skill) => ({
    id: skill.id,
    key: skill.key as LoadoutBriefingKey,
    name: skill.name,
    tag: skill.tag,
    oneLiner: skill.oneLiner,
    icon: skill.icon,
    glyph: skill.glyph,
    group: 'core',
    availability: 'level-up',
    availabilityLabel: skill.id === 'r' ? 'Lv8' : '레벨업',
  }))

  const passive = getPassiveDef(playerClass)
  const passiveItem: LoadoutBriefingItem = {
    ...passive,
    group: 'utility',
    availability: 'automatic',
    availabilityLabel: '자동',
  }

  const utility: LoadoutBriefingItem[] = UTILITY_IDS.map((id) => {
    const skill = getSkillDef(playerClass, id)!
    return {
      id: skill.id,
      key: skill.key as LoadoutBriefingKey,
      name: skill.name,
      tag: skill.tag,
      oneLiner: skill.oneLiner,
      icon: skill.icon,
      glyph: skill.glyph,
      group: 'utility',
      availability: 'ready',
      availabilityLabel: '사용 가능',
    }
  })

  return [...core, passiveItem, ...utility]
}

function createLoadoutCard(item: LoadoutBriefingItem): HTMLElement {
  const card = document.createElement('article')
  card.className = 'loadout-briefing-card'
  card.dataset.key = item.key.toLowerCase()
  card.dataset.group = item.group
  card.dataset.availability = item.availability
  card.setAttribute('role', 'listitem')
  card.setAttribute(
    'aria-label',
    `${item.key} ${item.name}. ${item.tag}. ${item.oneLiner}. ${item.availabilityLabel}.`,
  )

  const iconFrame = document.createElement('div')
  iconFrame.className = 'loadout-briefing-icon'
  iconFrame.setAttribute('aria-hidden', 'true')

  const icon = document.createElement('img')
  icon.src = `${import.meta.env.BASE_URL}${item.icon}`
  icon.alt = ''
  icon.decoding = 'async'

  const fallback = document.createElement('span')
  fallback.textContent = item.glyph
  fallback.hidden = true
  icon.onerror = () => {
    icon.hidden = true
    fallback.hidden = false
  }
  iconFrame.append(icon, fallback)

  const key = document.createElement('kbd')
  key.textContent = item.key
  iconFrame.appendChild(key)

  const copy = document.createElement('div')
  copy.className = 'loadout-briefing-copy'

  const meta = document.createElement('div')
  meta.className = 'loadout-briefing-meta'
  const tag = document.createElement('span')
  tag.className = 'loadout-briefing-tag'
  tag.textContent = item.tag
  const availability = document.createElement('span')
  availability.className = 'loadout-briefing-availability'
  availability.textContent = item.availabilityLabel
  meta.append(tag, availability)

  const name = document.createElement('h4')
  name.textContent = item.name

  const description = document.createElement('p')
  description.textContent = item.oneLiner

  copy.append(meta, name, description)
  card.append(iconFrame, copy)
  return card
}

/**
 * 캐릭터 선택과 실제 전투 사이의 한 장짜리 브리핑.
 * 사용자가 명시적으로 시작해야 닫히며, Escape/뒤로 버튼으로 캐릭터를 다시 고른다.
 */
export function showLoadoutBriefing(
  parent: HTMLElement,
  playerClass: PlayerClass,
): Promise<LoadoutBriefingDecision> {
  return new Promise((resolve) => {
    const option = CLASS_OPTIONS.find((entry) => entry.id === playerClass)!
    const items = getLoadoutBriefingItems(playerClass)
    const core = items.filter((item) => item.group === 'core')
    const utility = items.filter((item) => item.group === 'utility')

    const root = document.createElement('div')
    root.className = 'loadout-briefing'
    root.dataset.class = playerClass
    root.style.setProperty('--accent', option.accent)
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'loadout-briefing-title')
    root.setAttribute('aria-describedby', 'loadout-briefing-intro')

    const panel = document.createElement('main')
    panel.className = 'loadout-briefing-panel'

    const header = document.createElement('header')
    header.className = 'loadout-briefing-header'
    const heading = document.createElement('div')
    heading.className = 'loadout-briefing-heading'
    const kicker = document.createElement('span')
    kicker.className = 'loadout-briefing-kicker'
    kicker.textContent = `기술표 · ${option.name}`
    const title = document.createElement('h2')
    title.id = 'loadout-briefing-title'
    title.textContent = 'Q W E R · P · D F'
    const intro = document.createElement('p')
    intro.id = 'loadout-briefing-intro'
    intro.textContent =
      'QWE는 레벨업 · R은 Lv8 · P는 자동 · D/F는 처음부터 사용'
    heading.append(kicker, title, intro)
    header.append(heading)

    const coreSection = document.createElement('section')
    coreSection.className = 'loadout-briefing-section loadout-briefing-core'
    coreSection.setAttribute('aria-labelledby', 'loadout-core-title')
    const coreHeading = document.createElement('div')
    coreHeading.className = 'loadout-briefing-section-heading'
    const coreTitle = document.createElement('h3')
    coreTitle.id = 'loadout-core-title'
    coreTitle.textContent = 'Q W E R'
    coreHeading.append(coreTitle)
    const coreGrid = document.createElement('div')
    coreGrid.className = 'loadout-briefing-grid loadout-briefing-core-grid'
    coreGrid.setAttribute('role', 'list')
    for (const item of core) coreGrid.appendChild(createLoadoutCard(item))
    coreSection.append(coreHeading, coreGrid)

    const utilitySection = document.createElement('section')
    utilitySection.className = 'loadout-briefing-section loadout-briefing-utility'
    utilitySection.setAttribute('aria-labelledby', 'loadout-utility-title')
    const utilityHeading = document.createElement('div')
    utilityHeading.className = 'loadout-briefing-section-heading'
    const utilityTitle = document.createElement('h3')
    utilityTitle.id = 'loadout-utility-title'
    utilityTitle.textContent = 'P · D · F'
    utilityHeading.append(utilityTitle)
    const utilityGrid = document.createElement('div')
    utilityGrid.className = 'loadout-briefing-grid loadout-briefing-utility-grid'
    utilityGrid.setAttribute('role', 'list')
    for (const item of utility) utilityGrid.appendChild(createLoadoutCard(item))
    utilitySection.append(utilityHeading, utilityGrid)

    const footer = document.createElement('footer')
    footer.className = 'loadout-briefing-footer'
    const help = document.createElement('p')
    help.textContent = window.matchMedia('(pointer: coarse)').matches
      ? '전투 중에는 화면 아래의 같은 아이콘을 누르세요.'
      : '전투 중 아이콘에 마우스를 올리면 설명을 다시 볼 수 있습니다.'

    const actions = document.createElement('div')
    actions.className = 'loadout-briefing-actions'
    const back = document.createElement('button')
    back.className = 'loadout-briefing-back'
    back.type = 'button'
    back.textContent = '캐릭터 선택'

    const start = document.createElement('button')
    start.className = 'loadout-briefing-start'
    start.type = 'button'
    const startLabel = document.createElement('span')
    startLabel.textContent = '전투 시작'
    const startKey = document.createElement('small')
    startKey.textContent = 'ENTER'
    start.append(startLabel, startKey)
    actions.append(back, start)
    footer.append(help, actions)

    panel.append(header, coreSection, utilitySection, footer)
    root.appendChild(panel)
    parent.appendChild(root)

    const releaseFocus = trapFocus(root)
    let done = false
    const finish = (decision: LoadoutBriefingDecision): void => {
      if (done) return
      done = true
      back.disabled = true
      start.disabled = true
      window.removeEventListener('keydown', onKeyDown)
      root.classList.add('closing')
      const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 0
        : 180
      window.setTimeout(() => {
        releaseFocus()
        root.remove()
        resolve(decision)
      }, delay)
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.repeat || event.key !== 'Escape') return
      event.preventDefault()
      finish('back')
    }

    back.addEventListener('click', () => finish('back'))
    start.addEventListener('click', () => finish('start'))
    window.addEventListener('keydown', onKeyDown)
    start.focus()
  })
}
