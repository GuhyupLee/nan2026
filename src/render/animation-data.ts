import type { PlayerClass } from '../sim/types.ts'
import {
  PLAYER_ACTION_DURATION,
  playerActionDuration,
  playerActionTiming,
} from '../sim/action-timing.ts'
import type { CharacterAction } from './rig.ts'

export type VrmVec3 = [x: number, y: number, z: number]

export type VrmBoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'leftShoulder'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'leftHand'
  | 'rightShoulder'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'rightHand'
  | 'leftUpperLeg'
  | 'leftLowerLeg'
  | 'leftFoot'
  | 'rightUpperLeg'
  | 'rightLowerLeg'
  | 'rightFoot'

export type VrmActionStage =
  | 'start'
  | 'anticipation'
  | 'contact'
  | 'followThrough'
  | 'recovery'

export interface VrmActionKeyframe {
  stage: VrmActionStage
  /** Seconds from the beginning of the clip. */
  time: number
  /** Absolute humanoid Hips height. Root X/Z are intentionally not authored. */
  hipsY: number
  /** Absolute normalized-humanoid local rotations, in XYZ Euler radians. */
  rotations: Readonly<Record<VrmBoneName, VrmVec3>>
}

export interface VrmActionMotion {
  duration: number
  keyframes: readonly VrmActionKeyframe[]
}

type PosePatch = Partial<Record<VrmBoneName, VrmVec3>>

interface StagePose {
  hipsY?: number
  rotations: PosePatch
}

export const VRM_ACTION_DURATION = PLAYER_ACTION_DURATION

/** Class-aware duration used by playback; melee W has a longer authored recovery. */
export function vrmActionDuration(cls: PlayerClass, action: CharacterAction): number {
  return playerActionDuration(cls, action)
}

export const VRM_REST = {
  armDown: 1.31,
  armForward: -0.06,
  elbow: 0.16,
  legSplay: 0.028,
} as const

/**
 * The named stage peaks are authored in seconds so gameplay impacts can line up with
 * visible contacts. Melee W deliberately spends about 0.16 s drawing before it cuts.
 */
export const VRM_ACTION_PHASE_SECONDS: Readonly<
  Record<
    CharacterAction,
    Readonly<Record<Exclude<VrmActionStage, 'start'>, number>>
  >
> = {
  attack: { anticipation: 0.06, contact: 0.1, followThrough: 0.17, recovery: 0.26 },
  empowered: { anticipation: 0.14, contact: 0.22, followThrough: 0.32, recovery: 0.46 },
  ult: { anticipation: 0.07, contact: 0.11, followThrough: 0.21, recovery: 0.34 },
  q: { anticipation: 0.1, contact: 0.16, followThrough: 0.24, recovery: 0.36 },
  w: { anticipation: 0.07, contact: 0.11, followThrough: 0.24, recovery: 0.44 },
  e: { anticipation: 0.21, contact: 0.3, followThrough: 0.41, recovery: 0.58 },
  r: { anticipation: 0.38, contact: 0.52, followThrough: 0.68, recovery: 0.9 },
}

export function vrmActionPhaseSeconds(
  cls: PlayerClass,
  action: CharacterAction,
): Readonly<Record<Exclude<VrmActionStage, 'start'>, number>> {
  if (cls === 'melee' && action === 'w') {
    return {
      anticipation: 0.16,
      contact: 0.32,
      followThrough: 0.42,
      recovery: vrmActionDuration(cls, action),
    }
  }
  const authored = VRM_ACTION_PHASE_SECONDS[action]
  const impact = playerActionTiming(cls, action).impact
  // Basic attacks still deal damage immediately in simulation; their visual contacts
  // remain authored. Every timed skill uses the simulation impact as the source of truth.
  if (action === 'attack' || action === 'empowered') return authored
  return {
    anticipation: Math.min(authored.anticipation, impact * 0.68),
    contact: impact,
    followThrough: authored.followThrough,
    recovery: vrmActionDuration(cls, action),
  }
}

const RANGED_STANCE: Readonly<Record<VrmBoneName, VrmVec3>> = {
  hips: [0.025, -0.06, -0.015],
  spine: [0.035, 0.045, 0.018],
  chest: [-0.018, 0.035, -0.012],
  neck: [0.006, -0.025, 0.006],
  head: [-0.012, -0.02, 0.008],
  leftShoulder: [0.025, 0.04, -0.035],
  leftUpperArm: [-0.17, -0.12, -1.12],
  leftLowerArm: [-0.08, -0.52, -0.12],
  leftHand: [0.04, -0.08, 0.09],
  rightShoulder: [0.018, -0.035, 0.03],
  rightUpperArm: [-0.24, 0.14, 1.03],
  rightLowerArm: [-0.1, 0.58, 0.1],
  rightHand: [-0.05, 0.11, -0.08],
  leftUpperLeg: [-0.06, 0.045, -0.055],
  leftLowerLeg: [0.13, -0.018, 0.025],
  leftFoot: [-0.07, -0.025, 0.018],
  rightUpperLeg: [0.035, -0.04, 0.05],
  rightLowerLeg: [0.09, 0.02, -0.02],
  rightFoot: [-0.05, 0.025, -0.016],
}

const MELEE_STANCE: Readonly<Record<VrmBoneName, VrmVec3>> = {
  hips: [0.05, 0.11, -0.035],
  spine: [0.08, -0.1, 0.045],
  chest: [-0.025, -0.08, 0.03],
  neck: [-0.005, 0.045, -0.012],
  head: [-0.03, 0.035, -0.018],
  leftShoulder: [0.035, 0.05, -0.055],
  leftUpperArm: [-0.2, -0.18, -1.02],
  leftLowerArm: [-0.1, -0.46, -0.14],
  leftHand: [0.05, -0.12, 0.08],
  rightShoulder: [0.055, -0.09, 0.065],
  rightUpperArm: [-0.28, 0.22, 0.88],
  rightLowerArm: [-0.12, 0.62, 0.18],
  rightHand: [-0.12, 0.18, -0.16],
  leftUpperLeg: [-0.12, 0.1, -0.09],
  leftLowerLeg: [0.24, -0.045, 0.04],
  leftFoot: [-0.12, -0.06, 0.035],
  rightUpperLeg: [0.07, -0.09, 0.075],
  rightLowerLeg: [0.16, 0.04, -0.035],
  rightFoot: [-0.09, 0.055, -0.03],
}

export const VRM_CLASS_STANCE = {
  ranged: RANGED_STANCE,
  melee: MELEE_STANCE,
} as const satisfies Readonly<Record<PlayerClass, Readonly<Record<VrmBoneName, VrmVec3>>>>

