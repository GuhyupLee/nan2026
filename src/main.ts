import { GameAudio } from './audio.ts'
import { getClassSkills } from './content/skills.ts'
import { applyUpgrade } from './content/upgrades.ts'
import { InputState, applyPointerMove } from './input.ts'
import { Renderer } from './render/renderer.ts'
import {
  ensureVrm,
  getVrmLoadProgress,
  preloadVrm,
  shouldUseVrmModels,
} from './render/vrm-rig.ts'
import { ARENA_RADIUS, DT, MAX_TICKS_PER_FRAME } from './sim/constants.ts'
import { BOSS_PHASE_TWO_THRESHOLD } from './sim/boss.ts'
import { BOSS_SPAWN_TIME, spawnBoss } from './sim/enemies.ts'
import {
  BATTLEFIELD_MAGNET_DURATION,
  dropBattlefieldPickup,
  PICKUP_BOMB,
  PICKUP_HEAL,
  PICKUP_MAGNET,
} from './sim/battlefield-pickups.ts'
import { SURGE_BEATS, SURGE_WARNING_DURATION } from './sim/surges.ts'
import { MAX_LEVEL } from './sim/progression.ts'
import { rankUpSkill, unlockSkill } from './sim/skills.ts'
import { createInput } from './sim/types.ts'
import type { PlayerClass, RunConfig, World } from './sim/types.ts'
import {
  createWorld,
  continueIntoEndless,
  drainEvents,
  resolveLevelUp,
  resolveRewardChoice,
  stepWorld,
} from './sim/world.ts'
import { BossBar } from './ui/bossbar.ts'
import { showCharacterSelect } from './ui/charselect.ts'
import { Hud } from './ui/hud.ts'
import { showLevelUp } from './ui/levelup.ts'
import { showMainMenu } from './ui/mainmenu.ts'
import {
  createRunMetaSnapshot,
  isHardModeUnlocked,
  loadMetaProgress,
} from './ui/meta-progression.ts'
import { showMetaProgress } from './ui/meta.ts'
import { showOutcome } from './ui/outcome.ts'
import { PauseButton, showPause, showSettings } from './ui/pause.ts'
import { showRecords } from './ui/record-viewer.ts'
import { DEFAULT_SLOTS, SkillBar, assertSlotsCoverAllSkills } from './ui/skillbar.ts'
import './ui/fonts.generated.css'
import './ui/ui.css'

const app = document.getElementById('app')!
const bootEl = document.getElementById('boot')!
const hint = document.getElementById('hint')!
const statsEl = document.getElementById('stats')!
const coarsePointer = window.matchMedia('(pointer: coarse)').matches
const useVrmModels = shouldUseVrmModels()

// 성능 계측은 개발 빌드에서만 보인다. 상용 HUD와 같은 좌상단을 차지하지 않는다.
statsEl.hidden = !import.meta.env.DEV

if (coarsePointer) {
  hint.textContent = '전장을 밀어 이동 · 스킬 버튼 터치'
}

/**
 * 시드는 URL 파라미터로 고정할 수 있다 (?seed=42).
 * 시뮬 자체는 시드가 같으면 항상 같은 결과를 낸다 — 버그 재현과
 * 헤드리스 밸런싱이 여기에 의존한다.
 */
function resolveSeed(): number {
  const raw = new URLSearchParams(location.search).get('seed')
  if (raw !== null) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n)) return n >>> 0
  }
  return (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0
}

function fail(message: string): void {
  bootEl.innerHTML = `
    <h1>실행할 수 없습니다</h1>
    <p style="max-width:32rem;text-align:center;line-height:1.7">${message}</p>
  `
}

let renderer: Renderer
try {
  renderer = new Renderer(app, ARENA_RADIUS)
} catch (err) {
  console.error(err)
  fail(
    'WebGL을 초기화하지 못했습니다. 최신 Chrome 또는 Edge에서 열어 주세요. ' +
      '브라우저 설정에서 하드웨어 가속이 꺼져 있으면 켜야 합니다.',
  )
  throw err
}

const initialSeed = resolveSeed()
const input = new InputState(app)
const simInput = createInput()

