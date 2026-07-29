import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Euler, Quaternion } from 'three'
import type { PlayerClass } from '../src/sim/types.ts'
import type { CharacterAction } from '../src/render/rig.ts'
import {
  VRM_ACTION_MOTIONS,
  VRM_CLASS_STANCE,
  VRM_RESULT_MOTIONS,
  VRMA_CLIP_ORDER,
  type VrmaClipName,
  type VrmActionStage,
  type VrmAnimationState,
  type VrmBoneName,
  type VrmResultState,
  type VrmVec3,
} from '../src/render/animation-data.ts'

interface PoseFrame {
  hipsPosition: VrmVec3
  rotations: Readonly<Record<VrmBoneName, VrmVec3>>
}

interface NodeDef {
  name: string
  children?: number[]
  translation?: VrmVec3
}

interface BufferViewDef {
  buffer: 0
  byteOffset: number
  byteLength: number
}

interface AccessorDef {
  bufferView: number
  componentType: 5126
  count: number
  type: 'SCALAR' | 'VEC3' | 'VEC4'
  min?: number[]
  max?: number[]
}

interface AnimationSamplerDef {
  input: number
  output: number
  interpolation: 'LINEAR'
}

interface AnimationChannelDef {
  sampler: number
  target: {
    node: number
    path: 'translation' | 'rotation'
  }
}

interface AnimationExtras {
  sampleRate: 30
  inPlace: true
  loop: boolean
  phases?: Array<{ stage: VrmActionStage; time: number }>
}

interface AnimationDef {
  name: VrmaClipName
  samplers: AnimationSamplerDef[]
  channels: AnimationChannelDef[]
  extras: AnimationExtras
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT = resolve(SCRIPT_DIR, '../public/animations/myeongwol-combat.vrma')

const NODES: NodeDef[] = [
  { name: 'MyeongwolAnimationRoot', children: [1] },
  { name: 'hips', children: [2, 6, 9], translation: [0, 1, 0] },
  { name: 'spine', children: [3], translation: [0, 0.12, 0] },
  { name: 'chest', children: [4, 12, 16], translation: [0, 0.25, 0] },
  { name: 'neck', children: [5], translation: [0, 0.2, 0] },
  { name: 'head', translation: [0, 0.12, 0] },
  { name: 'leftUpperLeg', children: [7], translation: [0.09, -0.1, 0] },
  { name: 'leftLowerLeg', children: [8], translation: [0, -0.45, 0] },
  { name: 'leftFoot', translation: [0, -0.43, 0] },
  { name: 'rightUpperLeg', children: [10], translation: [-0.09, -0.1, 0] },
  { name: 'rightLowerLeg', children: [11], translation: [0, -0.45, 0] },
  { name: 'rightFoot', translation: [0, -0.43, 0] },
  { name: 'leftShoulder', children: [13], translation: [0.13, 0.14, 0] },
  { name: 'leftUpperArm', children: [14], translation: [0.12, 0, 0] },
  { name: 'leftLowerArm', children: [15], translation: [0.28, 0, 0] },
  { name: 'leftHand', translation: [0.25, 0, 0] },
  { name: 'rightShoulder', children: [17], translation: [-0.13, 0.14, 0] },
  { name: 'rightUpperArm', children: [18], translation: [-0.12, 0, 0] },
  { name: 'rightLowerArm', children: [19], translation: [-0.28, 0, 0] },
  { name: 'rightHand', translation: [-0.25, 0, 0] },
]

const NODE_INDEX = new Map(NODES.map((node, index) => [node.name, index]))
const TRACKED_BONES: readonly VrmBoneName[] = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
]

const HUMAN_BONES = {
  hips: { node: 1 },
  spine: { node: 2 },
  chest: { node: 3 },
  neck: { node: 4 },
  head: { node: 5 },
  leftUpperLeg: { node: 6 },
  leftLowerLeg: { node: 7 },
  leftFoot: { node: 8 },
  rightUpperLeg: { node: 9 },
  rightLowerLeg: { node: 10 },
  rightFoot: { node: 11 },
  leftShoulder: { node: 12 },
  leftUpperArm: { node: 13 },
  leftLowerArm: { node: 14 },
  leftHand: { node: 15 },
  rightShoulder: { node: 16 },
  rightUpperArm: { node: 17 },
  rightLowerArm: { node: 18 },
  rightHand: { node: 19 },
} as const

