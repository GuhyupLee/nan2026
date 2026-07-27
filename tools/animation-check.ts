import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'
import { Euler, Quaternion } from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { playerActionTiming } from '../src/sim/action-timing.ts'
import type { PlayerClass } from '../src/sim/types.ts'
import type { CharacterAction } from '../src/render/rig.ts'
import {
  VRM_ACTION_MOTIONS,
  VRMA_CLIP_ORDER,
  type VrmActionStage,
  type VrmBoneName,
  type VrmaClipName,
} from '../src/render/animation-data.ts'
import { canStartVrmAction } from '../src/render/vrm-animation.ts'

interface GltfAccessor {
  bufferView: number
  componentType: number
  count: number
  type: 'SCALAR' | 'VEC3' | 'VEC4'
}

interface GltfBufferView {
  byteOffset?: number
  byteLength: number
}

interface GltfAnimation {
  name: VrmaClipName
  samplers: Array<{ input: number; output: number }>
  channels: Array<{
    sampler: number
    target: { node: number; path: 'translation' | 'rotation' }
  }>
  extras?: {
    sampleRate?: number
    inPlace?: boolean
    loop?: boolean
    phases?: Array<{ stage: VrmActionStage; time: number }>
  }
}

interface GltfJson {
  extensions: {
    VRMC_vrm_animation: {
      specVersion: string
      humanoid: { humanBones: Record<string, { node: number }> }
    }
  }
  nodes: Array<{ name?: string }>
  animations: GltfAnimation[]
  bufferViews: GltfBufferView[]
  accessors: GltfAccessor[]
}

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FILE = resolve(HERE, '../public/animations/myeongwol-combat.vrma')
const file = readFileSync(FILE)
const view = new DataView(file.buffer, file.byteOffset, file.byteLength)

assert.equal(canStartVrmAction('attack', 0.2, 'attack'), false, 'attack blocks early retrigger')
assert.equal(canStartVrmAction('attack', 0.2, 'q'), true, 'Q interrupts attack')
assert.equal(canStartVrmAction('q', 0.2, 'attack'), false, 'attack cannot interrupt early Q')
assert.equal(canStartVrmAction('r', 0.17, 'ult'), false, 'ultimate follow-up cannot interrupt R')
assert.equal(canStartVrmAction('r', 0.85, 'attack'), false, 'attack cannot cut off R recovery')
assert.equal(canStartVrmAction('q', 0.99, 'attack'), false, 'attack waits for the full Q animation')
assert.equal(canStartVrmAction('attack', 0.73, 'attack'), false, 'attack does not retrigger in recovery')
assert.equal(canStartVrmAction('q', 1, 'attack'), true, 'attack starts after Q fully ends')

assert.equal(view.getUint32(0, true), 0x46546c67, 'GLB magic')
assert.equal(view.getUint32(4, true), 2, 'GLB version')
assert.equal(view.getUint32(8, true), file.byteLength, 'GLB declared length')

const jsonLength = view.getUint32(12, true)
assert.equal(view.getUint32(16, true), 0x4e4f534a, 'JSON chunk type')
const json = JSON.parse(
  new TextDecoder().decode(file.subarray(20, 20 + jsonLength)).trim(),
) as GltfJson

const binHeader = 20 + jsonLength
const binLength = view.getUint32(binHeader, true)
assert.equal(view.getUint32(binHeader + 4, true), 0x004e4942, 'BIN chunk type')
const binOffset = binHeader + 8
assert.ok(binOffset + binLength <= file.byteLength, 'BIN chunk bounds')

assert.equal(json.extensions.VRMC_vrm_animation.specVersion, '1.0')
assert.deepEqual(
  json.animations.map((animation) => animation.name),
  [...VRMA_CLIP_ORDER],
  'stable clip order',
)

const componentCount = (type: GltfAccessor['type']): number =>
  type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4

function accessorValues(index: number): Float32Array {
  const accessor = json.accessors[index]!
  assert.equal(accessor.componentType, 5126, `accessor ${index} uses float32`)
  const bufferView = json.bufferViews[accessor.bufferView]!
  const byteOffset = binOffset + (bufferView.byteOffset ?? 0)
  const count = accessor.count * componentCount(accessor.type)
  return new Float32Array(file.buffer, file.byteOffset + byteOffset, count)
}

function parseClipName(name: VrmaClipName): {
  cls: PlayerClass
  state: 'idle' | 'walk' | CharacterAction
} {
  const [cls, state] = name.split('.')
  return {
    cls: cls as PlayerClass,
    state: state as 'idle' | 'walk' | CharacterAction,
  }
}