if (import.meta.env.DEV) assertSlotsCoverAllSkills(DEFAULT_SLOTS)
// 스킬바는 body에 붙인다. 캔버스 컨테이너 밖이어야 슬롯 클릭이
// 이동 입력으로 새어 들어가지 않는다.
const skillBar = new SkillBar(document.body, DEFAULT_SLOTS, {
  start: (id) => input.startSkill(id),
  release: (id) => input.releaseSkill(id),
  cancel: (id) => input.cancelSkill(id),
})
skillBar.setVisible(false)

function releaseGameplayInput(): void {
  input.releaseMovement()
  skillBar.cancelTargeting()
}

const hud = new Hud(document.body)
const bossBar = new BossBar(document.body)
const audio = new GameAudio()
const pauseButton = new PauseButton(document.body, () => {
  void pauseRun()
})
pauseButton.setVisible(false)
const project = renderer.worldToScreen.bind(renderer)

/**
 * 레벨업 카드가 떠 있는 동안 중복 호출을 막는다.
 * awaitingChoice는 선택을 처리할 때까지 계속 true이므로
 * 이 플래그가 없으면 매 프레임 새 카드 화면이 쌓인다.
 */
let choiceOpen = false

/** 결과 화면이 매 프레임 중복으로 쌓이지 않게 막는다. */
let outcomeOpen = false
type FinalOutcome = Exclude<World['outcome'], 'alive'>

interface OutcomeTransition {
  readonly runId: number
  readonly world: World
  readonly result: FinalOutcome
  readonly restartClass: PlayerClass
  revealAt: number
  hiddenAt: number | null
}

const OUTCOME_REVEAL_DELAY_MS = 900
const REDUCED_MOTION_OUTCOME_REVEAL_DELAY_MS = 280
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let runId = 0
let outcomeTransition: OutcomeTransition | null = null
let pauseOpen = false
let activeRun = false

/**
 * 캐릭터 선택 중에도 렌더 루프는 돈다 — 셰이더 컴파일과 첫 프레임 비용을
 * 선택 화면 뒤에서 미리 치러야 "고르자마자 즉시 시작"이 된다.
 * 대신 running이 false인 동안 시뮬은 한 틱도 진행하지 않는다.
 */
let world: World = createWorld(initialSeed)
let running = false

let accumulator = 0
let lastTime = performance.now()

/** 불투명 메뉴 뒤에서만 두 프레임을 그려 scene/post 셰이더와 렌더 타겟을 예열한다. */
const MENU_WARMUP_FRAMES = 2
let menuWarmupFramesLeft = 0

function requestMenuWarmup(): void {
  menuWarmupFramesLeft = Math.max(menuWarmupFramesLeft, MENU_WARMUP_FRAMES)
}

/**
 * 결말 판정은 고정 틱에서 이미 끝났다. 이후에는 시뮬·입력·HUD만 즉시 잠그고,
 * 보스 사망 플래시·히트스톱·카메라 셰이크 같은 실시간 렌더 효과만 마무리한다.
 */
function beginOutcomeTransition(now: number, revealDelayOverride?: number): void {
  if (
    !running ||
    world.outcome === 'alive' ||
    outcomeTransition !== null ||
    outcomeOpen
  ) {
    return
  }

  const revealDelay =
    revealDelayOverride ??
    (reducedMotion.matches
      ? REDUCED_MOTION_OUTCOME_REVEAL_DELAY_MS
      : OUTCOME_REVEAL_DELAY_MS)

  running = false
  outcomeTransition = {
    runId,
    world,
    result: world.outcome,
    restartClass: world.playerClass,
    revealAt: now + revealDelay,
    hiddenAt: document.hidden ? now : null,
  }
  choiceOpen = false
  pauseOpen = false
  accumulator = 0
  releaseGameplayInput()
  hint.classList.add('hidden')
  skillBar.setVisible(false)
  hud.setVisible(false)
  bossBar.setVisible(false)
  pauseButton.setVisible(false)
}

/**
 * 결과창은 전환을 시작한 동일한 런에 한 번만 연다.
 * 오래된 Promise가 재시작된 월드를 다시 덮지 못하도록 runId와 World 참조를 함께 본다.
 */
