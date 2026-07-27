import { computeScore } from '../sim/score.ts'
import type { World } from '../sim/types.ts'
import { trapFocus } from './focus-trap.ts'
import { formatTime, loadRecords, saveRecord, type RunRecord } from './records.ts'

export type GameOutcome = Exclude<World['outcome'], 'alive'>
export type OutcomeAction = 'restart' | 'menu'

interface OutcomeCopy {
  eyebrow: string
  title: string
  description: string
}

const COPY: Record<GameOutcome, OutcomeCopy> = {
  dead: {
    eyebrow: 'RUN OVER',
    title: '쓰러졌습니다',
    description: '호흡을 고르고, 같은 전장에 다시 도전하세요.',
  },
  timeout: {
    eyebrow: 'TIME OVER',
    title: '시간이 다 됐습니다',
    description: '5분 안에 보스를 쓰러뜨리지 못했습니다. 같은 전장에 다시 도전하세요.',
  },
  victory: {
    eyebrow: 'VICTORY',
    title: '승리했습니다',
    description: '전장을 지배했습니다. 같은 조건으로 다시 도전할 수 있습니다.',
  },
}

/**
 * 결과 화면을 띄우고 재시작 의사가 들어올 때까지 기다린다.
 *
 * R은 궁극기 입력이므로 결과 화면에서도 쓰지 않는다. Enter/Space는 포커스된
 * 네이티브 버튼이 처리하므로, 메인 메뉴 버튼에서도 올바른 동작을 유지한다.
 */
/** 점수 내역 한 줄. */
function scoreRow(label: string, value: number, muted = false): string {
  if (value === 0 && muted) return ''
  return (
    `<div class="row${muted ? ' muted' : ''}">` +
    `<span>${label}</span><b>${value.toLocaleString('ko-KR')}</b></div>`
  )
}

function recordsTable(records: RunRecord[], currentAt: number): string {
  if (records.length === 0) return ''
  const rows = records
    .map((r, i) => {
      const mine = r.at === currentAt ? ' current' : ''
      const mark = r.victory ? '승' : '패'
      return (
        `<tr class="rec${mine}">` +
        `<td class="rank">${i + 1}</td>` +
        `<td class="sc">${r.score.toLocaleString('ko-KR')}</td>` +
        `<td class="res" data-win="${r.victory}">${mark}</td>` +
        `<td class="tm">${formatTime(r.time)}</td>` +
        `<td class="kl">${r.kills}킬</td>` +
        `</tr>`
      )
    })
    .join('')
  return `<div class="records"><h3>최고 기록</h3><table><tbody>${rows}</tbody></table></div>`
}

export function showOutcome(
  parent: HTMLElement,
  outcome: GameOutcome,
  world?: World,
): Promise<OutcomeAction> {
  return new Promise((resolve) => {
    const copy = COPY[outcome]
    const root = document.createElement('div')
    root.className = 'outcome'
    root.dataset.result = outcome
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'outcome-title')

    const panel = document.createElement('div')
    panel.className = 'panel'
    panel.innerHTML =
      `<div class="eyebrow">${copy.eyebrow}</div>` +
      `<h2 id="outcome-title">${copy.title}</h2>` +
      `<p>${copy.description}</p>`
    root.appendChild(panel)

    // --- 점수와 기록 ---
    if (world) {
      const s = computeScore(world)
      const at = Date.now()
      const { records, isBest } = saveRecord(world.playerClass, {
        score: s.total,
        kills: world.kills,
        level: world.progression.level,
        time: world.time,
        victory: outcome === 'victory',
        at,
      })

      const score = document.createElement('div')
      score.className = 'scoreboard'
      score.innerHTML =
        `<div class="total${isBest ? ' best' : ''}">` +
        `<span class="label">${isBest ? '최고 기록 갱신' : '점수'}</span>` +
        `<strong>${s.total.toLocaleString('ko-KR')}</strong>` +
        `</div>` +
        `<div class="rows">` +
        scoreRow(`처치 ${world.kills}`, s.kills) +
        scoreRow(`레벨 ${world.progression.level}`, s.level) +
        scoreRow('보스 처치', s.victory, true) +
        scoreRow(`남은 시간 ${formatTime(Math.max(0, 300 - world.time))}`, s.speed, true) +
        `</div>` +
        recordsTable(records, at)
      panel.appendChild(score)
    } else {
      // world 없이 부르는 경로가 남아 있어도 결과 화면 자체는 떠야 한다.
      const records = loadRecords('ranged')
      if (records.length > 0) {
        const box = document.createElement('div')
        box.className = 'scoreboard'
        box.innerHTML = recordsTable(records, -1)
        panel.appendChild(box)
      }
    }

    const actions = document.createElement('div')
    actions.className = 'actions'
    panel.appendChild(actions)

    const restart = document.createElement('button')
    restart.className = 'restart'
    restart.type = 'button'
    restart.innerHTML =
      `<span>같은 캐릭터로 재시작</span>` +
      `<small>ENTER 또는 SPACE</small>`
    actions.appendChild(restart)

    const menu = document.createElement('button')
    menu.className = 'menu'
    menu.type = 'button'
    menu.innerHTML =
      `<span>메인 메뉴</span>` +
      `<small>ESC</small>`
    actions.appendChild(menu)

    const note = document.createElement('div')
    note.className = 'note'
    note.textContent = '재시작은 같은 캐릭터 · 같은 시드'
    panel.appendChild(note)

    let done = false
    let releaseFocusTrap = (): void => {}
    const finish = (action: OutcomeAction): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
      releaseFocusTrap()
      root.remove()
      resolve(action)
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat) return
      if (e.key === 'Escape') {
        e.preventDefault()
        finish('menu')
      }
    }

    restart.addEventListener('click', () => finish('restart'))
    menu.addEventListener('click', () => finish('menu'))
    window.addEventListener('keydown', onKey)
    parent.appendChild(root)
    releaseFocusTrap = trapFocus(root)
    restart.focus()
  })
}
