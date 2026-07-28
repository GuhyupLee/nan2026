import type { PlayerClass } from '../sim/types.ts'
import { getClassSkills, getSkillDef } from '../content/skills.ts'

/**
 * 캐릭터 선택 화면.
 *
 * 심사자가 보는 첫 화면이다. 두 클래스의 색 대비(시안 vs 크림슨)가
 * 그대로 정체성이므로 UI가 그걸 증폭한다.
 *
 * 5분 게임에서 두 번째 판을 돌릴 이유가 여기서 나온다 —
 * 고르지 않은 쪽이 계속 눈에 남아야 한다.
 */

export interface ClassOption {
  id: PlayerClass
  /** 표시 이름. */
  name: string
  /** 부제. */
  epithet: string
  /** 역할 배지. */
  role: string
  /** 한 줄 소개. 어떻게 노는 캐릭터인지가 즉시 와야 한다. */
  tagline: string
  /** 특성 태그 3개 정도. */
  traits: string[]
  /** 초상 파일명 (public/art 기준). */
  portrait: string
  /** 클래스 강조색. 인게임 이펙트도 이 색을 따른다. */
  accent: string
  /** 단축키 라벨. */
  hotkey: string
}

/**
 * 기본 클래스 구성.
 *
 * 팔레트는 생성된 초상에서 뽑았다. 인게임 저폴리 모델과 스킬 이펙트가
 * 같은 색을 쓰면 2D 초상과 3D 모델의 정밀도가 달라도 같은 캐릭터로 읽힌다.
 */
export const CLASS_OPTIONS: ClassOption[] = [
  {
    id: 'ranged',
    name: '루멘',
    epithet: '빛의 마법사',
    role: '원거리',
    tagline: '거리를 두고 빛으로 지운다. 몰려드는 적을 한 점에 모아 터뜨린다.',
    traits: ['안전한 거리', '광역 섬멸', '느린 시작'],
    portrait: 'lumen-portrait-v2.webp',
    accent: '#b8d2cf',
    hotkey: '1',
  },
  {
    id: 'melee',
    name: '월아',
    epithet: '초승달의 검사',
    role: '근접',
    tagline: '파고들어 베어낸다. 벨수록 빨라지고, 멈추면 죽는다.',
    traits: ['높은 체력', '연속 처치', '높은 위험'],
    portrait: 'wola-portrait-v2.webp',
    accent: '#c47870',
    hotkey: '2',
  },
]

const PASSIVE_PREVIEW: Readonly<
  Record<PlayerClass, { name: string; label: string; description: string }>
> = {
  ranged: {
    name: '점등',
    label: 'PASSIVE · LIGHT MARK',
    description: '스킬로 점등한 적에게 평타가 추가 피해를 주고, 처치하면 빛을 회수해 회복합니다.',
  },
  melee: {
    name: '참흔 · 월참',
    label: 'PASSIVE · MOON SCAR',
    description: '근처의 적을 베며 참흔을 채웁니다. 100이 되면 다음 평타가 광역 월참으로 승격됩니다.',
  },
}

function createSkillChip(
  playerClass: PlayerClass,
  id: 'q' | 'w' | 'e' | 'r' | 'd' | 'f',
): HTMLElement | null {
  const def = getSkillDef(playerClass, id)
  if (!def) return null

  const chip = document.createElement('span')
  chip.className = 'kit-skill'
  chip.setAttribute('role', 'listitem')
  chip.setAttribute('aria-label', `${def.key} ${def.name}: ${def.oneLiner}`)
  chip.title = `${def.key} · ${def.name}\n${def.oneLiner}`

  const icon = document.createElement('img')
  icon.src = `${import.meta.env.BASE_URL}${def.icon}`
  icon.alt = ''
  icon.decoding = 'async'

  const copy = document.createElement('span')
  const key = document.createElement('b')
  key.textContent = def.key
  const name = document.createElement('small')
  name.textContent = def.name
  copy.append(key, name)

  chip.append(icon, copy)
  return chip
}

function createKitPreview(playerClass: PlayerClass): HTMLElement {
  const preview = document.createElement('div')
  preview.className = 'kit-preview'

  const label = document.createElement('span')
  label.className = 'kit-label'
  label.textContent = 'LOADOUT'
  preview.appendChild(label)

  const core = document.createElement('div')
  core.className = 'kit-row kit-core'
  core.setAttribute('role', 'list')
  core.setAttribute('aria-label', 'Q W E R 스킬')
  for (const def of getClassSkills(playerClass)) {
    const chip = createSkillChip(playerClass, def.id as 'q' | 'w' | 'e' | 'r')
    if (chip) core.appendChild(chip)
  }
  preview.appendChild(core)

  const utility = document.createElement('div')
  utility.className = 'kit-row kit-utility'
  utility.setAttribute('role', 'list')
  utility.setAttribute('aria-label', '소환사 주문 D F')
  for (const id of ['d', 'f'] as const) {
    const chip = createSkillChip(playerClass, id)
    if (chip) utility.appendChild(chip)
  }
  preview.appendChild(utility)

  const d = getSkillDef(playerClass, 'd')
  const f = getSkillDef(playerClass, 'f')
  const utilityCopy = document.createElement('p')
  utilityCopy.className = 'kit-utility-copy'
  utilityCopy.textContent =
    `D ${d?.name ?? '회복'} — ${d?.oneLiner ?? '체력을 회복합니다'} · ` +
    `F ${f?.name ?? '점멸'} — ${f?.oneLiner ?? '순간이동합니다'}`
  preview.appendChild(utilityCopy)

  const passiveDef = PASSIVE_PREVIEW[playerClass]
  const passive = document.createElement('div')
  passive.className = 'passive-preview'
  const passiveLabel = document.createElement('span')
  passiveLabel.textContent = passiveDef.label
  const passiveName = document.createElement('strong')
  passiveName.textContent = passiveDef.name
  const passiveCopy = document.createElement('p')
  passiveCopy.textContent = passiveDef.description
  passive.append(passiveLabel, passiveName, passiveCopy)
  preview.appendChild(passive)

  return preview
}

