import type { AttackEvent, CastEvent, World } from './sim/types.ts'

export interface AudioSettings {
  master: number
  sfx: number
  muted: boolean
}

const STORAGE_KEY = 'prototype-audio-settings-v1'
const DEFAULT_SETTINGS: AudioSettings = { master: 0.8, sfx: 0.8, muted: false }

type AudioContextConstructor = new () => AudioContext
type SoundGroup = 'attack' | 'cast' | 'death' | 'level' | 'boss' | 'outcome' | 'ui'

function clamp01(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback
}

function loadSettings(): AudioSettings {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<AudioSettings>
    return {
      master: clamp01(Number(parsed.master), DEFAULT_SETTINGS.master),
      sfx: clamp01(Number(parsed.sfx), DEFAULT_SETTINGS.sfx),
      muted: typeof parsed.muted === 'boolean' ? parsed.muted : DEFAULT_SETTINGS.muted,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 외부 음원 없이 짧은 전투 피드백을 합성하는 Web Audio 엔진.
 *
 * update()는 상태를 관찰할 뿐 AudioContext를 만들거나 resume하지 않는다.
 * unlock(), preview(), ui()처럼 사용자 제스처에서 호출하는 경로만 오디오를 연다.
 */
export class GameAudio {
  private settings = loadSettings()
  private context: AudioContext | null = null
  private masterBus: GainNode | null = null
  private sfxBus: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  private unlockPromise: Promise<void> | null = null
  private readonly activeSources = new Set<AudioScheduledSourceNode>()
  private readonly nextSoundAt: Record<SoundGroup, number> = {
    attack: 0,
    cast: 0,
    death: 0,
    level: 0,
    boss: 0,
    outcome: 0,
    ui: 0,
  }

  private lastSeed: number | null = null
  private lastTick = -1
  private lastLevel = 1
  private lastBossActive = false
  private lastOutcome: World['outcome'] = 'alive'

  getSettings(): AudioSettings {
    return { ...this.settings }
  }

  setSettings(patch: Partial<AudioSettings>): void {
    this.settings = {
      master:
        patch.master === undefined
          ? this.settings.master
          : clamp01(patch.master, this.settings.master),
      sfx: patch.sfx === undefined ? this.settings.sfx : clamp01(patch.sfx, this.settings.sfx),
      muted: patch.muted === undefined ? this.settings.muted : Boolean(patch.muted),
    }
    this.applySettings()

    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.settings))
    } catch {
      // 비공개 모드·저장소 차단 환경에서도 사운드는 현재 세션 설정으로 동작한다.
    }
  }

  async unlock(): Promise<void> {
    if (this.context?.state === 'running') return
    if (this.unlockPromise) return this.unlockPromise

    const context = this.ensureContext()
    if (!context) return

    this.unlockPromise = (async () => {
      try {
        if (context.state === 'suspended') await context.resume()
      } catch {
        // 자동재생 정책이나 OS 오디오 잠금은 조용히 무시하고 다음 제스처에서 재시도한다.
      }
    })().finally(() => {
      this.unlockPromise = null
    })
    return this.unlockPromise
  }

  preview(): void {
    this.fromGesture(() => {
      if (!this.allow('ui', 0.08)) return
      this.tone(440, 0.09, 0.055, 'triangle', 620)
      this.tone(660, 0.12, 0.045, 'sine', 880, 0.07)
    })
  }

  update(world: World): void {
    const newWorld =
      this.lastSeed === null || world.seed !== this.lastSeed || world.tick < this.lastTick
    const newTick = world.tick !== this.lastTick
    const levelled = !newWorld && world.progression.level > this.lastLevel
    const bossAppeared = !newWorld && world.boss.active && !this.lastBossActive
    const outcomeChanged =
      !newWorld && world.outcome !== this.lastOutcome && world.outcome !== 'alive'

    this.lastSeed = world.seed
    this.lastTick = world.tick
    this.lastLevel = world.progression.level
    this.lastBossActive = world.boss.active
    this.lastOutcome = world.outcome

    // update는 자동재생 잠금을 해제하지 않는다.
    if (newWorld || !this.isAudible() || !this.context || this.context.state !== 'running') {
      return
    }

    if (levelled && this.allow('level', 0.22)) this.levelUp()
    if (bossAppeared && this.allow('boss', 0.8)) this.bossArrival()
    if (outcomeChanged && this.allow('outcome', 0.8)) this.outcome(world.outcome)

    // 동일한 시뮬레이션 틱을 여러 번 그려도 이벤트음을 중복 재생하지 않는다.
    if (!newTick) return
    if (world.casts.length > 0 && this.allow('cast', 0.065)) {
      this.cast(this.strongestCast(world.casts), world.casts.length)
    }
    if (world.attacks.length > 0 && this.allow('attack', 0.045)) {
      this.attack(this.strongestAttack(world.attacks), world.attacks.length)
    }
    if (world.deaths.length > 0 && this.allow('death', 0.07)) {
      this.enemyDeath(world.deaths.length)
    }
  }

  ui(kind: 'select' | 'back' | 'pause'): void {
    this.fromGesture(() => {
      if (!this.allow('ui', 0.035)) return
      if (kind === 'select') {
        this.tone(520, 0.055, 0.04, 'triangle', 760)
      } else if (kind === 'back') {
        this.tone(360, 0.075, 0.038, 'triangle', 210)
      } else {
        this.tone(190, 0.09, 0.04, 'square', 150)
        this.tone(285, 0.07, 0.025, 'triangle', 220, 0.035)
      }
    })
  }

  reset(): void {
    for (const source of this.activeSources) {
      try {
        source.stop()
      } catch {
        // 이미 끝난 노드는 무시한다.
      }
    }
    this.activeSources.clear()
    for (const key of Object.keys(this.nextSoundAt) as SoundGroup[]) {
      this.nextSoundAt[key] = 0
    }
    this.lastSeed = null
    this.lastTick = -1
    this.lastLevel = 1
    this.lastBossActive = false
    this.lastOutcome = 'alive'
  }

  private ensureContext(): AudioContext | null {
    if (this.context?.state === 'closed') {
      this.context = null
      this.masterBus = null
      this.sfxBus = null
      this.noiseBuffer = null
    }
    if (this.context) return this.context

    const scope = globalThis as typeof globalThis & {
      AudioContext?: AudioContextConstructor
      webkitAudioContext?: AudioContextConstructor
    }
    const Context = scope.AudioContext ?? scope.webkitAudioContext
    if (!Context) return null

    try {
      const context = new Context()
      const master = context.createGain()
      const sfx = context.createGain()
      sfx.connect(master)
      master.connect(context.destination)
      this.context = context
      this.masterBus = master
      this.sfxBus = sfx
      this.applySettings()
      return context
    } catch {
      return null
    }
  }

  private applySettings(): void {
    const context = this.context
    if (!context || !this.masterBus || !this.sfxBus) return
    const now = context.currentTime
    const master = this.settings.muted ? 0 : this.settings.master
    this.masterBus.gain.cancelScheduledValues(now)
    this.masterBus.gain.setTargetAtTime(master, now, 0.012)
    this.sfxBus.gain.cancelScheduledValues(now)
    this.sfxBus.gain.setTargetAtTime(this.settings.sfx, now, 0.012)
  }

  private fromGesture(play: () => void): void {
    if (!this.isAudible()) return
    void this.unlock()
      .then(() => {
        if (this.context?.state === 'running') play()
      })
      .catch(() => {
        // 공개 제스처 API는 오디오 실패를 호출자에게 전파하지 않는다.
      })
  }

  private allow(group: SoundGroup, interval: number): boolean {
    const now = this.context?.currentTime
    if (now === undefined || now < this.nextSoundAt[group]) return false
    this.nextSoundAt[group] = now + interval
    return true
  }

  private isAudible(): boolean {
    return !this.settings.muted && this.settings.master > 0 && this.settings.sfx > 0
  }

  private tone(
    frequency: number,
    duration: number,
    volume: number,
    type: OscillatorType,
    endFrequency = frequency,
    delay = 0,
  ): void {
    const context = this.context
    const bus = this.sfxBus
    if (!this.isAudible() || !context || !bus || context.state !== 'running') return

    try {
      const start = context.currentTime + delay
      const end = start + duration
      const oscillator = context.createOscillator()
      const envelope = context.createGain()
      oscillator.type = type
      oscillator.frequency.setValueAtTime(Math.max(20, frequency), start)
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), end)
      envelope.gain.setValueAtTime(0.0001, start)
      envelope.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume), start + 0.008)
      envelope.gain.exponentialRampToValueAtTime(0.0001, end)
      oscillator.connect(envelope)
      envelope.connect(bus)
      this.track(oscillator)
      oscillator.start(start)
      oscillator.stop(end + 0.01)
    } catch {
      // 컨텍스트가 백그라운드 전환 중 닫혀도 게임 루프는 계속된다.
    }
  }

  private noise(duration: number, volume: number, cutoff: number, delay = 0): void {
    const context = this.context
    const bus = this.sfxBus
    if (!this.isAudible() || !context || !bus || context.state !== 'running') return

    try {
      const start = context.currentTime + delay
      const end = start + duration
      const source = context.createBufferSource()
      const filter = context.createBiquadFilter()
      const envelope = context.createGain()
      source.buffer = this.getNoiseBuffer(context)
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(cutoff, start)
      filter.frequency.exponentialRampToValueAtTime(Math.max(80, cutoff * 0.35), end)
      envelope.gain.setValueAtTime(Math.max(0.0001, volume), start)
      envelope.gain.exponentialRampToValueAtTime(0.0001, end)
      source.connect(filter)
      filter.connect(envelope)
      envelope.connect(bus)
      this.track(source)
      source.start(start, (start * 0.731) % 0.1, duration)
      source.stop(end + 0.01)
    } catch {
      // 미지원 노드나 중단된 컨텍스트는 무음 처리한다.
    }
  }

  private getNoiseBuffer(context: AudioContext): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer
    const length = Math.max(1, Math.floor(context.sampleRate * 0.6))
    const buffer = context.createBuffer(1, length, context.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    this.noiseBuffer = buffer
    return buffer
  }

  private track(source: AudioScheduledSourceNode): void {
    this.activeSources.add(source)
    source.addEventListener('ended', () => this.activeSources.delete(source), { once: true })
  }

  private strongestAttack(events: readonly AttackEvent[]): AttackEvent['kind'] {
    let best: AttackEvent['kind'] = 'ranged'
    const rank: Record<AttackEvent['kind'], number> = {
      ranged: 0,
      melee: 1,
      empowered: 2,
      ult: 3,
    }
    for (const event of events) if (rank[event.kind] > rank[best]) best = event.kind
    return best
  }

  private strongestCast(events: readonly CastEvent[]): CastEvent['slot'] {
    const rank: Record<CastEvent['slot'], number> = { q: 0, w: 1, d: 2, f: 3, e: 4, r: 5 }
    let best = events[0]!.slot
    for (const event of events) if (rank[event.slot] > rank[best]) best = event.slot
    return best
  }

  private attack(kind: AttackEvent['kind'], count: number): void {
    const lift = Math.min(1.35, 1 + Math.log2(Math.max(1, count)) * 0.08)
    if (kind === 'ranged') {
      this.tone(560, 0.045, 0.03 * lift, 'triangle', 280)
    } else if (kind === 'melee') {
      this.tone(180, 0.065, 0.04 * lift, 'sawtooth', 72)
      this.noise(0.045, 0.018 * lift, 1200)
    } else if (kind === 'empowered') {
      this.tone(230, 0.1, 0.05 * lift, 'square', 620)
      this.noise(0.07, 0.024 * lift, 1700)
    } else {
      this.tone(125, 0.15, 0.06 * lift, 'sawtooth', 45)
      this.tone(520, 0.12, 0.035 * lift, 'sine', 840, 0.025)
    }
  }

  private cast(slot: CastEvent['slot'], count: number): void {
    const lift = Math.min(1.25, 1 + Math.log2(Math.max(1, count)) * 0.06)
    if (slot === 'r') {
      this.tone(90, 0.28, 0.07 * lift, 'sawtooth', 45)
      this.tone(360, 0.22, 0.04 * lift, 'triangle', 720, 0.04)
      this.noise(0.18, 0.035 * lift, 1500)
    } else if (slot === 'e') {
      this.tone(210, 0.14, 0.045 * lift, 'triangle', 85)
      this.noise(0.11, 0.025 * lift, 1100)
    } else if (slot === 'w' || slot === 'f') {
      this.tone(slot === 'f' ? 920 : 300, 0.085, 0.04 * lift, 'sine', 1250)
      this.noise(0.045, 0.015 * lift, 2500)
    } else if (slot === 'd') {
      this.tone(420, 0.16, 0.04 * lift, 'sine', 680)
      this.tone(630, 0.14, 0.025 * lift, 'sine', 920, 0.07)
    } else {
      this.tone(390, 0.09, 0.04 * lift, 'triangle', 560)
    }
  }

  private enemyDeath(count: number): void {
    const lift = Math.min(1.5, 0.8 + Math.log2(count + 1) * 0.18)
    this.noise(0.075, 0.028 * lift, 850)
    this.tone(105 + Math.min(count, 8) * 4, 0.08, 0.024 * lift, 'triangle', 58)
  }

  private levelUp(): void {
    this.tone(392, 0.12, 0.045, 'triangle', 523)
    this.tone(523, 0.14, 0.045, 'triangle', 659, 0.08)
    this.tone(784, 0.2, 0.055, 'sine', 1047, 0.17)
  }

  private bossArrival(): void {
    this.tone(62, 0.65, 0.085, 'sawtooth', 42)
    this.tone(93, 0.55, 0.055, 'triangle', 62, 0.08)
    this.noise(0.42, 0.055, 520, 0.02)
  }

  private outcome(result: World['outcome']): void {
    if (result === 'victory') {
      this.tone(262, 0.25, 0.055, 'triangle', 392)
      this.tone(392, 0.28, 0.05, 'triangle', 523, 0.14)
      this.tone(659, 0.42, 0.055, 'sine', 784, 0.3)
      return
    }
    this.tone(result === 'timeout' ? 220 : 175, 0.35, 0.06, 'sawtooth', 82)
    this.noise(0.22, 0.03, 420, 0.06)
  }
}
