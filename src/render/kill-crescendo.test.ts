import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { nonBombKillTotal } from '../sim/battlefield-pickups.ts'
import {
  KILL_CADENCE_GAP,
  KillCadenceTracker,
} from './kill-crescendo.ts'

const tracker = new KillCadenceTracker()
tracker.reset(0, 0)

assert.equal(tracker.observe(9, 0.1), null)
assert.deepEqual(tracker.observe(10, 0.2), {
  tier: 0,
  count: 10,
  delta: 1,
})
assert.equal(tracker.observe(19, 0.3), null)
assert.equal(tracker.observe(20, 0.4)?.tier, 1)
assert.equal(tracker.observe(35, 0.5)?.tier, 2)
assert.equal(tracker.observe(60, 0.6)?.tier, 3)
assert.equal(tracker.observe(61, 0.7), null)

// 시간창을 넘긴 다음 처치는 새 연참의 첫 타다.
assert.equal(tracker.observe(62, 0.7 + KILL_CADENCE_GAP + 0.001), null)
assert.equal(tracker.chainCount, 1)
assert.equal(tracker.activeTier, -1)

// 같은 관찰 구간의 폭탄 60킬과 직접 1킬을 분리한다. 폭탄은 빠지지만
// 함께 일어난 직접 처치는 유실되지 않고 다음 연참의 첫 타가 된다.
tracker.reset(nonBombKillTotal(100, 0), 10)
assert.equal(
  tracker.observe(nonBombKillTotal(161, 60), 10.1),
  null,
)
assert.equal(tracker.chainCount, 1)
assert.equal(tracker.observe(nonBombKillTotal(169, 60), 10.2), null)
assert.equal(
  tracker.observe(nonBombKillTotal(170, 60), 10.3)?.tier,
  0,
)

// 보스 처치로 승리가 확정되어도 시각·오디오는 같은 직접 처치 누적값을 본다.
// 같은 월드로 무한전을 재개한 첫 처치도 양쪽 tracker가 어긋나지 않는다.
const visualCadence = new KillCadenceTracker()
const audioCadence = new KillCadenceTracker()
visualCadence.reset(0, 0)
audioCadence.reset(0, 0)
assert.equal(visualCadence.observe(9, 0.1), null)
assert.equal(audioCadence.observe(9, 0.1), null)
assert.equal(visualCadence.observe(10, 0.2)?.tier, 0)
assert.equal(audioCadence.observe(10, 0.2)?.tier, 0)
assert.equal(visualCadence.observe(11, 0.3), null)
assert.equal(audioCadence.observe(11, 0.3), null)
assert.equal(visualCadence.chainCount, audioCadence.chainCount)

// 한 렌더 프레임에 여러 티어를 건너뛰면 가장 높은 비트 하나로 집약한다.
tracker.reset(0, 20)
assert.deepEqual(tracker.observe(70, 20.1), {
  tier: 3,
  count: 70,
  delta: 70,
})

// 새 월드/되감기는 현재 값에 조용히 동기화한다.
assert.equal(tracker.observe(3, 0), null)
assert.equal(tracker.chainCount, 0)
assert.equal(tracker.activeTier, -1)

// 배포 자산도 같은 테스트에서 계약을 지킨다. Blender를 CI에서 다시 실행하지
// 않아도 파일 누락, 다중 드로우, 스킨/클립 유실을 즉시 잡을 수 있다.
const glb = readFileSync(
  new URL('../../public/env/moonflow-crescendo.glb', import.meta.url),
)
assert.equal(glb.toString('ascii', 0, 4), 'glTF')

let json: Record<string, unknown> | null = null
for (let offset = 12; offset + 8 <= glb.length;) {
  const length = glb.readUInt32LE(offset)
  const type = glb.readUInt32LE(offset + 4)
  const start = offset + 8
  if (type === 0x4e4f534a) {
    json = JSON.parse(
      glb.subarray(start, start + length).toString('utf8').trimEnd(),
    ) as Record<string, unknown>
    break
  }
  offset = start + length
}
assert.ok(json, 'crescendo GLB has a JSON chunk')

type GlbDocument = {
  meshes?: { primitives?: unknown[] }[]
  materials?: unknown[]
  skins?: { joints?: unknown[] }[]
  animations?: {
    name?: string
    channels?: unknown[]
    samplers?: { input: number }[]
  }[]
  accessors?: { max?: number[] }[]
}
const document = json as GlbDocument
assert.equal(document.meshes?.length, 1)
assert.equal(document.meshes?.[0]?.primitives?.length, 1)
assert.equal(document.materials?.length, 1)
assert.equal(document.skins?.length, 1)
assert.equal(document.skins?.[0]?.joints?.length, 4)
const clip = document.animations?.find(
  (animation) => animation.name === 'moonflow-crescendo',
)
assert.ok(clip)
assert.equal(clip.channels?.length, 12)
const duration = Math.max(
  ...(clip.samplers ?? []).map(
    (sampler) => document.accessors?.[sampler.input]?.max?.[0] ?? -1,
  ),
)
assert.ok(Math.abs(duration - 1.1) < 1e-3)

console.log(
  'kill-crescendo: cadence, mixed bomb kills, outcome parity, reset, and Blender GLB contract ok',
)
