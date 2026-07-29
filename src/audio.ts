import menuMusicUrl from '../music/mainmenu.mp3?url'
import soundtrack1Url from '../music/soundtrack1.mp3?url'
import soundtrack2Url from '../music/soundtrack2.mp3?url'
import soundtrack3Url from '../music/soundtrack3.mp3?url'
import soundtrack4Url from '../music/soundtrack4.mp3?url'
import bladeDrawUrl from './assets/audio/kenney/blade-draw.ogg?url'
import bladeImpactUrl from './assets/audio/kenney/blade-impact.ogg?url'
import bladeSlashUrl from './assets/audio/kenney/blade-slash.ogg?url'
import magicGlassUrl from './assets/audio/kenney/magic-glass.ogg?url'
import magicGlitchUrl from './assets/audio/kenney/magic-glitch.ogg?url'
import magicImpactUrl from './assets/audio/kenney/magic-impact.ogg?url'
import magicRiseUrl from './assets/audio/kenney/magic-rise.ogg?url'
import uiBackUrl from './assets/audio/kenney/ui-back.ogg?url'
import uiConfirmUrl from './assets/audio/kenney/ui-confirm.ogg?url'
import uiSelectUrl from './assets/audio/kenney/ui-select.ogg?url'
import {
  summarizeDamageFeedback,
  type HitFeedbackSummary,
} from './sim/damage-feedback.ts'
import type { AttackEvent, CastEvent, PlayerClass, World } from './sim/types.ts'

export interface AudioSettings {
  master: number
  music: number
  sfx: number
  muted: boolean
}

const STORAGE_KEY = 'prototype-audio-settings-v1'
const DEFAULT_SETTINGS: AudioSettings = {
  master: 0.8,
  music: 0.55,
  sfx: 0.8,
  muted: false,
}
const MENU_MUSIC_VOLUME = 0.72
const GAME_MUSIC_VOLUME = 0.62
const GAME_MUSIC_URLS = [
  soundtrack1Url,
  soundtrack2Url,
  soundtrack3Url,
  soundtrack4Url,
] as const
const MAX_ACTIVE_SOURCES = 40
const SAMPLE_URLS = {
  'blade-draw': bladeDrawUrl,
  'blade-impact': bladeImpactUrl,
  'blade-slash': bladeSlashUrl,
  'magic-glass': magicGlassUrl,
  'magic-glitch': magicGlitchUrl,
  'magic-impact': magicImpactUrl,
  'magic-rise': magicRiseUrl,
  'ui-back': uiBackUrl,
  'ui-confirm': uiConfirmUrl,
  'ui-select': uiSelectUrl,
} as const

