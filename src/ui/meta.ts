import { trapFocus } from './focus-trap.ts'
import {
  META_DOCTRINES,
  META_DOCTRINE_SLOT_MAX,
  META_STATS,
  META_STAT_RANK_MAX,
  META_UNLOCKS,
  isMetaDoctrineId,
  isMetaUnlockId,
  isMetaUnlockActive,
  loadMetaProgress,
  metaStatCost,
  metaStatRank,
  purchaseMetaItem,
  toggleMetaDoctrine,
  type MetaDoctrineId,
  type MetaProgress,
  type MetaPurchaseId,
  type MetaStatDef,
  type MetaUnlockDef,
} from './meta-progression.ts'

function progressPips(rank: number, max = META_STAT_RANK_MAX): string {
  return Array.from(
    { length: max },
    (_, index) =>
      `<i data-filled="${index < rank}" aria-hidden="true"></i>`,
  ).join('')
}

function formatMoonlight(value: number): string {
  return value.toLocaleString('ko-KR')
}

function statRow(
  stat: MetaStatDef,
  progress: MetaProgress,
): string {
  const { id, name } = stat
  const rank = metaStatRank(progress, id)
  const cost = metaStatCost(id, rank)
  const affordable = cost !== null && progress.moonlight >= cost
  const shortage = cost === null ? 0 : Math.max(0, cost - progress.moonlight)
  const action =
    cost === null
      ? `<span class="meta-row-state" data-state="complete">최대 단계</span>`
      : `<div class="meta-row-action"><small>${formatMoonlight(cost)} 월광</small>` +
        `<button type="button" data-meta-buy="${id}" data-affordable="${affordable}" ` +
        `data-shortage="${shortage}" ${affordable ? '' : 'disabled'}>` +
        `${affordable ? '강화' : `${formatMoonlight(shortage)} 부족`}</button></div>`

  return (
    `<article class="meta-stat-row" data-purchase-state="${
      cost === null ? 'complete' : affordable ? 'affordable' : 'shortage'
    }">` +
    `<div class="meta-row-copy"><header><strong>${name}</strong><b>${stat.currentEffect(rank)}</b></header>` +
    `<p>${cost === null ? '강화 완료' : `${stat.summary} 다음 · ${stat.nextEffect(rank)}`}</p>` +
    `<div class="meta-rank" role="img" aria-label="${name} ${rank}/${META_STAT_RANK_MAX}">` +
    `${progressPips(rank)}</div></div>${action}</article>`
  )
}

function unlockProgress(progress: MetaProgress, unlock: MetaUnlockDef): string {
  if (unlock.id === 'decapitating-flash') {
    return `${Math.min(progress.lifetimeKills, 3000).toLocaleString('ko-KR')} / 3,000 처치`
  }
  if (unlock.id === 'supernova-specimen') {
    return `${Math.min(progress.lifetimeKills, 1500).toLocaleString('ko-KR')} / 1,500 처치`
  }
  return `${Math.min(progress.bossWins, 1)} / 1 보스 격파`
}

function unlockRow(progress: MetaProgress, unlock: MetaUnlockDef): string {
  const active = isMetaUnlockActive(progress, unlock.id)
  const affordable = !active && progress.moonlight >= unlock.cost
  const shortage = active
    ? 0
    : Math.max(0, unlock.cost - progress.moonlight)
  const action = active
    ? `<span class="meta-row-state" data-state="complete">해금됨</span>`
    : `<div class="meta-row-action"><small>${formatMoonlight(unlock.cost)} 월광</small>` +
      `<button type="button" data-meta-buy="${unlock.id}" data-affordable="${affordable}" ` +
      `data-shortage="${shortage}" ${affordable ? '' : 'disabled'}>` +
      `${affordable ? '해금' : `${formatMoonlight(shortage)} 부족`}</button></div>`

  return (
    `<article class="meta-unlock-row" data-active="${active}" data-purchase-state="${
      active ? 'complete' : affordable ? 'affordable' : 'shortage'
    }">` +
    `<div class="meta-row-copy"><header><small>${unlock.scopeLabel}</small>` +
    `<strong>${unlock.name}</strong></header><p>${unlock.description}</p>` +
    `<span class="meta-unlock-progress">${active ? '카드 풀 적용 중' : unlockProgress(progress, unlock)}</span>` +
    `</div>${action}</article>`
  )
}