/**
 * 선택 화면을 띄우고 고를 때까지 기다린다.
 * 고른 클래스를 resolve하고 화면은 스스로 사라진다.
 */
export function showCharacterSelect(
  parent: HTMLElement,
  options: readonly ClassOption[] = CLASS_OPTIONS,
  onSettings?: () => Promise<void> | void,
): Promise<PlayerClass> {
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'charselect'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'charselect-title')

    const title = document.createElement('div')
    title.className = 'title'

    const titleCopy = document.createElement('div')
    titleCopy.className = 'title-copy'
    titleCopy.innerHTML =
      `<span class="charselect-kicker">CHARACTER SELECT</span>` +
      `<h2 id="charselect-title">캐릭터 선택</h2>` +
      `<p>5분 안에 보스를 쓰러뜨리면 승리.</p>`
    title.appendChild(titleCopy)

    let settingsOpen = false
    if (onSettings) {
      const settings = document.createElement('button')
      settings.className = 'charselect-settings'
      settings.type = 'button'
      settings.textContent = '설정'

      const openSettings = async (): Promise<void> => {
        if (done || settingsOpen) return
        settingsOpen = true
        window.removeEventListener('keydown', onKey)
        try {
          await onSettings()
        } finally {
          settingsOpen = false
          if (!done) {
            window.addEventListener('keydown', onKey)
            settings.focus()
          }
        }
      }

      settings.addEventListener('click', () => void openSettings())
      title.appendChild(settings)
    }
    root.appendChild(title)

    const cards = document.createElement('div')
    cards.className = 'cards'
    root.appendChild(cards)

    const foot = document.createElement('div')
    foot.className = 'footnote'
    foot.textContent = window.matchMedia('(pointer: coarse)').matches
      ? '전장을 밀어 이동 · 아래 스킬 버튼 터치 · D 회복 · F 점멸'
      : '마우스를 누른 채 이동 · Q W E R 스킬 · D 회복 · F 점멸'
    root.appendChild(foot)

    let done = false
    const choose = (id: PlayerClass): void => {
      if (done || settingsOpen) return
      done = true
      window.removeEventListener('keydown', onKey)
      root.classList.add('closing')
      // 페이드가 끝난 뒤 제거한다. 바로 지우면 전환이 툭 끊긴다.
      window.setTimeout(() => root.remove(), 420)
      resolve(id)
    }

    for (const [index, opt] of options.entries()) {
      const card = document.createElement('button')
      card.className = 'charcard'
      card.type = 'button'
      card.style.setProperty('--accent', opt.accent)
      card.dataset.class = opt.id
      const coreSummary = getClassSkills(opt.id)
        .map((skill) => `${skill.key} ${skill.name}, ${skill.oneLiner}`)
        .join('. ')
      const d = getSkillDef(opt.id, 'd')
      const f = getSkillDef(opt.id, 'f')
      const passive = PASSIVE_PREVIEW[opt.id]
      card.setAttribute(
        'aria-label',
        `${opt.name}, ${opt.epithet}. ${coreSummary}. ` +
          `D ${d?.name ?? '회복'}, ${d?.oneLiner ?? ''}. ` +
          `F ${f?.name ?? '점멸'}, ${f?.oneLiner ?? ''}. ` +
          `패시브 ${passive.name}, ${passive.description}`,
      )

      const img = document.createElement('img')
      img.className = 'portrait'
      img.src = `${import.meta.env.BASE_URL}art/${opt.portrait}`
      img.alt = ''
      // 첫 화면이라 지연 로드하지 않는다. 여기서 늦으면 첫인상이 무너진다.
      img.decoding = 'async'
      card.appendChild(img)

      const veil = document.createElement('div')
      veil.className = 'veil'
      card.appendChild(veil)

      const hotkey = document.createElement('div')
      hotkey.className = 'hotkey'
      hotkey.innerHTML =
        `<small>0${index + 1}</small>` +
        `<span>${opt.hotkey}</span>`
      card.appendChild(hotkey)

      const info = document.createElement('div')
      info.className = 'info'
      info.innerHTML =
        `<span class="role">${opt.role}</span>` +
        `<h3>${opt.name}</h3>` +
        `<div class="epithet">${opt.epithet}</div>` +
        `<div class="tagline">${opt.tagline}</div>` +
        `<div class="traits">${opt.traits.map((t) => `<span>${t}</span>`).join('')}</div>`
      info.appendChild(createKitPreview(opt.id))
      card.appendChild(info)

      const selectLabel = document.createElement('div')
      selectLabel.className = 'select-label'
      selectLabel.innerHTML = '선택 <span aria-hidden="true">↗</span>'
      card.appendChild(selectLabel)

      card.addEventListener('click', () => choose(opt.id))
      cards.appendChild(card)
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat || settingsOpen) return
      const hit = options.find((o) => o.hotkey === e.key)
      if (hit) choose(hit.id)
    }
    window.addEventListener('keydown', onKey)

    parent.appendChild(root)
    ;(cards.firstElementChild as HTMLButtonElement | null)?.focus()
  })
}
