import { PLAYER_ACTION_TIMING } from './action-timing.ts'
import type {
  PendingPlayerAction,
  PlayerActionKind,
  PlayerActionSource,
  World,
} from './types.ts'

const TIME_EPSILON = 1e-9

export function emitActionStart(
  world: World,
  kind: PlayerActionKind,
  angle: number,
): void {
  if (world.actionStarts.length < 16) world.actionStarts.push({ kind, angle })
}

/**
 * 평타 또는 QWER의 선딜을 시작한다.
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

  const timing = PLAYER_ACTION_TIMING[kind]
  world.playerAction = {
    source,
    kind,
    slot,
    angle,
    targetX,
    targetY,
    impactAt: world.time + timing.impact,
    endAt: world.time + timing.duration,
    resolved: false,
  }
  world.player.facing = angle
  emitActionStart(world, kind, angle)
  return true
}

/** 후딜이 끝난 동작을 비워 다음 평타·QWER를 받을 수 있게 한다. */
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

export function markPlayerActionResolved(
  world: World,
  action: PendingPlayerAction,
): void {
  if (world.playerAction === action) action.resolved = true
}
