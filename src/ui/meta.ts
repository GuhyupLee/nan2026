import { trapFocus } from './focus-trap.ts'
import {
  META_STAT_RANK_MAX,
  META_UNLOCKS,
  isHardModeUnlocked,
  isMetaUnlockActive,
  loadMetaProgress,
  metaStatCost,
  purchaseMetaItem,
  type MetaProgress,
  type MetaPurchaseId,
  type MetaStatId,
} from './meta-progression.ts'

function progressPips(rank: number, max = META_STAT_RANK_MAX): string {
  let value = ''
  for (let i = 1; i <= max; i += 1) {
    value += `<i data-filled="${i <= rank}" aria-hidden="true"></i>`
  }
  return value
}

function formatMoonlight(value: number): string {
  return value.toLocaleString('ko-KR')
}

function statCard(
  id: MetaStatId,
  name: string,
  description: string,
  rank: number,
  progress: MetaProgress,
): string {
  const cost = metaStatCost(id, rank)
  const affordable = cost !== null && progress.moonlight >= cost
  const shortage =
    cost === null ? 0 : Math.max(0, cost - progress.moonlight)
  const buttonLabel =
    cost === null
      ? '최대 강화 완료'
      : affordable
        ? `월광 ${formatMoonlight(cost)}로 강화`
        : `월광 ${formatMoonlight(shortage)} 부족`
  return (
    `<article class="meta-stat-card" data-purchase-state="${cost === null ? 'complete' : affordable ? 'affordable' : 'shortage'}">` +
    `<header><span>영구 보정</span><strong>${name}</strong></header>` +
    `<p>${description}</p>` +
    `<div class="meta-rank" role="img" aria-label="${name} ${rank}/${META_STAT_RANK_MAX}">` +
    progressPips(rank) +
    `</div>` +
    `<button type="button" data-meta-buy="${id}" ` +
    `data-affordable="${affordable}" data-shortage="${shortage}" ${affordable ? '' : 'disabled'}>` +
    `${buttonLabel}</button>` +
    `</article>`
  )
}

function unlockCard(progress: MetaProgress, index: number): string {
  const unlock = META_UNLOCKS[index]!
  const active = isMetaUnlockActive(progress, unlock.id)
  const affordable = !active && progress.moonlight >= unlock.cost
  const shortage = active
    ? 0
    : Math.max(0, unlock.cost - progress.moonlight)
  const label = active
    ? '해금 완료'
    : affordable
      ? `월광 ${formatMoonlight(unlock.cost)}로 해금`
      : `월광 ${formatMoonlight(shortage)} 부족`
  return (
    `<article class="meta-unlock-card" data-active="${active}" ` +
    `data-purchase-state="${active ? 'complete' : affordable ? 'affordable' : 'shortage'}">` +
    `<header><span>${String(index + 1).padStart(2, '0')}</span>` +
    `<strong>${unlock.name}</strong></header>` +
    `<p>${unlock.description}</p>` +
    `<small>${active ? '카드 풀 적용 중' : unlock.conditionLabel}</small>` +
    `<button type="button" data-meta-buy="${unlock.id}" ` +
    `data-affordable="${affordable}" data-shortage="${shortage}" ` +
    `${affordable ? '' : 'disabled'}>${label}</button>` +
    `</article>`
  )
}

function purchaseName(id: MetaPurchaseId): string {
  if (id === 'vitality') return '월맥 강화'
  if (id === 'stride') return '월보 강화'
  return META_UNLOCKS.find((unlock) => unlock.id === id)?.name ?? '선택 항목'
}

function purchaseFailureMessage(
  id: MetaPurchaseId,
  progress: MetaProgress,
): string {
  const name = purchaseName(id)
  if (id === 'vitality' || id === 'stride') {
    const rank =
      id === 'vitality' ? progress.vitalityRank : progress.strideRank
    const cost = metaStatCost(id, rank)
    if (cost === null) return `${name}은 이미 최대 단계입니다.`
    const shortage = Math.max(0, cost - progress.moonlight)
    return shortage > 0
      ? `${name}: 월광 ${formatMoonlight(shortage)}이 부족합니다.`
      : `${name}을 지금 강화할 수 없습니다.`
  }

  const unlock = META_UNLOCKS.find((candidate) => candidate.id === id)
  if (!unlock || isMetaUnlockActive(progress, id)) {
    return `${name}은 이미 해금되었습니다.`
  }
  const shortage = Math.max(0, unlock.cost - progress.moonlight)
  return shortage > 0
    ? `${name}: 월광 ${formatMoonlight(shortage)}이 부족합니다.`
    : `${name}을 지금 해금할 수 없습니다.`
}