function doctrineCard(progress: MetaProgress, id: MetaDoctrineId): string {
  const doctrine = META_DOCTRINES.find((candidate) => candidate.id === id)!
  const purchased = progress.purchasedDoctrines.includes(id)
  const equipped = progress.equippedDoctrineIds.includes(id)
  const affordable = !purchased && progress.moonlight >= doctrine.cost
  const shortage = purchased ? 0 : Math.max(0, doctrine.cost - progress.moonlight)
  const state = equipped
    ? 'equipped'
    : purchased
      ? 'owned'
      : affordable
        ? 'affordable'
        : 'shortage'
  const rankLines = doctrine.rankLines
    .map(
      (line, index) =>
        `<li><b>${['I', 'II', 'III'][index]}</b><span>${line}</span></li>`,
    )
    .join('')
  const action = purchased
    ? `<button type="button" data-doctrine-toggle="${id}" aria-pressed="${equipped}">` +
      `${equipped ? '해제' : '장착'}</button>`
    : `<button type="button" data-meta-buy="${id}" data-affordable="${affordable}" ` +
      `data-shortage="${shortage}" ${affordable ? '' : 'disabled'}>` +
      `${affordable ? '구매' : `${formatMoonlight(shortage)} 부족`}</button>`

  return (
    `<article class="meta-doctrine-card" data-doctrine-state="${state}">` +
    `<header><div><small>전승 경로</small><h4>${doctrine.name}</h4></div>` +
    `<span>${equipped ? '장착 중' : purchased ? '보유' : `${formatMoonlight(doctrine.cost)} 월광`}</span></header>` +
    `<ol aria-label="${doctrine.name} 경로 효과">${rankLines}</ol>` +
    `<footer>${action}</footer></article>`
  )
}

function purchaseName(id: MetaPurchaseId): string {
  const stat = META_STATS.find((candidate) => candidate.id === id)
  if (stat) return stat.name
  if (isMetaDoctrineId(id)) {
    return META_DOCTRINES.find((doctrine) => doctrine.id === id)?.name ?? '전승 경로'
  }
  return (
    META_UNLOCKS.find((unlock) => unlock.id === id)?.name ??
    '선택 항목'
  )
}

function purchaseFailureMessage(
  id: MetaPurchaseId,
  progress: MetaProgress,
): string {
  const name = purchaseName(id)
  const stat = META_STATS.find((candidate) => candidate.id === id)
  if (stat) {
    const rank = metaStatRank(progress, stat.id)
    const cost = metaStatCost(stat.id, rank)
    if (cost === null) return `${name} · 최대 단계`
    return `${name} · 월광 ${formatMoonlight(Math.max(0, cost - progress.moonlight))} 부족`
  }

  if (isMetaDoctrineId(id)) {
    const doctrine = META_DOCTRINES.find((candidate) => candidate.id === id)!
    if (progress.purchasedDoctrines.includes(id)) return `${name} · 이미 보유 중`
    return `${name} · 월광 ${formatMoonlight(Math.max(0, doctrine.cost - progress.moonlight))} 부족`
  }

  if (!isMetaUnlockId(id)) return `${name} · 사용할 수 없음`
  const unlock = META_UNLOCKS.find((candidate) => candidate.id === id)
  if (!unlock || isMetaUnlockActive(progress, id)) return `${name} · 이미 해금됨`
  return `${name} · 월광 ${formatMoonlight(Math.max(0, unlock.cost - progress.moonlight))} 부족`
}

/**
 * 카드 풀에 넣을 전승 경로와 영구 해금을 한 화면에서 편집한다.
 * 선택 가능한 경로만 카드로 두고, 수치·해금 정보는 장부형 행으로 압축한다.
 */
