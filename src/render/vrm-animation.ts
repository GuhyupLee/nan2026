import * as THREE from 'three'
import {
  createVRMAnimationClip,
  type VRMAnimation,
} from '@pixiv/three-vrm-animation'
import type { VRM } from '@pixiv/three-vrm'
import type { PlayerClass } from '../sim/types.ts'
import type { CharacterAction } from './rig.ts'
import {
  VRM_ACTION_DURATION,
  VRMA_CLIP_ORDER,
  type VrmAnimationState,
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

const RECOVERY_START: Record<CharacterAction, number> = {
  attack: 0.72,
  empowered: 0.74,
  ult: 0.72,
  q: 0.76,
  w: 0.7,
  e: 0.8,
  r: 0.84,
}

const ACTION_CROSS_FADE = 0.08

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

  return currentProgress >= RECOVERY_START[current]
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

function actionWeight(progress: number): number {
  const enter = smoothstep(0, 0.1, progress)
  const leave = 1 - smoothstep(0.82, 1, progress)
  return enter * leave
}

interface Playback {
  kind: CharacterAction
  action: THREE.AnimationAction
  startedAt: number
  duration: number
}

interface Outgoing {
  action: THREE.AnimationAction
  weight: number
  remaining: number
}

/**
 * 한 VRM 인스턴스의 idle/walk/전투 클립을 관리한다.
 *
 * 동시에 활성화되는 것은 idle, walk, one-shot 세 개뿐이다. 클립과 액션은
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
  private walkBlend = 0

  private constructor(
    private readonly vrm: VRM,
    cls: PlayerClass,
    animations: readonly VRMAnimation[],
  ) {
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
    if (!idle || !walk || this.actions.size !== 9) {
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

  playAction(kind: CharacterAction, time: number): boolean {
    const current = this.active(time)
    if (!canStartVrmAction(current?.kind ?? null, current?.progress ?? 1, kind)) {
      return false
    }

    const next = this.actions.get(kind)
    const clip = this.clips.get(kind)
    if (!next || !clip) return false

    if (this.outgoing) {
      this.outgoing.action.stop()
      this.outgoing = null
    }

    const previous = this.activePlayback
    if (previous) {
      if (previous.kind !== kind) {
        this.outgoing = {
          action: previous.action,
          weight: actionWeight(this.progress(previous, time)),
          remaining: ACTION_CROSS_FADE,
        }
      } else {
        previous.action.stop()
      }
    }

    next
      .reset()
      .setLoop(THREE.LoopOnce, 1)
      .setEffectiveTimeScale(clip.duration / VRM_ACTION_DURATION[kind])
      .setEffectiveWeight(0)
    next.clampWhenFinished = true
    next.play()

    this.activePlayback = {
      kind,
      action: next,
      startedAt: time,
      duration: VRM_ACTION_DURATION[kind],
    }
    return true
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
    const targetWalk = smoothstep(0.02, 0.62, clamp01(speed / 8))
    this.walkBlend +=
      (targetWalk - this.walkBlend) * (1 - Math.exp(-delta * 11))

    let activeWeight = 0
    const active = this.activePlayback
    if (active) {
      const progress = this.progress(active, time)
      if (progress >= 1) {
        active.action.stop()
        this.activePlayback = null
      } else {
        activeWeight = actionWeight(progress)
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

    // 빠른 스킬 캔슬에서는 나가는 모션과 새 모션의 페이드 곡선이 잠깐
    // 겹칠 수 있다. 합을 1로 제한해야 관절 회전이 과장되지 않고 대기/걷기
    // 가중치까지 포함한 블렌드가 항상 볼록 결합으로 유지된다.
    const oneShotWeight = activeWeight + outgoingWeight
    if (oneShotWeight > 1) {
      const scale = 1 / oneShotWeight
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
  }

  private progress(playback: Playback, time: number): number {
    return Math.max(0, (time - playback.startedAt) / playback.duration)
  }
}