function channelFor(
  animation: GltfAnimation,
  targetName: string,
  path: 'translation' | 'rotation',
): GltfAnimation['channels'][number] {
  const channel = animation.channels.find(
    (candidate) =>
      candidate.target.path === path &&
      json.nodes[candidate.target.node]?.name === targetName,
  )
  assert.ok(channel, `${animation.name} has ${targetName}.${path} track`)
  return channel
}

function quaternionAt(
  animation: GltfAnimation,
  bone: VrmBoneName,
  time: number,
): Quaternion {
  const channel = channelFor(animation, bone, 'rotation')
  const sampler = animation.samplers[channel.sampler]!
  const times = accessorValues(sampler.input)
  const values = accessorValues(sampler.output)
  const index = Array.from(times).findIndex((candidate) => Math.abs(candidate - time) < 1e-5)
  assert.notEqual(index, -1, `${animation.name} samples ${bone} at ${time.toFixed(3)} s`)
  const offset = index * 4
  return new Quaternion(
    values[offset]!,
    values[offset + 1]!,
    values[offset + 2]!,
    values[offset + 3]!,
  )
}

function quaternionDistance(a: Quaternion, b: Quaternion): number {
  const normalizedDot = a.dot(b) / Math.max(1e-12, a.length() * b.length())
  return 2 * Math.acos(Math.min(1, Math.abs(normalizedDot)))
}

const EXPECTED_STAGES: readonly VrmActionStage[] = [
  'start',
  'anticipation',
  'contact',
  'followThrough',
  'recovery',
]

const XYZ_GROUPS: Readonly<Record<string, readonly VrmBoneName[]>> = {
  pelvis: ['hips'],
  spine: ['spine'],
  chest: ['chest'],
  head: ['head'],
  upperArm: ['leftUpperArm', 'rightUpperArm'],
  lowerArm: ['leftLowerArm', 'rightLowerArm'],
  hand: ['leftHand', 'rightHand'],
  upperLeg: ['leftUpperLeg', 'rightUpperLeg'],
  lowerLeg: ['leftLowerLeg', 'rightLowerLeg'],
  foot: ['leftFoot', 'rightFoot'],
}

const actionNames = new Set<string>([
  'attack',
  'empowered',
  'ult',
  'q',
  'w',
  'e',
  'r',
])

