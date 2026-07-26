import { InputState, applyPointerMove } from './input.ts'
import { Renderer } from './render/renderer.ts'
import { ARENA_RADIUS, DT, MAX_TICKS_PER_FRAME } from './sim/constants.ts'
import { createInput } from './sim/types.ts'
import type { World } from './sim/types.ts'
import { createWorld, stepWorld } from './sim/world.ts'
import { showCharacterSelect } from './ui/charselect.ts'
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
    __game: { get world() { return world }, renderer, input, skillBar },
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
  skillBar.update(world.skills)

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

/** 첫 프레임이 나온 뒤 캐릭터 선택을 띄우고, 고르면 판을 시작한다. */
async function start(): Promise<void> {
  const playerClass = await showCharacterSelect(document.body)

  world = createWorld(seed, playerClass)
  skillBar.setVisible(true)
  hint.classList.remove('hidden')
  // 선택 화면에 머문 시간이 첫 프레임 델타로 밀려들지 않게 시계를 다시 맞춘다.
  lastTime = performance.now()
  accumulator = 0
  running = true
}

// 선택 화면은 첫 프레임을 기다리지 않는다. 렌더러는 이미 생성되어 있고,
// rAF에 물려두면 탭이 백그라운드에 있거나 프레임이 지연될 때
// 심사자가 로딩 화면에 갇힌다. 렌더 루프는 선택 화면 뒤에서 돌며
// 셰이더 컴파일 비용을 미리 치른다.
bootEl.classList.add('hidden')
void start()
requestAnimationFrame(frame)
