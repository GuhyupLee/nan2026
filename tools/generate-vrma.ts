import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Euler, Quaternion } from 'three'
import type { PlayerClass } from '../src/sim/types.ts'
import type { CharacterAction } from '../src/render/rig.ts'
import {
  VRM_ACTION_DURATION,
  VRM_POSES,
  VRM_REST,
  VRM_TIMING,
  VRMA_CLIP_ORDER,
  actionEnvelope,
  type VrmaClipName,
  type VrmVec3,
} from '../src/render/animation-data.ts'

type BoneName =
  | 'hips'
  | 'spine'
  | 'chest'
  | 'neck'
  | 'head'
  | 'leftUpperArm'
  | 'leftLowerArm'
  | 'rightUpperArm'
  | 'rightLowerArm'
  | 'leftUpperLeg'
  | 'leftLowerLeg'
  | 'leftFoot'
  | 'rightUpperLeg'
  | 'rightLowerLeg'
  | 'rightFoot'

interface PoseFrame {
  hipsPosition: VrmVec3
  rotations: Record<BoneName, VrmVec3>
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

interface AnimationDef {
  name: VrmaClipName
  samplers: AnimationSamplerDef[]
  channels: AnimationChannelDef[]
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUTPUT = resolve(SCRIPT_DIR, '../public/animations/myeongwol-combat.vrma')
const IDENTITY: VrmVec3 = [0, 0, 0]

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
const TRACKED_BONES: BoneName[] = [
  'hips',
  'spine',
  'chest',
  'head',
  'leftUpperArm',
  'leftLowerArm',
  'rightUpperArm',
  'rightLowerArm',
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

function rotations(
  values: Partial<Record<BoneName, VrmVec3>>,
): Record<BoneName, VrmVec3> {
  return Object.fromEntries(
    TRACKED_BONES.map((bone) => [bone, values[bone] ?? IDENTITY]),
  ) as Record<BoneName, VrmVec3>
}

function idleFrame(cls: PlayerClass, t: number, duration: number): PoseFrame {
  const phase = (t / duration) * Math.PI * 2
  const breath = Math.sin(phase)
  const drift = Math.sin(phase * 0.5)
  const classBias = cls === 'melee' ? 1 : -1

  return {
    hipsPosition: [0, 1 + breath * 0.006, 0],
    rotations: rotations({
      hips: [breath * 0.006, drift * 0.018, drift * 0.008],
      spine: [-breath * 0.01, -drift * 0.012, -drift * 0.006],
      chest: [breath * 0.014, -drift * 0.006, drift * 0.004],
      head: [-breath * 0.008, drift * 0.016, -drift * 0.004],
      leftUpperArm: [
        VRM_REST.armForward - breath * 0.012,
        0,
        -VRM_REST.armDown + classBias * 0.012,
      ],
      leftLowerArm: [0, -VRM_REST.elbow - breath * 0.01, 0],
      rightUpperArm: [
        VRM_REST.armForward + breath * 0.012,
        0,
        VRM_REST.armDown + classBias * 0.018,
      ],
      rightLowerArm: [0, VRM_REST.elbow + breath * 0.012, 0],
      leftUpperLeg: [0, 0, -VRM_REST.legSplay],
      rightUpperLeg: [0, 0, VRM_REST.legSplay],
    }),
  }
}

function walkFrame(cls: PlayerClass, t: number, duration: number): PoseFrame {
  const phase = (t / duration) * Math.PI * 2
  const stride = Math.sin(phase)
  const bounce = Math.cos(phase * 2)
  const classWeight = cls === 'melee' ? 1.08 : 0.96
  const armSwing = stride * 0.42 * classWeight
  const legSwing = stride * 0.62
  const leftKnee = Math.max(0, stride) * 0.9
  const rightKnee = Math.max(0, -stride) * 0.9

  return {
    hipsPosition: [0, 1 + bounce * 0.018, 0],
    rotations: rotations({
      hips: [-stride * 0.04, stride * 0.15, bounce * 0.018],
      spine: [0.055, -stride * 0.105, -bounce * 0.012],
      chest: [0.012, -stride * 0.045, bounce * 0.009],
      head: [-0.018, stride * 0.04, -bounce * 0.006],
      leftUpperArm: [VRM_REST.armForward + armSwing, 0, -VRM_REST.armDown],
      leftLowerArm: [0, -VRM_REST.elbow - Math.max(0, -stride) * 0.08, 0],
      rightUpperArm: [VRM_REST.armForward - armSwing, 0, VRM_REST.armDown],
      rightLowerArm: [0, VRM_REST.elbow + Math.max(0, stride) * 0.08, 0],
      leftUpperLeg: [-legSwing, 0, -VRM_REST.legSplay],
      leftLowerLeg: [leftKnee, 0, 0],
      leftFoot: [-leftKnee * 0.45, 0, 0],
      rightUpperLeg: [legSwing, 0, VRM_REST.legSplay],
      rightLowerLeg: [rightKnee, 0, 0],
      rightFoot: [-rightKnee * 0.45, 0, 0],
    }),
  }
}

function actionFrame(cls: PlayerClass, action: CharacterAction, t: number): PoseFrame {
  const duration = VRM_ACTION_DURATION[action]
  const env = actionEnvelope(t / duration, VRM_TIMING[action])
  const pose = VRM_POSES[cls][action]
  const stance = Math.abs(env)

  const arm = (side: 1 | -1, values: typeof pose.armL) => {
    const down = VRM_REST.armDown - Math.max(-0.4, values[2] * env)
    const elbow = Math.max(0.02, VRM_REST.elbow + values[3] * env)
    return {
      upper: [
        VRM_REST.armForward - values[0] * env,
        -side * values[1] * env,
        -side * down,
      ] as VrmVec3,
      lower: [0, -side * elbow, 0] as VrmVec3,
    }
  }

  const leftArm = arm(1, pose.armL)
  const rightArm = arm(-1, pose.armR)
  const leftKnee = stance * 0.24
  const rightKnee = stance * 0.24

  return {
    // VRMA permits translation on Hips only. X/Z stay zero so gameplay owns root motion.
    hipsPosition: [0, 1 + pose.lift * env, 0],
    rotations: rotations({
      hips: pose.hips.map((value) => value * env) as VrmVec3,
      spine: pose.spine.map((value) => value * env) as VrmVec3,
      chest: pose.chest.map((value) => value * env) as VrmVec3,
      head: pose.head.map((value) => value * env) as VrmVec3,
      leftUpperArm: leftArm.upper,
      leftLowerArm: leftArm.lower,
      rightUpperArm: rightArm.upper,
      rightLowerArm: rightArm.lower,
      leftUpperLeg: [-stance * 0.3, 0, -(VRM_REST.legSplay + stance * 0.09)],
      leftLowerLeg: [leftKnee, 0, 0],
      leftFoot: [-leftKnee * 0.45, 0, 0],
      rightUpperLeg: [stance * 0.3, 0, VRM_REST.legSplay + stance * 0.09],
      rightLowerLeg: [rightKnee, 0, 0],
      rightFoot: [-rightKnee * 0.45, 0, 0],
    }),
  }
}

function uniformTimes(duration: number, sampleCount: number): number[] {
  return Array.from(
    { length: sampleCount },
    (_, index) => (duration * index) / (sampleCount - 1),
  )
}

function actionTimes(action: CharacterAction): number[] {
  const duration = VRM_ACTION_DURATION[action]
  const timing = VRM_TIMING[action]
  const recoveryTurn = timing.tHold + (1 - timing.tHold) * 0.65
  const values = [
    ...uniformTimes(duration, Math.max(9, Math.ceil(duration * 30) + 1)),
    duration * timing.tWind,
    duration * timing.tStrike,
    duration * timing.tHold,
    duration * recoveryTurn,
  ]
  return [...new Set(values.map((value) => Number(value.toFixed(6))))].sort((a, b) => a - b)
}

function splitClipName(name: VrmaClipName): [PlayerClass, 'idle' | 'walk' | CharacterAction] {
  const [cls, state] = name.split('.')
  return [cls as PlayerClass, state as 'idle' | 'walk' | CharacterAction]
}

function createFrames(name: VrmaClipName): { times: number[]; frames: PoseFrame[] } {
  const [cls, state] = splitClipName(name)
  if (state === 'idle') {
    const duration = 2.4
    const times = uniformTimes(duration, 49)
    return { times, frames: times.map((time) => idleFrame(cls, time, duration)) }
  }
  if (state === 'walk') {
    const duration = cls === 'melee' ? 0.68 : 0.72
    const times = uniformTimes(duration, 25)
    return { times, frames: times.map((time) => walkFrame(cls, time, duration)) }
  }
  const times = actionTimes(state)
  return { times, frames: times.map((time) => actionFrame(cls, state, time)) }
}

function quatValues(frames: PoseFrame[], bone: BoneName): number[] {
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
  const { times, frames } = createFrames(name)
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
  return { name, samplers, channels }
}

function padChunk(bytes: Uint8Array, fill: number): Uint8Array {
  const paddedLength = Math.ceil(bytes.byteLength / 4) * 4
  if (paddedLength === bytes.byteLength) return bytes
  const padded = new Uint8Array(paddedLength)
  padded.fill(fill)
  padded.set(bytes)
  return padded
}

function createGlb(): Uint8Array {
  const binary = new BinaryBuilder()
  const animations = VRMA_CLIP_ORDER.map((name) => addAnimation(name, binary))
  const binChunk = padChunk(binary.finish(), 0)
  const json = {
    asset: {
      version: '2.0',
      generator: 'Myeongwol authored VRMA generator',
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

const output = createGlb()
mkdirSync(dirname(OUTPUT), { recursive: true })
writeFileSync(OUTPUT, output)
console.log(`Generated ${OUTPUT}`)
console.log(`${VRMA_CLIP_ORDER.length} clips, ${output.byteLength.toLocaleString()} bytes`)