/**
 * 런 간 성장과 카드 언락을 한 화면에서 관리한다.
 * 저장 실패는 meta-progression의 세션 메모리 폴백이 흡수한다.
 */
export function showMetaProgress(parent: HTMLElement): Promise<MetaProgress> {
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'meta-overlay'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'meta-title')

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

    const render = (): void => {
      content.innerHTML =
        `<header class="meta-heading">` +
        `<div><span>전승 관리</span><h2 id="meta-title">월광 전승</h2>` +
        `<p>한 판의 성과를 다음 전장의 선택지로 바꿉니다.</p></div>` +
        `<div class="meta-currency"><small>보유 월광</small>` +
        `<strong>${formatMoonlight(progress.moonlight)}</strong></div>` +
        `</header>` +
        `<div class="meta-summary" aria-label="누적 전적">` +
        `<span><small>누적 처치</small><b>${progress.lifetimeKills.toLocaleString('ko-KR')}</b></span>` +
        `<span><small>보스 격파</small><b>${progress.bossWins}</b></span>` +
        `<span><small>월식 난이도</small><b>${isHardModeUnlocked(progress) ? '해금' : '잠김'}</b></span>` +
        `</div>` +
        `<section class="meta-section" aria-labelledby="meta-stats-title">` +
        `<header><span>영구 강화</span><h3 id="meta-stats-title">능력치 강화</h3></header>` +
        `<div class="meta-stat-grid">` +
        statCard(
          'vitality',
          '월맥 강화',
          '랭크마다 시작 최대 체력 +3',
          progress.vitalityRank,
          progress,
        ) +
        statCard(
          'stride',
          '월보 강화',
          '랭크마다 시작 이동 속도 +1%',
          progress.strideRank,
          progress,
        ) +
        `</div></section>` +
        `<section class="meta-section" aria-labelledby="meta-unlocks-title">` +
        `<header><span>전투 해금</span><h3 id="meta-unlocks-title">새로운 강화 선택지</h3></header>` +
        `<div class="meta-unlock-grid">${META_UNLOCKS.map((_, index) =>
          unlockCard(progress, index),
        ).join('')}</div></section>` +
        `<button class="menu-button primary meta-back" type="button">` +
        `<span>메인 메뉴로 돌아가기</span><small>ESC</small></button>`

      for (const button of content.querySelectorAll<HTMLButtonElement>(
        '[data-meta-buy]',
      )) {
        button.addEventListener('click', () => {
          const id = button.dataset.metaBuy as MetaPurchaseId | undefined
          if (!id || button.disabled) return
          const result = purchaseMetaItem(id)
          progress = result.progress
          render()
          feedback.dataset.state = result.purchased ? 'success' : 'error'
          feedback.textContent = result.purchased
            ? `${purchaseName(id)} 적용 완료. 월광 ${formatMoonlight(progress.moonlight)}이 남았습니다.`
            : purchaseFailureMessage(id, progress)
          const next = content.querySelector<HTMLButtonElement>(
            `[data-meta-buy="${id}"]`,
          )
          if (next && !next.disabled) {
            next.focus()
          } else {
            ;(
              content.querySelector<HTMLButtonElement>(
                '[data-meta-buy]:not(:disabled)',
              ) ?? content.querySelector<HTMLButtonElement>('.meta-back')
            )?.focus()
          }
        })
      }
      content
        .querySelector<HTMLButtonElement>('.meta-back')
        ?.addEventListener('click', close)
    }

    const close = (): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
      releaseFocusTrap()
      root.remove()
      resolve(progress)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat || event.key !== 'Escape') return
      event.preventDefault()
      close()
    }

    render()
    window.addEventListener('keydown', onKey)
    parent.appendChild(root)
    releaseFocusTrap = trapFocus(root)
    content.querySelector<HTMLButtonElement>('.meta-back')?.focus()
  })
}
