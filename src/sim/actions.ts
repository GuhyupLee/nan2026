import { playerActionTiming } from './action-timing.ts'
import type {
  PendingPlayerAction,
  PlayerActionKind,
  PlayerActionSource,
  World,
} from './types.ts'

const TIME_EPSILON = 1e-9
export const PLAYER_ACTION_BUFFER_WINDOW = 0.15

type BufferedSkillSlot = Exclude<PendingPlayerAction['slot'], null>

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
): boolean {
  if (world.playerAction) return false

  const timing = playerActionTiming(world.playerClass, kind)
  const startedAt = world.time
  world.playerAction = {
    source,
    kind,
    slot,
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
  if (action.meleeDash) return

  const targetX = world.lastAim.x
  const targetY = world.lastAim.y
  const dx = targetX - world.player.pos.x
  const dy = targetY - world.player.pos.y

  action.targetX = targetX
  action.targetY = targetY
  if (dx * dx + dy * dy > 1e-8) {
    action.angle = Math.atan2(dy, dx)
    world.player.facing = action.angle
  }
}

/**
 * 후딜 마지막 0.15초의 입력만 기억해 오래 전에 누른 키가 뒤늦게 나가지 않게 한다.
 */
export function bufferPlayerSkill(
  world: World,
  slot: BufferedSkillSlot,
): boolean {
  const action = world.playerAction
  if (!action || world.ult.active) return false

  const remaining = action.endAt - world.time
  if (
    remaining < -TIME_EPSILON ||
    remaining > PLAYER_ACTION_BUFFER_WINDOW + TIME_EPSILON
  ) {
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
    expiresAt: world.time + PLAYER_ACTION_BUFFER_WINDOW,
  }
  return true
}

/** 잠금이 풀린 첫 틱에만 버퍼를 꺼내 연속 입력의 리듬을 보존한다. */
export function takeBufferedPlayerSkill(world: World): BufferedSkillSlot | null {
  if (world.playerAction || world.ult.active) return null

  const buffered = world.bufferedSkill
  if (!buffered) return null
  world.bufferedSkill = null
  return buffered.expiresAt + TIME_EPSILON >= world.time
    ? buffered.slot
    : null
}

export function markPlayerActionResolved(
  world: World,
  action: PendingPlayerAction,
): void {
  if (world.playerAction === action) action.resolved = true
}