function revealOutcome(now: number): void {
  const transition = outcomeTransition
  if (
    transition === null ||
    transition.hiddenAt !== null ||
    now < transition.revealAt
  ) {
    return
  }

  if (
    transition.runId !== runId ||
    transition.world !== world ||
    world.outcome === 'alive' ||
    !activeRun
  ) {
    outcomeTransition = null
    return
  }

  outcomeTransition = null
  activeRun = false
  outcomeOpen = true

  void showOutcome(
    document.body,
    transition.result,
    transition.world,
  ).then((action) => {
    if (
      !outcomeOpen ||
      transition.runId !== runId ||
      transition.world !== world
    ) {
      return
    }

    outcomeOpen = false
    if (action === 'endless' && continueIntoEndless(transition.world)) {
      activeRun = true
      running = true
      skillBar.setVisible(true)
      hud.setVisible(true)
      bossBar.setVisible(false)
      pauseButton.setVisible(true)
      lastTime = performance.now()
      accumulator = 0
      releaseGameplayInput()
    } else if (action === 'restart') {
      // 결과를 만든 정확한 시드와 클래스를 다시 넘긴다. 메뉴의 새 판 정책이
      // 달라져도 SAME SEED 재도전 계약은 이 경로에서 유지된다.
      beginRun(
        transition.restartClass,
        transition.world.seed,
        transition.world.runConfig,
      )
    } else {
      void start()
    }
  })
}

// 스탯 표시용
let fpsAccum = 0
let fpsFrames = 0
let statsTimer = 0
let fps = 0

if (import.meta.env.DEV) {
  Object.assign(window, {
    __game: {
      get world() {
        return world
      },
      renderer,
      input,
      skillBar,
      bossBar,
      audio,
      // rAF가 멈춘 환경(백그라운드 탭)에서도 시뮬을 손으로 돌려
      // 렌더 결과를 검증할 수 있게 열어둔다.
      stepWorld,
      createInput,
      createWorld,
      drainEvents,
      hud,
      project,
      showLevelUp,
      resolveLevelUp,
      resolveRewardChoice,
      setWorld(w: World) {
        world = w
      },
    },
  })
}