class BinaryBuilder {
  readonly bufferViews: BufferViewDef[] = []
  readonly accessors: AccessorDef[] = []
  private readonly chunks: Uint8Array[] = []
  private byteLength = 0

  addAccessor(
    values: readonly number[],
    type: AccessorDef['type'],
    itemSize: number,
    range?: { min: number[]; max: number[] },
  ): number {
    this.align4()
    const floats = Float32Array.from(values)
    const bytes = new Uint8Array(floats.buffer)
    const viewIndex = this.bufferViews.length
    this.bufferViews.push({
      buffer: 0,
      byteOffset: this.byteLength,
      byteLength: bytes.byteLength,
    })
    this.chunks.push(bytes)
    this.byteLength += bytes.byteLength

    const accessorIndex = this.accessors.length
    this.accessors.push({
      bufferView: viewIndex,
      componentType: 5126,
      count: values.length / itemSize,
      type,
      ...range,
    })
    return accessorIndex
  }

  finish(): Uint8Array {
    this.align4()
    const out = new Uint8Array(this.byteLength)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.byteLength
    }
    return out
  }

  get length(): number {
    return this.byteLength
  }

  private align4(): void {
    const padding = (4 - (this.byteLength % 4)) % 4
    if (padding === 0) return
    this.chunks.push(new Uint8Array(padding))
    this.byteLength += padding
  }
}

function addVec(a: VrmVec3, b: VrmVec3): VrmVec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

function offsetPose(
  base: Readonly<Record<VrmBoneName, VrmVec3>>,
  offsets: Partial<Record<VrmBoneName, VrmVec3>>,
): Readonly<Record<VrmBoneName, VrmVec3>> {
  return Object.fromEntries(
    TRACKED_BONES.map((bone) => [bone, addVec(base[bone], offsets[bone] ?? [0, 0, 0])]),
  ) as Record<VrmBoneName, VrmVec3>
}

/**
 * Periodic breathing and weight transfer. Every rotational chain gets a subtle
 * three-axis response, while ranged wrists stay quiet enough to keep the staff stable.
 */
function idleFrame(cls: PlayerClass, time: number, duration: number): PoseFrame {
  const phase = (time / duration) * Math.PI * 2
  const breath = Math.sin(phase * 2)
  const sway = Math.sin(phase)
  const settle = Math.cos(phase)
  const melee = cls === 'melee'
  const hand = melee ? 1 : 0.42

  return {
    hipsPosition: [0, 1 + breath * 0.006 - settle * 0.004, 0],
    rotations: offsetPose(VRM_CLASS_STANCE[cls], {
      hips: [breath * 0.008, sway * 0.026, settle * 0.014],
      spine: [-breath * 0.012, -sway * 0.021, -settle * 0.011],
      chest: [breath * 0.018, -sway * 0.013, settle * 0.009],
      neck: [-breath * 0.007, sway * 0.01, -settle * 0.005],
      head: [-breath * 0.01, sway * 0.018, -settle * 0.007],
      leftShoulder: [breath * 0.01, -sway * 0.009, settle * 0.007],
      leftUpperArm: [-breath * 0.014, sway * 0.011, settle * 0.009],
      leftLowerArm: [breath * 0.01, -sway * 0.008, -settle * 0.007],
      leftHand: [-breath * 0.008 * hand, sway * 0.009 * hand, settle * 0.007 * hand],
      rightShoulder: [breath * 0.009, sway * 0.008, -settle * 0.006],
      rightUpperArm: [breath * 0.013, -sway * 0.01, -settle * 0.008],
      rightLowerArm: [-breath * 0.009, sway * 0.007, settle * 0.006],
      rightHand: [breath * 0.007 * hand, -sway * 0.008 * hand, -settle * 0.006 * hand],
      leftUpperLeg: [-settle * 0.012, sway * 0.012, -sway * 0.01],
      leftLowerLeg: [settle * 0.015, -sway * 0.008, sway * 0.006],
      leftFoot: [-settle * 0.008, sway * 0.006, -sway * 0.005],
      rightUpperLeg: [settle * 0.012, -sway * 0.012, sway * 0.01],
      rightLowerLeg: [-settle * 0.015, sway * 0.008, -sway * 0.006],
      rightFoot: [settle * 0.008, -sway * 0.006, sway * 0.005],
    }),
  }
}

