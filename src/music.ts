import type { World } from './sim/types.ts'

/**
 * 적응형 배경음.
 *
 * 음원 파일이 0개다. 전부 WebAudio로 합성한다 — 라이선스 문제가 원천적으로
 * 없고, 무엇보다 **음악이 게임 상태를 따라간다.** 녹음된 트랙으로는
 * 못 하는 일이다.
 *
 * 5분 비트 시트에 맞춰 레이어가 쌓인다:
 *   0:00~  드론만. 적이 적고 조용하다.
 *   ~1:40  베이스가 들어온다. 압박이 시작된다.
 *   ~2:40  타악이 붙는다. 밀도가 오른다.
 *   ~3:20  아르페지오. 최대 밀도.
 *   3:30~  보스 모드 — 조성이 바뀌고 템포가 오른다.
 *
 * 음계는 마이너 펜타토닉이다. 반음이 없어 어떤 음을 겹쳐도 부딪히지 않으므로
 * 절차적 생성에 안전하고, 동아시아적 색채가 일현(日弦)·월아(月牙)의
 * 이름과도 맞는다.
 *
 * 스케줄링은 렌더 프레임에서 미리 앞당겨 예약한다(lookahead). setInterval로
 * 별도 타이머를 돌리면 탭이 백그라운드로 갈 때 어긋나고 정리할 것이 늘어난다.
 */

/** E 마이너 펜타토닉. 저음부터. */
const SCALE = [82.41, 98.0, 110.0, 123.47, 146.83, 164.81, 196.0, 220.0, 246.94, 293.66]
/** 보스 구간은 한 음 올린 프리지안 느낌으로 긴장을 준다. */
const BOSS_SCALE = [87.31, 92.5, 116.54, 138.59, 155.56, 174.61, 185.0, 233.08, 277.18, 311.13]

/** 몇 초 앞까지 미리 예약할 것인가. 프레임이 한두 번 걸러도 끊기지 않는 값. */
const LOOKAHEAD = 0.25

/** 아르페지오가 밟는 음 인덱스 패턴. */
const ARP_PATTERN = [0, 2, 4, 2, 5, 4, 2, 0]

export class GameMusic {
  private ctx: AudioContext | null = null
  private bus: GainNode | null = null

  /** 지속되는 드론. 시작할 때 한 번 만들고 게인만 움직인다. */
  private droneGain: GainNode | null = null
  private droneFilter: BiquadFilterNode | null = null
  private droneOsc: OscillatorNode[] = []

  private noiseBuffer: AudioBuffer | null = null

  /** 다음에 예약할 스텝의 시각(컨텍스트 시간). */
  private nextStepAt = 0
  private step = 0
  private running = false

  /** 0..1. 레이어 게이트와 필터를 움직인다. */
  private intensity = 0

  start(ctx: AudioContext, destination: AudioNode): void {
    if (this.running && this.ctx === ctx) return
    this.stop()

    this.ctx = ctx
    const bus = ctx.createGain()
    bus.gain.value = 1
    bus.connect(destination)
    this.bus = bus

    // --- 드론: 근음 + 5도. 필터가 강도에 따라 열린다 ---
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = 320
    filter.Q.value = 0.7
    filter.connect(bus)

    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(filter)

    for (const [freq, type, detune] of [
      [SCALE[0]!, 'sawtooth', -6],
      [SCALE[0]! * 1.5, 'triangle', 5],
      [SCALE[0]! * 2, 'sine', 0],
    ] as const) {
      const osc = ctx.createOscillator()
      osc.type = type
      osc.frequency.value = freq
      osc.detune.value = detune
      osc.connect(gain)
      osc.start()
      this.droneOsc.push(osc)
    }

    this.droneGain = gain
    this.droneFilter = filter
    this.noiseBuffer = makeNoise(ctx)

    this.nextStepAt = ctx.currentTime + 0.05
    this.step = 0
    this.running = true
  }

  stop(): void {
    for (const osc of this.droneOsc) {
      try {
        osc.stop()
      } catch {
        // 이미 멈춘 오실레이터는 무시한다.
      }
      osc.disconnect()
    }
    this.droneOsc = []
    this.droneGain?.disconnect()
    this.droneFilter?.disconnect()
    this.bus?.disconnect()
    this.droneGain = null
    this.droneFilter = null
    this.bus = null
    this.ctx = null
    this.running = false
    this.intensity = 0
  }

