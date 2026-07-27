import type { PlayerClass } from '../sim/types.ts'
import { PLAYER_ACTION_DURATION } from '../sim/action-timing.ts'
import type { CharacterAction } from './rig.ts'

export type VrmVec3 = [number, number, number]
export type VrmArmPose = [forward: number, twist: number, raise: number, elbow: number]

export interface VrmPose {
  hips: VrmVec3
  spine: VrmVec3
  chest: VrmVec3
  head: VrmVec3
  armR: VrmArmPose
  armL: VrmArmPose
  aim: VrmVec3
  lift: number
}

export interface Timing {
  wind: number
  tWind: number
  tStrike: number
  tHold: number
  overshoot: number
}

export const VRM_REST = {
  armDown: 1.31,
  armForward: -0.06,
  elbow: 0.16,
  legSplay: 0.028,
} as const

export const ZERO_POSE: VrmPose = {
  hips: [0, 0, 0],
  spine: [0, 0, 0],
  chest: [0, 0, 0],
  head: [0, 0, 0],
  armR: [0, 0, 0, 0],
  armL: [0, 0, 0, 0],
  aim: [0, 0, 0],
  lift: 0,
}

export const VRM_ACTION_DURATION = PLAYER_ACTION_DURATION

export const VRM_POSES: Record<PlayerClass, Record<CharacterAction, VrmPose>> = {
  ranged: {
    attack: {
      hips: [0, -0.04, 0],
      spine: [0.01, -0.09, 0.02],
      chest: [0, -0.06, 0],
      head: [0.01, 0.1, 0],
      armR: [0.04, 0.02, 0.06, 0.03],
      armL: [0.02, 0, 0.03, 0.04],
      aim: [0, 0, -0.07],
      lift: 0,
    },
    empowered: {
      hips: [0, -0.2, 0.04],
      spine: [-0.06, -0.3, 0.08],
      chest: [-0.04, -0.16, 0.04],
      head: [0.04, 0.26, 0],
      armR: [0.65, 0.2, 1, 0.45],
      armL: [0.32, 0.05, 0.45, 0.5],
      aim: [0, 0, 0.42],
      lift: 0.02,
    },
    ult: {
      hips: [0.16, -0.2, 0.06],
      spine: [0.3, -0.34, 0.12],
      chest: [0.16, -0.18, 0.06],
      head: [0.14, 0.24, 0],
      armR: [0.95, 0.25, 0.95, 0.2],
      armL: [0.25, 0.1, 0.55, 0.65],
      aim: [0, 0, 0.5],
      lift: 0.04,
    },
    q: {
      hips: [0, -0.26, 0],
      spine: [0.1, -0.4, 0.06],
      chest: [0.04, -0.2, 0],
      head: [0.06, 0.34, 0],
      armR: [0.8, 0.25, 1.15, 0.25],
      armL: [-0.3, -0.2, 0.45, 0.95],
      aim: [0, 0, 0.24],
      lift: 0.01,
    },
    w: {
      hips: [-0.16, 0.34, -0.12],
      spine: [-0.2, 0.4, -0.16],
      chest: [-0.1, 0.2, -0.08],
      head: [0.1, -0.5, 0.1],
      armR: [-0.3, -0.15, 0.5, 0.8],
      armL: [0.5, 0.2, 0.8, 0.6],
      aim: [0.3, 0, -0.3],
      lift: 0.09,
    },
    e: {
      hips: [-0.1, 0, 0],
      spine: [-0.26, 0.12, 0],
      chest: [-0.16, 0.06, 0],
      head: [-0.24, 0, 0],
      armR: [0.15, 0.3, 1.9, 0.8],
      armL: [0.4, 0.35, 1.05, 1.3],
      aim: [0, 0, -0.4],
      lift: 0.05,
    },
    r: {
      hips: [0.12, -0.16, 0],
      spine: [-0.4, -0.24, 0.1],
      chest: [-0.24, -0.12, 0.06],
      head: [-0.3, 0.2, 0],
      armR: [0.1, 0.25, 2.3, 0.35],
      armL: [0.35, 0.3, 1, 1.35],
      aim: [0, 0, -0.55],
      lift: 0.13,
    },
  },
  melee: {
    attack: {
      hips: [0, 0.22, 0],
      spine: [0.14, -0.42, 0.16],
      chest: [0.08, -0.24, 0.1],
      head: [0.04, 0.3, 0.06],
      armR: [0.55, 0.25, 1, 0.5],
      armL: [-0.25, -0.15, 0.45, 0.65],
      aim: [0, 0, 0.55],
      lift: 0.01,
    },
    empowered: {
      hips: [-0.04, 0.5, -0.06],
      spine: [0.18, -0.75, 0.26],
      chest: [0.1, -0.4, 0.16],
      head: [0.06, 0.55, 0.1],
      armR: [0.7, 0.3, 1.18, 0.4],
      armL: [-0.35, -0.2, 0.6, 0.85],
      aim: [0, 0, 0.85],
      lift: 0.04,
    },
    ult: {
      hips: [0.34, 0.1, 0],
      spine: [0.5, -0.3, 0.12],
      chest: [0.26, -0.16, 0.06],
      head: [0.2, 0.2, 0],
      armR: [0.75, 0.25, 0.45, 0.4],
      armL: [0.15, 0.1, 0.35, 0.75],
      aim: [0, 0, 0.75],
      lift: -0.05,
    },
    q: {
      hips: [0.16, 0.4, -0.08],
      spine: [0.24, -0.66, 0.22],
      chest: [0.12, -0.34, 0.12],
      head: [0.02, 0.5, 0.08],
      armR: [0.65, 0.4, 0.72, 0.95],
      armL: [-0.15, -0.3, 0.55, 1.05],
      aim: [0, 0, 0.7],
      lift: -0.03,
    },
    w: {
      hips: [0.3, -0.2, 0],
      spine: [0.36, 0.3, -0.12],
      chest: [0.2, 0.16, -0.06],
      head: [-0.24, -0.3, 0],
      armR: [-0.55, -0.2, 0.5, 0.55],
      armL: [0.6, 0.25, 0.7, 0.95],
      aim: [0, 0, -0.5],
      lift: 0.11,
    },
    e: {
      hips: [-0.06, -0.62, 0.1],
      spine: [0.1, 0.85, -0.2],
      chest: [0.04, 0.45, -0.1],
      head: [0.04, -0.7, -0.1],
      armR: [0.02, 0.2, 0.92, 0.3],
      armL: [-0.4, -0.2, 0.85, 0.45],
      aim: [0, 0, 0.35],
      lift: 0.03,
    },
    r: {
      hips: [-0.2, 0.3, 0],
      spine: [-0.42, -0.5, 0.18],
      chest: [-0.24, -0.26, 0.1],
      head: [-0.34, 0.34, 0],
      armR: [0.05, 0.15, 2.25, 0.3],
      armL: [0.3, 0.25, 1.15, 1.2],
      aim: [0, 0, -0.6],
      lift: 0.16,
    },
  },
}