function frame(now: number): void {
  requestAnimationFrame(frame)

  const rawDt = (now - lastTime) / 1000
  lastTime = now

  if (running) {
    // 탭이 백그라운드에 있다 돌아오면 rawDt가 수 초가 된다.
    // 그대로 누적하면 수백 틱을 한 프레임에 밀어넣어 멈춘 것처럼 보인다.
    //
    // 히트스톱은 시뮬을 멈추지 않고 **누적되는 시간에 배율만 건다**. 큰 타격
    // 순간 틱이 덜 도는 형태라 고정 DT 결정론이 그대로 유지된다 —
    // 헤드리스 밸런싱과 sim-check는 stepWorld를 직접 돌리므로 영향이 없다.
    accumulator += Math.min(rawDt, DT * MAX_TICKS_PER_FRAME) * renderer.simTimeScale

    let ticks = 0
    while (accumulator >= DT && ticks < MAX_TICKS_PER_FRAME) {
      input.sample(simInput)
      // 조준점(월드 좌표)을 먼저 구해야 포인터 이동 방향을 계산할 수 있다.
      renderer.screenToGround(input.pointerX, input.pointerY, simInput.aim)
      applyPointerMove(input, simInput, world.player.pos)
      stepWorld(world, simInput)
      accumulator -= DT
      ticks += 1
      if (world.outcome !== 'alive') {
        beginOutcomeTransition(now)
        break
      }
    }
  } else {
    accumulator = 0
  }

  // 외부 QA 훅 등으로 틱 사이에 outcome이 바뀐 경우도 같은 경로로 잠근다.
  if (running && world.outcome !== 'alive') beginOutcomeTransition(now)

  // 결말 전환은 accumulator를 비운 뒤에도 마지막 고정 틱의 정확한 착지 포즈를
  // 보여줘야 한다. 평상시에는 기존의 한 틱 지연 보간을 그대로 유지한다.
  const renderAlpha = outcomeTransition === null ? accumulator / DT : 1
  renderer.setTargeting(
    world,
    activeRun && running && !world.awaitingChoice ? input.targetingSkill : null,
    renderAlpha,
  )

  // 전면 불투명 오버레이 뒤에서는 평상시 3D를 쉬되, 메뉴·캐릭터 선택에 들어간
  // 직후 두 프레임만 실제 렌더한다. 첫 전투 프레임에서 scene/post 셰이더 컴파일과
  // 렌더 타겟 할당이 한꺼번에 튀는 일을 막고, 이후에는 다시 0 draw로 돌아간다.
  // 일시정지·레벨업은 activeRun=true인 반투명 오버레이라 계속 그린다.
  const warmingMenu = !activeRun && menuWarmupFramesLeft > 0
  if (activeRun || warmingMenu) {
    renderer.render(world, renderAlpha)
    if (warmingMenu) menuWarmupFramesLeft -= 1
  }
  skillBar.update(world.skills, world.playerClass, world)
  hud.update(world, project, Math.min(rawDt, 0.1))
  bossBar.update(world)
  // 렌더 전용 전투 이벤트를 비우기 전에 사운드도 같은 이벤트를 읽는다.
  audio.update(world)
  // 렌더러가 사망·예광선 이벤트를 소비했으므로 비운다.
  drainEvents(world)

  // 결과는 레벨업보다 먼저 처리한다. 같은 틱에 사망과 XP 획득이 겹쳐도
  // 레벨업 카드가 결과 화면 위에 뜨면 안 된다.
  revealOutcome(now)

  // 레벨업 카드. 시뮬은 awaitingChoice 동안 한 틱도 진행하지 않으므로
  // 여기서 화면을 띄우지 않으면 게임이 영영 멈춘다.
  if (running && world.outcome === 'alive' && world.awaitingChoice && !choiceOpen) {
    choiceOpen = true
    releaseGameplayInput()
    const target = world
    void showLevelUp(document.body, target).then(() => {
      audio.ui('select')
      releaseGameplayInput()
      resolveRewardChoice(target)
      choiceOpen = false
      // 카드를 읽던 시간이 다음 프레임 델타로 밀려들지 않게 시계를 다시 맞춘다.
      lastTime = performance.now()
      accumulator = 0
    })
  }

  // --- HUD ---
  if (rawDt > 0) {
    fpsAccum += 1 / rawDt
    fpsFrames += 1
  }
  statsTimer += rawDt
  if (statsTimer >= 0.25) {
    fps = fpsFrames > 0 ? fpsAccum / fpsFrames : 0
    fpsAccum = 0
    fpsFrames = 0
    statsTimer = 0
    const t = world.time
    const mm = Math.floor(t / 60)
    const ss = (t % 60).toFixed(1).padStart(4, '0')
    statsEl.textContent =
      `${mm}:${ss}  ·  ${fps.toFixed(0)} FPS  ·  ` +
      `${renderer.drawCalls} draws  ·  seed ${world.seed}`
  }

  if (input.hasActed) hint.classList.add('hidden')
}

/** 진행 중인 판을 멈추고 일시정지 메뉴를 연다. */
async function pauseRun(): Promise<void> {
  if (
    !activeRun ||
    !running ||
    pauseOpen ||
    choiceOpen ||
    outcomeOpen ||
    world.outcome !== 'alive'
  ) {
    return
  }

  running = false
  pauseOpen = true
  accumulator = 0
  releaseGameplayInput()
  pauseButton.setVisible(false)
  // 일부 WebView는 AudioContext.resume()을 오래 보류한다. 오디오는 best-effort로 열고
  // 일시정지 UI와 시뮬레이션 상태 전환은 절대 그 Promise를 기다리지 않는다.
  void audio.unlock()
  audio.ui('pause')

  const action = await showPause(document.body, audio, input)
  pauseOpen = false

  if (action === 'menu') {
    activeRun = false
    hint.classList.add('hidden')
    skillBar.setVisible(false)
    hud.setVisible(false)
    bossBar.setVisible(false)
    pauseButton.setVisible(false)
    void start()
    return
  }

  if (!activeRun || world.outcome !== 'alive') return
  void audio.unlock()
  lastTime = performance.now()
  accumulator = 0
  releaseGameplayInput()
  pauseButton.setVisible(true)
  running = true
}