function mergePose(
  base: Readonly<Record<VrmBoneName, VrmVec3>>,
  patch: PosePatch,
): Readonly<Record<VrmBoneName, VrmVec3>> {
  return Object.fromEntries(
    (Object.keys(base) as VrmBoneName[]).map((bone) => [bone, patch[bone] ?? base[bone]]),
  ) as Record<VrmBoneName, VrmVec3>
}

function frame(
  stage: VrmActionStage,
  time: number,
  base: Readonly<Record<VrmBoneName, VrmVec3>>,
  pose?: StagePose,
): VrmActionKeyframe {
  return {
    stage,
    time,
    hipsY: pose?.hipsY ?? 1,
    rotations: mergePose(base, pose?.rotations ?? {}),
  }
}

function motion(
  cls: PlayerClass,
  action: CharacterAction,
  anticipation: StagePose,
  contact: StagePose,
  followThrough: StagePose,
): VrmActionMotion {
  const base = VRM_CLASS_STANCE[cls]
  const phase = vrmActionPhaseSeconds(cls, action)
  return {
    duration: vrmActionDuration(cls, action),
    keyframes: [
      frame('start', 0, base),
      frame('anticipation', phase.anticipation, base, anticipation),
      frame('contact', phase.contact, base, contact),
      frame('followThrough', phase.followThrough, base, followThrough),
      frame('recovery', phase.recovery, base),
    ],
  }
}

/**
 * Hand-authored combat keys. Every move has a different wind-up, contact silhouette,
 * follow-through and recovery; the generator samples these curves at 30 fps.
 */
export const VRM_ACTION_MOTIONS: Readonly<
  Record<PlayerClass, Readonly<Record<CharacterAction, VrmActionMotion>>>