export function showMetaProgress(parent: HTMLElement): Promise<MetaProgress> {
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'meta-overlay'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'meta-title')
    root.setAttribute('aria-describedby', 'meta-intro')

    const panel = document.createElement('section')
    panel.className = 'meta-panel'
    root.appendChild(panel)

    const feedback = document.createElement('p')
    feedback.className = 'meta-feedback'
    feedback.setAttribute('role', 'status')
    feedback.setAttribute('aria-live', 'polite')
    feedback.setAttribute('aria-atomic', 'true')
    panel.appendChild(feedback)

    const content = document.createElement('div')
    content.className = 'meta-content'
    panel.appendChild(content)

    let progress = loadMetaProgress()
    let releaseFocusTrap = (): void => {}
    let done = false

    function close(): void {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
      releaseFocusTrap()
      root.remove()
      resolve(progress)
    }

    function onKey(event: KeyboardEvent): void {
      if (event.repeat || event.key !== 'Escape') return
      event.preventDefault()
      close()
    }

    function focusItem(id: string): void {
      ;(
        content.querySelector<HTMLButtonElement>(
          `[data-doctrine-toggle="${id}"], [data-meta-buy="${id}"]`,
        ) ?? content.querySelector<HTMLButtonElement>('.meta-close')
      )?.focus()
    }

    function setFeedback(message: string, state: 'success' | 'error'): void {
      feedback.dataset.state = state
      feedback.textContent = message
    }

    function render(): void {
      const equipped = progress.equippedDoctrineIds.length
      content.innerHTML =
        `<header class="meta-heading">` +
        `<div class="meta-brand"><img src="${import.meta.env.BASE_URL}art/myeongwol-mark.webp" alt="">` +
        `<div><h2 id="meta-title">월광 전승</h2>` +
        `<p id="meta-intro">전투 점수 75점마다 월광 1개를 얻습니다. 영구 강화와 전승 빌드에 투자하세요.</p></div></div>` +
        `<div class="meta-heading-actions"><div class="meta-currency">` +
        `<span><small>월광</small><strong>${formatMoonlight(progress.moonlight)}</strong></span>` +
        `<span><small>누적 점수</small><strong>${formatMoonlight(progress.lifetimeScore)}</strong></span>` +
        `<span><small>장착</small><strong>${equipped}/${META_DOCTRINE_SLOT_MAX}</strong></span></div>` +
        `<button class="meta-close" type="button" aria-label="월광 전승 닫기">닫기 <kbd>ESC</kbd></button>` +
        `</div></header>` +
        `<section class="meta-section meta-doctrine-section" aria-labelledby="meta-doctrine-title">` +
        `<header><div><h3 id="meta-doctrine-title">전승 경로</h3>` +
        `<p>장착한 경로만 다음 전투의 강화 카드 풀에 들어갑니다.</p></div>` +
        `<span>${equipped}/${META_DOCTRINE_SLOT_MAX} 장착</span></header>` +
        `<div class="meta-doctrine-grid">${META_DOCTRINES.map((doctrine) =>
          doctrineCard(progress, doctrine.id),
        ).join('')}</div></section>` +
        `<div class="meta-lower-grid">` +
        `<section class="meta-section meta-ledger-section" aria-labelledby="meta-stats-title">` +
        `<header><div><h3 id="meta-stats-title">시작 능력</h3>` +
        `<p>8개 계통 · 40단계가 모든 전투에 적용됩니다.</p></div></header>` +
        `<div class="meta-stat-list">` +
        META_STATS.map((stat) => statRow(stat, progress)).join('') +
        `</div></section>` +
        `<section class="meta-section meta-ledger-section" aria-labelledby="meta-unlocks-title">` +
        `<header><div><h3 id="meta-unlocks-title">카드 해금</h3>` +
        `<p>조건을 달성하거나 월광으로 바로 엽니다.</p></div></header>` +
        `<div class="meta-unlock-list">${META_UNLOCKS.map((unlock) =>
          unlockRow(progress, unlock),
        ).join('')}</div></section></div>` +
        `<footer class="meta-footer"><span>완료한 런 ${progress.completedRuns.toLocaleString('ko-KR')} · ` +
        `누적 처치 ${progress.lifetimeKills.toLocaleString('ko-KR')} · 보스 격파 ${progress.bossWins}</span>` +
        `<button class="menu-button primary meta-back" type="button"><span>메뉴로</span></button></footer>`

      for (const button of content.querySelectorAll<HTMLButtonElement>(
        '[data-meta-buy]',
      )) {
        button.addEventListener('click', () => {
          const id = button.dataset.metaBuy as MetaPurchaseId | undefined
          if (!id || button.disabled) return
          const result = purchaseMetaItem(id)
          progress = result.progress
          render()
          setFeedback(
            result.purchased
              ? `${purchaseName(id)} 구매 · 남은 월광 ${formatMoonlight(progress.moonlight)}`
              : purchaseFailureMessage(id, progress),
            result.purchased ? 'success' : 'error',
          )
          focusItem(id)
        })
      }

      for (const button of content.querySelectorAll<HTMLButtonElement>(
        '[data-doctrine-toggle]',
      )) {
        button.addEventListener('click', () => {
          const id = button.dataset.doctrineToggle as MetaDoctrineId | undefined
          if (!id) return
          const name = purchaseName(id)
          const result = toggleMetaDoctrine(id)
          progress = result.progress
          render()
          setFeedback(
            result.changed
              ? `${name} ${result.equipped ? '장착' : '해제'}`
              : `장착 경로가 ${META_DOCTRINE_SLOT_MAX}개입니다. 하나를 해제하세요.`,
            result.changed ? 'success' : 'error',
          )
          focusItem(id)
        })
      }

      content
        .querySelector<HTMLButtonElement>('.meta-close')
        ?.addEventListener('click', close)
      content
        .querySelector<HTMLButtonElement>('.meta-back')
        ?.addEventListener('click', close)
    }

    render()
    window.addEventListener('keydown', onKey)
    parent.appendChild(root)
    releaseFocusTrap = trapFocus(root)
    content.querySelector<HTMLButtonElement>('.meta-close')?.focus()
  })
}
