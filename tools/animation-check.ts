import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { VRMA_CLIP_ORDER } from '../src/render/animation-data.ts'
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
  name: string
  samplers: Array<{ input: number; output: number }>
  channels: Array<{
    sampler: number
    target: { node: number; path: 'translation' | 'rotation' }
  }>
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
assert.equal(canStartVrmAction('r', 0.85, 'attack'), true, 'attack starts after R recovery')
assert.equal(canStartVrmAction('attack', 0.73, 'attack'), true, 'attack retriggers in recovery')

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

for (const animation of json.animations) {
  for (const sampler of animation.samplers) {
    const times = accessorValues(sampler.input)
    assert.equal(times[0], 0, `${animation.name} starts at zero`)
    for (let index = 1; index < times.length; index += 1) {
      assert.ok(times[index]! > times[index - 1]!, `${animation.name} times increase`)
    }
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
}

const loader = new GLTFLoader()
loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
const glb = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer
const loaded = await loader.parseAsync(glb, '')
const animations = loaded.userData.vrmAnimations as Array<{ duration: number }> | undefined

assert.equal(animations?.length, VRMA_CLIP_ORDER.length, 'official loader clip count')
assert.ok(animations?.every((animation) => animation.duration > 0), 'all clips have duration')

console.log(
  `VRMA check passed: ${VRMA_CLIP_ORDER.length} clips, ${file.byteLength.toLocaleString()} bytes`,
)