/** 선택된 캐릭터와 명시한 시드로 새 판을 즉시 시작한다. */
function beginRun(
  playerClass: PlayerClass,
  runSeed = initialSeed,
  runConfig?: Partial<RunConfig>,
): void {
  runId += 1
  running = false
  activeRun = true
  menuWarmupFramesLeft = 0
  outcomeTransition = null
  world = createWorld(runSeed, playerClass, runConfig)
  choiceOpen = false
  outcomeOpen = false
  pauseOpen = false
  audio.reset()
  void audio.unlock()

  // 직전 판의 포인터·1틱 입력·안내 상태가 새 판으로 넘어가지 않게 한다.
  releaseGameplayInput()
  input.hasActed = false
  simInput.move.x = 0
  simInput.move.y = 0
  simInput.aim.x = 1
  simInput.aim.y = 0
  simInput.skillsPressed = 0

  // 숨겨진 동안 새 월드 상태를 먼저 반영해 낡은 쿨다운·체력바가 비치지 않게 한다.
  skillBar.update(world.skills, world.playerClass, world)
  hud.update(world, project, 0)
  bossBar.update(world)
  skillBar.setVisible(true)
  hud.setVisible(true)
  bossBar.setVisible(true)
  pauseButton.setVisible(true)
  hint.classList.remove('hidden')

  // 결과 화면에 머문 시간이 새 판의 첫 프레임과 FPS 통계에 섞이지 않게 한다.
  lastTime = performance.now()
  accumulator = 0
  fpsAccum = 0
  fpsFrames = 0
  statsTimer = 0.25
  fps = 0
  let revealQaOutcome = false
  if (import.meta.env.DEV) {
    const qa = new URLSearchParams(window.location.search).get('qa')
    if (qa === 'relic') {
      world.pendingRelicChoices = 1
      world.relicsClaimed = 1
      world.awaitingChoice = true
    } else if (qa === 'boss' || qa === 'boss-p2') {
      // P1은 등장부터 돌진선, P2는 첫 평타부터 전환·예측 장판을 검수한다.
      // 프로덕션 빌드에서는 이 분기 전체가 제거된다.
      world.tick = Math.round(BOSS_SPAWN_TIME / DT)
      world.time = world.tick * DT
      world.spawnEnabled = false
      if (spawnBoss(world.enemies, world.rng, world.player.pos.x, world.player.pos.y)) {
        const boss = world.enemies.count - 1
        const bossX =
          qa === 'boss-p2' && world.playerClass === 'melee' ? 2.6 : 8
        world.enemies.x[boss] = bossX
        world.enemies.y[boss] = 0
        world.enemies.prevX[boss] = bossX
        world.enemies.prevY[boss] = 0
        world.boss.spawned = true
        world.boss.spawnedAt = world.time
        world.boss.active = true
        if (qa === 'boss-p2') {
          const readyHp = BOSS_PHASE_TWO_THRESHOLD + 1
          world.enemies.hp[boss] = readyHp
          world.boss.hp = readyHp
          world.player.invulnUntil = Number.POSITIVE_INFINITY
          world.lastAim.x = bossX
          world.lastAim.y = 0
        } else {
          world.boss.hp = world.boss.maxHp
        }
      }
    } else if (qa === 'outcome') {
      // 대표 완성 빌드로 결과 화면을 즉시 연다. DEV 상수와 함께 프로덕션
      // 번들에서 제거되며 데스크톱·모바일 결과 UI를 반복 검수할 때 쓴다.
      const targetRanks = { q: 4, w: 3, e: 2, r: 1 } as const
      for (const skill of getClassSkills(world.playerClass)) {
        unlockSkill(world.skills, skill.id, skill.cooldown)
        const targetRank =
          targetRanks[skill.id as keyof typeof targetRanks] ?? 0
        for (let rank = 0; rank < targetRank; rank += 1) {
          rankUpSkill(world.skills, skill.id)
        }
      }

      const recipe =
        world.playerClass === 'ranged'
          ? ['orbit-lens', 'gravity-prism', 'singularity-interferometer']
          : ['iai-scroll', 'fullmoon-form', 'eclipse-sword-codex']
      for (const id of recipe.slice(0, 2)) {
        for (let rank = 0; rank < 3; rank += 1) applyUpgrade(world, id)
      }
      applyUpgrade(world, recipe[2]!)

      world.tick = Math.round(247.4 / DT)
      world.time = world.tick * DT
      world.kills = 318
      world.progression.level = 26
      world.relicsClaimed = 3
      world.outcome = 'victory'
      revealQaOutcome = true
    } else if (qa === 'pickups') {
      // 세 픽업의 월드 실루엣과 자석 지속 HUD를 한 화면에서 검수한다.
      // 프로덕션 빌드에서는 이 분기 전체가 제거된다.
      world.spawnEnabled = false
      const { x, y } = world.player.pos
      dropBattlefieldPickup(
        world.battlefieldPickups,
        x - 3,
        y - 1.2,
        PICKUP_HEAL,
        world.time,
      )
      dropBattlefieldPickup(
        world.battlefieldPickups,
        x,
        y - 3.4,
        PICKUP_MAGNET,
        world.time,
      )
      dropBattlefieldPickup(
        world.battlefieldPickups,
        x + 3,
        y - 1.2,
        PICKUP_BOMB,
        world.time,
      )
      world.battlefieldPickups.magnetUntil =
        world.time + BATTLEFIELD_MAGNET_DURATION
      world.battlefieldPickups.magnetActivations = 1
    } else if (
      qa === 'surge' ||
      qa === 'surge-2' ||
      qa === 'surge-3'
    ) {
      // 선택한 급습 3초 전부터 예고 HUD·지면 링·실제 편대 진입을 검수한다.
      // 프로덕션 빌드에서는 이 분기 전체가 제거된다.
      const surgeIndex = qa === 'surge-2' ? 1 : qa === 'surge-3' ? 2 : 0
      const previewAt =
        SURGE_BEATS[surgeIndex]!.at - SURGE_WARNING_DURATION
      world.tick = Math.round(previewAt / DT)
      world.time = world.tick * DT
      world.player.invulnUntil = Number.POSITIVE_INFINITY
      world.progression.level = MAX_LEVEL
      world.surgeBeatIndex = surgeIndex
      world.surgeWarningIndex = surgeIndex
    }
  }
  running = true
  if (revealQaOutcome) {
    const now = performance.now()
    beginOutcomeTransition(now, 0)
  }
}

