import {
  ARENA_RADIUS,
  DT,
  PLAYER_ACCEL,
  PLAYER_MAX_HP,
  PLAYER_RADIUS,
  PLAYER_SPEED,
} from './constants.ts'
import { createRng } from './rng.ts'
import type { Input, Player, World } from './types.ts'
import { length, lerpAngle, normalize, vec2 } from './vec.ts'

export function createWorld(seed: number): World {
  const player: Player = {
    pos: vec2(0, 0),
    prevPos: vec2(0, 0),
    vel: vec2(0, 0),
    facing: 0,
    prevFacing: 0,
    radius: PLAYER_RADIUS,
    speed: PLAYER_SPEED,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
  }

  return {
    seed,
    tick: 0,
    time: 0,
    rng: createRng(seed),
    arenaRadius: ARENA_RADIUS,
    player,
  }
}

/**
 * 시뮬레이션을 정확히 한 틱 진행한다.
 *
 * 항상 고정 DT로만 호출된다. 가변 델타를 받지 않는 것이 결정론의 핵심이다.
 */
export function stepWorld(world: World, input: Input): void {
  stepPlayer(world, input)

  world.tick += 1
  world.time = world.tick * DT
}

const moveDir = vec2()

function stepPlayer(world: World, input: Input): void {
  const p = world.player

  // 렌더 보간용으로 직전 상태를 먼저 보관한다.
  p.prevPos.x = p.pos.x
  p.prevPos.y = p.pos.y
  p.prevFacing = p.facing

  // --- 이동 ---
  moveDir.x = input.move.x
  moveDir.y = input.move.y
  normalize(moveDir)

  const targetVx = moveDir.x * p.speed
  const targetVy = moveDir.y * p.speed

  // 프레임레이트 독립 지수 감쇠. DT가 고정이라 사실상 상수지만,
  // 상수를 바꿔 손맛을 튜닝할 때 의미가 직관적으로 유지된다.
  const k = 1 - Math.exp(-PLAYER_ACCEL * DT)
  p.vel.x += (targetVx - p.vel.x) * k
  p.vel.y += (targetVy - p.vel.y) * k

  p.pos.x += p.vel.x * DT
  p.pos.y += p.vel.y * DT

  // --- 아레나 경계 ---
  const maxDist = world.arenaRadius - p.radius
  const dist = length(p.pos)
  if (dist > maxDist && dist > 1e-9) {
    const s = maxDist / dist
    p.pos.x *= s
    p.pos.y *= s
    // 경계에 붙었을 때 속도가 남아 떨리는 것을 막는다.
    const nx = p.pos.x / maxDist
    const ny = p.pos.y / maxDist
    const outward = p.vel.x * nx + p.vel.y * ny
    if (outward > 0) {
      p.vel.x -= nx * outward
      p.vel.y -= ny * outward
    }
  }

  // --- 조준 방향 ---
  const ax = input.aim.x - p.pos.x
  const ay = input.aim.y - p.pos.y
  if (ax * ax + ay * ay > 1e-6) {
    const targetFacing = Math.atan2(ay, ax)
    p.facing = lerpAngle(p.facing, targetFacing, 0.35)
  }
}