/**
 * In-place locomotion with pelvis counter-rotation, foot roll, wrist drag and a
 * class-specific upper-body weight. Root X/Z always stay at zero.
 */
function walkFrame(cls: PlayerClass, time: number, duration: number): PoseFrame {
  const phase = (time / duration) * Math.PI * 2
  const stride = Math.sin(phase)
  const side = Math.cos(phase)
  const bounce = Math.cos(phase * 2)
  const leftLift = Math.max(0, stride)
  const rightLift = Math.max(0, -stride)
  const weight = cls === 'melee' ? 1.08 : 0.94
  const hand = cls === 'melee' ? 1 : 0.45

  return {
    hipsPosition: [0, 1 + bounce * 0.018, 0],
    rotations: offsetPose(VRM_CLASS_STANCE[cls], {
      hips: [-stride * 0.045, stride * 0.15, side * 0.035],
      spine: [0.055 + stride * 0.02, -stride * 0.12, -side * 0.028],
      chest: [-0.025 - stride * 0.014, -stride * 0.075, side * 0.022],
      neck: [-stride * 0.012, stride * 0.026, -side * 0.012],
      head: [-0.02 - bounce * 0.008, stride * 0.045, -side * 0.018],
      leftShoulder: [-stride * 0.035, stride * 0.025, side * 0.018],
      leftUpperArm: [stride * 0.43 * weight, stride * 0.055, side * 0.04],
      leftLowerArm: [-leftLift * 0.12, -stride * 0.045, -side * 0.03],
      leftHand: [stride * 0.06 * hand, stride * 0.04 * hand, side * 0.035 * hand],
      rightShoulder: [stride * 0.032, -stride * 0.023, -side * 0.017],
      rightUpperArm: [-stride * 0.43 * weight, -stride * 0.052, -side * 0.038],
      rightLowerArm: [-rightLift * 0.12, stride * 0.043, side * 0.028],
      rightHand: [-stride * 0.058 * hand, -stride * 0.038 * hand, -side * 0.032 * hand],
      leftUpperLeg: [-stride * 0.64, stride * 0.055, -side * 0.04],
      leftLowerLeg: [leftLift * 0.92, -stride * 0.04, side * 0.035],
      leftFoot: [-leftLift * 0.46 + rightLift * 0.12, stride * 0.035, -side * 0.028],
      rightUpperLeg: [stride * 0.64, -stride * 0.055, side * 0.04],
      rightLowerLeg: [rightLift * 0.92, stride * 0.04, -side * 0.035],
      rightFoot: [-rightLift * 0.46 + leftLift * 0.12, -stride * 0.035, side * 0.028],
    }),
  }
}

function lerp(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}

function easedSegment(stage: VrmActionStage, amount: number): number {
  if (stage === 'contact') return amount * amount * amount
  if (stage === 'followThrough') return 1 - (1 - amount) ** 3
  return amount * amount * (3 - 2 * amount)
}

function actionFrame(
  cls: PlayerClass,
  action: CharacterAction,
  time: number,
): PoseFrame {
  const motion = VRM_ACTION_MOTIONS[cls][action]
  let previous = motion.keyframes[0]!
  let next = motion.keyframes.at(-1)!

  for (let index = 1; index < motion.keyframes.length; index += 1) {
    const candidate = motion.keyframes[index]!
    if (time <= candidate.time) {
      next = candidate
      previous = motion.keyframes[index - 1]!
      break
    }
  }

  const span = Math.max(1e-6, next.time - previous.time)
  const raw = Math.max(0, Math.min(1, (time - previous.time) / span))
  const amount = easedSegment(next.stage, raw)
  const rotations = Object.fromEntries(
    TRACKED_BONES.map((bone) => [
      bone,
      [
        lerp(previous.rotations[bone][0], next.rotations[bone][0], amount),
        lerp(previous.rotations[bone][1], next.rotations[bone][1], amount),
        lerp(previous.rotations[bone][2], next.rotations[bone][2], amount),
      ] satisfies VrmVec3,
    ]),
  ) as Record<VrmBoneName, VrmVec3>

  return {
    hipsPosition: [0, lerp(previous.hipsY, next.hipsY, amount), 0],
    rotations,
  }
}