export const VRM_TIMING: Record<CharacterAction, Timing> = {
  attack: { wind: 0.3, tWind: 0.22, tStrike: 0.42, tHold: 0.5, overshoot: 0.1 },
  empowered: { wind: 0.42, tWind: 0.26, tStrike: 0.46, tHold: 0.56, overshoot: 0.14 },
  ult: { wind: 0.18, tWind: 0.14, tStrike: 0.32, tHold: 0.44, overshoot: 0.1 },
  q: { wind: 0.35, tWind: 0.24, tStrike: 0.44, tHold: 0.54, overshoot: 0.12 },
  w: { wind: 0.14, tWind: 0.1, tStrike: 0.26, tHold: 0.42, overshoot: 0.08 },
  e: { wind: 0.45, tWind: 0.3, tStrike: 0.52, tHold: 0.66, overshoot: 0.12 },
  r: { wind: 0.55, tWind: 0.34, tStrike: 0.58, tHold: 0.72, overshoot: 0.16 },
}

export type VrmAnimationState = 'idle' | 'walk' | CharacterAction
export type VrmaClipName = `${PlayerClass}.${VrmAnimationState}`

export const VRMA_CLIP_ORDER = [
  'ranged.idle',
  'ranged.walk',
  'ranged.attack',
  'ranged.empowered',
  'ranged.ult',
  'ranged.q',
  'ranged.w',
  'ranged.e',
  'ranged.r',
  'melee.idle',
  'melee.walk',
  'melee.attack',
  'melee.empowered',
  'melee.ult',
  'melee.q',
  'melee.w',
  'melee.e',
  'melee.r',
] as const satisfies readonly VrmaClipName[]

export function clipKey(cls: PlayerClass, state: VrmAnimationState): VrmaClipName {
  return `${cls}.${state}`
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t)
}

function easeIn(t: number): number {
  return t * t
}

export function actionEnvelope(t: number, timing: Timing): number {
  const x = clamp01(t)
  if (x < timing.tWind) return lerp(0, -timing.wind, easeOut(x / timing.tWind))
  if (x < timing.tStrike) {
    return lerp(
      -timing.wind,
      1,
      easeIn((x - timing.tWind) / (timing.tStrike - timing.tWind)),
    )
  }
  if (x < timing.tHold) return 1
  const recovery = (x - timing.tHold) / (1 - timing.tHold)
  return recovery < 0.65
    ? lerp(1, -timing.overshoot, easeOut(recovery / 0.65))
    : lerp(-timing.overshoot, 0, (recovery - 0.65) / 0.35)
}
