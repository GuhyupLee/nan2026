import { InputState, applyPointerMove } from './input.ts'
import { Renderer } from './render/renderer.ts'
import { ARENA_RADIUS, DT, MAX_TICKS_PER_FRAME } from './sim/constants.ts'
import { createInput } from './sim/types.ts'
import type { PlayerClass, World } from './sim/types.ts'
import { createWorld, drainEvents, resolveLevelUp, stepWorld } from './sim/world.ts'
import { BossBar } from './ui/bossbar.ts'
import { showCharacterSelect } from './ui/charselect.ts'
import { Hud } from './ui/hud.ts'
import { showLevelUp } from './ui/levelup.ts'
import { showOutcome } from './ui/outcome.ts'
import { DEFAULT_SLOTS, SkillBar, assertSlotsCoverAllSkills } from './ui/skillbar.ts'
import './ui/ui.css'

const app = document.getElementById('app')!
const bootEl = document.getElementById('boot')!
const hint = document.getElementById('hint')!
const statsEl = document.getElementById('stats')!

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

const seed = resolveSeed()
const input = new InputState(app)
const simInput = createInput()

if (import.meta.env.DEV) assertSlotsCoverAllSkills(DEFAULT_SLOTS)
// 스킬바는 body에 붙인다. 캔버스 컨테이너 밖이어야 슬롯 클릭이
// 이동 입력으로 새어 들어가지 않는다.
const skillBar = new SkillBar(document.body, DEFAULT_SLOTS, (id) => input.pressSkill(id))
skillBar.setVisible(false)

const hud = new Hud(document.body)
const bossBar = new BossBar(document.body)
const project = renderer.worldToScreen.bind(renderer)

/**
 * 레벨업 카드가 떠 있는 동안 중복 호출을 막는다.
 * awaitingChoice는 선택을 처리할 때까지 계속 true이므로
 * 이 플래그가 없으면 매 프레임 새 카드 화면이 쌓인다.
 */
let choiceOpen = false

/** 결과 화면이 매 프레임 중복으로 쌓이지 않게 막는다. */
let outcomeOpen = false

/**
 * 캐릭터 선택 중에도 렌더 루프는 돈다 — 셰이더 컴파일과 첫 프레임 비용을
 * 선택 화면 뒤에서 미리 치러야 "고르자마자 즉시 시작"이 된다.
 * 대신 running이 false인 동안 시뮬은 한 틱도 진행하지 않는다.
 */
let world: World = createWorld(seed)
let running = false

let accumulator = 0
let lastTime = performance.now()

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
    accumulator += Math.min(rawDt, DT * MAX_TICKS_PER_FRAME)

    let ticks = 0
    while (accumulator >= DT && ticks < MAX_TICKS_PER_FRAME) {
      input.sample(simInput)
      // 조준점(월드 좌표)을 먼저 구해야 포인터 이동 방향을 계산할 수 있다.
      renderer.screenToGround(input.pointerX, input.pointerY, simInput.aim)
      applyPointerMove(input, simInput, world.player.pos)
      stepWorld(world, simInput)
      accumulator -= DT
      ticks += 1
    }
  } else {
    accumulator = 0
  }

  renderer.render(world, accumulator / DT)
  skillBar.update(world.skills, world.playerClass)
  hud.update(world, project, Math.min(rawDt, 0.1))
  bossBar.update(world)
  // 렌더러가 사망·예광선 이벤트를 소비했으므로 비운다.
  drainEvents(world)

  // 결과는 레벨업보다 먼저 처리한다. 같은 틱에 사망과 XP 획득이 겹쳐도
  // 레벨업 카드가 결과 화면 위에 뜨면 안 된다.
  if (running && world.outcome !== 'alive' && !outcomeOpen) {
    running = false
    outcomeOpen = true
    choiceOpen = false
    accumulator = 0
    input.pointerHeld = false
    hint.classList.add('hidden')
    skillBar.setVisible(false)
    hud.setVisible(false)
    bossBar.setVisible(false)

    const result = world.outcome
    const restartClass = world.playerClass
    void showOutcome(document.body, result).then((action) => {
      if (action === 'restart') {
        beginRun(restartClass)
      } else {
        void start()
      }
    })
  }

  // 레벨업 카드. 시뮬은 awaitingChoice 동안 한 틱도 진행하지 않으므로
  // 여기서 화면을 띄우지 않으면 게임이 영영 멈춘다.
  if (running && world.outcome === 'alive' && world.awaitingChoice && !choiceOpen) {
    choiceOpen = true
    const target = world
    void showLevelUp(document.body, target).then(() => {
      resolveLevelUp(target)
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

/** 선택된 캐릭터와 고정 시드로 새 판을 즉시 시작한다. */
function beginRun(playerClass: PlayerClass): void {
  running = false
  world = createWorld(seed, playerClass)
  choiceOpen = false
  outcomeOpen = false

  // 직전 판의 포인터·1틱 입력·안내 상태가 새 판으로 넘어가지 않게 한다.
  input.pointerHeld = false
  input.hasActed = false
  simInput.move.x = 0
  simInput.move.y = 0
  simInput.aim.x = 1
  simInput.aim.y = 0
  simInput.skillsPressed = 0

  // 숨겨진 동안 새 월드 상태를 먼저 반영해 낡은 쿨다운·체력바가 비치지 않게 한다.
  skillBar.update(world.skills, world.playerClass)
  hud.update(world, project, 0)
  bossBar.update(world)
  skillBar.setVisible(true)
  hud.setVisible(true)
  bossBar.setVisible(true)
  hint.classList.remove('hidden')

  // 결과 화면에 머문 시간이 새 판의 첫 프레임과 FPS 통계에 섞이지 않게 한다.
  lastTime = performance.now()
  accumulator = 0
  fpsAccum = 0
  fpsFrames = 0
  statsTimer = 0.25
  fps = 0
  running = true
}

/** 첫 프레임이 나온 뒤 캐릭터 선택을 띄우고, 고르면 판을 시작한다. */
async function start(): Promise<void> {
  const playerClass = await showCharacterSelect(document.body)
  beginRun(playerClass)
}

// 선택 화면은 첫 프레임을 기다리지 않는다. 렌더러는 이미 생성되어 있고,
// rAF에 물려두면 탭이 백그라운드에 있거나 프레임이 지연될 때
// 심사자가 로딩 화면에 갇힌다. 렌더 루프는 선택 화면 뒤에서 돌며
// 셰이더 컴파일 비용을 미리 치른다.
bootEl.classList.add('hidden')
void start()
requestAnimationFrame(frame)
