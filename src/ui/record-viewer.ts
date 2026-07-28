import type { PlayerClass } from '../sim/types.ts'
import { trapFocus } from './focus-trap.ts'
import { formatTime, loadRecords, type RunRecord } from './records.ts'

const CLASS_LABEL: Record<PlayerClass, { name: string; role: string }> = {
  ranged: { name: '루멘', role: '원거리' },
  melee: { name: '월아', role: '근접' },
}

function formatRecordDate(at: number): string {
  try {
    const date = new Date(at)
    if (Number.isNaN(date.getTime())) return '날짜 없음'
    return new Intl.DateTimeFormat('ko-KR', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  } catch {
    // 한 줄이 손상돼도 나머지 기록과 뒤로 버튼은 반드시 살아 있어야 한다.
    return '날짜 없음'
  }
}

function createRecordRow(record: RunRecord, rank: number): HTMLTableRowElement {
  const row = document.createElement('tr')

  const values = [
    String(rank),
    record.score.toLocaleString('ko-KR'),
    `${record.victory ? '승리' : '패배'}${
      record.difficulty === 'hard' ? ' · H' : ''
    }${record.endless ? ' · ∞' : ''}`,
    record.endless && record.endlessTime !== undefined
      ? `∞ ${formatTime(record.endlessTime)}`
      : formatTime(record.time),
    `${record.kills}킬`,
    `Lv.${record.level}`,
    formatRecordDate(record.at),
  ]

  for (const [index, value] of values.entries()) {
    const cell = document.createElement('td')
    cell.textContent = value
    if (index === 1) cell.className = 'record-score'
    if (index === 2) {
      cell.className = 'record-result'
      cell.dataset.win = String(record.victory)
    }
    row.appendChild(cell)
  }
  return row
}

function createClassRecords(cls: PlayerClass): HTMLElement {
  const records = loadRecords(cls)
  const section = document.createElement('section')
  section.className = 'record-class'
  section.dataset.class = cls

  const heading = document.createElement('header')
  const best = records[0]
  heading.innerHTML =
    `<div><span>${CLASS_LABEL[cls].role}</span><h3>${CLASS_LABEL[cls].name}</h3></div>` +
    `<strong>${best ? best.score.toLocaleString('ko-KR') : '—'}</strong>`
  section.appendChild(heading)

  if (records.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'record-empty'
    empty.textContent = '아직 저장된 기록이 없습니다.'
    section.appendChild(empty)
    return section
  }

  const viewport = document.createElement('div')
  viewport.className = 'record-table-viewport'
  const table = document.createElement('table')
  const head = document.createElement('thead')
  head.innerHTML =
    '<tr><th>#</th><th>점수</th><th>결과</th><th>시간</th><th>처치</th><th>레벨</th><th>기록일</th></tr>'
  const body = document.createElement('tbody')
  records.forEach((record, index) => body.appendChild(createRecordRow(record, index + 1)))
  table.append(head, body)
  viewport.appendChild(table)
  section.appendChild(viewport)
  return section
}

export function showRecords(parent: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const root = document.createElement('div')
    root.className = 'records-overlay'
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'records-title')

    const panel = document.createElement('section')
    panel.className = 'records-panel'
    root.appendChild(panel)

    const heading = document.createElement('header')
    heading.className = 'menu-heading'
    heading.innerHTML =
      '<div class="menu-eyebrow">전투 기록</div>' +
      '<h2 id="records-title">점수 기록</h2>' +
      '<p>이 기기에 저장된 캐릭터별 최고 기록입니다.</p>'
    heading.tabIndex = 0
    panel.appendChild(heading)

    const classes = document.createElement('div')
    classes.className = 'record-classes'
    classes.append(createClassRecords('ranged'), createClassRecords('melee'))
    panel.appendChild(classes)

    const back = document.createElement('button')
    back.className = 'menu-button primary records-back'
    back.type = 'button'
    back.innerHTML = '<span>뒤로</span><small>ESC</small>'
    panel.appendChild(back)

    let done = false
    let releaseFocusTrap = (): void => {}
    const close = (): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
      releaseFocusTrap()
      root.remove()
      resolve()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.repeat || event.key !== 'Escape') return
      event.preventDefault()
      close()
    }

    back.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    parent.appendChild(root)
    releaseFocusTrap = trapFocus(root)
    // 대화상자를 열자마자 닫기 버튼으로 건너뛰지 않고 제목과 기록 맥락부터 읽힌다.
    heading.focus()
  })
}
