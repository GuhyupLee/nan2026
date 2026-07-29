import { computeScore } from '../sim/score.ts'
import { difficultyRules, runDifficultyLabel } from '../sim/difficulty.ts'
import type { World } from '../sim/types.ts'
import { countAttrs, runBriefing } from './briefing.ts'
import { trapFocus } from './focus-trap.ts'
import { formatTime, loadRecords, saveRecord, type RunRecord } from './records.ts'
import {
  createRunBuildSummary,
  getRunBuildPresentation,
  type RunBuildPresentation,
} from './run-build.ts'
import {
  META_UNLOCKS,
  awardMetaRun,
  scoreToMoonlight,
} from './meta-progression.ts'

export type GameOutcome = Exclude<World['outcome'], 'alive'>
export type OutcomeAction = 'restart' | 'menu' | 'endless'

interface OutcomeCopy {
  eyebrow: string
  title: string
  description: string
}

/**
 * 결과별 문구.
 *
 * 셋의 어조를 일부러 다르게 잡았다. 예전에는 세 문구가 거의 같은 톤이라
 * 이겼는지 졌는지가 색으로만 구분됐다. 승리는 사건을 선언하고, 패배는
 * 어디까지 갔는지를 말한다 — 실패 화면에서 점수를 제일 크게 띄우면
 * 위로가 아니라 조롱으로 읽힌다.
 */
