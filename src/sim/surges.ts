import { DT } from './constants.ts'
import {
  MAX_ENEMIES,
  TYPE_RUSHER,
  TYPE_WALKER,
  spawnEnemyAtAngle,
} from './enemies.ts'
import type { World } from './types.ts'

export const SURGE_WARNING_DURATION = 3
/** 각본 편대가 들어온 뒤 일반 웨이브 포락선을 소강값으로 누르는 시간. */
export const SURGE_WAVE_SUPPRESSION_DURATION = 12
// 서지 몹은 목표 마릿수에 포함되어 일반 스폰을 잠시 대체한다. 대군 이벤트의
// 중복 농사를 막되 4:52 성장 비트를 밀어내지 않는 24시드 측정값이다.
export const SURGE_XP_SCALE = 0.6
/** 편대 압박은 유지하되 수확 흐름을 막지 않도록 일반 개체 체력의 75%만 쓴다. */
export const SURGE_HEALTH_SCALE = 0.75
/** 예고를 무시하고 편대에 닿으면 평시보다 분명히 아프다. */
export const SURGE_CONTACT_DAMAGE_SCALE = 1.3

export const SURGE_ENCIRCLEMENT = 0
export const SURGE_COLUMN = 1
export const SURGE_FLOOD = 2
export type SurgeKind =
  | typeof SURGE_ENCIRCLEMENT
  | typeof SURGE_COLUMN
  | typeof SURGE_FLOOD

export interface SurgeBeat {
  readonly at: number
  readonly kind: SurgeKind
  readonly label: string
  readonly instruction: string
  readonly count: number
  readonly warningRadius: number
}

/**
 * 정예 비트 사이를 끊는 세 개의 고정 서지.
 *
 * 종류·수량·편대는 시드에서 파생한 시작 각도만 다르고 난수 스트림을 직접
 * 소비하지 않는다. 등장 뒤 일반 스폰 속도는 현재 생존 수에 따라 자연스럽게
 * 낮아지지만, 편대 좌표 계산 자체가 다음 난수 값을 당기지는 않는다.
 */
export const SURGE_BEATS: readonly SurgeBeat[] = [
  {
    at: 110,
    kind: SURGE_ENCIRCLEMENT,
    label: '포위 링',
    instruction: '한쪽을 뚫어 탈출로를 만드세요',
    count: 40,
    warningRadius: 14,
  },
  {
    at: 170,
    kind: SURGE_COLUMN,
    label: '돌격 행렬',
    instruction: '정면을 버리고 측면으로 피하세요',
    count: 18,
    warningRadius: 17,
  },
  {
    at: 250,
    kind: SURGE_FLOOD,
    label: '월광 홍수',
    instruction: '보스와 군세 사이의 틈을 지키세요',
    count: 28,
    warningRadius: 19,
  },
] as const

const TAU = Math.PI * 2

/**
 * 예고와 실제 편대를 정확히 한 번씩 진행한다.
 *
 * 풀 자리가 모자라면 실제 등장은 다음 틱에 재시도하되 부분 스폰은 하지 않는다.
 * XP 보상과 체력은 낮추되 접촉 피해는 높인다. 예고를 읽고 편대를 먼저 정리하면
 * 빠르게 쓸어 담을 수 있지만, 포위를 허용하면 평소보다 확실히 위험하다.
 */
export function stepSurgeBeats(world: World): void {
  const index = world.surgeBeatIndex
  const beat = SURGE_BEATS[index]
  if (!beat) return

  if (
    world.surgeWarningIndex === index &&
    world.time + DT * 0.5 >= beat.at - SURGE_WARNING_DURATION
  ) {
    world.surgeWarningIndex += 1
    pushSurgeRing(world, beat.warningRadius)
  }

  if (world.time + DT * 0.5 < beat.at) return
  if (world.enemies.count + beat.count > MAX_ENEMIES) return

  const angle = surgeAngle(world.seed, index)
  const startCount = world.enemies.count
  const spawned =
    beat.kind === SURGE_ENCIRCLEMENT
      ? spawnEncirclement(world, beat, angle, startCount)
      : beat.kind === SURGE_COLUMN
        ? spawnColumn(world, beat, angle, startCount)
        : spawnFlood(world, beat, angle, startCount)

  // 위의 용량 선검사 뒤에는 전부 성공해야 한다. 비정상 좌표나 향후 정의 변경이
  // 섞였을 때만 false가 되며, 그 경우 인덱스를 넘기지 않아 조용히 유실되지 않는다.
  if (spawned !== beat.count) {
    world.enemies.count = startCount
    return
  }

  world.surgeBeatIndex += 1
  world.surgeStartedAt = world.time
  pushSurgeRing(world, Math.min(beat.warningRadius, 8))
}

/** 일반 스폰 RNG와 독립적인 0..TAU 시작 각도. */
export function surgeAngle(seed: number, index: number): number {
  const mixed = Math.imul((seed ^ 0x7f4a7c15) >>> 0, 0x85ebca6b)
  const stepped = (mixed + Math.imul(index + 1, 0x9e3779b1)) >>> 0
  return (stepped / 4294967296) * TAU
}

function spawnEncirclement(
  world: World,
  beat: SurgeBeat,
  startAngle: number,
  startCount: number,
): number {
  let spawned = 0
  for (let i = 0; i < beat.count; i += 1) {
    const angle = startAngle + (i / beat.count) * TAU
    if (spawnAuthored(world, TYPE_WALKER, angle, 14, startCount)) spawned += 1
  }
  return spawned
}

function spawnColumn(
  world: World,
  beat: SurgeBeat,
  startAngle: number,
  startCount: number,
): number {
  let spawned = 0
  const rows = Math.ceil(beat.count / 3)
  for (let i = 0; i < beat.count; i += 1) {
    const lane = (i % 3) - 1
    const row = Math.floor(i / 3)
    // 세 개의 좁은 방사선과 바깥으로 이어지는 여섯 줄이 한 방향의 행렬로 읽힌다.
    const angle = startAngle + lane * 0.055
    const distance = 14.8 + (row / Math.max(1, rows - 1)) * 5.2
    if (spawnAuthored(world, TYPE_RUSHER, angle, distance, startCount)) {
      spawned += 1
    }
  }
  return spawned
}

function spawnFlood(
  world: World,
  beat: SurgeBeat,
  startAngle: number,
  startCount: number,
): number {
  let spawned = 0
  const arms = 3
  for (let i = 0; i < beat.count; i += 1) {
    const arm = i % arms
    const step = Math.floor(i / arms)
    const angle = startAngle + (arm / arms) * TAU + step * 0.22
    const distance = 13 + step * 0.55
    if (spawnAuthored(world, TYPE_WALKER, angle, distance, startCount)) {
      spawned += 1
    }
  }
  return spawned
}

function spawnAuthored(
  world: World,
  type: number,
  angle: number,
  distance: number,
  startCount: number,
): boolean {
  return spawnEnemyAtAngle(
    world.enemies,
    world.player.pos.x,
    world.player.pos.y,
    type,
    world.time,
    angle,
    distance,
    SURGE_XP_SCALE,
    SURGE_HEALTH_SCALE,
    SURGE_CONTACT_DAMAGE_SCALE,
    startCount,
  )
}

function pushSurgeRing(world: World, radius: number): void {
  if (world.rings.length >= 32) return
  world.rings.push({
    x: world.player.pos.x,
    y: world.player.pos.y,
    radius,
    kind: 4,
  })
}
