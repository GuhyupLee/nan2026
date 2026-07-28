import { DT } from './constants.ts'
import { ELITE_SPAWN_TIMES, spawnElite } from './enemies.ts'
import type { World } from './types.ts'

/** 정예가 남긴 월식 인장. prev 좌표는 60Hz와 화면 프레임 사이를 보간한다. */
export interface RelicDrop {
  x: number
  y: number
  prevX: number
  prevY: number
  spawnedAt: number
}

export const RELIC_ARM_DELAY = 0.8
export const RELIC_PICKUP_RADIUS = 0.9
export const RELIC_ATTRACT_SPEED = 15
const MAX_RELIC_DROPS = ELITE_SPAWN_TIMES.length

/**
 * 정예 비트를 정확히 한 번씩 소모한다.
 *
 * 풀 용량 때문에 스폰이 실패하면 인덱스를 넘기지 않는다. 다음 틱에 다시
 * 시도해야 5분 런의 핵심 보상이 조용히 유실되지 않는다.
 */
export function stepEliteRewardBeats(world: World): void {
  const beat = ELITE_SPAWN_TIMES[world.eliteBeatIndex]
  if (beat === undefined || world.time + DT * 0.5 < beat) return
  if (!spawnElite(world.enemies, world.rng, world.player.pos.x, world.player.pos.y, world.time)) {
    return
  }

  const index = world.enemies.count - 1
  const x = world.enemies.x[index]!
  const y = world.enemies.y[index]!
  world.eliteBeatIndex += 1

  // 금빛 출현 파동. 판정에는 관여하지 않고 정예가 섞여 들어왔다는 신호만 준다.
  if (world.rings.length < 32) world.rings.push({ x, y, radius: 5.5, kind: 2 })
}

/** 정예 사망 위치에 월식 인장을 하나 만든다. */
export function dropRelic(world: World, x: number, y: number): void {
  if (world.relicDrops.length >= MAX_RELIC_DROPS) return
  world.relicDrops.push({ x, y, prevX: x, prevY: y, spawnedAt: world.time })
}

/**
 * 인장은 0.8초 동안 사망 위치에서 읽힌 뒤 플레이어에게 날아온다.
 * 직접 밟을 필요는 없게 했다. 전리품은 보상이지 전투 중 놓칠 수 있는 벌점이 아니다.
 */
export function stepRelicDrops(world: World): void {
  const px = world.player.pos.x
  const py = world.player.pos.y

  for (let i = world.relicDrops.length - 1; i >= 0; i--) {
    const relic = world.relicDrops[i]!
    relic.prevX = relic.x
    relic.prevY = relic.y

    const age = world.time - relic.spawnedAt
    let dx = px - relic.x
    let dy = py - relic.y
    let distance = Math.hypot(dx, dy)

    if (age >= RELIC_ARM_DELAY && distance > 1e-6) {
      dx /= distance
      dy /= distance
      const step = Math.min(distance, RELIC_ATTRACT_SPEED * DT)
      relic.x += dx * step
      relic.y += dy * step
      distance -= step
    }

    if (age < RELIC_ARM_DELAY || distance > RELIC_PICKUP_RADIUS) continue

    const last = world.relicDrops.pop()!
    if (i < world.relicDrops.length) world.relicDrops[i] = last
    world.pendingRelicChoices += 1
    world.relicsClaimed += 1
    world.awaitingChoice = true

    if (world.rings.length < 32) {
      world.rings.push({ x: px, y: py, radius: 4.2, kind: 2 })
    }
  }
}