type AudioContextConstructor = new () => AudioContext
type MusicMode = 'stopped' | 'menu' | 'game'
type SampleId = keyof typeof SAMPLE_URLS
type SoundGroup =
  | 'attack'
  | 'cast'
  | 'hit'
  | 'hurt'
  | 'death'
  | 'level'
  | 'boss'
  | 'hazard'
  | 'surge'
  | 'outcome'
  | 'ui'

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
      music: clamp01(Number(parsed.music), DEFAULT_SETTINGS.music),
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
  private readonly sampleBuffers = new Map<SampleId, AudioBuffer>()
  private readonly sampleLoads = new Map<SampleId, Promise<AudioBuffer | null>>()
  private music: HTMLAudioElement | null = null
  private musicMode: MusicMode = 'stopped'
  private musicSuspended = false
  private gameMusicBag: number[] = []
  private lastGameMusicIndex = -1
  private readonly nextSoundAt: Record<SoundGroup, number> = {
    attack: 0,
    cast: 0,
    hit: 0,
    hurt: 0,
    death: 0,
    level: 0,
    boss: 0,
    hazard: 0,
    surge: 0,
    outcome: 0,
    ui: 0,
  }

  private lastSeed: number | null = null
  private lastTick = -1
  private lastLevel = 1
  private lastBossActive = false
  private lastBossPhaseTwoAt = -1
  private lastBossPhaseThreeAt = -1
  private lastBossHazardVolley = 0
  private lastBossHazardDetonations = 0
  private lastSurgeWarningIndex = 0
  private lastSurgeBeatIndex = 0
  private lastOutcome: World['outcome'] = 'alive'
  private lastPlayerHp = 0

  getSettings(): AudioSettings {
    return { ...this.settings }
  }

  setSettings(patch: Partial<AudioSettings>): void {
    this.settings = {
      master:
        patch.master === undefined
          ? this.settings.master
          : clamp01(patch.master, this.settings.master),
      music:
        patch.music === undefined
          ? this.settings.music
          : clamp01(patch.music, this.settings.music),
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
    // HTMLAudio와 Web Audio는 서로 기다리지 않는다. 느린 MP3 버퍼링이 UI 효과음을
    // 막거나, 일부 WebView의 오래 걸리는 AudioContext.resume()이 BGM을 막지 않게 한다.
    void this.resumeMusic()
    if (this.unlockPromise) return this.unlockPromise

    const context = this.ensureContext()
    if (!context || context.state === 'running') {
      if (context?.state === 'running') void this.preloadSamples()
      return
    }
    this.unlockPromise = (async () => {
      try {
        if (context.state === 'suspended') await context.resume()
      } catch {
        // 자동재생 정책이나 OS 오디오 잠금은 조용히 무시하고 다음 제스처에서 재시도한다.
      }
      if (context.state === 'running') void this.preloadSamples()
    })().finally(() => {
      this.unlockPromise = null
    })
    return this.unlockPromise
  }

  /**
   * 메인 메뉴, 캐릭터 선택, 로드아웃 안내에서 같은 테마를 이어 재생한다.
   * 자동재생이 막힌 환경에서는 첫 입력 시 unlock()이 현재 요청을 재시도한다.
   */
  playMenuMusic(): void {
    if (this.musicMode === 'menu') {
      void this.resumeMusic()
      return
    }
    this.musicMode = 'menu'
    this.setMusicSource(menuMusicUrl, true)
    void this.resumeMusic()
  }

  /**
   * 네 곡을 셔플 백으로 한 번씩 재생하고, 곡이 끝날 때 다음 백을 만든다.
   * 직전 곡과 새 백의 첫 곡이 같아지는 즉시 반복도 피한다.
   */
  playGameMusic(): void {
    this.musicMode = 'game'
    this.playNextGameMusic()
  }

  stopMusic(): void {
    this.musicMode = 'stopped'
    if (!this.music) return
    this.music.pause()
    this.music.removeAttribute('src')
    delete this.music.dataset.track
    this.music.load()
  }

  setSuspended(suspended: boolean): void {
    this.musicSuspended = suspended
    if (suspended) {
      this.music?.pause()
    } else {
      void this.resumeMusic()
    }
  }

  preview(): void {
    this.fromGesture(() => {
      if (!this.allow('ui', 0.08)) return
      this.sample('ui-select', 0.16)
      this.tone(440, 0.09, 0.055, 'triangle', 620)
      this.tone(660, 0.12, 0.045, 'sine', 880, 0.07)
    })
  }

  characterSelect(playerClass: PlayerClass): void {
    this.fromGesture(() => {
      if (!this.allow('ui', 0.12)) return
      this.sample('ui-confirm', 0.24)
      if (playerClass === 'ranged') {
        this.sample('magic-rise', 0.2, 1.06, 0.03)
        this.sample('magic-glass', 0.16, 1.12, 0.09)
        this.tone(392, 0.22, 0.04, 'triangle', 784)
        this.tone(659, 0.2, 0.035, 'sine', 988, 0.08)
      } else {
        this.sample('blade-draw', 0.24, 0.94, 0.02)
        this.sample('blade-impact', 0.13, 0.86, 0.16)
        this.tone(196, 0.18, 0.045, 'sawtooth', 110)
        this.tone(294, 0.12, 0.028, 'triangle', 196, 0.1)
      }
    })
  }

  upgradeChoice(): void {
    this.fromGesture(() => {
      if (!this.allow('ui', 0.06)) return
      this.sample('ui-confirm', 0.22, 1.08)
      this.tone(523, 0.1, 0.04, 'triangle', 784)
      this.tone(784, 0.14, 0.035, 'sine', 1047, 0.06)
    })
  }

  update(world: World): void {
    const newWorld =
      this.lastSeed === null || world.seed !== this.lastSeed || world.tick < this.lastTick
    const newTick = world.tick !== this.lastTick
    const levelled = !newWorld && world.progression.level > this.lastLevel
    const bossAppeared = !newWorld && world.boss.active && !this.lastBossActive
    const bossShifted =
      !newWorld &&
      ((world.boss.phaseTwoAt >= 0 && this.lastBossPhaseTwoAt < 0) ||
        (world.boss.phaseThreeAt >= 0 && this.lastBossPhaseThreeAt < 0))
    const bossHazardWarned =
      !newWorld &&
      world.boss.nextHazardVolley > this.lastBossHazardVolley
    const bossHazardDetonated =
      !newWorld &&
      world.boss.hazardDetonations > this.lastBossHazardDetonations
    const surgeWarned =
      !newWorld && world.surgeWarningIndex > this.lastSurgeWarningIndex
    const surgeStarted =
      !newWorld && world.surgeBeatIndex > this.lastSurgeBeatIndex
    const outcomeChanged =
      !newWorld && world.outcome !== this.lastOutcome && world.outcome !== 'alive'
    const playerDamage = newWorld
      ? 0
      : Math.max(0, this.lastPlayerHp - world.player.hp)

    this.lastSeed = world.seed
    this.lastTick = world.tick
    this.lastLevel = world.progression.level
    this.lastBossActive = world.boss.active
    this.lastBossPhaseTwoAt = world.boss.phaseTwoAt
    this.lastBossPhaseThreeAt = world.boss.phaseThreeAt
    this.lastBossHazardVolley = world.boss.nextHazardVolley
    this.lastBossHazardDetonations = world.boss.hazardDetonations
    this.lastSurgeWarningIndex = world.surgeWarningIndex
    this.lastSurgeBeatIndex = world.surgeBeatIndex
    this.lastOutcome = world.outcome
    this.lastPlayerHp = world.player.hp


    // update는 자동재생 잠금을 해제하지 않는다.
    if (newWorld || !this.isAudible() || !this.context || this.context.state !== 'running') {
      return
    }

    if (levelled && this.allow('level', 0.22)) this.levelUp()
    if (bossAppeared && this.allow('boss', 0.8)) this.bossArrival()
    if (bossShifted && this.allow('boss', 0.8)) this.bossPhaseTwo()
    if (bossHazardWarned && this.allow('hazard', 0.24)) {
      this.bossHazardWarning()
    }
    if (bossHazardDetonated && this.allow('hazard', 0.18)) {
      this.bossHazardImpact()
    }
    if (surgeWarned && this.allow('surge', 0.8)) this.surgeWarning()
    if (surgeStarted && this.allow('surge', 0.8)) this.surgeImpact()
    if (outcomeChanged && this.allow('outcome', 0.8)) this.outcome(world.outcome)
    if (playerDamage > 0 && this.allow('hurt', 0.14)) {
      this.playerHurt(playerDamage, world.stats.maxHp)
    }

    // 동일한 시뮬레이션 틱을 여러 번 그려도 이벤트음을 중복 재생하지 않는다.
    if (!newTick) return
    if (world.casts.length > 0 && this.allow('cast', 0.065)) {
      this.cast(this.strongestCast(world.casts), world.casts.length, world.playerClass)
    }
    if (world.attacks.length > 0 && this.allow('attack', 0.045)) {
      this.attack(this.strongestAttack(world.attacks), world.attacks.length, world.playerClass)
    }
    const confirmedHit = summarizeDamageFeedback(world.damageFeedback)
    if (confirmedHit && this.allow('hit', 0.05)) {
      this.enemyImpact(confirmedHit, world.playerClass)
    }
    if (world.deaths.length > 0 && this.allow('death', 0.07)) {
      this.enemyDeath(world.deaths.length)
    }
  }

  ui(kind: 'select' | 'confirm' | 'back' | 'pause'): void {
    this.fromGesture(() => {
      if (!this.allow('ui', 0.035)) return
      if (kind === 'select') {
        this.sample('ui-select', 0.18)
        this.tone(520, 0.055, 0.04, 'triangle', 760)
      } else if (kind === 'confirm') {
        this.sample('ui-confirm', 0.22)
        this.tone(440, 0.08, 0.04, 'triangle', 660)
        this.tone(660, 0.11, 0.035, 'sine', 880, 0.055)
      } else if (kind === 'back') {
        this.sample('ui-back', 0.19)
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
    this.lastBossPhaseTwoAt = -1
    this.lastBossPhaseThreeAt = -1
    this.lastBossHazardVolley = 0
    this.lastBossHazardDetonations = 0
    this.lastSurgeWarningIndex = 0
    this.lastSurgeBeatIndex = 0
    this.lastOutcome = 'alive'
    this.lastPlayerHp = 0
  }

  private ensureContext(): AudioContext | null {
    if (this.context?.state === 'closed') {
      this.context = null
      this.masterBus = null
      this.sfxBus = null
      this.noiseBuffer = null
      this.sampleBuffers.clear()
      this.sampleLoads.clear()
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
    this.applyMusicVolume()
    const context = this.context
    if (!context || !this.masterBus || !this.sfxBus) return
    const now = context.currentTime
    const master = this.settings.muted ? 0 : this.settings.master
    this.masterBus.gain.cancelScheduledValues(now)
    this.masterBus.gain.setTargetAtTime(master, now, 0.012)
    this.sfxBus.gain.cancelScheduledValues(now)
    this.sfxBus.gain.setTargetAtTime(this.settings.sfx, now, 0.012)
  }

  private ensureMusic(): HTMLAudioElement | null {
    if (this.music) return this.music
    if (typeof Audio === 'undefined') return null
    const music = new Audio()
    music.preload = 'auto'
    music.setAttribute('playsinline', '')
    music.addEventListener('ended', () => {
      if (this.musicMode === 'game') this.playNextGameMusic()
    })
    this.music = music
    this.applyMusicVolume()
    return music
  }

  private setMusicSource(url: string, loop: boolean): void {
    const music = this.ensureMusic()
    if (!music) return
    if (music.dataset.track !== url) {
      music.pause()
      music.src = url
      music.dataset.track = url
      music.currentTime = 0
    }
    music.loop = loop
    this.applyMusicVolume()
  }

  private async resumeMusic(): Promise<void> {
    if (this.musicMode === 'stopped' || this.musicSuspended) return
    const music = this.ensureMusic()
    if (!music || !music.src) return
    this.applyMusicVolume()
    try {
      await music.play()
    } catch {
      // 자동재생 정책이 막으면 요청 상태를 유지하고 다음 사용자 입력에서 재시도한다.
    }
  }

  private playNextGameMusic(): void {
    if (this.musicMode !== 'game') return
    const index = this.takeNextGameMusicIndex()
    this.lastGameMusicIndex = index
    this.setMusicSource(GAME_MUSIC_URLS[index]!, false)
    void this.resumeMusic()
  }

  private takeNextGameMusicIndex(): number {
    if (this.gameMusicBag.length === 0) {
      const bag = GAME_MUSIC_URLS.map((_, index) => index)
      for (let index = bag.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(Math.random() * (index + 1))
        ;[bag[index], bag[swap]] = [bag[swap]!, bag[index]!]
      }
      if (bag.length > 1 && bag[bag.length - 1] === this.lastGameMusicIndex) {
        ;[bag[0], bag[bag.length - 1]] = [bag[bag.length - 1]!, bag[0]!]
      }
      this.gameMusicBag = bag
    }
    return this.gameMusicBag.pop()!
  }

  private applyMusicVolume(): void {
    if (!this.music) return
    const sceneVolume =
      this.musicMode === 'menu' ? MENU_MUSIC_VOLUME : GAME_MUSIC_VOLUME
    this.music.volume = this.settings.muted
      ? 0
      : clamp01(this.settings.master * this.settings.music * sceneVolume, 0)
  }

  private preloadSamples(): Promise<(AudioBuffer | null)[]> {
    return Promise.all(
      (Object.keys(SAMPLE_URLS) as SampleId[]).map((id) => this.loadSample(id)),
    )
  }

  private loadSample(id: SampleId): Promise<AudioBuffer | null> {
    const cached = this.sampleBuffers.get(id)
    if (cached) return Promise.resolve(cached)
    const pending = this.sampleLoads.get(id)
    if (pending) return pending

    const context = this.context
    if (!context || context.state === 'closed') return Promise.resolve(null)
    const load = fetch(SAMPLE_URLS[id])
      .then((response) => {
        if (!response.ok) throw new Error(`audio sample ${response.status}`)
        return response.arrayBuffer()
      })
      .then((bytes) => context.decodeAudioData(bytes))
      .then((buffer) => {
        if (context === this.context) this.sampleBuffers.set(id, buffer)
        return buffer
      })
      .catch(() => null)
      .finally(() => {
        this.sampleLoads.delete(id)
      })
    this.sampleLoads.set(id, load)
    return load
  }

  private sample(
    id: SampleId,
    volume: number,
    playbackRate = 1,
    delay = 0,
  ): void {
    const context = this.context
    const bus = this.sfxBus
    if (!this.isAudible() || !context || !bus || context.state !== 'running') return
    const play = (buffer: AudioBuffer): void => {
      if (
        !this.isAudible() ||
        context !== this.context ||
        context.state !== 'running' ||
        !this.sfxBus
      ) {
        return
      }
      try {
        const source = context.createBufferSource()
        const gain = context.createGain()
        source.buffer = buffer
        source.playbackRate.value = Math.max(0.5, Math.min(2, playbackRate))
        gain.gain.value = Math.max(0, volume)
        source.connect(gain)
        gain.connect(this.sfxBus)
        this.track(source)
        source.start(context.currentTime + Math.max(0, delay))
      } catch {
        // 샘플 재생 실패는 합성음 레이어와 게임 진행에 영향을 주지 않는다.
      }
    }

    const buffer = this.sampleBuffers.get(id)
    if (buffer) {
      play(buffer)
      return
    }
    void this.loadSample(id).then((loaded) => {
      if (loaded) play(loaded)
    })
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
    if (this.activeSources.size >= MAX_ACTIVE_SOURCES) {
      const oldest = this.activeSources.values().next().value
      if (oldest) {
        this.activeSources.delete(oldest)
        try {
          oldest.stop()
        } catch {
          // 이미 끝난 소스는 Set에서만 제거하면 된다.
        }
      }
    }
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

  private attack(
    kind: AttackEvent['kind'],
    count: number,
    playerClass: PlayerClass,
  ): void {
    const lift = Math.min(1.35, 1 + Math.log2(Math.max(1, count)) * 0.08)
    if (kind === 'ranged') {
      this.tone(560, 0.045, 0.03 * lift, 'triangle', 280)
    } else if (kind === 'melee') {
      this.tone(180, 0.065, 0.04 * lift, 'sawtooth', 72)
      this.noise(0.045, 0.018 * lift, 1200)
    } else if (kind === 'empowered') {
      if (playerClass === 'ranged') {
        // 삼중 굴절은 무거운 근접 강화타와 달리 세 광선이 갈라지는 얇은
        // 음형으로 들려야 한다. 짧은 유리음과 세 개의 상승음을 좌우 광선처럼 펼친다.
        this.sample('magic-glass', 0.065 * lift, 1.28)
        this.tone(520, 0.055, 0.025 * lift, 'triangle', 760)
        this.tone(660, 0.06, 0.022 * lift, 'sine', 920, 0.018)
        this.tone(800, 0.065, 0.02 * lift, 'sine', 1080, 0.036)
      } else {
        this.sample('blade-impact', 0.08 * lift, 1.05)
        this.tone(230, 0.1, 0.05 * lift, 'square', 620)
        this.noise(0.07, 0.024 * lift, 1700)
      }
    } else {
      this.sample(
        playerClass === 'ranged' ? 'magic-glass' : 'blade-impact',
        0.13 * lift,
        playerClass === 'ranged' ? 0.88 : 0.78,
      )
      this.tone(125, 0.15, 0.06 * lift, 'sawtooth', 45)
      this.tone(520, 0.12, 0.035 * lift, 'sine', 840, 0.025)
    }
  }

  /**
   * Confirmed contact, deliberately louder and lower than launch/swing cues.
   * A whole fixed-tick batch becomes one layered transient, so AoE remains a
   * single weighty hit instead of dozens of overlapping samples.
   */
  private enemyImpact(
    summary: HitFeedbackSummary,
    playerClass: PlayerClass,
  ): void {
    const intensity = Math.max(0.18, summary.intensity)
    const crowdLift = Math.min(
      1.24,
      1 + Math.log2(Math.max(1, summary.count)) * 0.055,
    )
    const salt =
      (Math.round(summary.strongest.amount) * 31 + summary.count * 17) % 11
    const pitchVariation = (salt - 5) * 0.006

    if (playerClass === 'melee') {
      this.sample(
        'blade-impact',
        (0.15 + intensity * 0.09) * crowdLift,
        1.08 - intensity * 0.18 + pitchVariation,
      )
      this.noise(
        0.035 + intensity * 0.03,
        (0.012 + intensity * 0.018) * crowdLift,
        1350 - intensity * 520,
      )
      this.tone(
        150 - intensity * 28,
        0.055 + intensity * 0.035,
        (0.018 + intensity * 0.025) * crowdLift,
        'triangle',
        62 - intensity * 12,
      )
    } else {
      this.sample(
        'magic-impact',
        (0.13 + intensity * 0.09) * crowdLift,
        1.25 - intensity * 0.16 + pitchVariation,
      )
      this.noise(
        0.028 + intensity * 0.025,
        (0.008 + intensity * 0.013) * crowdLift,
        2200 - intensity * 650,
      )
      this.tone(
        720 - intensity * 90,
        0.04 + intensity * 0.025,
        (0.012 + intensity * 0.02) * crowdLift,
        'triangle',
        260 - intensity * 55,
      )
    }

    if (
      summary.tier === 'finisher' ||
      summary.hasCapped ||
      summary.intensity >= 0.68
    ) {
      this.tone(
        78,
        0.095,
        (0.02 + intensity * 0.025) * crowdLift,
        'sawtooth',
        42,
      )
    }
  }

  private playerHurt(amount: number, maxHp: number): void {
    const intensity = Math.min(
      1,
      Math.max(0.18, amount / Math.max(1, maxHp * 0.2)),
    )
    this.noise(
      0.075 + intensity * 0.055,
      0.02 + intensity * 0.032,
      850 - intensity * 350,
    )
    this.tone(
      165 - intensity * 25,
      0.09 + intensity * 0.05,
      0.025 + intensity * 0.035,
      'sawtooth',
      62,
    )
  }

  private cast(
    slot: CastEvent['slot'],
    count: number,
    playerClass: PlayerClass,
  ): void {
    const lift = Math.min(1.25, 1 + Math.log2(Math.max(1, count)) * 0.06)
    if (slot === 'd') {
      this.sample('magic-rise', 0.14 * lift, 1.12)
      this.tone(420, 0.16, 0.04 * lift, 'sine', 680)
      this.tone(630, 0.14, 0.025 * lift, 'sine', 920, 0.07)
      return
    }
    if (slot === 'f') {
      this.sample('magic-glitch', 0.17 * lift, 1.08)
      this.tone(920, 0.085, 0.04 * lift, 'sine', 1250)
      this.noise(0.045, 0.015 * lift, 2500)
      return
    }

    if (playerClass === 'ranged') {
      this.rangedCast(slot, lift)
      return
    }
    this.meleeCast(slot, lift)
  }

  private rangedCast(slot: CastEvent['slot'], lift: number): void {
    if (slot === 'r') {
      this.sample('magic-rise', 0.2 * lift, 0.82)
      this.sample('magic-impact', 0.16 * lift, 0.72, 0.12)
      this.tone(90, 0.28, 0.07 * lift, 'sawtooth', 45)
      this.tone(360, 0.22, 0.04 * lift, 'triangle', 720, 0.04)
      this.noise(0.18, 0.035 * lift, 1500)
    } else if (slot === 'e') {
      this.sample('magic-glass', 0.16 * lift, 0.88)
      this.tone(210, 0.14, 0.045 * lift, 'triangle', 85)
      this.noise(0.11, 0.025 * lift, 1100)
    } else if (slot === 'w') {
      this.sample('magic-glitch', 0.13 * lift, 1.18)
      this.tone(300, 0.085, 0.04 * lift, 'sine', 1250)
      this.noise(0.045, 0.015 * lift, 2500)
    } else {
      // Q는 적중음이 아니라 일정 시간 렌즈를 전개하는 시작음이다.
      this.sample('magic-rise', 0.105 * lift, 1.32)
      this.tone(390, 0.1, 0.035 * lift, 'triangle', 560)
      this.tone(585, 0.12, 0.025 * lift, 'sine', 780, 0.035)
      this.tone(780, 0.14, 0.018 * lift, 'sine', 1040, 0.07)
    }
  }

  private meleeCast(slot: CastEvent['slot'], lift: number): void {
    if (slot === 'r') {
      this.sample('blade-draw', 0.17 * lift, 0.82)
      this.sample('blade-impact', 0.22 * lift, 0.76, 0.11)
      this.tone(82, 0.3, 0.07 * lift, 'sawtooth', 42)
      this.noise(0.2, 0.038 * lift, 980, 0.05)
    } else if (slot === 'e') {
      this.sample('blade-draw', 0.16 * lift, 1.08)
      this.tone(175, 0.15, 0.045 * lift, 'triangle', 92)
    } else if (slot === 'w') {
      this.sample('blade-slash', 0.17 * lift, 1.2)
      this.tone(260, 0.08, 0.042 * lift, 'sawtooth', 110)
      this.noise(0.055, 0.018 * lift, 1900)
    } else {
      this.sample('blade-slash', 0.18 * lift, 0.94)
      this.tone(210, 0.1, 0.045 * lift, 'triangle', 95)
      this.noise(0.065, 0.02 * lift, 1500)
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

  private bossPhaseTwo(): void {
    this.tone(74, 0.55, 0.085, 'sawtooth', 38)
    this.tone(148, 0.42, 0.055, 'square', 296, 0.04)
    this.tone(444, 0.34, 0.045, 'triangle', 222, 0.13)
    this.noise(0.36, 0.055, 680, 0.02)
  }

  private bossHazardWarning(): void {
    this.tone(520, 0.11, 0.035, 'square', 350)
    this.tone(350, 0.13, 0.03, 'triangle', 235, 0.1)
  }

  private bossHazardImpact(): void {
    this.tone(96, 0.24, 0.055, 'sawtooth', 48)
    this.noise(0.16, 0.035, 920)
  }

  private surgeWarning(): void {
    this.tone(330, 0.18, 0.05, 'square', 220)
    this.tone(220, 0.2, 0.045, 'triangle', 165, 0.16)
    this.tone(165, 0.25, 0.04, 'sawtooth', 110, 0.34)
  }

  private surgeImpact(): void {
    this.tone(86, 0.32, 0.065, 'sawtooth', 52)
    this.noise(0.18, 0.04, 780)
    this.tone(430, 0.16, 0.028, 'triangle', 260, 0.04)
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