/** 첫 프레임이 나온 뒤 캐릭터 선택을 띄우고, 고르면 판을 시작한다. */
async function start(): Promise<void> {
  runId += 1
  outcomeTransition = null
  outcomeOpen = false
  activeRun = false
  pauseButton.setVisible(false)
  requestMenuWarmup()
  let metaProgress = loadMetaProgress()
  const difficulty = await showMainMenu(
    document.body,
    () => showSettings(document.body, audio, input),
    () => showRecords(document.body),
    async () => {
      metaProgress = await showMetaProgress(document.body)
      return { moonlight: metaProgress.moonlight }
    },
    metaProgress.moonlight,
    isHardModeUnlocked(metaProgress),
  )
  // 일부 WebView는 AudioContext.resume() Promise를 사용자 제스처가 끝난 뒤에도
  // 오래 보류한다. 사운드는 best-effort 기능이므로 화면 전환을 막지 않는다.
  void audio.unlock()
  audio.ui('select')
  requestMenuWarmup()
  const playerClass = await showCharacterSelect(
    document.body,
    undefined,
    () => showSettings(document.body, audio, input),
    useVrmModels ? preloadVrm : undefined,
  )
  void audio.unlock()
  audio.ui('select')

  // 아직 안 받았으면 여기서 기다린다. 실패해도 false가 올 뿐이고,
  // createCharacterRig가 프로시저럴 모델로 폴백하므로 판은 그대로 시작된다.
  if (
    useVrmModels &&
    !(await withLoadingScreen(ensureVrm(playerClass), () =>
      getVrmLoadProgress(playerClass),
    ))
  ) {
    console.warn('[vrm] 모델을 못 받아 프로시저럴 캐릭터로 시작합니다')
  }

  // 메뉴에서 구매한 내용까지 다시 읽고 작은 불변 스냅샷으로 런에 고정한다.
  metaProgress = loadMetaProgress()
  beginRun(playerClass, initialSeed, {
    meta: createRunMetaSnapshot(metaProgress),
    difficulty,
  })
}