for (const animation of json.animations) {
  assert.equal(animation.extras?.sampleRate, 30, `${animation.name} declares 30 fps`)
  assert.equal(animation.extras?.inPlace, true, `${animation.name} declares in-place motion`)
  assert.equal(animation.channels.length, 20, `${animation.name} has Hips plus 19 bone tracks`)

  const commonInput = animation.samplers[0]!.input
  const times = accessorValues(commonInput)
  assert.equal(times[0], 0, `${animation.name} starts at zero`)
  for (let index = 1; index < times.length; index += 1) {
    const gap = times[index]! - times[index - 1]!
    assert.ok(gap > 0, `${animation.name} times increase`)
    assert.ok(gap <= 1 / 30 + 2e-6, `${animation.name} has no gap larger than one 30 fps frame`)
  }
  for (const sampler of animation.samplers) {
    assert.equal(sampler.input, commonInput, `${animation.name} tracks share the 30 fps clock`)
  }

  for (const hand of ['leftHand', 'rightHand'] as const) {
    channelFor(animation, hand, 'rotation')
  }

  for (const channel of animation.channels) {
    const sampler = animation.samplers[channel.sampler]!
    const output = accessorValues(sampler.output)
    const targetName = json.nodes[channel.target.node]?.name

    if (channel.target.path === 'translation') {
      assert.equal(targetName, 'hips', `${animation.name} translates Hips only`)
      for (let index = 0; index < output.length; index += 3) {
        assert.ok(Math.abs(output[index]!) < 1e-7, `${animation.name} has no root X motion`)
        assert.ok(Math.abs(output[index + 2]!) < 1e-7, `${animation.name} has no root Z motion`)
      }
    } else {
      for (let index = 0; index < output.length; index += 4) {
        const norm = Math.hypot(
          output[index]!,
          output[index + 1]!,
          output[index + 2]!,
          output[index + 3]!,
        )
        assert.ok(Math.abs(norm - 1) < 1e-5, `${animation.name} quaternion is normalized`)
      }
    }
  }

  const { cls, state } = parseClipName(animation.name)
  if (!actionNames.has(state)) {
    assert.equal(animation.extras?.loop, true, `${animation.name} is a loop`)
    for (const bone of ['hips', 'spine', 'chest', 'leftHand', 'rightHand'] as const) {
      const first = quaternionAt(animation, bone, times[0]!)
      const last = quaternionAt(animation, bone, times.at(-1)!)
      assert.ok(
        quaternionDistance(first, last) < 1e-5,
        `${animation.name} loops ${bone} without a seam`,
      )
    }
    continue
  }

  const action = state as CharacterAction
  const motion = VRM_ACTION_MOTIONS[cls][action]
  const phases = animation.extras?.phases
  assert.ok(phases, `${animation.name} embeds authored phase markers`)
  assert.deepEqual(
    phases.map(({ stage }) => stage),
    EXPECTED_STAGES,
    `${animation.name} has start/anticipation/contact/follow-through/recovery`,
  )
  assert.equal(phases[0]!.time, 0, `${animation.name} starts at time zero`)
  assert.ok(
    Math.abs(phases.at(-1)!.time - motion.duration) < 1e-6,
    `${animation.name} recovery ends at its class-aware duration`,
  )
  for (let index = 1; index < phases.length; index += 1) {
    assert.ok(
      phases[index]!.time > phases[index - 1]!.time,
      `${animation.name} phase markers are distinct and ordered`,
    )
  }

  if (action !== 'attack' && action !== 'empowered') {
    const expectedImpact = playerActionTiming(cls, action).impact
    const contact = phases.find(({ stage }) => stage === 'contact')!
    assert.ok(
      Math.abs(contact.time - expectedImpact) < 1e-6,
      `${animation.name} contact matches simulation impact`,
    )
  }

  if (animation.name === 'melee.w') {
    assert.deepEqual(
      phases.map(({ time }) => time),
      [0, 0.16, 0.32, 0.42, 0.56],
      'melee W reads as draw preparation, advancing cut, landing, recovery',
    )
  }

  for (let index = 1; index < phases.length; index += 1) {
    const before: { stage: VrmActionStage; time: number } = phases[index - 1]!
    const after: { stage: VrmActionStage; time: number } = phases[index]!
    let silhouetteChange = 0
    for (const bone of [
      'hips',
      'spine',
      'chest',
      'leftUpperArm',
      'rightUpperArm',
      'leftHand',
      'rightHand',
      'leftUpperLeg',
      'rightUpperLeg',
    ] as const) {
      silhouetteChange += quaternionDistance(
        quaternionAt(animation, bone, before.time),
        quaternionAt(animation, bone, after.time),
      )
    }
    assert.ok(
      silhouetteChange > 0.65,
      `${animation.name} ${before.stage}→${after.stage} has a distinct silhouette`,
    )
  }

  for (const [group, bones] of Object.entries(XYZ_GROUPS)) {
    const axisRange = [0, 0, 0]
    for (const bone of bones) {
      const channel = channelFor(animation, bone, 'rotation')
      const output = accessorValues(animation.samplers[channel.sampler]!.output)
      const values: number[][] = [[], [], []]
      for (let index = 0; index < output.length; index += 4) {
        const euler = new Euler().setFromQuaternion(
          new Quaternion(
            output[index]!,
            output[index + 1]!,
            output[index + 2]!,
            output[index + 3]!,
          ),
          'XYZ',
        )
        values[0]!.push(euler.x)
        values[1]!.push(euler.y)
        values[2]!.push(euler.z)
      }
      for (let axis = 0; axis < 3; axis += 1) {
        const range = Math.max(...values[axis]!) - Math.min(...values[axis]!)
        axisRange[axis] = Math.max(axisRange[axis]!, range)
      }
    }
    for (let axis = 0; axis < 3; axis += 1) {
      assert.ok(
        axisRange[axis]! > 0.025,
        `${animation.name} animates ${group} on ${'XYZ'[axis]} axis`,
      )
    }
  }
}

const loader = new GLTFLoader()
loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
const glb = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
const loaded = await loader.parseAsync(glb, '')
const animations = loaded.userData.vrmAnimations as Array<{ duration: number }> | undefined

assert.equal(animations?.length, VRMA_CLIP_ORDER.length, 'official loader clip count')
assert.ok(animations?.every((animation) => animation.duration > 0), 'all clips have duration')
for (let index = 0; index < VRMA_CLIP_ORDER.length; index += 1) {
  const { cls, state } = parseClipName(VRMA_CLIP_ORDER[index]!)
  if (!actionNames.has(state)) continue
  const expected = VRM_ACTION_MOTIONS[cls][state as CharacterAction].duration
  assert.ok(
    Math.abs(animations![index]!.duration - expected) < 1e-5,
    `${VRMA_CLIP_ORDER[index]} official-loader duration`,
  )
}

console.log(
  `VRMA check passed: ${VRMA_CLIP_ORDER.length} clips, ${file.byteLength.toLocaleString()} bytes`,
)