> = {
  ranged: {
    // Short right-palm bolt: draw to the ribs, snap forward, then absorb recoil.
    attack: motion(
      'ranged',
      'attack',
      {
        hipsY: 0.985,
        rotations: {
          hips: [0.08, 0.24, -0.06],
          spine: [0.12, -0.28, 0.09],
          chest: [-0.05, -0.32, 0.07],
          head: [-0.06, 0.22, -0.04],
          leftUpperArm: [-0.34, -0.28, -0.86],
          leftLowerArm: [-0.14, -0.74, -0.22],
          leftHand: [0.16, -0.22, 0.18],
          rightUpperArm: [0.18, 0.42, 0.72],
          rightLowerArm: [-0.28, 0.94, 0.26],
          rightHand: [-0.28, 0.34, -0.24],
          leftUpperLeg: [-0.18, 0.13, -0.11],
          leftLowerLeg: [0.31, -0.07, 0.06],
          leftFoot: [-0.16, -0.09, 0.05],
          rightUpperLeg: [0.12, -0.12, 0.1],
          rightLowerLeg: [0.22, 0.06, -0.05],
          rightFoot: [-0.12, 0.08, -0.04],
        },
      },
      {
        hipsY: 0.972,
        rotations: {
          hips: [-0.04, -0.27, 0.08],
          spine: [-0.08, 0.36, -0.11],
          chest: [0.06, 0.42, -0.08],
          head: [0.02, -0.3, 0.05],
          leftUpperArm: [-0.18, -0.08, -0.98],
          leftLowerArm: [-0.18, -0.58, -0.12],
          leftHand: [0.08, -0.16, 0.12],
          rightUpperArm: [-1.18, -0.18, 0.18],
          rightLowerArm: [-0.18, 0.24, -0.08],
          rightHand: [-0.05, -0.22, 0.32],
          leftUpperLeg: [-0.28, 0.16, -0.14],
          leftLowerLeg: [0.44, -0.08, 0.09],
          leftFoot: [-0.21, -0.11, 0.07],
          rightUpperLeg: [0.22, -0.15, 0.12],
          rightLowerLeg: [0.28, 0.08, -0.07],
          rightFoot: [-0.16, 0.1, -0.06],
        },
      },
      {
        hipsY: 0.982,
        rotations: {
          hips: [0.01, -0.15, 0.045],
          spine: [0.03, 0.2, -0.065],
          chest: [-0.02, 0.25, -0.04],
          head: [-0.025, -0.16, 0.03],
          leftUpperArm: [-0.22, -0.12, -1.04],
          leftLowerArm: [-0.12, -0.61, -0.16],
          leftHand: [0.1, -0.12, 0.08],
          rightUpperArm: [-0.76, -0.12, 0.48],
          rightLowerArm: [-0.22, 0.46, -0.12],
          rightHand: [0.12, -0.18, 0.22],
          leftUpperLeg: [-0.16, 0.11, -0.09],
          leftLowerLeg: [0.29, -0.055, 0.055],
          leftFoot: [-0.14, -0.075, 0.04],
          rightUpperLeg: [0.13, -0.1, 0.08],
          rightLowerLeg: [0.19, 0.05, -0.045],
          rightFoot: [-0.1, 0.07, -0.035],
        },
      },
    ),

    // Two-hand compression and a broad, heavy energy discharge.
    empowered: motion(
      'ranged',
      'empowered',
      {
        hipsY: 0.955,
        rotations: {
          hips: [0.18, 0.38, -0.12],
          spine: [0.24, -0.48, 0.16],
          chest: [-0.12, -0.54, 0.12],
          head: [-0.12, 0.38, -0.08],
          leftUpperArm: [0.22, -0.52, -0.48],
          leftLowerArm: [-0.32, -1.02, -0.36],
          leftHand: [0.34, -0.48, 0.31],
          rightUpperArm: [0.28, 0.56, 0.42],
          rightLowerArm: [-0.38, 1.08, 0.4],
          rightHand: [-0.38, 0.52, -0.34],
          leftUpperLeg: [-0.36, 0.2, -0.18],
          leftLowerLeg: [0.58, -0.11, 0.12],
          leftFoot: [-0.27, -0.15, 0.1],
          rightUpperLeg: [0.3, -0.19, 0.17],
          rightLowerLeg: [0.46, 0.1, -0.1],
          rightFoot: [-0.23, 0.14, -0.09],
        },
      },
      {
        hipsY: 0.93,
        rotations: {
          hips: [-0.13, -0.42, 0.16],
          spine: [-0.16, 0.55, -0.2],
          chest: [0.14, 0.64, -0.16],
          head: [0.08, -0.48, 0.1],
          leftUpperArm: [-1.02, 0.16, -0.28],
          leftLowerArm: [-0.24, -0.3, 0.22],
          leftHand: [-0.18, 0.26, 0.46],
          rightUpperArm: [-1.06, -0.16, 0.26],
          rightLowerArm: [-0.26, 0.32, -0.2],
          rightHand: [0.2, -0.28, -0.44],
          leftUpperLeg: [-0.48, 0.24, -0.22],
          leftLowerLeg: [0.7, -0.14, 0.15],
          leftFoot: [-0.32, -0.18, 0.12],
          rightUpperLeg: [0.4, -0.23, 0.2],
          rightLowerLeg: [0.56, 0.13, -0.13],
          rightFoot: [-0.28, 0.17, -0.11],
        },
      },
      {
        hipsY: 0.962,
        rotations: {
          hips: [0.04, -0.26, 0.09],
          spine: [0.08, 0.34, -0.13],
          chest: [-0.04, 0.4, -0.1],
          head: [-0.05, -0.28, 0.065],
          leftUpperArm: [-0.64, 0.04, -0.62],
          leftLowerArm: [-0.2, -0.42, 0.08],
          leftHand: [-0.08, 0.12, 0.28],
          rightUpperArm: [-0.68, -0.05, 0.58],
          rightLowerArm: [-0.22, 0.45, -0.07],
          rightHand: [0.09, -0.14, -0.27],
          leftUpperLeg: [-0.29, 0.17, -0.14],
          leftLowerLeg: [0.46, -0.09, 0.09],
          leftFoot: [-0.22, -0.12, 0.075],
          rightUpperLeg: [0.24, -0.16, 0.13],
          rightLowerLeg: [0.36, 0.085, -0.08],
          rightFoot: [-0.18, 0.11, -0.065],
        },
      },
    ),

    // Quick overdrive follow-up: lift the core, spear both palms, recoil upward.
    ult: motion(
      'ranged',
      'ult',
      {
        hipsY: 1.015,
        rotations: {
          hips: [-0.12, 0.2, 0.08],
          spine: [-0.2, -0.27, -0.1],
          chest: [-0.14, -0.32, -0.07],
          head: [0.08, 0.22, 0.05],
          leftUpperArm: [0.28, -0.34, -0.54],
          leftLowerArm: [-0.38, -0.88, -0.3],
          leftHand: [0.3, -0.4, 0.28],
          rightUpperArm: [0.24, 0.38, 0.5],
          rightLowerArm: [-0.36, 0.92, 0.32],
          rightHand: [-0.32, 0.42, -0.3],
          leftUpperLeg: [-0.16, 0.14, -0.11],
          leftLowerLeg: [0.26, -0.08, 0.07],
          leftFoot: [-0.12, -0.1, 0.055],
          rightUpperLeg: [0.14, -0.13, 0.105],
          rightLowerLeg: [0.22, 0.07, -0.065],
          rightFoot: [-0.11, 0.09, -0.05],
        },
      },
      {
        hipsY: 1.045,
        rotations: {
          hips: [0.1, -0.31, -0.1],
          spine: [0.16, 0.42, 0.13],
          chest: [0.1, 0.5, 0.09],
          head: [-0.07, -0.36, -0.06],
          leftUpperArm: [-1.28, 0.12, -0.18],
          leftLowerArm: [-0.12, -0.18, 0.16],
          leftHand: [-0.12, 0.16, 0.38],
          rightUpperArm: [-1.3, -0.12, 0.16],
          rightLowerArm: [-0.14, 0.2, -0.15],
          rightHand: [0.14, -0.18, -0.36],
          leftUpperLeg: [0.08, 0.12, -0.08],
          leftLowerLeg: [0.12, -0.06, 0.04],
          leftFoot: [-0.05, -0.08, 0.035],
          rightUpperLeg: [-0.06, -0.11, 0.075],
          rightLowerLeg: [0.1, 0.055, -0.038],
          rightFoot: [-0.045, 0.07, -0.032],
        },
      },
      {
        hipsY: 0.99,
        rotations: {
          hips: [0.16, -0.18, -0.07],
          spine: [0.22, 0.25, 0.1],
          chest: [0.14, 0.29, 0.07],
          head: [-0.1, -0.2, -0.05],
          leftUpperArm: [-0.78, 0.04, -0.48],
          leftLowerArm: [-0.2, -0.36, 0.08],
          leftHand: [-0.06, 0.08, 0.23],
          rightUpperArm: [-0.82, -0.04, 0.44],
          rightLowerArm: [-0.21, 0.38, -0.075],
          rightHand: [0.07, -0.1, -0.22],
          leftUpperLeg: [-0.24, 0.15, -0.12],
          leftLowerLeg: [0.38, -0.08, 0.08],
          leftFoot: [-0.18, -0.11, 0.06],
          rightUpperLeg: [0.2, -0.14, 0.11],
          rightLowerLeg: [0.31, 0.075, -0.07],
          rightFoot: [-0.15, 0.1, -0.055],
        },
      },
    ),

    // Q — 머리 위로 빛을 모은 뒤 한 손을 지면으로 내리꽂아 조준점에 낙광을 부른다.
    q: motion(
      'ranged',
      'q',
      {
        hipsY: 0.94,
        rotations: {
          hips: [0.2, -0.18, -0.12],
          spine: [0.28, 0.24, 0.15],
          chest: [-0.16, 0.3, 0.11],
          head: [-0.32, -0.22, -0.08],
          leftUpperArm: [-1.42, -0.36, -0.42],
          leftLowerArm: [-0.62, -0.86, -0.3],
          leftHand: [0.46, -0.36, 0.5],
          rightUpperArm: [-1.62, 0.28, 0.34],
          rightLowerArm: [-0.54, 0.82, 0.28],
          rightHand: [-0.44, 0.34, -0.46],
          leftUpperLeg: [-0.56, 0.26, -0.25],
          leftLowerLeg: [0.78, -0.16, 0.19],
          leftFoot: [-0.36, -0.21, 0.14],
          rightUpperLeg: [0.45, -0.25, 0.22],
          rightLowerLeg: [0.62, 0.15, -0.16],
          rightFoot: [-0.31, 0.19, -0.13],
        },
      },
      {
        hipsY: 0.905,
        rotations: {
          hips: [0.42, 0.44, -0.2],
          spine: [0.56, -0.58, 0.26],
          chest: [0.38, -0.68, 0.2],
          head: [0.24, 0.5, -0.14],
          leftUpperArm: [-0.34, -0.5, -0.92],
          leftLowerArm: [0.16, -0.88, -0.24],
          leftHand: [-0.28, -0.34, 0.24],
          rightUpperArm: [-0.58, 0.24, 0.54],
          rightLowerArm: [0.08, 0.16, -0.1],
          rightHand: [0.5, -0.12, -0.28],
          leftUpperLeg: [-0.74, 0.34, -0.3],
          leftLowerLeg: [1.02, -0.22, 0.25],
          leftFoot: [-0.46, -0.28, 0.18],
          rightUpperLeg: [0.6, -0.33, 0.28],
          rightLowerLeg: [0.82, 0.2, -0.22],
          rightFoot: [-0.4, 0.26, -0.17],
        },
      },
      {
        hipsY: 0.95,
        rotations: {
          hips: [0.18, 0.24, -0.1],
          spine: [0.24, -0.32, 0.14],
          chest: [0.12, -0.38, 0.1],
          head: [0.08, 0.28, -0.08],
          leftUpperArm: [-0.88, 0.34, -0.72],
          leftLowerArm: [-0.28, -0.62, 0.18],
          leftHand: [-0.16, 0.22, 0.36],
          rightUpperArm: [-0.42, 0.16, 0.68],
          rightLowerArm: [-0.04, 0.26, -0.12],
          rightHand: [0.32, -0.16, -0.22],
          leftUpperLeg: [-0.42, 0.22, -0.19],
          leftLowerLeg: [0.61, -0.13, 0.13],
          leftFoot: [-0.28, -0.17, 0.1],
          rightUpperLeg: [0.34, -0.21, 0.17],
          rightLowerLeg: [0.48, 0.12, -0.11],
          rightFoot: [-0.24, 0.15, -0.09],
        },
      },
    ),

    // W — refractive sidestep: compress, pivot away, fan the arms, settle facing front.
    w: motion(
      'ranged',
      'w',
      {
        hipsY: 0.93,
        rotations: {
          hips: [0.28, -0.48, 0.22],
          spine: [0.34, 0.56, -0.26],
          chest: [-0.16, 0.62, -0.2],
          head: [-0.15, -0.52, 0.14],
          leftUpperArm: [0.36, -0.62, -0.44],
          leftLowerArm: [-0.44, -1.02, -0.4],
          leftHand: [0.42, -0.55, 0.36],
          rightUpperArm: [-0.06, 0.7, 0.38],
          rightLowerArm: [-0.36, 1.16, 0.42],
          rightHand: [-0.45, 0.62, -0.38],
          leftUpperLeg: [-0.58, 0.3, -0.26],
          leftLowerLeg: [0.82, -0.18, 0.2],
          leftFoot: [-0.38, -0.23, 0.16],
          rightUpperLeg: [0.48, -0.29, 0.24],
          rightLowerLeg: [0.66, 0.17, -0.18],
          rightFoot: [-0.33, 0.22, -0.15],
        },
      },
      {
        hipsY: 1.025,
        rotations: {
          hips: [-0.18, 0.78, -0.28],
          spine: [-0.28, -0.86, 0.32],
          chest: [0.18, -0.92, 0.25],
          head: [0.12, 0.74, -0.18],
          leftUpperArm: [-0.48, 0.58, -0.78],
          leftLowerArm: [0.24, -0.5, 0.32],
          leftHand: [-0.28, 0.42, -0.44],
          rightUpperArm: [-0.52, -0.62, 0.72],
          rightLowerArm: [0.22, 0.54, -0.3],
          rightHand: [0.3, -0.46, 0.42],
          leftUpperLeg: [0.24, -0.42, -0.18],
          leftLowerLeg: [0.34, 0.25, -0.15],
          leftFoot: [-0.14, 0.31, 0.13],
          rightUpperLeg: [-0.36, 0.4, 0.2],
          rightLowerLeg: [0.48, -0.23, 0.16],
          rightFoot: [-0.2, -0.29, -0.14],
        },
      },
      {
        hipsY: 0.965,
        rotations: {
          hips: [0.16, 0.34, -0.15],
          spine: [0.2, -0.4, 0.18],
          chest: [-0.1, -0.46, 0.14],
          head: [-0.08, 0.36, -0.1],
          leftUpperArm: [-0.26, 0.22, -0.94],
          leftLowerArm: [-0.08, -0.68, 0.12],
          leftHand: [-0.12, 0.18, -0.24],
          rightUpperArm: [-0.34, -0.26, 0.86],
          rightLowerArm: [-0.1, 0.72, -0.11],
          rightHand: [0.14, -0.2, 0.23],
          leftUpperLeg: [-0.34, 0.2, -0.17],
          leftLowerLeg: [0.52, -0.11, 0.11],
          leftFoot: [-0.25, -0.15, 0.085],
          rightUpperLeg: [0.28, -0.19, 0.15],
          rightLowerLeg: [0.41, 0.1, -0.095],
          rightFoot: [-0.21, 0.14, -0.08],
        },
      },
    ),

    // E — coil around a prism in the right hand, throw overhand, then sweep the hand down.
    e: motion(
      'ranged',
      'e',
      {
        hipsY: 0.91,
        rotations: {
          hips: [0.31, 0.52, -0.19],
          spine: [0.4, -0.66, 0.25],
          chest: [-0.2, -0.74, 0.19],
          head: [-0.18, 0.57, -0.13],
          leftUpperArm: [0.42, -0.58, -0.38],
          leftLowerArm: [-0.52, -1.12, -0.42],
          leftHand: [0.48, -0.6, 0.4],
          rightUpperArm: [-0.78, 0.72, 0.52],
          rightLowerArm: [-0.72, 1.28, 0.48],
          rightHand: [-0.62, 0.68, -0.46],
          leftUpperLeg: [-0.62, 0.31, -0.28],
          leftLowerLeg: [0.88, -0.19, 0.21],
          leftFoot: [-0.4, -0.24, 0.17],
          rightUpperLeg: [0.5, -0.3, 0.26],
          rightLowerLeg: [0.7, 0.18, -0.2],
          rightFoot: [-0.35, 0.23, -0.16],
        },
      },
      {
        hipsY: 1.02,
        rotations: {
          hips: [-0.2, -0.62, 0.24],
          spine: [-0.3, 0.78, -0.29],
          chest: [0.22, 0.88, -0.22],
          head: [0.14, -0.67, 0.16],
          leftUpperArm: [-0.34, 0.24, -0.9],
          leftLowerArm: [0.18, -0.62, 0.24],
          leftHand: [-0.22, 0.3, -0.32],
          rightUpperArm: [-1.52, -0.22, 0.08],
          rightLowerArm: [-0.24, 0.18, -0.28],
          rightHand: [0.24, -0.38, 0.48],
          leftUpperLeg: [-0.18, 0.25, -0.16],
          leftLowerLeg: [0.36, -0.14, 0.11],
          leftFoot: [-0.16, -0.18, 0.09],
          rightUpperLeg: [0.12, -0.23, 0.14],
          rightLowerLeg: [0.28, 0.13, -0.1],
          rightFoot: [-0.13, 0.17, -0.08],
        },
      },
      {
        hipsY: 0.96,
        rotations: {
          hips: [0.14, -0.34, 0.13],
          spine: [0.2, 0.46, -0.17],
          chest: [-0.1, 0.52, -0.13],
          head: [-0.08, -0.38, 0.095],
          leftUpperArm: [-0.26, 0.08, -0.98],
          leftLowerArm: [-0.04, -0.62, 0.12],
          leftHand: [-0.1, 0.16, -0.18],
          rightUpperArm: [-0.92, -0.14, 0.42],
          rightLowerArm: [-0.28, 0.4, -0.16],
          rightHand: [0.15, -0.22, 0.29],
          leftUpperLeg: [-0.32, 0.19, -0.16],
          leftLowerLeg: [0.49, -0.1, 0.1],
          leftFoot: [-0.23, -0.14, 0.08],
          rightUpperLeg: [0.26, -0.18, 0.145],
          rightLowerLeg: [0.39, 0.095, -0.09],
          rightFoot: [-0.2, 0.13, -0.075],
        },
      },
    ),

    // R — long planted charge, both hands form a lens, beam release, whole-body recoil.
    r: motion(
      'ranged',
      'r',
      {
        hipsY: 0.87,
        rotations: {
          hips: [0.38, 0.28, -0.2],
          spine: [0.5, -0.36, 0.28],
          chest: [-0.24, -0.42, 0.22],
          head: [-0.22, 0.32, -0.16],
          leftUpperArm: [0.28, -0.7, -0.34],
          leftLowerArm: [-0.62, -1.3, -0.5],
          leftHand: [0.58, -0.72, 0.54],
          rightUpperArm: [0.34, 0.76, 0.3],
          rightLowerArm: [-0.66, 1.34, 0.52],
          rightHand: [-0.6, 0.76, -0.56],
          leftUpperLeg: [-0.78, 0.36, -0.32],
          leftLowerLeg: [1.02, -0.23, 0.26],
          leftFoot: [-0.46, -0.29, 0.2],
          rightUpperLeg: [0.64, -0.35, 0.3],
          rightLowerLeg: [0.84, 0.21, -0.24],
          rightFoot: [-0.42, 0.28, -0.19],
        },
      },
      {
        hipsY: 0.9,
        rotations: {
          hips: [-0.16, -0.48, 0.18],
          spine: [-0.22, 0.62, -0.24],
          chest: [0.18, 0.74, -0.18],
          head: [0.1, -0.56, 0.13],
          leftUpperArm: [-1.34, 0.1, -0.16],
          leftLowerArm: [-0.08, -0.14, 0.12],
          leftHand: [-0.08, 0.28, 0.52],
          rightUpperArm: [-1.38, -0.1, 0.14],
          rightLowerArm: [-0.1, 0.16, -0.11],
          rightHand: [0.1, -0.3, -0.5],
          leftUpperLeg: [-0.68, 0.31, -0.28],
          leftLowerLeg: [0.94, -0.19, 0.22],
          leftFoot: [-0.42, -0.25, 0.18],
          rightUpperLeg: [0.56, -0.3, 0.26],
          rightLowerLeg: [0.76, 0.18, -0.2],
          rightFoot: [-0.38, 0.24, -0.17],
        },
      },
      {
        hipsY: 0.84,
        rotations: {
          hips: [0.44, -0.29, -0.18],
          spine: [0.58, 0.4, 0.25],
          chest: [0.32, 0.47, 0.2],
          head: [-0.26, -0.34, -0.15],
          leftUpperArm: [-0.86, 0.04, -0.48],
          leftLowerArm: [-0.28, -0.38, 0.2],
          leftHand: [-0.18, 0.18, 0.34],
          rightUpperArm: [-0.9, -0.045, 0.45],
          rightLowerArm: [-0.3, 0.4, -0.19],
          rightHand: [0.2, -0.2, -0.32],
          leftUpperLeg: [-0.72, 0.32, -0.3],
          leftLowerLeg: [0.98, -0.2, 0.23],
          leftFoot: [-0.44, -0.26, 0.19],
          rightUpperLeg: [0.59, -0.31, 0.28],
          rightLowerLeg: [0.8, 0.19, -0.22],
          rightFoot: [-0.4, 0.25, -0.18],
        },
      },
    ),
  },

  melee: {
    // Fast diagonal draw cut: shoulder-led wind-up, blade contact, low opposite finish.
    attack: motion(
      'melee',
      'attack',
      {
        hipsY: 0.975,
        rotations: {
          hips: [0.12, 0.38, -0.1],
          spine: [0.18, -0.5, 0.15],
          chest: [-0.08, -0.58, 0.12],
          head: [-0.08, 0.43, -0.07],
          leftUpperArm: [-0.12, -0.34, -0.84],
          leftLowerArm: [-0.18, -0.72, -0.24],
          leftHand: [0.22, -0.3, 0.2],
          rightUpperArm: [0.24, 0.64, 0.54],
          rightLowerArm: [-0.5, 1.1, 0.42],
          rightHand: [-0.52, 0.58, -0.46],
          leftUpperLeg: [-0.34, 0.19, -0.17],
          leftLowerLeg: [0.52, -0.1, 0.11],
          leftFoot: [-0.24, -0.14, 0.085],
          rightUpperLeg: [0.27, -0.18, 0.15],
          rightLowerLeg: [0.42, 0.095, -0.095],
          rightFoot: [-0.21, 0.13, -0.08],
        },
      },
      {
        hipsY: 0.955,
        rotations: {
          hips: [-0.12, -0.52, 0.16],
          spine: [-0.16, 0.68, -0.21],
          chest: [0.13, 0.78, -0.17],
          head: [0.07, -0.57, 0.11],
          leftUpperArm: [-0.32, 0.22, -0.95],
          leftLowerArm: [0.12, -0.58, 0.2],
          leftHand: [-0.18, 0.26, -0.28],
          rightUpperArm: [-0.96, -0.34, 0.2],
          rightLowerArm: [-0.22, 0.28, -0.26],
          rightHand: [0.28, -0.42, 0.58],
          leftUpperLeg: [-0.48, 0.24, -0.22],
          leftLowerLeg: [0.7, -0.14, 0.15],
          leftFoot: [-0.32, -0.18, 0.12],
          rightUpperLeg: [0.39, -0.23, 0.2],
          rightLowerLeg: [0.55, 0.13, -0.13],
          rightFoot: [-0.28, 0.17, -0.11],
        },
      },
      {
        hipsY: 0.97,
        rotations: {
          hips: [0.07, -0.32, 0.1],
          spine: [0.1, 0.42, -0.14],
          chest: [-0.05, 0.49, -0.11],
          head: [-0.055, -0.35, 0.075],
          leftUpperArm: [-0.28, 0.08, -0.98],
          leftLowerArm: [-0.02, -0.61, 0.12],
          leftHand: [-0.08, 0.14, -0.16],
          rightUpperArm: [-0.72, -0.2, 0.46],
          rightLowerArm: [-0.28, 0.48, -0.18],
          rightHand: [0.18, -0.28, 0.34],
          leftUpperLeg: [-0.3, 0.18, -0.15],
          leftLowerLeg: [0.47, -0.09, 0.095],
          leftFoot: [-0.22, -0.13, 0.075],
          rightUpperLeg: [0.25, -0.17, 0.14],
          rightLowerLeg: [0.37, 0.09, -0.085],
          rightFoot: [-0.19, 0.12, -0.07],
        },
      },
    ),

    // Heavy empowered cut: deep two-arm coil and a torso-driven horizontal cleave.
    empowered: motion(
      'melee',
      'empowered',
      {
        hipsY: 0.92,
        rotations: {
          hips: [0.3, 0.68, -0.23],
          spine: [0.4, -0.82, 0.3],
          chest: [-0.2, -0.92, 0.24],
          head: [-0.18, 0.7, -0.16],
          leftUpperArm: [0.28, -0.62, -0.42],
          leftLowerArm: [-0.48, -1.16, -0.44],
          leftHand: [0.5, -0.62, 0.42],
          rightUpperArm: [0.46, 0.86, 0.34],
          rightLowerArm: [-0.7, 1.32, 0.54],
          rightHand: [-0.68, 0.74, -0.6],
          leftUpperLeg: [-0.64, 0.31, -0.28],
          leftLowerLeg: [0.9, -0.19, 0.21],
          leftFoot: [-0.41, -0.24, 0.17],
          rightUpperLeg: [0.52, -0.3, 0.26],
          rightLowerLeg: [0.72, 0.18, -0.2],
          rightFoot: [-0.36, 0.23, -0.16],
        },
      },
      {
        hipsY: 0.89,
        rotations: {
          hips: [-0.24, -0.86, 0.3],
          spine: [-0.32, 1.02, -0.36],
          chest: [0.24, 1.12, -0.28],
          head: [0.16, -0.88, 0.2],
          leftUpperArm: [-0.54, 0.48, -0.7],
          leftLowerArm: [0.28, -0.46, 0.35],
          leftHand: [-0.34, 0.44, -0.5],
          rightUpperArm: [-1.08, -0.58, 0.12],
          rightLowerArm: [-0.26, 0.22, -0.36],
          rightHand: [0.36, -0.56, 0.72],
          leftUpperLeg: [-0.78, 0.36, -0.33],
          leftLowerLeg: [1.04, -0.23, 0.26],
          leftFoot: [-0.47, -0.29, 0.2],
          rightUpperLeg: [0.65, -0.35, 0.3],
          rightLowerLeg: [0.86, 0.21, -0.24],
          rightFoot: [-0.43, 0.28, -0.19],
        },
      },
      {
        hipsY: 0.925,
        rotations: {
          hips: [0.16, -0.52, 0.18],
          spine: [0.24, 0.65, -0.24],
          chest: [-0.12, 0.74, -0.19],
          head: [-0.11, -0.56, 0.13],
          leftUpperArm: [-0.38, 0.22, -0.86],
          leftLowerArm: [0.08, -0.55, 0.22],
          leftHand: [-0.2, 0.26, -0.31],
          rightUpperArm: [-0.82, -0.34, 0.38],
          rightLowerArm: [-0.34, 0.4, -0.25],
          rightHand: [0.25, -0.36, 0.47],
          leftUpperLeg: [-0.48, 0.25, -0.22],
          leftLowerLeg: [0.7, -0.14, 0.15],
          leftFoot: [-0.32, -0.18, 0.12],
          rightUpperLeg: [0.4, -0.23, 0.2],
          rightLowerLeg: [0.56, 0.13, -0.13],
          rightFoot: [-0.28, 0.17, -0.11],
        },
      },
    ),

    // Ultimate follow-up: rising slash with a brief lift and a guarded landing.
    ult: motion(
      'melee',
      'ult',
      {
        hipsY: 0.94,
        rotations: {
          hips: [0.34, -0.36, 0.2],
          spine: [0.46, 0.48, -0.25],
          chest: [-0.22, 0.54, -0.19],
          head: [-0.2, -0.42, 0.14],
          leftUpperArm: [0.12, 0.34, -0.72],
          leftLowerArm: [-0.36, -0.52, 0.3],
          leftHand: [0.34, 0.3, -0.28],
          rightUpperArm: [0.44, -0.58, 0.42],
          rightLowerArm: [-0.54, 0.82, -0.4],
          rightHand: [-0.5, -0.46, 0.56],
          leftUpperLeg: [-0.5, 0.25, -0.23],
          leftLowerLeg: [0.72, -0.15, 0.16],
          leftFoot: [-0.33, -0.19, 0.13],
          rightUpperLeg: [0.42, -0.24, 0.21],
          rightLowerLeg: [0.58, 0.14, -0.14],
          rightFoot: [-0.29, 0.18, -0.12],
        },
      },
      {
        hipsY: 1.07,
        rotations: {
          hips: [-0.3, 0.5, -0.22],
          spine: [-0.4, -0.62, 0.28],
          chest: [0.2, -0.72, 0.21],
          head: [0.16, 0.55, -0.16],
          leftUpperArm: [-0.32, -0.2, -0.94],
          leftLowerArm: [0.18, -0.58, -0.22],
          leftHand: [-0.22, -0.18, 0.3],
          rightUpperArm: [-1.54, 0.28, 0.06],
          rightLowerArm: [-0.16, 0.12, 0.34],
          rightHand: [0.2, 0.34, -0.5],
          leftUpperLeg: [0.18, 0.2, -0.13],
          leftLowerLeg: [0.24, -0.11, 0.08],
          leftFoot: [-0.1, -0.14, 0.07],
          rightUpperLeg: [-0.14, -0.19, 0.12],
          rightLowerLeg: [0.2, 0.1, -0.075],
          rightFoot: [-0.09, 0.13, -0.065],
        },
      },
      {
        hipsY: 0.91,
        rotations: {
          hips: [0.42, 0.28, -0.18],
          spine: [0.54, -0.38, 0.24],
          chest: [0.3, -0.45, 0.18],
          head: [-0.24, 0.34, -0.13],
          leftUpperArm: [-0.28, -0.04, -0.96],
          leftLowerArm: [-0.05, -0.62, -0.1],
          leftHand: [0.08, -0.08, 0.18],
          rightUpperArm: [-0.92, 0.18, 0.38],
          rightLowerArm: [-0.32, 0.42, 0.2],
          rightHand: [-0.12, 0.24, -0.34],
          leftUpperLeg: [-0.64, 0.29, -0.27],
          leftLowerLeg: [0.88, -0.18, 0.2],
          leftFoot: [-0.4, -0.23, 0.16],
          rightUpperLeg: [0.52, -0.28, 0.24],
          rightLowerLeg: [0.7, 0.17, -0.18],
          rightFoot: [-0.35, 0.22, -0.15],
        },
      },
    ),

    // Q — low advancing cut into a rising diagonal, then settle behind the blade.
    q: motion(
      'melee',
      'q',
      {
        hipsY: 0.9,
        rotations: {
          hips: [0.36, 0.58, -0.25],
          spine: [0.48, -0.72, 0.32],
          chest: [-0.24, -0.82, 0.25],
          head: [-0.21, 0.63, -0.18],
          leftUpperArm: [0.2, -0.48, -0.54],
          leftLowerArm: [-0.42, -0.98, -0.38],
          leftHand: [0.43, -0.5, 0.37],
          rightUpperArm: [0.5, 0.76, 0.32],
          rightLowerArm: [-0.64, 1.22, 0.5],
          rightHand: [-0.62, 0.66, -0.56],
          leftUpperLeg: [-0.68, 0.33, -0.3],
          leftLowerLeg: [0.94, -0.21, 0.23],
          leftFoot: [-0.43, -0.26, 0.18],
          rightUpperLeg: [0.56, -0.32, 0.28],
          rightLowerLeg: [0.76, 0.19, -0.21],
          rightFoot: [-0.38, 0.25, -0.17],
        },
      },
      {
        hipsY: 1.025,
        rotations: {
          hips: [-0.28, -0.68, 0.27],
          spine: [-0.38, 0.84, -0.33],
          chest: [0.24, 0.96, -0.26],
          head: [0.17, -0.74, 0.19],
          leftUpperArm: [-0.44, 0.36, -0.78],
          leftLowerArm: [0.24, -0.5, 0.3],
          leftHand: [-0.3, 0.37, -0.42],
          rightUpperArm: [-1.36, -0.4, 0.1],
          rightLowerArm: [-0.18, 0.18, -0.32],
          rightHand: [0.32, -0.5, 0.66],
          leftUpperLeg: [-0.24, 0.25, -0.18],
          leftLowerLeg: [0.42, -0.14, 0.12],
          leftFoot: [-0.19, -0.18, 0.095],
          rightUpperLeg: [0.18, -0.24, 0.16],
          rightLowerLeg: [0.34, 0.13, -0.11],
          rightFoot: [-0.16, 0.17, -0.09],
        },
      },
      {
        hipsY: 0.94,
        rotations: {
          hips: [0.23, -0.42, 0.17],
          spine: [0.31, 0.54, -0.22],
          chest: [-0.15, 0.63, -0.17],
          head: [-0.13, -0.47, 0.12],
          leftUpperArm: [-0.34, 0.17, -0.88],
          leftLowerArm: [0.07, -0.56, 0.2],
          leftHand: [-0.18, 0.2, -0.28],
          rightUpperArm: [-0.88, -0.25, 0.36],
          rightLowerArm: [-0.3, 0.38, -0.22],
          rightHand: [0.22, -0.32, 0.43],
          leftUpperLeg: [-0.5, 0.26, -0.23],
          leftLowerLeg: [0.72, -0.15, 0.16],
          leftFoot: [-0.33, -0.19, 0.13],
          rightUpperLeg: [0.42, -0.25, 0.21],
          rightLowerLeg: [0.58, 0.14, -0.14],
          rightFoot: [-0.29, 0.18, -0.12],
        },
      },
    ),

    // W — iaijutsu: hand to hip/sheath, forward draw posture and level cut, low landing.
    w: motion(
      'melee',
      'w',
      {
        hipsY: 0.865,
        rotations: {
          hips: [0.44, 0.74, -0.31],
          spine: [0.58, -0.9, 0.39],
          chest: [-0.28, -1.02, 0.31],
          head: [-0.26, 0.8, -0.22],
          leftShoulder: [0.12, -0.28, -0.18],
          leftUpperArm: [0.44, -0.72, -0.28],
          leftLowerArm: [-0.7, -1.34, -0.58],
          leftHand: [0.66, -0.78, 0.62],
          rightShoulder: [0.16, 0.32, 0.2],
          rightUpperArm: [0.62, 1.02, 0.18],
          rightLowerArm: [-0.82, 1.46, 0.68],
          rightHand: [-0.78, 0.94, -0.74],
          leftUpperLeg: [-0.82, 0.39, -0.36],
          leftLowerLeg: [1.08, -0.25, 0.29],
          leftFoot: [-0.49, -0.31, 0.22],
          rightUpperLeg: [0.68, -0.38, 0.33],
          rightLowerLeg: [0.9, 0.23, -0.26],
          rightFoot: [-0.45, 0.3, -0.21],
        },
      },
      {
        hipsY: 0.91,
        rotations: {
          hips: [-0.26, -1.02, 0.34],
          spine: [-0.36, 1.18, -0.41],
          chest: [0.26, 1.3, -0.32],
          head: [0.18, -1.02, 0.23],
          leftShoulder: [-0.08, 0.3, 0.16],
          leftUpperArm: [-0.62, 0.62, -0.62],
          leftLowerArm: [0.34, -0.4, 0.42],
          leftHand: [-0.4, 0.54, -0.58],
          rightShoulder: [-0.12, -0.34, -0.18],
          rightUpperArm: [-0.92, -0.82, 0.08],
          rightLowerArm: [-0.2, 0.16, -0.46],
          rightHand: [0.46, -0.72, 0.82],
          leftUpperLeg: [-0.7, 0.35, -0.32],
          leftLowerLeg: [0.98, -0.22, 0.25],
          leftFoot: [-0.45, -0.28, 0.19],
          rightUpperLeg: [0.58, -0.34, 0.3],
          rightLowerLeg: [0.8, 0.2, -0.23],
          rightFoot: [-0.4, 0.27, -0.18],
        },
      },
      {
        hipsY: 0.84,
        rotations: {
          hips: [0.5, -0.58, 0.24],
          spine: [0.64, 0.72, -0.3],
          chest: [0.36, 0.84, -0.24],
          head: [-0.3, -0.64, 0.18],
          leftUpperArm: [-0.44, 0.28, -0.82],
          leftLowerArm: [0.14, -0.51, 0.28],
          leftHand: [-0.26, 0.3, -0.38],
          rightUpperArm: [-0.78, -0.46, 0.34],
          rightLowerArm: [-0.36, 0.36, -0.3],
          rightHand: [0.3, -0.44, 0.52],
          leftUpperLeg: [-0.86, 0.4, -0.37],
          leftLowerLeg: [1.12, -0.25, 0.3],
          leftFoot: [-0.51, -0.32, 0.22],
          rightUpperLeg: [0.72, -0.39, 0.34],
          rightLowerLeg: [0.94, 0.24, -0.27],
          rightFoot: [-0.47, 0.31, -0.21],
        },
      },
    ),

    // E — full-body clockwise sweep: close guard, rotating contact, unwind the feet.
    e: motion(
      'melee',
      'e',
      {
        hipsY: 0.9,
        rotations: {
          hips: [0.32, -0.82, 0.28],
          spine: [0.44, 0.98, -0.35],
          chest: [-0.22, 1.08, -0.27],
          head: [-0.2, -0.86, 0.2],
          leftUpperArm: [0.3, 0.52, -0.48],
          leftLowerArm: [-0.5, -0.7, 0.4],
          leftHand: [0.48, 0.5, -0.44],
          rightUpperArm: [0.4, -0.72, 0.38],
          rightLowerArm: [-0.66, 1.04, -0.5],
          rightHand: [-0.62, -0.66, 0.68],
          leftUpperLeg: [-0.7, -0.34, -0.3],
          leftLowerLeg: [0.96, 0.21, 0.24],
          leftFoot: [-0.44, 0.27, 0.18],
          rightUpperLeg: [0.58, 0.33, 0.28],
          rightLowerLeg: [0.78, -0.2, -0.22],
          rightFoot: [-0.39, -0.26, -0.18],
        },
      },
      {
        hipsY: 0.965,
        rotations: {
          hips: [-0.18, 1.34, -0.36],
          spine: [-0.28, -1.5, 0.42],
          chest: [0.2, -1.62, 0.34],
          head: [0.14, 1.28, -0.25],
          leftUpperArm: [-0.56, -0.68, -0.66],
          leftLowerArm: [0.32, -0.43, -0.44],
          leftHand: [-0.38, -0.56, 0.54],
          rightUpperArm: [-0.84, 0.92, 0.1],
          rightLowerArm: [-0.22, 0.2, 0.5],
          rightHand: [0.44, 0.82, -0.78],
          leftUpperLeg: [-0.48, 0.5, -0.26],
          leftLowerLeg: [0.7, -0.3, 0.2],
          leftFoot: [-0.32, -0.4, 0.16],
          rightUpperLeg: [0.38, -0.48, 0.24],
          rightLowerLeg: [0.56, 0.29, -0.18],
          rightFoot: [-0.28, 0.38, -0.15],
        },
      },
      {
        hipsY: 0.9,
        rotations: {
          hips: [0.36, 0.64, -0.24],
          spine: [0.48, -0.78, 0.3],
          chest: [0.27, -0.9, 0.24],
          head: [-0.22, 0.7, -0.17],
          leftUpperArm: [-0.4, -0.32, -0.84],
          leftLowerArm: [0.12, -0.54, -0.28],
          leftHand: [-0.24, -0.25, 0.34],
          rightUpperArm: [-0.72, 0.48, 0.32],
          rightLowerArm: [-0.34, 0.38, 0.28],
          rightHand: [0.28, 0.42, -0.48],
          leftUpperLeg: [-0.64, 0.3, -0.28],
          leftLowerLeg: [0.88, -0.18, 0.21],
          leftFoot: [-0.4, -0.24, 0.17],
          rightUpperLeg: [0.52, -0.29, 0.26],
          rightLowerLeg: [0.7, 0.17, -0.2],
          rightFoot: [-0.35, 0.23, -0.16],
        },
      },
    ),

    // R — overhead execution: long grounded load, vertical impact, blade-heavy recovery.
    r: motion(
      'melee',
      'r',
      {
        hipsY: 0.86,
        rotations: {
          hips: [0.46, 0.42, -0.26],
          spine: [0.6, -0.55, 0.34],
          chest: [-0.3, -0.64, 0.27],
          head: [-0.28, 0.5, -0.19],
          leftUpperArm: [-1.26, -0.48, -0.18],
          leftLowerArm: [-0.42, -0.52, -0.36],
          leftHand: [0.4, -0.34, 0.52],
          rightUpperArm: [-1.42, 0.58, 0.1],
          rightLowerArm: [-0.5, 0.46, 0.4],
          rightHand: [-0.44, 0.4, -0.58],
          leftUpperLeg: [-0.82, 0.38, -0.35],
          leftLowerLeg: [1.08, -0.24, 0.28],
          leftFoot: [-0.49, -0.3, 0.21],
          rightUpperLeg: [0.68, -0.37, 0.33],
          rightLowerLeg: [0.9, 0.22, -0.26],
          rightFoot: [-0.45, 0.29, -0.2],
        },
      },
      {
        hipsY: 0.79,
        rotations: {
          hips: [-0.34, -0.46, 0.3],
          spine: [-0.48, 0.58, -0.38],
          chest: [0.3, 0.7, -0.3],
          head: [0.22, -0.54, 0.21],
          leftUpperArm: [-0.36, 0.3, -0.88],
          leftLowerArm: [0.2, -0.5, 0.32],
          leftHand: [-0.28, 0.26, -0.42],
          rightUpperArm: [0.82, -0.48, 0.34],
          rightLowerArm: [-0.84, 0.78, -0.46],
          rightHand: [0.52, -0.62, 0.74],
          leftUpperLeg: [-0.96, 0.42, -0.39],
          leftLowerLeg: [1.2, -0.27, 0.32],
          leftFoot: [-0.55, -0.34, 0.23],
          rightUpperLeg: [0.8, -0.41, 0.36],
          rightLowerLeg: [1.02, 0.25, -0.29],
          rightFoot: [-0.51, 0.33, -0.22],
        },
      },
      {
        hipsY: 0.82,
        rotations: {
          hips: [0.5, -0.3, 0.23],
          spine: [0.66, 0.4, -0.31],
          chest: [0.38, 0.48, -0.25],
          head: [-0.31, -0.36, 0.18],
          leftUpperArm: [-0.38, 0.16, -0.9],
          leftLowerArm: [0.09, -0.56, 0.22],
          leftHand: [-0.19, 0.15, -0.3],
          rightUpperArm: [0.36, -0.3, 0.58],
          rightLowerArm: [-0.66, 0.7, -0.32],
          rightHand: [0.36, -0.4, 0.52],
          leftUpperLeg: [-0.9, 0.4, -0.37],
          leftLowerLeg: [1.15, -0.25, 0.3],
          leftFoot: [-0.52, -0.32, 0.22],
          rightUpperLeg: [0.74, -0.39, 0.34],
          rightLowerLeg: [0.96, 0.24, -0.27],
          rightFoot: [-0.48, 0.31, -0.21],
        },
      },
    ),
  },
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