  /** 볼륨 0이면 아무것도 예약하지 않는다. */
  setVolume(v: number): void {
    if (!this.ctx || !this.bus) return
    this.bus.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.05)
  }

  /**
   * 매 프레임 호출한다. 상태를 읽어 강도를 갱신하고 앞당겨 예약한다.
   * 시뮬을 건드리지 않는다 — 읽기만 한다.
   */
  update(world: World | null): void {
    const ctx = this.ctx
    if (!this.running || !ctx || ctx.state !== 'running') return

    // --- 강도 산출 ---
    let target = 0
    let boss = false
    if (world && world.outcome === 'alive') {
      // 적 밀도가 주 동력이다. 화면이 차오르는 것과 음악이 같이 간다.
      const density = Math.min(1, world.enemies.count / 85)
      const timeRamp = Math.min(1, world.time / 200)
      target = Math.max(density, timeRamp * 0.75)
      boss = world.boss?.active === true
      if (boss) target = 1
    }
    // 급변을 막는다. 적이 한 번 쓸릴 때마다 음악이 툭툭 끊기면 안 된다.
    this.intensity += (target - this.intensity) * 0.02

    const now = ctx.currentTime
    const i = this.intensity

    // 판이 끝났으면 드론까지 내린다. 안 그러면 승리·패배 효과음이 웅웅거림에 묻힌다.
    const alive = world !== null && world.outcome === 'alive'
    const droneLevel = alive ? 0.035 + i * 0.05 : 0

    // 드론은 강도에 따라 커지고 필터가 열린다.
    this.droneGain?.gain.setTargetAtTime(droneLevel, now, alive ? 0.4 : 0.25)
    this.droneFilter?.frequency.setTargetAtTime(280 + i * 900, now, 0.5)

    // 끝난 판에서는 새 음을 예약하지 않는다.
    if (!alive) {
      this.nextStepAt = now + 0.05
      return
    }

    // --- 스텝 예약 ---
    const bpm = 96 + i * 30 + (boss ? 14 : 0)
    const stepDur = 60 / bpm / 2 // 8분음표

    while (this.nextStepAt < now + LOOKAHEAD) {
      this.scheduleStep(ctx, this.nextStepAt, this.step, i, boss)
      this.nextStepAt += stepDur
      this.step = (this.step + 1) % 32
    }

    // 프레임이 오래 멈췄다 돌아오면 과거를 몰아서 예약하게 된다. 현재로 당긴다.
    if (this.nextStepAt < now) this.nextStepAt = now + 0.02
  }

  private scheduleStep(
    ctx: AudioContext,
    at: number,
    step: number,
    i: number,
    boss: boolean,
  ): void {
    const bus = this.bus
    if (!bus) return
    const scale = boss ? BOSS_SCALE : SCALE
    const beat = step % 4 === 0

    // --- 베이스: 마디의 1·3박 ---
    if (i > 0.12 && step % 8 === 0) {
      const root = scale[step % 16 === 0 ? 0 : 2]!
      this.blip(ctx, bus, at, root, 0.32, 0.09 + i * 0.05, 'sawtooth', 240)
    }

    // --- 킥: 매 박 ---
    if (i > 0.3 && beat) {
      this.kick(ctx, bus, at, 0.1 + i * 0.06)
    }

    // --- 하이햇: 8분음표 뒤쪽 ---
    if (i > 0.34 && step % 2 === 1) {
      this.hat(ctx, bus, at, 0.022 + i * 0.02)
    }

    // --- 아르페지오: 최대 밀도에서만 ---
    if (i > 0.55) {
      const note = scale[3 + ARP_PATTERN[step % ARP_PATTERN.length]!]!
      this.blip(ctx, bus, at, note, 0.14, 0.03 + (i - 0.55) * 0.09, 'triangle', 2200)
    }

    // --- 보스 리드: 두 마디마다 한 번 길게 ---
    if (boss && step % 16 === 0) {
      this.blip(ctx, bus, at, scale[5]!, 0.7, 0.07, 'square', 1400)
    }
  }

  private blip(
    ctx: AudioContext,
    dest: AudioNode,
    at: number,
    freq: number,
    dur: number,
    peak: number,
    type: OscillatorType,
    cutoff: number,
  ): void {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(cutoff, at)
    filter.frequency.exponentialRampToValueAtTime(Math.max(160, cutoff * 0.35), at + dur)

    osc.type = type
    osc.frequency.setValueAtTime(freq, at)

    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)

    osc.connect(filter)
    filter.connect(gain)
    gain.connect(dest)
    osc.start(at)
    osc.stop(at + dur + 0.02)
    // 노드는 stop 후 자동으로 해제된다. 참조를 남기지 않아야 GC가 가져간다.
    osc.onended = () => {
      osc.disconnect()
      filter.disconnect()
      gain.disconnect()
    }
  }

  private kick(ctx: AudioContext, dest: AudioNode, at: number, peak: number): void {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    // 피치가 급락하는 것이 킥의 전부다.
    osc.frequency.setValueAtTime(140, at)
    osc.frequency.exponentialRampToValueAtTime(42, at + 0.09)
    gain.gain.setValueAtTime(peak, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16)
    osc.connect(gain)
    gain.connect(dest)
    osc.start(at)
    osc.stop(at + 0.18)
    osc.onended = () => {
      osc.disconnect()
      gain.disconnect()
    }
  }

  private hat(ctx: AudioContext, dest: AudioNode, at: number, peak: number): void {
    if (!this.noiseBuffer) return
    const src = ctx.createBufferSource()
    const gain = ctx.createGain()
    const filter = ctx.createBiquadFilter()
    src.buffer = this.noiseBuffer
    filter.type = 'highpass'
    filter.frequency.value = 7000
    gain.gain.setValueAtTime(peak, at)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05)
    src.connect(filter)
    filter.connect(gain)
    gain.connect(dest)
    src.start(at)
    src.stop(at + 0.06)
    src.onended = () => {
      src.disconnect()
      filter.disconnect()
      gain.disconnect()
    }
  }
}

/** 0.4초짜리 화이트 노이즈. 하이햇이 재사용한다. */
function makeNoise(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 0.4)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const data = buf.getChannelData(0)
  // 시각 연출이 아니라 소리라 결정론이 필요 없다. Math.random을 써도 된다.
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  return buf
}