function resultPoseFrame(
  cls: PlayerClass,
  state: VrmResultState,
  time: number,
): PoseFrame {
  const motion = VRM_RESULT_MOTIONS[cls][state]
  let previous = motion.keyframes[0]!
  let next = motion.keyframes.at(-1)!

  for (let index = 1; index < motion.keyframes.length; index += 1) {
    const candidate = motion.keyframes[index]!
    if (time <= candidate.time) {
      next = candidate
      previous = motion.keyframes[index - 1]!
      break
    }
  }

  const span = Math.max(1e-6, next.time - previous.time)
  const raw = Math.max(0, Math.min(1, (time - previous.time) / span))
  // 결과 루프는 급한 타격 판정이 없으므로 모든 구간을 부드러운 S자 곡선으로 잇는다.
  const amount = raw * raw * (3 - 2 * raw)
  const rotations = Object.fromEntries(
    TRACKED_BONES.map((bone) => [
      bone,
      [
        lerp(previous.rotations[bone][0], next.rotations[bone][0], amount),
        lerp(previous.rotations[bone][1], next.rotations[bone][1], amount),
        lerp(previous.rotations[bone][2], next.rotations[bone][2], amount),
      ] satisfies VrmVec3,
    ]),
  ) as Record<VrmBoneName, VrmVec3>

  return {
    hipsPosition: [0, lerp(previous.hipsY, next.hipsY, amount), 0],
    rotations,
  }
}

function frameTimes(duration: number, extra: readonly number[] = []): number[] {
  const frames = Array.from(
    { length: Math.floor(duration * 30) + 1 },
    (_, index) => index / 30,
  )
  if ((frames.at(-1) ?? 0) < duration - 1e-7) frames.push(duration)
  return [...new Set([...frames, ...extra].map((value) => Number(value.toFixed(6))))].sort(
    (a, b) => a - b,
  )
}

function splitClipName(
  name: VrmaClipName,
): [PlayerClass, VrmAnimationState] {
  const [cls, state] = name.split('.')
  return [cls as PlayerClass, state as VrmAnimationState]
}

function createFrames(name: VrmaClipName): {
  times: number[]
  frames: PoseFrame[]
  extras: AnimationExtras
} {
  const [cls, state] = splitClipName(name)
  if (state === 'idle') {
    const duration = 2.4
    const times = frameTimes(duration)
    return {
      times,
      frames: times.map((time) => idleFrame(cls, time, duration)),
      extras: { sampleRate: 30, inPlace: true, loop: true },
    }
  }
  if (state === 'walk') {
    const duration = cls === 'melee' ? 0.68 : 0.72
    const times = frameTimes(duration)
    return {
      times,
      frames: times.map((time) => walkFrame(cls, time, duration)),
      extras: { sampleRate: 30, inPlace: true, loop: true },
    }
  }
  if (state === 'victory' || state === 'defeat') {
    const motion = VRM_RESULT_MOTIONS[cls][state]
    const times = frameTimes(
      motion.duration,
      motion.keyframes.map((keyframe) => keyframe.time),
    )
    return {
      times,
      frames: times.map((time) => resultPoseFrame(cls, state, time)),
      extras: { sampleRate: 30, inPlace: true, loop: true },
    }
  }

  const motion = VRM_ACTION_MOTIONS[cls][state]
  const times = frameTimes(
    motion.duration,
    motion.keyframes.map((keyframe) => keyframe.time),
  )
  return {
    times,
    frames: times.map((time) => actionFrame(cls, state, time)),
    extras: {
      sampleRate: 30,
      inPlace: true,
      loop: false,
      phases: motion.keyframes.map(({ stage, time }) => ({ stage, time })),
    },
  }
}

