import { InputState } from './input.ts'
import { Renderer } from './render/renderer.ts'
import { ARENA_RADIUS, DT, MAX_TICKS_PER_FRAME } from './sim/constants.ts'
import { createInput } from './sim/types.ts'
import { createWorld, stepWorld } from './sim/world.ts'

const app = document.getElementById('app')!
const boot = document.getElementById('boot')!
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
  boot.innerHTML = `
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

const world = createWorld(resolveSeed())
const input = new InputState()
const simInput = createInput()

// 개발 중에만 콘솔에서 상태를 들여다보고 프레임을 강제로 돌릴 수 있게 열어둔다.
// 프로덕션 번들에는 포함되지 않는다.
if (import.meta.env.DEV) {
  Object.assign(window, { __game: { world, renderer, input } })
}

let accumulator = 0
let lastTime = performance.now()
let booted = false

// 스탯 표시용
let fpsAccum = 0
let fpsFrames = 0
let statsTimer = 0
let fps = 0

function frame(now: number): void {
  requestAnimationFrame(frame)

  const rawDt = (now - lastTime) / 1000
  lastTime = now

  // 탭이 백그라운드에 있다 돌아오면 rawDt가 수 초가 된다.
  // 그대로 누적하면 수백 틱을 한 프레임에 밀어넣어 멈춘 것처럼 보인다.
  accumulator += Math.min(rawDt, DT * MAX_TICKS_PER_FRAME)

  let ticks = 0
  while (accumulator >= DT && ticks < MAX_TICKS_PER_FRAME) {
    input.sample(simInput)
    renderer.screenToGround(input.mouseX, input.mouseY, simInput.aim)
    stepWorld(world, simInput)
    accumulator -= DT
    ticks += 1
  }

  renderer.render(world, accumulator / DT)

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

  if (!booted) {
    booted = true
    boot.classList.add('hidden')
  }
  if (input.hasMoved) {
    hint.classList.add('hidden')
  }
}

requestAnimationFrame(frame)