const COPY: Record<GameOutcome, OutcomeCopy> = {
  dead: {
    eyebrow: '전투 종료',
    title: '쓰러졌습니다',
    description: '여기까지 왔습니다. 같은 전장에서 바로 다시 시작할 수 있습니다.',
  },
  timeout: {
    eyebrow: '시간 초과',
    title: '시간이 다 됐습니다',
    description: '보스를 끝내지 못한 채 제한 시간이 지났습니다. 조금 더 밀어붙이면 닿습니다.',
  },
  victory: {
    eyebrow: '승리',
    title: '균열의 군주를 쓰러뜨렸습니다',
    description: '전장이 조용해졌습니다. 계속 싸우거나 보상을 챙기고 돌아갈 수 있습니다.',
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

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function skillPips(rank: number): string {
  let pips = ''
  for (let value = 1; value <= 4; value += 1) {
    pips += `<i data-filled="${value <= rank}" aria-hidden="true"></i>`
  }
  return pips
}

function evolutionList(label: string, names: string[], kind: 'awakening' | 'fusion'): string {
  const value = names.length > 0 ? names.map(escapeHtml).join(' · ') : '미완성'
  return (
    `<div class="build-evolution" data-kind="${kind}">` +
    `<span>${label}</span><strong>${value}</strong></div>`
  )
}

function buildManifest(
  build: ReturnType<typeof createRunBuildSummary>,
  view: RunBuildPresentation,
): string {
  const skills = view.skills
    .map((skill) => {
      const state = skill.unlocked ? `${skill.rank}단계` : '잠김'
      const path = skill.unlocked ? skill.branchName ?? '기본식' : '미해금'
      return (
        `<div class="build-skill" data-evolution="${skill.evolution}">` +
        `<div class="build-skill-heading">` +
        `<b>${skill.id.toUpperCase()}</b><span>${state}</span></div>` +
        `<div class="build-skill-pips" role="img" aria-label="${skill.id.toUpperCase()} 강화 ${skill.rank}/4">` +
        skillPips(skill.rank) +
        `</div>` +
        `<small>${escapeHtml(path)}</small>` +
        `</div>`
      )
    })
    .join('')

  return (
    `<section class="build-manifest" aria-labelledby="build-manifest-title">` +
    `<header><div>` +
    `<span>전투 빌드</span>` +
    `<h3 id="build-manifest-title">이번 전투의 최종 강화</h3>` +
    `</div><code>#${view.battlefieldCode}</code></header>` +
    `<div class="build-skills">${skills}</div>` +
    `<div class="build-counters">` +
    `<div><span>각성</span><strong>${view.awakeningNames.length}</strong></div>` +
    `<div data-kind="fusion"><span>융합</span><strong>${view.fusionNames.length}</strong></div>` +
    `<div data-kind="seals"><span>월식 인장</span><strong>${build.seals}</strong></div>` +
    `</div>` +
    `<div class="build-evolutions">` +
    evolutionList('각성', view.awakeningNames, 'awakening') +
    evolutionList('융합', view.fusionNames, 'fusion') +
    `</div>` +
    `</section>`
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
        `<td>${runDifficultyLabel(r.difficulty ?? 'normal')}</td>` +
        `<td class="res" data-win="${r.victory}">${mark}</td>` +
        `<td class="tm">${formatTime(r.time)}</td>` +
        `<td class="kl">${r.kills}킬</td>` +
        `</tr>`
      )
    })
    .join('')
  return (
    `<div class="records"><h3>최고 기록</h3>` +
    `<table aria-label="최고 기록 순위">` +
    `<thead><tr><th scope="col">순위</th><th scope="col">점수</th><th scope="col">스테이지</th>` +
    `<th scope="col">결과</th><th scope="col">시간</th><th scope="col">처치</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  )
}

export function showOutcome(
  parent: HTMLElement,
  outcome: GameOutcome,
  world?: World,
): Promise<OutcomeAction> {
  return new Promise((resolve) => {
    const baseCopy = COPY[outcome]
    const runRules = world
      ? difficultyRules(world.runConfig.difficulty)
      : null
    const stageLabel = world
      ? runDifficultyLabel(world.runConfig.difficulty)
      : ''
    const copy: OutcomeCopy =
      world && outcome === 'timeout' && runRules
        ? {
            ...baseCopy,
            description: `${formatTime(runRules.runTimeLimit)} 안에 ${stageLabel} 보스를 쓰러뜨리지 못했습니다. 바로 재도전하거나 기록을 확인할 수 있습니다.`,
          }
        : world && outcome === 'victory'
          ? {
              ...baseCopy,
              title:
                world.runConfig.difficulty === 'fullmoon'
                  ? '만월을 제압했습니다'
                  : baseCopy.title,
              description:
                world.runConfig.difficulty === 'fullmoon'
                  ? '10분의 공세와 최종 보스 3페이즈를 돌파했습니다.'
                  : baseCopy.description,
            }
          : baseCopy
    const root = document.createElement('div')
    root.className = 'outcome'
    root.dataset.result = outcome
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-modal', 'true')
    root.setAttribute('aria-labelledby', 'outcome-title')

    const panel = document.createElement('div')
    panel.className = 'panel'
    // 헤더가 브리핑의 첫 단계다. 나머지 줄은 아래에서 순서를 이어받는다.
    panel.innerHTML =
      `<div class="outcome-head" data-brief="0">` +
      `<div class="eyebrow">${copy.eyebrow}</div>` +
      `<h2 id="outcome-title">${copy.title}</h2>` +
      `<p>${copy.description}</p>` +
      `</div>`
    root.appendChild(panel)

    // --- 한눈에 보는 결과와, 필요할 때 펼치는 상세 기록 ---
    let retryBattlefieldCode: string | null = null
    let outcomeDetails: HTMLDetailsElement | null = null
    if (world) {
      const s = computeScore(world)
      const targetMoonlight = scoreToMoonlight(s.total)
      const moonlightEarned = Math.max(
        0,
        targetMoonlight - world.metaAwardedMoonlight,
      )
      const scoreEarned = Math.max(0, s.total - world.metaAwardedScore)
      const killsEarned = Math.max(0, world.kills - world.metaAwardedKills)
      const bossWinEarned =
        outcome === 'victory' && !world.metaVictoryAwarded ? 1 : 0
      const runEarned = world.metaRunRecorded ? 0 : 1
      const metaAward = awardMetaRun({
        moonlight: moonlightEarned,
        kills: killsEarned,
        bossWins: bossWinEarned,
        normalWins:
          world.runConfig.difficulty === 'normal' ? bossWinEarned : 0,
        eclipseWins:
          world.runConfig.difficulty === 'hard' ? bossWinEarned : 0,
        fullMoonWins:
          world.runConfig.difficulty === 'fullmoon' ? bossWinEarned : 0,
        score: scoreEarned,
        runs: runEarned,
      })
      world.metaAwardedMoonlight += moonlightEarned
      world.metaAwardedKills += killsEarned
      world.metaAwardedScore += scoreEarned
      world.metaRunRecorded ||= runEarned > 0
      world.metaVictoryAwarded ||= bossWinEarned > 0
      const at = world.runRecordAt >= 0 ? world.runRecordAt : Date.now()
      world.runRecordAt = at
      const build = createRunBuildSummary(world)
      const buildView = getRunBuildPresentation(build)
      retryBattlefieldCode = buildView.battlefieldCode
      const { records, isBest } = saveRecord(world.playerClass, {
        score: s.total,
        kills: world.kills,
        level: world.progression.level,
        time: world.time,
        victory: outcome === 'victory' || world.victoryAt >= 0,
        difficulty: world.runConfig.difficulty,
        endless: world.endless,
        endlessTime: world.endless
          ? Math.max(0, world.time - world.endlessStartedAt)
          : 0,
        at,
        build,
      })

      const score = document.createElement('div')
      score.className = 'scoreboard'
      const unlockedNames = metaAward.newlyUnlocked.flatMap((id) => {
        const unlock = META_UNLOCKS.find((candidate) => candidate.id === id)
        return unlock ? [unlock.name] : []
      })
      const unlockedStage =
        bossWinEarned > 0 &&
        world.runConfig.difficulty === 'normal' &&
        metaAward.progress.normalWins === 1
          ? '새 스테이지 해금 · 월식'
          : bossWinEarned > 0 &&
              world.runConfig.difficulty === 'hard' &&
              metaAward.progress.eclipseWins === 1
            ? '새 스테이지 해금 · 만월 · 10:00 보스 · 3페이즈'
            : ''
      // 보스를 얼마나 깎았는가. 패배 화면에서는 이게 점수보다 중요한 정보다 —
      // "어디까지 갔는지"를 알아야 다음 판에 무엇을 바꿀지 판단이 선다.
      const bossProgress =
        world.boss.maxHp > 0
          ? Math.round(
              (1 - Math.max(0, world.boss.hp) / world.boss.maxHp) * 100,
            )
          : 0
      const cleared = outcome === 'victory'

      // 승리는 점수를 앞세우고, 패배는 도달 지점을 앞세운다. 실패 화면에서
      // 점수를 제일 크게 띄우면 위로가 아니라 조롱으로 읽힌다.
      const headline = cleared
        ? {
            label: isBest ? `${stageLabel} 최고 기록 갱신` : '점수',
            value: s.total,
            text: s.total.toLocaleString('ko-KR'),
            format: 'number' as const,
          }
        : {
            label: '보스 진행도',
            value: bossProgress,
            text: `${bossProgress}%`,
            format: 'percent' as const,
          }

      const metricRow = (
        key: string,
        label: string,
        value: number,
        text: string,
        format: 'number' | 'time' | 'percent',
      ): string =>
        `<div class="row" data-metric="${key}">` +
        `<span>${label}</span>` +
        `<b${countAttrs(value, format)}>${text}</b>` +
        `<span class="sr-only">${label} ${text}</span>` +
        `</div>`

      const metrics = cleared
        ? metricRow('kills', '처치', world.kills, `${world.kills.toLocaleString('ko-KR')}킬`, 'number') +
          metricRow('time', '전투 시간', Math.floor(world.time), formatTime(world.time), 'time')
        : metricRow('level', '도달 레벨', world.progression.level, `Lv ${world.progression.level}`, 'number') +
          metricRow('kills', '처치', world.kills, `${world.kills.toLocaleString('ko-KR')}킬`, 'number') +
          metricRow('time', '생존 시간', Math.floor(world.time), formatTime(world.time), 'time') +
          metricRow('score', '점수', s.total, s.total.toLocaleString('ko-KR'), 'number')

      score.innerHTML =
        `<section class="score-summary outcome-core-summary" aria-label="이번 전투 핵심 결과">` +
        `<div class="total${isBest ? ' best' : ''}" data-brief="1">` +
        `<span class="label">${headline.label}</span>` +
        `<strong${countAttrs(headline.value, headline.format)}>${headline.text}</strong>` +
        `<span class="sr-only">${headline.label} ${headline.text}</span>` +
        `</div>` +
        `<div class="rows outcome-core-metrics" data-brief="2">` +
        metrics +
        `</div>` +
        `</section>`

      outcomeDetails = document.createElement('details')
      outcomeDetails.className = 'outcome-details'
      outcomeDetails.innerHTML =
        `<summary>상세 점수·기록·빌드 보기</summary>` +
        `<div class="run-report outcome-details-content">` +
        `<section class="score-summary" aria-label="상세 점수와 기록">` +
        `<h3 class="outcome-detail-title">점수 계산</h3>` +
        `<div class="rows">` +
        scoreRow(`처치 점수 (${world.kills}킬)`, s.kills) +
        scoreRow(`레벨 점수 (${world.progression.level}레벨)`, s.level) +
        scoreRow('보스 처치 점수', s.victory, true) +
        scoreRow(`남은 시간 점수 (${formatTime(Math.max(0, difficultyRules(world.runConfig.difficulty).runTimeLimit - world.time))})`, s.speed, true) +
        scoreRow('추가 생존 점수', s.survival, true) +
        (s.difficultyMultiplier > 1
          ? `<div class="row hard"><span>${runDifficultyLabel(world.runConfig.difficulty)} 스테이지 배율</span><b>×${s.difficultyMultiplier.toFixed(2).replace(/0$/, '')}</b></div>`
          : '') +
        `</div>` +
        recordsTable(records, at) +
        `</section>` +
        buildManifest(build, buildView) +
        `</div>`

      const legacy = document.createElement('section')
      legacy.className = 'meta-run-reward'
      legacy.setAttribute('aria-label', '월광 전승 보상')
      legacy.dataset.brief = '3'
      legacy.innerHTML =
        (unlockedStage
          ? `<div class="stage-unlock"><span>${unlockedStage}</span><strong>NEW</strong></div>`
          : '') +
        `<div><span>점수 환산 월광</span><strong>+${moonlightEarned.toLocaleString('ko-KR')}</strong></div>` +
        `<p>점수 75 = 월광 1 · 보유 ${metaAward.progress.moonlight.toLocaleString('ko-KR')}` +
        (unlockedNames.length > 0
          ? ` · 신규 해금 ${unlockedNames.join(' · ')}`
          : '') +
        `</p>`
      panel.appendChild(score)
      panel.appendChild(legacy)
    } else {
      // world 없이 부르는 경로가 남아 있어도 결과 화면 자체는 떠야 한다.
      const records = loadRecords('ranged')
      if (records.length > 0) {
        outcomeDetails = document.createElement('details')
        outcomeDetails.className = 'outcome-details'
        outcomeDetails.innerHTML =
          `<summary>최고 기록 보기</summary>` +
          `<div class="scoreboard">${recordsTable(records, -1)}</div>`
      }
    }

    const actions = document.createElement('div')
    actions.className = 'actions'
    actions.dataset.brief = '4'
    panel.appendChild(actions)

    let endless: HTMLButtonElement | null = null
    if (world && outcome === 'victory' && !world.endless) {
      endless = document.createElement('button')
      endless.className = 'endless'
      endless.type = 'button'
      endless.dataset.primaryAction = 'true'
      endless.innerHTML =
        `<span>계속 싸운다</span>` +
        `<small>끝없는 전투 · 40초마다 정예 출현</small>`
      actions.appendChild(endless)
    }

    const restart = document.createElement('button')
    restart.className = 'restart'
    restart.type = 'button'
    if (retryBattlefieldCode) {
      restart.innerHTML =
        `<span>같은 전장 재도전</span>` +
        `<small>전장 코드 #${retryBattlefieldCode}</small>`
    } else {
      restart.innerHTML =
        `<span>같은 캐릭터로 재시작</span>` +
        `<small>ENTER 또는 SPACE</small>`
    }
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
    note.dataset.brief = '5'
    note.textContent = world
      ? '같은 캐릭터와 전장 코드로 적 배치와 보상 순서를 다시 재현합니다.'
      : '재시작하면 같은 캐릭터와 같은 전장 배치를 사용합니다.'
    panel.appendChild(note)
    if (outcomeDetails) {
      outcomeDetails.dataset.brief = '6'
      panel.appendChild(outcomeDetails)
    }

    let done = false
    let releaseFocusTrap = (): void => {}
    let briefing: { finish(): void; dispose(): void } | null = null
    const finish = (action: OutcomeAction): void => {
      if (done) return
      done = true
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', skipBriefing, true)
      briefing?.dispose()
      releaseFocusTrap()
      root.remove()
      resolve(action)
    }

    /**
     * 연출을 건너뛴다.
     *
     * 결과를 이미 아는 사람에게 브리핑은 기다림일 뿐이다. 아무 입력이나
     * 들어오면 즉시 최종 상태로 간다. 버튼 자체는 연출 중에도 눌리므로
     * (`briefing.ts`가 투명도만 건드린다) 이건 조작을 여는 게 아니라
     * **눈을 편하게** 해 주는 장치다.
     */
    const skipBriefing = (): void => {
      briefing?.finish()
    }

    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat) return
      if (e.key === 'Escape') {
        e.preventDefault()
        finish('menu')
        return
      }
      skipBriefing()
    }

    restart.addEventListener('click', () => finish('restart'))
    endless?.addEventListener('click', () => finish('endless'))
    menu.addEventListener('click', () => finish('menu'))
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', skipBriefing, true)
    parent.appendChild(root)
    releaseFocusTrap = trapFocus(root)
    // 포커스를 먼저 준다. 브리핑이 끝나기를 기다리지 않으므로 키보드
    // 사용자는 첫 프레임부터 Enter로 재도전할 수 있다.
    ;(endless ?? restart).focus()
    briefing = runBriefing(panel)
  })
}
