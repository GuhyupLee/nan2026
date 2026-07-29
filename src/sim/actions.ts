import { playerActionTiming } from './action-timing.ts'
import type {
  BufferedSkillInput,
  PendingPlayerAction,
  PlayerActionKind,
  PlayerActionSource,
  World,
} from './types.ts'
import type { Vec2 } from './vec.ts'
import {
  resolveTargeting,
  type TargetingSolution,
} from './targeting.ts'

const TIME_EPSILON = 1e-9
export const PLAYER_ACTION_BUFFER_WINDOW = 0.25
export const PLAYER_COOLDOWN_BUFFER_WINDOW = 0.18

type BufferedSkillSlot = Exclude<PendingPlayerAction['slot'], null>
const retargetedAim: TargetingSolution = {
  x: 0,
  y: 0,
  angle: 0,
  distance: 0,
  snapped: false,
}

export function emitActionStart(
  world: World,
  kind: PlayerActionKind,
  angle: number,
  startedAt = world.time,
): void {
  if (world.actionStarts.length < 16) {
    world.actionStarts.push({ kind, angle, startedAt })
  }
}

/**
 * QWER의 선딜을 시작한다.
 *
 * 판정은 impactAt에서 별도로 처리하고, endAt까지는 다음 전투 동작을 받지 않는다.
 */
export function beginPlayerAction(
  world: World,
  source: PlayerActionSource,
  kind: PlayerActionKind,
  angle: number,
  targetX: number,
  targetY: number,
  slot: PendingPlayerAction['slot'],
  aimLocked = false,
): boolean {
  if (world.playerAction) return false

  const timing = playerActionTiming(world.playerClass, kind)
  const startedAt = world.time
  world.playerAction = {
    source,
    kind,
    slot,
    aimLocked,
    angle,
    targetX,
    targetY,
    startedAt,
    impactAt: startedAt + timing.impact,
    endAt: startedAt + timing.duration,
    resolved: false,
  }
  world.player.facing = angle
  emitActionStart(world, kind, angle, startedAt)
  return true
}

/** 후딜이 끝난 동작을 비워 다음 QWER를 받을 수 있게 한다. */
export function releaseFinishedPlayerAction(world: World): void {
  const action = world.playerAction
  if (
    action &&
    action.resolved &&
    world.time + TIME_EPSILON >= action.endAt
  ) {
    world.playerAction = null
  }
}

/** 지정한 계열의 판정 프레임에 도달한 동작을 반환한다. */
export function pendingImpact(
  world: World,
  source: PlayerActionSource,
): PendingPlayerAction | null {
  const action = world.playerAction
  if (
    !action ||
    action.source !== source ||
    action.resolved ||
    world.time + TIME_EPSILON < action.impactAt
  ) {
    return null
  }
  return action
}

/**
 * 판정 직전의 커서를 다시 읽어 이동 중에도 조준한 곳으로 공격이 나가게 한다.
 * 이미 이동 경로가 시작된 돌진은 궤적과 이펙트가 갈라지지 않도록 예외로 둔다.
 */
export function retargetPendingImpact(
  world: World,
  action: PendingPlayerAction,
): void {
  if (action.skillDash || action.aimLocked) return

  if (action.slot === null) return
  const target = resolveTargeting(world, action.slot, retargetedAim)
  action.targetX = target.x
  action.targetY = target.y
  action.angle = target.angle
  world.player.facing = target.angle
}

/**
 * 조준 가능한 동작은 선딜 동안 커서를 따라가며, 판정과 캐릭터 시선이 같은
 * 해석 결과를 공유한다. 이동 경로가 이미 확정된 월아 W는 예외다.
 */
export function trackPlayerActionAim(world: World): void {
  const action = world.playerAction
  if (
    !action ||
    action.source !== 'skill' ||
    action.resolved ||
    action.skillDash ||
    action.aimLocked ||
    action.slot === null
  ) {
    return
  }
  retargetPendingImpact(world, action)
}

/**
 * 후딜 마지막 0.25초와 쿨 종료 0.18초 전 입력만 기억해 오래 전에 누른 키가
 * 뒤늦게 나가지 않게 한다.
 */
export function bufferPlayerSkill(
  world: World,
  slot: BufferedSkillSlot,
  lockedAim?: Vec2,
): boolean {
  const action = world.playerAction
  const runtime = world.skills[slot]
  if (!runtime.unlocked) return false
  if (world.ult.active && slot !== 'd') return false

  const remaining = action ? Math.max(0, action.endAt - world.time) : 0
  const cooldownLeft = Math.max(0, runtime.cooldown)
  if (action) {
    if (cooldownLeft > remaining + PLAYER_ACTION_BUFFER_WINDOW + TIME_EPSILON) {
      return false
    }
  } else if (cooldownLeft > PLAYER_COOLDOWN_BUFFER_WINDOW + TIME_EPSILON) {
    return false
  }

  const current = world.bufferedSkill
  if (
    current &&
    Math.abs(current.queuedAt - world.time) <= TIME_EPSILON &&
    current.expiresAt + TIME_EPSILON >= world.time
  ) {
    return false
  }

  world.bufferedSkill = {
    slot,
    queuedAt: world.time,
    expiresAt: action
      ? Math.max(action.endAt, world.time + cooldownLeft) +
        PLAYER_ACTION_BUFFER_WINDOW
      : world.time + PLAYER_COOLDOWN_BUFFER_WINDOW,
    lockedAim:
      lockedAim &&
      Number.isFinite(lockedAim.x) &&
      Number.isFinite(lockedAim.y)
        ? { x: lockedAim.x, y: lockedAim.y }
        : null,
  }
  return true
}

/** 잠금이 풀린 첫 틱에만 버퍼를 꺼내 연속 입력의 리듬을 보존한다. */
export function takeBufferedPlayerSkill(
  world: World,
): BufferedSkillInput | null {
  const buffered = world.bufferedSkill
  if (!buffered) return null
  if (buffered.expiresAt + TIME_EPSILON < world.time) {
    world.bufferedSkill = null
    return null
  }
  if (world.playerAction) return null
  if (
    world.ult.active &&
    buffered.slot !== 'd'
  ) {
    return null
  }
  const runtime = world.skills[buffered.slot]
  if (!runtime.unlocked) {
    world.bufferedSkill = null
    return null
  }
  if (runtime.cooldown > TIME_EPSILON) return null
  // tickSkills의 부동소수점 잔여값을 준비 상태와 같은 틱으로 정규화한다.
  // 여기서 버퍼를 비운 뒤 consumeCooldown이 0 초과로 거절하면 입력이 유실된다.
  runtime.cooldown = 0

  world.bufferedSkill = null
  return buffered
}

export function markPlayerActionResolved(
  world: World,
  action: PendingPlayerAction,
): void {
  if (world.playerAction === action) action.resolved = true
}