/**
 * 약속이 200ms 안에 끝나면 아무것도 띄우지 않는다.
 * 캐시가 살아 있는 두 번째 실행에서 로딩 화면이 깜빡이는 것이 더 나쁘다.
 *
 * @param progress 0..1 진행률 게터. 있으면 부정형 슬라이드 대신 실제 바를 채운다 —
 *                 20MB급 모델을 기다리는 화면에서 "멈췄나?"라는 의심을 없앤다.
 */
async function withLoadingScreen<T>(
  promise: Promise<T>,
  progress?: () => number,
): Promise<T> {
  let shown = false
  let progressTimer = 0
  const timer = window.setTimeout(() => {
    shown = true
    bootEl.innerHTML =
      '<h1>캐릭터를 불러오는 중…</h1>' +
      '<div class="bar"></div>' +
      (progress ? '<p data-loading-pct hidden></p>' : '')
    bootEl.classList.remove('hidden')
    bootEl.removeAttribute('aria-hidden')

    if (progress) {
      const bar = bootEl.querySelector<HTMLElement>('.bar')!
      const pct = bootEl.querySelector<HTMLElement>('[data-loading-pct]')!
      progressTimer = window.setInterval(() => {
        const value = Math.round(Math.max(0, Math.min(1, progress())) * 100)
        // Content-Length가 없는 서버에서는 진행률이 영영 0이다. 그때는
        // 부정형 슬라이드를 유지하는 편이 "0%에 얼어붙은 바"보다 낫다.
        if (value <= 0) return
        bar.dataset.progress = ''
        pct.hidden = false
        bar.style.setProperty('--progress', `${value}%`)
        pct.textContent = `${value}%`
      }, 120)
    }
  }, 200)
  try {
    return await promise
  } finally {
    window.clearTimeout(timer)
    if (progressTimer) window.clearInterval(progressTimer)
    if (shown) {
      bootEl.classList.add('hidden')
      bootEl.setAttribute('aria-hidden', 'true')
    }
  }
}

// 브라우저의 사용자 제스처 정책을 만족시키기 위해 첫 입력에서 오디오를 연다.
const unlockAudio = (): void => {
  void audio.unlock()
}
window.addEventListener('pointerdown', unlockAudio, { capture: true, once: true })
window.addEventListener('keydown', unlockAudio, { capture: true, once: true })

window.addEventListener('keydown', (event) => {
  if (event.code !== 'Escape' || event.repeat) return
  if (!activeRun || !running || pauseOpen || choiceOpen || outcomeOpen) return
  event.preventDefault()
  void pauseRun()
})

// 모바일에서 앱을 내렸다 돌아왔을 때 전투가 진행돼 있지 않게 한다.
document.addEventListener('visibilitychange', () => {
  const transition = outcomeTransition
  if (transition !== null) {
    const now = performance.now()
    if (document.hidden) {
      transition.hiddenAt ??= now
    } else if (transition.hiddenAt !== null) {
      transition.revealAt += now - transition.hiddenAt
      transition.hiddenAt = null
      lastTime = now
    }
    return
  }

  if (document.hidden && activeRun && running && !choiceOpen && !outcomeOpen) {
    void pauseRun()
  }
})

// 선택 화면은 첫 프레임을 기다리지 않는다. 렌더러는 이미 생성되어 있고,
// rAF에 물려두면 탭이 백그라운드에 있거나 프레임이 지연될 때
// 심사자가 로딩 화면에 갇힌다. 렌더 루프는 선택 화면 뒤에서 돌며
// 셰이더 컴파일 비용을 미리 치른다.
bootEl.classList.add('hidden')
bootEl.setAttribute('aria-hidden', 'true')
void start()
requestAnimationFrame(frame)
