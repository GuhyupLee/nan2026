import { ARENA_RADIUS, FLASH_RANGE, HEAL_AMOUNT, HEAL_SPEED_BOOST, HEAL_BOOST_TIME } from './constants.ts'
import { consumeCooldown, SKILL_D, SKILL_F } from './skills.ts'
import type { Input, World } from './types.ts'

/**
 * 소환사 주문 — D 회복 / F 점멸.
 *
 * 시작부터 보유하는 두 능력이다. 구현이 싸면서(투사체도 복잡한 판정도 없다)
 * 효과가 크다 — 롤의 D/F 키를 그대로 쓰므로 한국 심사자는 0.5초 만에 알아본다.
 *
 * 그리고 이 둘이 해금 순서 밸런싱 문제를 통째로 없앤다. Q/W/E를 어떤 순서로
 * 골라도 첫 20초부터 탈출기와 회복이 손에 있으므로, "생존기를 마지막에
 * 뽑은 사람"이라는 최약 조합이 존재하지 않는다. 6가지 순서의 성립을
 * 밸런싱이 아니라 슬롯 배치로 사는 셈이다.
 */

/** 지면에 남는 원형 연출. 스킬들이 앞으로 이 큐를 공유한다. */
export interface RingEvent {
  x: number
  y: number
  /** 최종 반경. */
  radius: number
  /** 0 = 시안(점멸), 1 = 초록(회복) */
  kind: number
}

function tryFlash(world: World): boolean {
  if (!consumeCooldown(world.skills, 'f')) return false

  const p = world.player
  let dx = world.lastAim.x - p.pos.x
  let dy = world.lastAim.y - p.pos.y
  const d = Math.hypot(dx, dy)

  if (d < 1e-4) {
    // 커서가 발밑이면 바라보는 방향으로 나간다. 제자리 점멸은 낭비다.
    dx = Math.cos(p.facing)
    dy = Math.sin(p.facing)
  } else {
    dx /= d
    dy /= d
  }

  // 롤과 같다 — 커서까지 가되 최대 사거리를 넘지 않는다.
  const dist = Math.min(d < 1e-4 ? FLASH_RANGE : d, FLASH_RANGE)

  const fromX = p.pos.x
  const fromY = p.pos.y
  let nx = fromX + dx * dist
  let ny = fromY + dy * dist

  // 아레나 밖으로 나가면 경계 안쪽으로 접는다
  const outer = Math.hypot(nx, ny)
  const limit = ARENA_RADIUS - p.radius
  if (outer > limit && outer > 1e-6) {
    const s = limit / outer
    nx *= s
    ny *= s
  }

  p.pos.x = nx
  p.pos.y = ny
  // prev도 같이 옮긴다. 안 그러면 렌더가 두 지점을 보간해서
  // 순간이동이 아니라 초고속 이동으로 보인다.
  p.prevPos.x = nx
  p.prevPos.y = ny
  // 순간이동 후 관성이 남으면 미끄러진다
  p.vel.x = 0
  p.vel.y = 0

  pushRing(world, fromX, fromY, 1.6, 0)
  pushRing(world, nx, ny, 2.2, 0)
  return true
}

function tryHeal(world: World): boolean {
  const p = world.player
  if (!consumeCooldown(world.skills, 'd')) return false

  p.hp = Math.min(p.maxHp, p.hp + HEAL_AMOUNT)
  // 롤의 회복처럼 짧은 이동속도 증가가 붙는다. 회복만 있으면
  // "맞으면서 회복"이 되지만, 이속이 붙으면 "빠져나오면서 회복"이 된다.
  p.speedBoostUntil = world.time + HEAL_BOOST_TIME

  pushRing(world, p.pos.x, p.pos.y, 3.2, 1)
  return true
}

function pushRing(world: World, x: number, y: number, radius: number, kind: number): void {
  if (world.rings.length < 32) world.rings.push({ x, y, radius, kind })
}

/**
 * 이번 틱에 눌린 스킬을 처리한다.
 * Q/W/E/R은 클래스별 킷이 붙으면 여기에 추가된다.
 */
export function stepAbilities(world: World, input: Input): void {
  const pressed = input.skillsPressed
  if (pressed === 0) return

  if (pressed & SKILL_F) tryFlash(world)
  if (pressed & SKILL_D) tryHeal(world)
}

/** 회복 버프가 적용된 현재 이동 속도. */
export function currentSpeed(world: World): number {
  const p = world.player
  return world.time < p.speedBoostUntil ? p.speed * HEAL_SPEED_BOOST : p.speed
}