function quatValues(frames: PoseFrame[], bone: VrmBoneName): number[] {
  const euler = new Euler()
  const quat = new Quaternion()
  const previous = new Quaternion()
  const values: number[] = []

  frames.forEach((frame, index) => {
    euler.set(...frame.rotations[bone], 'XYZ')
    quat.setFromEuler(euler).normalize()
    if (index > 0 && previous.dot(quat) < 0) {
      quat.set(-quat.x, -quat.y, -quat.z, -quat.w)
    }
    values.push(quat.x, quat.y, quat.z, quat.w)
    previous.copy(quat)
  })
  return values
}

function addAnimation(name: VrmaClipName, binary: BinaryBuilder): AnimationDef {
  const { times, frames, extras } = createFrames(name)
  const duration = times.at(-1) ?? 0
  const timeAccessor = binary.addAccessor(times, 'SCALAR', 1, {
    min: [0],
    max: [duration],
  })
  const samplers: AnimationSamplerDef[] = []
  const channels: AnimationChannelDef[] = []

  const addTrack = (
    node: number,
    path: AnimationChannelDef['target']['path'],
    output: number,
  ) => {
    const sampler = samplers.length
    samplers.push({ input: timeAccessor, output, interpolation: 'LINEAR' })
    channels.push({ sampler, target: { node, path } })
  }

  addTrack(
    NODE_INDEX.get('hips')!,
    'translation',
    binary.addAccessor(frames.flatMap((frame) => frame.hipsPosition), 'VEC3', 3),
  )
  for (const bone of TRACKED_BONES) {
    addTrack(
      NODE_INDEX.get(bone)!,
      'rotation',
      binary.addAccessor(quatValues(frames, bone), 'VEC4', 4),
    )
  }
  return { name, samplers, channels, extras }
}

function padChunk(bytes: Uint8Array, fill: number): Uint8Array {
  const paddedLength = Math.ceil(bytes.byteLength / 4) * 4
  if (paddedLength === bytes.byteLength) return bytes
  const padded = new Uint8Array(paddedLength)
  padded.fill(fill)
  padded.set(bytes)
  return padded
}

/**
 * Builds the committed VRMA entirely in memory.
 *
 * Keeping generation pure lets checks compare repeated outputs without
 * rewriting the tracked asset or depending on a temporary directory.
 */
export function generateVrmaBytes(): Uint8Array {
  const binary = new BinaryBuilder()
  const animations = VRMA_CLIP_ORDER.map((name) => addAnimation(name, binary))
  const binChunk = padChunk(binary.finish(), 0)
  const json = {
    asset: {
      version: '2.0',
      generator: 'Myeongwol authored XYZ multistage VRMA generator',
      copyright: '2026 Myeongwol project',
    },
    extensionsUsed: ['VRMC_vrm_animation'],
    extensionsRequired: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: { humanBones: HUMAN_BONES },
      },
    },
    scene: 0,
    scenes: [{ name: 'MyeongwolAnimation', nodes: [0] }],
    nodes: NODES,
    animations,
    buffers: [{ byteLength: binary.length }],
    bufferViews: binary.bufferViews,
    accessors: binary.accessors,
  }

  const jsonChunk = padChunk(new TextEncoder().encode(JSON.stringify(json)), 0x20)
  const totalLength = 12 + 8 + jsonChunk.byteLength + 8 + binChunk.byteLength
  const glb = new ArrayBuffer(totalLength)
  const view = new DataView(glb)
  const bytes = new Uint8Array(glb)
  let offset = 0

  view.setUint32(offset, 0x46546c67, true)
  offset += 4
  view.setUint32(offset, 2, true)
  offset += 4
  view.setUint32(offset, totalLength, true)
  offset += 4
  view.setUint32(offset, jsonChunk.byteLength, true)
  offset += 4
  view.setUint32(offset, 0x4e4f534a, true)
  offset += 4
  bytes.set(jsonChunk, offset)
  offset += jsonChunk.byteLength
  view.setUint32(offset, binChunk.byteLength, true)
  offset += 4
  view.setUint32(offset, 0x004e4942, true)
  offset += 4
  bytes.set(binChunk, offset)
  return bytes
}

export function writeVrmaFile(outputPath = OUTPUT): Uint8Array {
  const output = generateVrmaBytes()
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, output)
  return output
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  const output = writeVrmaFile()
  console.log(`Generated ${OUTPUT}`)
  console.log(`${VRMA_CLIP_ORDER.length} clips, ${output.byteLength.toLocaleString()} bytes`)
}
