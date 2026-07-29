import { bufferPlayerSkill, takeBufferedPlayerSkill } from './actions.ts'
import { castSkill, MARK_DURATION } from './kits.ts'
import { upgradeTraitToken } from './progression.ts'
import {
  consumeCooldown,
  SKILL_BIT,
  SKILL_D,
  SKILL_F,
  type SkillId,
} from './skills.ts'
import { effectiveAtkDamage } from './stats.ts'
import {
  resolveTargeting,
  type TargetingSolution,
} from './targeting.ts'
import type { Input, World } from './types.ts'
import type { Vec2 } from './vec.ts'
import { pushBlast } from './zones.ts'

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
  /** 0=시안, 1=회복, 2=금빛, 3=참격, 4=적대 서지 예고. */
  kind: number
}

const flashTarget: TargetingSolution = {
  x: 0,
  y: 0,
  angle: 0,
  distance: 0,
  snapped: false,
}

function tryFlash(world: World, aim?: Vec2): boolean {
  if (world.ult.active) return false

  const p = world.player
  const fromX = p.pos.x
  const fromY = p.pos.y
  const target = resolveTargeting(
    world,
    'f',
    flashTarget,
    aim?.x,
    aim?.y,
  )
  const nx = target.x
  const ny = target.y

  if (Math.hypot(nx - fromX, ny - fromY) < 0.12) return false
  if (!consumeCooldown(world.skills, 'f')) return false
  if (world.upgradesTaken.has(upgradeTraitToken('utility-overdrive'))) {
    world.player.utilityPowerUntil = Math.max(
      world.player.utilityPowerUntil,
      world.time + 3,
    )
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

  const skillDash = world.playerAction?.skillDash
  if (skillDash) {
    // F는 소환사 주문이라 QWER보다 우선한다. 진행 중인 W가 다음 stepPlayer에서
    // 원래 보간 경로를 다시 쓰면 점멸이 통째로 사라지므로 이동만 취소한다.
    // 스킬 원점과 종점은 보존해야 루멘 W 렌즈와 월아 W 베기가 점멸 위치로
    // 따라오지 않고, 시전 FX도 처음 예고한 경로와 일치한다.
    skillDash.movementCancelled = true
  }

  pushRing(world, fromX, fromY, 1.6, 0)
  pushRing(world, nx, ny, 2.2, 0)
  if (
    world.playerClass === 'melee' &&
    world.upgradesTaken.has(upgradeTraitToken('afterimage-step'))
  ) {
    pushBlast(world, {
      kind: 1,
      x: fromX,
      y: fromY,
      radius: 3.2,
      damage:
        effectiveAtkDamage(world.stats) *
        (world.time < world.player.utilityPowerUntil ? 1.25 : 1) *
        0.65,
      impulse: 8,
      markDuration: MARK_DURATION,
      slowMul: 1,
      slowDuration: 0,
      fireAt: world.time + 0.18,
    })
  }
  return true
}

function tryHeal(world: World): boolean {
  const p = world.player
  if (!consumeCooldown(world.skills, 'd')) return false
  if (world.upgradesTaken.has(upgradeTraitToken('utility-overdrive'))) {
    p.utilityPowerUntil = Math.max(p.utilityPowerUntil, world.time + 3)
  }

  const overflow = Math.max(
    0,
    p.hp + world.stats.healAmount - world.stats.maxHp,
  )
  p.hp = Math.min(world.stats.maxHp, p.hp + world.stats.healAmount)
  // 롤의 회복처럼 짧은 이동속도 증가가 붙는다. 회복만 있으면
  // "맞으면서 회복"이 되지만, 이속이 붙으면 "빠져나오면서 회복"이 된다.
  p.speedBoostUntil = world.time + world.stats.healBoostTime
  if (
    overflow > 0 &&
    world.upgradesTaken.has(upgradeTraitToken('overflow-guard'))
  ) {
    // 초과 회복량이 크더라도 긴 무적으로 바뀌지 않게 보호 시간을 고정한다.
    p.invulnUntil = Math.max(p.invulnUntil, world.time + 0.65)
  }
  if (
    overflow > 0 &&
    world.upgradesTaken.has(upgradeTraitToken('overheal-guard'))
  ) {
    p.guardCharges = Math.min(1, p.guardCharges + 1)
  }

  pushRing(world, p.pos.x, p.pos.y, 3.2, 1)
  return true
}

function pushRing(world: World, x: number, y: number, radius: number, kind: number): void {
  if (world.rings.length < 32) world.rings.push({ x, y, radius, kind })
}

/**
 * 브라우저는 스킬바가 실제로 조준한 슬롯만 잠근다. aimedSkillSlot이 없는
 * 헤드리스 입력은 기존 계약대로 단일 skillAim을 모든 동시 시전에 사용한다.
 */
function inputSkillAim(input: Input, slot: SkillId): Vec2 | undefined {
  if (!input.skillAim) return undefined
  if (
    input.aimedSkillSlot !== undefined &&
    input.aimedSkillSlot !== slot
  ) {
    return undefined
  }
  return input.skillAim
}

/**
 * 이번 틱에 눌린 스킬을 처리한다.
 * Q/W/E/R은 클래스별 킷이 붙으면 여기에 추가된다.
 */
export function stepAbilities(world: World, input: Input): void {
  const pressed = input.skillsPressed

  const buffered = takeBufferedPlayerSkill(world)
  if (buffered?.slot === 'f') {
    tryFlash(world, buffered.lockedAim ?? undefined)
  } else if (buffered?.slot === 'd') {
    tryHeal(world)
  } else if (buffered) {
    castSkill(world, buffered.slot, buffered.lockedAim ?? undefined)
  }
  if (pressed === 0) return

  // 소환사 주문이 먼저다. 위기에서 점멸이 스킬 뒤로 밀리면 안 된다.
  if (pressed & SKILL_F) {
    const aim = inputSkillAim(input, 'f')
    if (!tryFlash(world, aim)) {
      bufferPlayerSkill(world, 'f', aim)
    }
  }
  if (pressed & SKILL_D) {
    if (!tryHeal(world)) bufferPlayerSkill(world, 'd')
  }

  let handled = 0
  for (const slot of input.skillSequence ?? []) {
    if (
      slot === 'd' ||
      slot === 'f' ||
      (handled & SKILL_BIT[slot]) !== 0 ||
      (pressed & SKILL_BIT[slot]) === 0
    ) {
      continue
    }
    castSkill(world, slot, inputSkillAim(input, slot))
    handled |= SKILL_BIT[slot]
  }

  const fallback: readonly SkillId[] = ['q', 'w', 'e', 'r']
  for (const slot of fallback) {
    const bit = SKILL_BIT[slot]
    if ((pressed & bit) !== 0 && (handled & bit) === 0) {
      castSkill(world, slot, inputSkillAim(input, slot))
    }
  }
}

/** 회복 버프가 적용된 현재 이동 속도. */
export function currentSpeed(world: World): number {
  const s = world.stats
  return world.time < world.player.speedBoostUntil ? s.speed * s.healSpeedBoost : s.speed
}
