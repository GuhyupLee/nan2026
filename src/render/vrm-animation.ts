import * as THREE from 'three'
import {
  createVRMAnimationClip,
  VRMLookAtQuaternionProxy,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation'
import type { VRM } from '@pixiv/three-vrm'
import { playerActionDuration } from '../sim/action-timing.ts'
import type { PlayerClass } from '../sim/types.ts'
import type { CharacterAction } from './rig.ts'
import {
  VRM_RESULT_MOTIONS,
  VRMA_CLIP_ORDER,
  type VrmAnimationState,
  type VrmResultState,
} from './animation-data.ts'

const ACTION_PRIORITY: Record<CharacterAction, number> = {
  attack: 10,
  empowered: 20,
  q: 30,
  w: 30,
  e: 30,
  ult: 35,
  r: 40,
}

const BASIC_ATTACK_RECOVERY_START: Readonly<
  Partial<Record<CharacterAction, number>>
> = {
  attack: 0.72,
  empowered: 0.74,
}

/**
 * 이동 중 전투 동작이 남겨야 하는 locomotion 층의 최소 비율.
 *
 * VRMA one-shot은 전신 트랙이라 가중치 1에서 다리까지 완전히 덮는다. 특히
 * 원거리 평타는 0.28초마다 반복돼 보행이 거의 영구히 꺼지고, 캐릭터가 굳은
 * 다리로 미끄러졌다. 전투 동작의 실루엣은 유지하되 실제 이동 중에는
 * idle/walk 층을 이 비율만큼 예약한다. 평타는 상체 중심이라 가장 많이,
 * 궁극기는 전신 실루엣이 중요해 가장 적게 남긴다.
 */
const ACTION_LOCOMOTION_FLOOR: Readonly<Record<CharacterAction, number>> = {
  attack: 0.72,
  empowered: 0.66,
  q: 0.38,
  w: 0.36,
  e: 0.34,
  r: 0.22,
  ult: 0.24,
}

/** 새 동작의 짧은 예비 자세가 걷기 블렌드에 묻히지 않는 최대 진입 시간. */
const ACTION_FADE_IN = 0.018
/** 이전 one-shot만 빠르게 걷어내는 교차 페이드. */
const ACTION_CROSS_FADE = 0.035
const ACTION_TIME_EPSILON = 1e-6
/** 결과 전신 포즈가 마지막 전투 프레임을 갑자기 덮지 않게 하는 짧은 진입 블렌드. */
const RESULT_FADE_IN = 0.16

export interface ActiveVrmAction {
  kind: CharacterAction
  progress: number
}

/**
 * 렌더러는 한 프레임 안의 이벤트 우선순위만 안다. 이 잠금이 다음 틱의
 * 자동 평타가 Q/W/E/R 모션을 덮거나, 빠른 공속이 평타 첫 프레임만
 * 반복시키는 일을 막는다.
 */
export function canStartVrmAction(
  current: CharacterAction | null,
  currentProgress: number,
  incoming: CharacterAction,
): boolean {
  if (current === null || currentProgress >= 1) return true

  const currentPriority = ACTION_PRIORITY[current]
  const incomingPriority = ACTION_PRIORITY[incoming]
  if (incomingPriority > currentPriority) return true

  const recoveryStart = BASIC_ATTACK_RECOVERY_START[current]
  if (
    recoveryStart !== undefined &&
    (incoming === 'attack' || incoming === 'empowered') &&
    currentProgress >= recoveryStart
  ) {
    // 공격속도 강화의 다음 타격은 접촉 뒤 회수 구간만 줄여야 타격 모션이 빠지지 않는다.
    return true
  }

  return false
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function actionWeight(elapsed: number, duration: number): number {
  const fadeOut = Math.min(0.07, duration * 0.18)
  const enter = smoothstep(0, ACTION_FADE_IN, elapsed)
  const leave = 1 - smoothstep(duration - fadeOut, duration, elapsed)
  return enter * leave
}

function isPrimarySkill(kind: CharacterAction): boolean {
  return kind === 'q' || kind === 'w' || kind === 'e' || kind === 'r'
}

interface Playback {
  kind: CharacterAction
  action: THREE.AnimationAction
  startedAt: number
  duration: number
  clipDuration: number
}

interface Outgoing {
  kind: CharacterAction
  action: THREE.AnimationAction
  weight: number
  remaining: number
}

/**
 * 한 VRM 인스턴스의 idle/walk/전투/결과 클립을 관리한다.
 *
 * 전투 중 동시에 활성화되는 것은 idle, walk, one-shot 세 개뿐이고, 결과가
 * 정해지면 이 층을 결과 루프 하나로 넘긴다. 클립과 액션은
 * 생성할 때 캐시하고 update에서는 객체를 만들지 않는다.
 */
export class VrmAnimationController {
  private readonly mixer: THREE.AnimationMixer
  private readonly clips = new Map<VrmAnimationState, THREE.AnimationClip>()
  private readonly actions = new Map<VrmAnimationState, THREE.AnimationAction>()
  private readonly idle: THREE.AnimationAction
  private readonly walk: THREE.AnimationAction
  private activePlayback: Playback | null = null
  private outgoing: Outgoing | null = null
  private resultState: VrmResultState | null = null
  private resultAction: THREE.AnimationAction | null = null
  private resultBlend = 0
  private walkBlend = 0

  private constructor(
    private readonly vrm: VRM,
    private readonly cls: PlayerClass,
    animations: readonly VRMAnimation[],
  ) {
    if (
      vrm.lookAt &&
      !vrm.scene.children.some(
        (child) => child instanceof VRMLookAtQuaternionProxy,
      )
    ) {
      const lookAtProxy = new VRMLookAtQuaternionProxy(vrm.lookAt)
      lookAtProxy.name = 'VRMLookAtQuaternionProxy'
      vrm.scene.add(lookAtProxy)
    }

    this.mixer = new THREE.AnimationMixer(vrm.scene)

    for (let index = 0; index < VRMA_CLIP_ORDER.length; index += 1) {
      const name = VRMA_CLIP_ORDER[index]!
      if (!name.startsWith(`${cls}.`)) continue

      const animation = animations[index]
      if (!animation) throw new Error(`[vrma] missing source clip: ${name}`)

      const state = name.slice(cls.length + 1) as VrmAnimationState
      const clip = createVRMAnimationClip(animation, vrm)
      clip.name = name
      clip.optimize()
      if (!clip.validate() || clip.tracks.length === 0) {
        throw new Error(`[vrma] invalid or empty clip: ${name}`)
      }

      const action = this.mixer.clipAction(clip)
      this.clips.set(state, clip)
      this.actions.set(state, action)
    }

    const idle = this.actions.get('idle')
    const walk = this.actions.get('walk')
    const victory = this.actions.get('victory')
    const defeat = this.actions.get('defeat')
    if (!idle || !walk || !victory || !defeat || this.actions.size !== 11) {
      throw new Error(`[vrma] incomplete ${cls} clip set`)
    }
    this.idle = idle
    this.walk = walk

    this.idle.setLoop(THREE.LoopRepeat, Infinity).setEffectiveWeight(1).play()
    this.walk.setLoop(THREE.LoopRepeat, Infinity).setEffectiveWeight(0).play()
  }

  static create(
    vrm: VRM,
    cls: PlayerClass,
    animations: readonly VRMAnimation[] | null,
  ): VrmAnimationController | null {
    if (!animations || animations.length !== VRMA_CLIP_ORDER.length) return null
    try {
      return new VrmAnimationController(vrm, cls, animations)
    } catch (error) {
      console.warn('[vrma] 클립 생성 실패, 기존 모션으로 대체합니다.', error)
      return null
    }
  }

  playAction(
    kind: CharacterAction,
    time: number,
    startedAt = time,
  ): boolean {
    if (this.resultState) return false

    const eventStartedAt = Number.isFinite(startedAt) ? startedAt : time
    const previous = this.activePlayback
    const current = this.active(time)

    if (previous) {
      const sameEvent =
        previous.kind === kind &&
        Math.abs(previous.startedAt - eventStartedAt) <= ACTION_TIME_EPSILON
      if (sameEvent) return true

      // 늦게 도착한 과거 이벤트가 최신 동작을 되감지 못하게 한다.
      if (eventStartedAt < previous.startedAt - ACTION_TIME_EPSILON) return false

      // QWER는 이미 시뮬레이션이 승인한 이벤트다. 렌더러의 이전 클립 잔여
      // 상태 때문에 같은 우선순위의 다음 스킬을 버리지 않는다. 평타와 궁극
      // 후속타는 R 같은 상위 동작을 끊을 수 없도록 기존 우선순위를 유지한다.
      const authoritativeSuccessor =
        isPrimarySkill(kind) &&
        eventStartedAt > previous.startedAt + ACTION_TIME_EPSILON
      if (
        !authoritativeSuccessor &&
        !canStartVrmAction(current?.kind ?? null, current?.progress ?? 1, kind)
      ) {
        return false
      }
    }

    const next = this.actions.get(kind)
    const clip = this.clips.get(kind)
    if (!next || !clip) return false

    if (this.outgoing) {
      this.outgoing.action.stop()
      this.outgoing = null
    }

    if (previous) {
      if (previous.kind !== kind) {
        this.syncPlaybackTime(previous, time)
        this.outgoing = {
          kind: previous.kind,
          action: previous.action,
          weight: actionWeight(this.elapsed(previous, time), previous.duration),
          remaining: ACTION_CROSS_FADE,
        }
      } else {
        previous.action.stop()
      }
    }

    next
      .reset()
      .setLoop(THREE.LoopOnce, 1)
      // one-shot은 시뮬레이션 시각으로 직접 샘플링한다. 브라우저 wall-clock이나
      // 프레임 드롭이 클립 진행률에 영향을 주지 않는다.
      .setEffectiveTimeScale(1)
      .setEffectiveWeight(0)
    next.clampWhenFinished = true
    next.play()
    next.paused = true

    this.activePlayback = {
      kind,
      action: next,
      startedAt: eventStartedAt,
      duration: playerActionDuration(this.cls, kind),
      clipDuration: clip.duration,
    }
    this.syncPlaybackTime(this.activePlayback, time)
    return true
  }

  /**
   * 결과 루프를 켜거나 해제한다.
   *
   * 0초/마지막 프레임은 같은 정착 자세이고, 첫 진입만 entryTime에서 시작해
   * 승리의 준비 동작이나 패배의 무너짐을 먼저 보여 준다.
   */
  setResult(state: VrmResultState | null): void {
    if (state === this.resultState) return

    this.resultAction?.stop()
    this.resultAction = null
    this.resultState = state
    this.resultBlend = 0

    if (this.activePlayback) {
      this.activePlayback.action.stop()
      this.activePlayback = null
    }
    if (this.outgoing) {
      this.outgoing.action.stop()
      this.outgoing = null
    }

    if (!state) {
      this.idle.setEffectiveWeight(1)
      this.walk.setEffectiveWeight(0)
      return
    }

    const action = this.actions.get(state)
    if (!action) return
    action
      .reset()
      .setLoop(THREE.LoopRepeat, Infinity)
      .setEffectiveTimeScale(1)
      .setEffectiveWeight(0)
      .play()
    action.paused = false
    action.time = VRM_RESULT_MOTIONS[this.cls][state].entryTime
    this.resultAction = action
    this.walkBlend = 0
  }

  active(time: number): ActiveVrmAction | null {
    const playback = this.activePlayback
    if (!playback) return null
    return {
      kind: playback.kind,
      progress: this.progress(playback, time),
    }
  }

  update(dt: number, time: number, speed: number): void {
    const delta = Math.min(0.1, Math.max(0, dt))
    if (this.resultState && this.resultAction) {
      this.resultBlend +=
        (1 - this.resultBlend) *
        (1 - Math.exp(-delta * (4.6 / RESULT_FADE_IN)))
      if (this.resultBlend > 0.999) this.resultBlend = 1
      this.resultAction.setEffectiveWeight(this.resultBlend)
      this.idle.setEffectiveWeight(1 - this.resultBlend)
      this.walk.setEffectiveWeight(0)
      this.mixer.update(delta)
      return
    }

    const targetWalk = smoothstep(0.02, 0.62, clamp01(speed / 8))
    this.walkBlend +=
      (targetWalk - this.walkBlend) * (1 - Math.exp(-delta * 11))

    let activeWeight = 0
    const active = this.activePlayback
    if (active) {
      const elapsed = this.elapsed(active, time)
      const progress = elapsed / active.duration
      if (progress >= 1) {
        active.action.stop()
        this.activePlayback = null
      } else {
        this.syncPlaybackTime(active, time)
        activeWeight = actionWeight(elapsed, active.duration)
        active.action.setEffectiveWeight(activeWeight)
      }
    }

    let outgoingWeight = 0
    if (this.outgoing) {
      this.outgoing.remaining = Math.max(0, this.outgoing.remaining - delta)
      outgoingWeight =
        this.outgoing.weight *
        smoothstep(0, ACTION_CROSS_FADE, this.outgoing.remaining)
      this.outgoing.action.setEffectiveWeight(outgoingWeight)
      if (this.outgoing.remaining <= 0) {
        this.outgoing.action.stop()
        this.outgoing = null
      }
    }

    // one-shot은 전신 트랙이므로 평타뿐 아니라 이동 중 QWER도 걷기를 통째로
    // 덮을 수 있다. 실제 보행량을 다시 walkBlend로 곱하기 전에 locomotion
    // 층 자체를 예약해야, 중간 속도에서도 다리가 의미 있게 움직인다.
    const activeLocomotionFloor = active
      ? ACTION_LOCOMOTION_FLOOR[active.kind]
      : 0
    const outgoingLocomotionFloor = this.outgoing
      ? ACTION_LOCOMOTION_FLOOR[this.outgoing.kind]
      : 0
    const locomotionFloor =
      this.walkBlend > 0.08
        ? Math.max(activeLocomotionFloor, outgoingLocomotionFloor)
        : 0

    // 빠른 스킬 캔슬에서는 나가는 모션과 새 모션의 페이드 곡선이 잠깐
    // 겹칠 수 있다. 보행층 예약분을 제외한 합을 제한해야 관절 회전이
    // 과장되지 않고 전체 블렌드가 항상 볼록 결합으로 유지된다.
    const oneShotWeight = activeWeight + outgoingWeight
    const maxOneShotWeight = 1 - locomotionFloor
    if (oneShotWeight > maxOneShotWeight) {
      const scale = maxOneShotWeight / oneShotWeight
      activeWeight *= scale
      outgoingWeight *= scale
      active?.action.setEffectiveWeight(activeWeight)
      this.outgoing?.action.setEffectiveWeight(outgoingWeight)
    }

    const locomotionWeight = Math.max(0, 1 - activeWeight - outgoingWeight)
    this.idle.setEffectiveWeight((1 - this.walkBlend) * locomotionWeight)
    this.walk
      .setEffectiveWeight(this.walkBlend * locomotionWeight)
      .setEffectiveTimeScale(0.78 + clamp01(speed / 8) * 0.74)

    this.mixer.update(delta)
  }

  dispose(): void {
    this.mixer.stopAllAction()
    for (const clip of this.clips.values()) this.mixer.uncacheClip(clip)
    this.mixer.uncacheRoot(this.vrm.scene)
    this.clips.clear()
    this.actions.clear()
    this.activePlayback = null
    this.outgoing = null
    this.resultState = null
    this.resultAction = null
  }

  private progress(playback: Playback, time: number): number {
    return this.elapsed(playback, time) / playback.duration
  }

  private elapsed(playback: Playback, time: number): number {
    return Math.max(0, time - playback.startedAt)
  }

  private syncPlaybackTime(playback: Playback, time: number): void {
    playback.action.time =
      playback.clipDuration *
      clamp01(this.elapsed(playback, time) / playback.duration)
  }
}
