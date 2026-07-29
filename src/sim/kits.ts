import { ARENA_RADIUS } from './constants.ts'
import {
  MELEE_W_DASH_END,
  MELEE_W_PREPARE_END,
  RANGED_W_DASH_END,
  RANGED_W_DASH_START,
} from './action-timing.ts'
import {
  beginPlayerAction,
  bufferPlayerSkill,
  emitActionStart,
  markPlayerActionResolved,
  pendingImpact,
  retargetPendingImpact,
} from './actions.ts'
import { damageEnemy } from './damage.ts'
import { ENEMY_TYPES } from './enemies.ts'
import { nearestEnemy, queryCircle, queryCone, querySegment } from './query.ts'
import { upgradeTraitToken } from './progression.ts'
import {
  consumeCooldown,
  skillDamageMul,
  type SkillId,
} from './skills.ts'
import { effectiveAtkDamage } from './stats.ts'
import { applyImpulse, applyMark, applyPull } from './status.ts'
import {
  resolveTargeting,
  type TargetingSolution,
} from './targeting.ts'
import type { PendingPlayerAction, World } from './types.ts'
import type { Vec2 } from './vec.ts'
import { pushBlast, pushZone } from './zones.ts'

/**
 * 두 클래스의 QWER.
 *
 * 설계 축: **달은 몸 주위의 원을 파고, 해는 먼 지점을 밝힌다.**
 *   일현(日弦, 원거리) — 삼중 평타·전진 렌즈·투척·전장 빔.
 *   월아(月牙, 근접)   — 견인·돌진·링·회전.
 * 거리 운용이 곧 정체성이라 두 클래스의 같은 슬롯도 역할만 공유한다.
 *
 * 슬롯 역할 규약은 두 클래스 공통이다:
 *   Q 저쿨 주력기 / W 이동기 【생존】 / E 광역기 【광역】 / R 궁극기
 * 쿨다운도 Q < W < E 순서를 지킨다 — 규약이 있으면 두 번째 캐릭터를
 * 배우는 비용이 0이 된다.
 */

/** 스킬 적중이 거는 점등 지속시간(초). 원거리 패시브의 원천. */
export const MARK_DURATION = 4

/**
 * 「월참」(승격된 평타)의 평타 대비 배수.
 * 근접 기본 공격력 22 기준으로 32였던 값을 배수로 환산한 것이다.
 */
const EMPOWERED_ATTACK_MUL = 1.45

// ---------------------------------------------------------------------------
// 공통 도구
// ---------------------------------------------------------------------------

/** 커서 방향 단위벡터. 커서가 발밑이면 바라보는 방향으로 대체한다. */
interface SkillCastContext {
  angle: number
  targetX: number
  targetY: number
}

function aimDir(
  world: World,
  out: { x: number; y: number },
  context?: SkillCastContext,
): void {
  if (context) {
    out.x = Math.cos(context.angle)
    out.y = Math.sin(context.angle)
    return
  }
  const p = world.player
  let dx = world.lastAim.x - p.pos.x
  let dy = world.lastAim.y - p.pos.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-4) {
    out.x = Math.cos(p.facing)
    out.y = Math.sin(p.facing)
    return
  }
  out.x = dx / d
  out.y = dy / d
}

const dir = { x: 1, y: 0 }
const castTarget: TargetingSolution = {
  x: 0,
  y: 0,
  angle: 0,
  distance: 0,
  snapped: false,
}

function emitCast(
  world: World,
  slot: SkillId,
  angle: number,
  originX: number,
  originY: number,
  targetX: number,
  targetY: number,
): void {
  if (world.casts.length < 8) {
    world.casts.push({ slot, angle, originX, originY, targetX, targetY })
  }
}

function emitBeam(
  world: World,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  kind: number,
): void {
  if (world.tracers.length < 64) world.tracers.push({ x0, y0, x1, y1, width, kind })
}

function emitRing(world: World, x: number, y: number, radius: number, kind: number): void {
  if (world.rings.length < 32) world.rings.push({ x, y, radius, kind })
}

/** 플레이어를 순간 이동시킨다. 렌더 보간이 끌려가지 않게 prev도 옮긴다. */
function teleport(world: World, x: number, y: number): void {
  const p = world.player
  const d = Math.hypot(x, y)
  const limit = ARENA_RADIUS - world.stats.radius
  if (d > limit && d > 1e-6) {
    const s = limit / d
    x *= s
    y *= s
  }
  p.pos.x = x
  p.pos.y = y
  p.prevPos.x = x
  p.prevPos.y = y
  p.vel.x = 0
  p.vel.y = 0
}

/**
 * 스킬 랭크와 전역 공격력 강화가 반영된 피해.
 *
 * 모든 스킬 피해가 이 함수를 거친다. 각 스킬이 직접 곱하면 반드시
 * 하나가 빠지고, 같은 공격력 카드가 슬롯마다 다르게 작동하게 된다.
 */
function dmg(world: World, slot: SkillId, base: number): number {
  return (
    base *
    skillDamageMul(world.skills, slot) *
    world.stats.atkDamageMul *
    (world.time < world.player.utilityPowerUntil ? 1.25 : 1)
  )
}

function hasSkillTrait(
  world: World,
  slot: SkillId,
  trait: string,
): boolean {
  return (
    world.skills[slot].branch === trait ||
    world.upgradesTaken.has(upgradeTraitToken(trait))
  )
}

/** 거리순으로 정렬된 적을 모으는 임시 버퍼. */
const hits: { i: number; d2: number }[] = []

function collectSorted(): { i: number; d2: number }[] {
  hits.sort((a, b) => a.d2 - b.d2)
  return hits
}

// ---------------------------------------------------------------------------
// 일현 (日弦) — 원거리. 기본 공격 굴절과 광선
// ---------------------------------------------------------------------------

/** Q 삼중 굴절 — 잠시 동안 모든 기본 공격을 정면과 양옆 세 갈래로 나눈다. */
function rangedQ(world: World, context?: SkillCastContext): void {
  const p = world.player
  const now = world.time
  const duration = hasSkillTrait(world, 'q', 'orbital-prism') ? 7 : 5
  p.rangedVolleyUntil = Math.max(p.rangedVolleyUntil, now + duration)
  // 시전 선딜 동안 먼저 흐른 일부 쿨다운도 되돌린다. 강화가 끝난 다음 틱부터
  // 항상 온전한 재사용 대기시간이 시작되어 HUD와 실제 사용 가능 시점이 같다.
  world.skills.q.cooldown = world.skills.q.maxCooldown
  emitRing(world, p.pos.x, p.pos.y, Math.min(world.stats.atkRange, 5.5), 2)
  emitCast(
    world,
    'q',
    context?.angle ?? p.facing,
    p.pos.x,
    p.pos.y,
    p.pos.x,
    p.pos.y,
  )
}

/** W 광도약 — 커서 방향으로 도약하며 있던 자리에 적을 모으는 렌즈를 남긴다. */
function rangedW(world: World, context?: SkillCastContext): void {
  const p = world.player
  const now = world.time
  aimDir(world, dir, context)

  const dash = world.playerAction?.skillDash
  const fromX = dash?.originX ?? p.pos.x
  const fromY = dash?.originY ?? p.pos.y
  const destinationX = dash?.destinationX
  const destinationY = dash?.destinationY
  // 입력과 이동이 같은 방향이어야 위험한 순간에도 결과를 즉시 예측할 수 있다.
  if (dash) {
    // 실제 이동은 stepPlayer가 짧게 보간한다.
  } else if (context) {
    teleport(world, context.targetX, context.targetY)
  } else {
    teleport(world, fromX + dir.x * 8, fromY + dir.y * 8)
  }
  const pool = world.enemies
  const doubleCollapse =
    hasSkillTrait(world, 'w', 'double-collapse') ||
    hasSkillTrait(world, 'w', 'singularity-interference')
  queryCircle(pool, world.enemyHash, fromX, fromY, 5.5, (i) => {
    applyMark(pool, i, now, 1.2)
    applyPull(
      pool,
      i,
      now,
      fromX,
      fromY,
      doubleCollapse ? 1.5 : 0.75,
      15,
      1.5,
    )
  })

  if (doubleCollapse) {
    pushBlast(world, {
      kind: 0,
      x: fromX,
      y: fromY,
      radius: 5.2,
      damage: dmg(world, 'w', 7 * 12 * 0.45),
      impulse: 0,
      markDuration: 1.2,
      slowMul: 0.28,
      slowDuration: 0.9,
      fireAt: now + 1.4,
    })
  }

  // 도약 출발점에 렌즈를 남겨 추격하는 적을 묶고 다음 스킬의 목표를 만든다.
  pushZone(world, {
    kind: 0,
    x: fromX,
    y: fromY,
    radius: 5.2,
    expireAt: now + 3,
    nextTickAt: now,
    tickInterval: 0.25,
    tickDamage: dmg(world, 'w', 7),
    pushSpeed: 0,
    slowMul: 0.55,
    slowDuration: 0.35,
    markDuration: 0.6,
  })

  emitRing(world, fromX, fromY, 5.2, 0)
  emitRing(world, destinationX ?? p.pos.x, destinationY ?? p.pos.y, 2, 0)
  emitCast(
    world,
    'w',
    context?.angle ?? Math.atan2(dir.y, dir.x),
    fromX,
    fromY,
    destinationX ?? p.pos.x,
    destinationY ?? p.pos.y,
  )
}

/** E 분광(分光) — 던져서 터뜨리고 그 자리를 둔화 장판으로 남긴다. */
function rangedE(world: World, context?: SkillCastContext): void {
  const p = world.player
  const now = world.time

  let tx = context?.targetX ?? world.lastAim.x
  let ty = context?.targetY ?? world.lastAim.y
  const dx = tx - p.pos.x
  const dy = ty - p.pos.y
  const d = Math.hypot(dx, dy)
  if (d > 14) {
    tx = p.pos.x + (dx / d) * 14
    ty = p.pos.y + (dy / d) * 14
  }

  if (hasSkillTrait(world, 'e', 'afterimage-aperture')) {
    querySegment(
      world.enemies,
      world.enemyHash,
      p.pos.x,
      p.pos.y,
      tx,
      ty,
      1.4,
      (i) => {
        applyMark(world.enemies, i, now, MARK_DURATION)
        damageEnemy(world, i, dmg(world, 'e', 160 * 0.35))
      },
    )
    emitBeam(world, p.pos.x, p.pos.y, tx, ty, 1.4, 1)
  }

  const detonateAt = now + 0.3
  pushBlast(world, {
    kind: 0,
    x: tx,
    y: ty,
    radius: 6,
    damage: dmg(world, 'e', 160),
    impulse: 26,
    markDuration: MARK_DURATION,
    slowMul: 1,
    slowDuration: 0,
    fireAt: detonateAt,
  })

  pushZone(world, {
    kind: 1,
    x: tx,
    y: ty,
    radius: 5,
    expireAt: detonateAt + 3,
    nextTickAt: detonateAt,
    tickInterval: 0.25,
    tickDamage: dmg(world, 'e', 6),
    pushSpeed: 0,
    slowMul: 0.45,
    slowDuration: 0.4,
    markDuration: 0.6,
  })

  // 폭발 링은 실제 발화 때 zones가 내므로 여기서는 착탄 지점만 먼저 읽힌다.
  emitRing(world, tx, ty, 6, 0)
  emitCast(world, 'e', Math.atan2(ty - p.pos.y, tx - p.pos.x), p.pos.x, p.pos.y, tx, ty)
}

/** R 일현(日弦) — 화면 끝에서 끝까지. 직선 위의 모든 것이 사라진다. */
function rangedR(world: World, context?: SkillCastContext): void {
  const p = world.player
  const now = world.time
  aimDir(world, dir, context)

  // 길이 64는 아레나 지름 60을 넘긴다 — 언제나 화면 끝에서 끝까지다.
  const x0 = p.pos.x - dir.x * 2
  const y0 = p.pos.y - dir.y * 2
  const x1 = p.pos.x + dir.x * 62
  const y1 = p.pos.y + dir.y * 62

  const nx = -dir.y
  const ny = dir.x
  const pool = world.enemies
  const beamHits: number[] = []

  querySegment(pool, world.enemyHash, x0, y0, x1, y1, 3.4, (i) => {
    beamHits.push(i)
    applyMark(pool, i, now, 5)
    const rx = pool.x[i]! - p.pos.x
    const ry = pool.y[i]! - p.pos.y
    let side = rx * nx + ry * ny
    if (side === 0) side = i % 2 === 0 ? 1 : -1
    applyImpulse(pool, i, nx * (side > 0 ? 1 : -1), ny * (side > 0 ? 1 : -1), 32)
    // 잡몹은 예외 없이 전멸한다. 예외가 없어야 심사자가 한 번 보고 규칙을 배운다.
    damageEnemy(world, i, dmg(world, 'r', 1700))
  })

  if (hasSkillTrait(world, 'r', 'heliostat-chain')) {
    const mainTargets = new Set<number>()
    const chainedTargets = new Set<number>()
    for (const i of beamHits) mainTargets.add(i)

    for (const source of beamHits) {
      let target = -1
      let targetDistance = 10 * 10
      for (let i = 0; i < pool.count; i++) {
        if (
          pool.hp[i]! <= 0 ||
          mainTargets.has(i) ||
          chainedTargets.has(i)
        ) {
          continue
        }
        const dx = pool.x[i]! - pool.x[source]!
        const dy = pool.y[i]! - pool.y[source]!
        const distance = dx * dx + dy * dy
        if (distance < targetDistance) {
          target = i
          targetDistance = distance
        }
      }
      if (target < 0) continue

      chainedTargets.add(target)
      applyMark(pool, target, now, MARK_DURATION)
      damageEnemy(world, target, dmg(world, 'r', 1700 * 0.25))
      emitBeam(
        world,
        pool.x[source]!,
        pool.y[source]!,
        pool.x[target]!,
        pool.y[target]!,
        1,
        1,
      )
    }
  }

  emitBeam(world, x0, y0, x1, y1, 5.5, 2)
  emitCast(world, 'r', Math.atan2(dir.y, dir.x), x0, y0, x1, y1)
}

// ---------------------------------------------------------------------------
// 월아 (月牙) — 근접. 원(圓)
// ---------------------------------------------------------------------------

/** Q 인월참(引月斬) — 앞의 적을 칼끝 거리로 끌어다 꿰뚫는다. */
function meleeQ(world: World, context?: SkillCastContext): void {
  const p = world.player
  const now = world.time
  aimDir(world, dir, context)
  const pool = world.enemies

  const x1 = p.pos.x + dir.x * 5.5
  const y1 = p.pos.y + dir.y * 5.5

  hits.length = 0
  querySegment(pool, world.enemyHash, p.pos.x, p.pos.y, x1, y1, 1.8, (i, d2) => {
    hits.push({ i, d2 })
  })
  const sorted = collectSorted()

  for (let k = 0; k < sorted.length; k++) {
    const i = sorted[k]!.i
    applyMark(pool, i, now, MARK_DURATION)

    // 근접의 정체성: 멀리 있는 놈은 끌어오고, 붙어 있는 놈은 떼어낸다.
    // 그래야 "칼끝 거리"라는 안전 링이 유지된다.
    const rd = Math.hypot(pool.x[i]! - p.pos.x, pool.y[i]! - p.pos.y)
    if (rd > 2.5) {
      applyPull(pool, i, now, p.pos.x, p.pos.y, 0.28, 12, 2.3)
    } else {
      applyImpulse(pool, i, pool.x[i]! - p.pos.x, pool.y[i]! - p.pos.y, 16)
    }

    damageEnemy(world, i, dmg(world, 'q', k === 0 ? 96 : 52))
  }

  if (
    hasSkillTrait(world, 'q', 'returning-draw-cut') ||
    hasSkillTrait(world, 'q', 'eclipse-sword-domain')
  ) {
    querySegment(pool, world.enemyHash, x1, y1, p.pos.x, p.pos.y, 1.8, (i) => {
      applyMark(pool, i, now, MARK_DURATION)
      damageEnemy(world, i, dmg(world, 'q', 96 * 0.55))
    })
    emitBeam(world, x1, y1, p.pos.x, p.pos.y, 2, 3)
  }

  emitBeam(world, p.pos.x, p.pos.y, x1, y1, 2.4, 3)
  emitCast(world, 'q', Math.atan2(dir.y, dir.x), p.pos.x, p.pos.y, x1, y1)
}

/** W 이합참(離合斬) — 가려는 쪽으로 꿰뚫고 나간다. 그동안 무적. */
function meleeW(world: World, context?: SkillCastContext): void {
  const p = world.player
  const now = world.time
  const pool = world.enemies

  // 이동 방향 우선 — 도망칠 때 손이 이미 그쪽을 향하고 있다.
  const dash = world.playerAction?.skillDash
  const angle = context?.angle ?? p.facing
  const dx = Math.cos(angle)
  const dy = Math.sin(angle)
  const fromX = dash?.originX ?? p.pos.x
  const fromY = dash?.originY ?? p.pos.y
  const toX = dash?.destinationX ?? p.pos.x
  const toY = dash?.destinationY ?? p.pos.y

  // 지나온 경로
  // 돌진이 0.16초 동안 실제로 전진하므로, 프레임 사이를 스친 적도 검 궤적에
  // 포함되도록 기존 순간이동 판정보다 아주 조금 넓은 폭을 쓴다.
  querySegment(pool, world.enemyHash, fromX, fromY, toX, toY, 2.3, (i) => {
    applyMark(pool, i, now, MARK_DURATION)
    damageEnemy(world, i, dmg(world, 'w', 60))
  })

  // 착지 지점 — 경로와 겹치면 120이 들어가 브루트가 정확히 한 사이클에 죽는다.
  queryCircle(pool, world.enemyHash, toX, toY, 3.5, (i) => {
    applyMark(pool, i, now, MARK_DURATION)
    damageEnemy(world, i, dmg(world, 'w', 60))
    applyImpulse(pool, i, pool.x[i]! - toX, pool.y[i]! - toY, 30)
  })

  if (hasSkillTrait(world, 'w', 'returning-sheath')) {
    querySegment(pool, world.enemyHash, toX, toY, fromX, fromY, 2.3, (i) => {
      applyMark(pool, i, now, MARK_DURATION)
      damageEnemy(world, i, dmg(world, 'w', 60 * 0.55))
    })
    emitBeam(world, toX, toY, fromX, fromY, 2.2, 3)
  }

  if (world.upgradesTaken.has(upgradeTraitToken('afterimage-step'))) {
    pushBlast(world, {
      kind: 1,
      x: fromX,
      y: fromY,
      radius: 3.2,
      damage: effectiveAtkDamage(world.stats) * 0.65,
      impulse: 8,
      markDuration: MARK_DURATION,
      slowMul: 1,
      slowDuration: 0,
      fireAt: now + 0.18,
    })
  }

  emitBeam(world, fromX, fromY, toX, toY, 3, 3)
  emitRing(world, toX, toY, 3.5, 3)
  emitCast(world, 'w', Math.atan2(dy, dx), fromX, fromY, toX, toY)
}

/** E 월륜(月輪) — 주변을 한 겹 밀어낸 뒤 끌어모아 통째로 벤다. */
function meleeE(world: World): void {
  const p = world.player
  const now = world.time
  const pool = world.enemies

  queryCircle(pool, world.enemyHash, p.pos.x, p.pos.y, 9, (i) => {
    applyMark(pool, i, now, MARK_DURATION)
    const rd = Math.hypot(pool.x[i]! - p.pos.x, pool.y[i]! - p.pos.y)
    if (rd < 3) {
      // 너무 붙은 놈은 먼저 밀어낸다 — 밀어낸 뒤 끌어모아야
      // 링 위에 정렬되어 참격 한 번에 전부 들어간다.
      applyImpulse(pool, i, pool.x[i]! - p.pos.x, pool.y[i]! - p.pos.y, 24)
    } else {
      applyPull(pool, i, now, p.pos.x, p.pos.y, 0.3, 16, 4)
    }
  })

  pushBlast(world, {
    kind: 1,
    x: p.pos.x,
    y: p.pos.y,
    radius: 6,
    damage: dmg(world, 'e', 140),
    impulse: 10,
    markDuration: MARK_DURATION,
    slowMul: 1,
    slowDuration: 0,
    fireAt: now + 0.3,
  })

  if (hasSkillTrait(world, 'e', 'mirror-counter')) {
    pushBlast(world, {
      kind: 1,
      x: p.pos.x,
      y: p.pos.y,
      radius: 6,
      damage: dmg(world, 'e', 140 * 0.7),
      impulse: 14,
      markDuration: MARK_DURATION,
      slowMul: 1,
      slowDuration: 0,
      fireAt: now + 0.75,
    })
  }

  emitRing(world, p.pos.x, p.pos.y, 9, 3)
  emitCast(world, 'e', p.facing, p.pos.x, p.pos.y, p.pos.x, p.pos.y)
}

/** R 만월난무(滿月亂舞) — 사라져서 여섯 번 벤다. 마지막에 크게 회복한다. */
function meleeR(world: World): void {
  const now = world.time
  world.ult.active = true
  world.ult.hitsLeft = 6
  world.ult.nextHitAt = now + 0.4
  world.player.invulnUntil = now + 2.85

  emitRing(world, world.player.pos.x, world.player.pos.y, 5, 3)
  emitCast(
    world,
    'r',
    world.player.facing,
    world.player.pos.x,
    world.player.pos.y,
    world.player.pos.x,
    world.player.pos.y,
  )
}

/**
 * 만월난무의 지속 타격.
 * 매 틱 호출되어 0.45초 간격으로 6번 터진다.
 */
function stepMeleeUlt(world: World): void {
  const u = world.ult
  if (!u.active || world.time < u.nextHitAt) return

  const p = world.player
  const pool = world.enemies
  const now = world.time
  const last = u.hitsLeft === 1
  let attackAngle = p.facing

  // 매 타격마다 가장 가까운 적으로 순간이동한다 — "사라져서 벤다"가 이렇게 읽힌다.
  const target = nearestEnemy(pool, world.enemyHash, p.pos.x, p.pos.y, 13)
  if (target >= 0) {
    attackAngle = Math.atan2(pool.y[target]! - p.pos.y, pool.x[target]! - p.pos.x)
    const def = ENEMY_TYPES[pool.type[target]!]!
    teleport(world, pool.x[target]! - def.radius * 1.4, pool.y[target]!)
  }
  p.facing = attackAngle

  if (world.attacks.length < 16) {
    world.attacks.push({ angle: attackAngle, kind: 'ult' })
  }
  emitActionStart(world, 'ult', attackAngle, now)

  const radius = last ? 8.5 : 4.6
  const damage = last ? 430 : 260
  queryCircle(pool, world.enemyHash, p.pos.x, p.pos.y, radius, (i) => {
    applyMark(pool, i, now, MARK_DURATION)
    damageEnemy(world, i, dmg(world, 'r', damage))
  })

  if (hasSkillTrait(world, 'r', 'eclipse-sword-domain')) {
    const crossTargets = new Set<number>()
    for (const crossAngle of [
      attackAngle + Math.PI * 0.25,
      attackAngle - Math.PI * 0.25,
    ]) {
      const crossX = Math.cos(crossAngle) * radius
      const crossY = Math.sin(crossAngle) * radius
      querySegment(
        pool,
        world.enemyHash,
        p.pos.x - crossX,
        p.pos.y - crossY,
        p.pos.x + crossX,
        p.pos.y + crossY,
        1.1,
        (i) => {
          if (crossTargets.has(i)) return
          crossTargets.add(i)
          applyMark(pool, i, now, MARK_DURATION)
          damageEnemy(world, i, dmg(world, 'r', damage * 0.35))
        },
      )
      emitBeam(
        world,
        p.pos.x - crossX,
        p.pos.y - crossY,
        p.pos.x + crossX,
        p.pos.y + crossY,
        1.5,
        3,
      )
    }
  }

  emitRing(world, p.pos.x, p.pos.y, radius, 3)

  if (last) {
    if (
      hasSkillTrait(world, 'r', 'fullmoon-domain') ||
      hasSkillTrait(world, 'r', 'eclipse-sword-domain')
    ) {
      pushZone(world, {
        kind: 1,
        x: p.pos.x,
        y: p.pos.y,
        radius: 8.5,
        expireAt: now + 2.25,
        nextTickAt: now + 0.25,
        tickInterval: 0.25,
        tickDamage: dmg(world, 'r', 430 * 0.08),
        pushSpeed: 0,
        slowMul: 0.72,
        slowDuration: 0.35,
        markDuration: 0.6,
      })
    }

    // 마지막 타격의 회복이 근접 클래스 스킬에서 나오는 유일한 큰 회복이다.
    p.hp = Math.min(world.stats.maxHp, p.hp + 60)
    u.active = false
    u.hitsLeft = 0
  } else {
    u.hitsLeft -= 1
    u.nextHitAt = now + 0.45
  }
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

type SkillFn = (world: World, context?: SkillCastContext) => void

const RANGED: Record<string, SkillFn> = {
  q: rangedQ,
  w: rangedW,
  e: rangedE,
  r: rangedR,
}
const MELEE: Record<string, SkillFn> = {
  q: meleeQ,
  w: meleeW,
  e: meleeE,
  r: meleeR,
}

/**
 * QWER 하나를 시전한다.
 * @returns 실제로 나갔으면 true
 */
export function castSkill(world: World, slot: SkillId, aim?: Vec2): boolean {
  // 궁극기가 도는 중에는 다른 스킬을 받지 않는다 — 무적으로 사라진 상태다.
  if (world.ult.active) return false
  if (slot === 'd' || slot === 'f') return false
  const table = world.playerClass === 'melee' ? MELEE : RANGED
  const fn = table[slot]
  if (!fn) return false
  const lockedAim =
    aim && Number.isFinite(aim.x) && Number.isFinite(aim.y)
      ? aim
      : undefined
  if (world.playerAction) {
    bufferPlayerSkill(world, slot, lockedAim)
    return false
  }
  if (!consumeCooldown(world.skills, slot)) {
    bufferPlayerSkill(world, slot, lockedAim)
    return false
  }
  const p = world.player
  const target = resolveTargeting(
    world,
    slot,
    castTarget,
    lockedAim?.x,
    lockedAim?.y,
  )
  const angle = target.angle

  const accepted = beginPlayerAction(
    world,
    'skill',
    slot,
    angle,
    target.x,
    target.y,
    slot,
    lockedAim !== undefined,
  )
  if (!accepted) return false

  if (world.playerClass === 'ranged' && slot === 'r') {
    // 일현은 0.9초 동안 전장을 가르는 고정 자세다. 근접 궁극기의 긴
    // 무적·회복보다 짧지만, 보스 패턴 속에서도 시전을 완주할 수 있게 한다.
    const action = world.playerAction as PendingPlayerAction | null
    p.invulnUntil = Math.max(
      p.invulnUntil,
      action?.endAt ?? world.time,
    )
  }

  if (slot === 'w') {
    const action = world.playerAction as PendingPlayerAction | null
    if (!action) return false

    const originX = p.pos.x
    const originY = p.pos.y
    const destinationX = target.x
    const destinationY = target.y

    const melee = world.playerClass === 'melee'
    action.skillDash = {
      originX,
      originY,
      destinationX,
      destinationY,
      moveStart: melee ? MELEE_W_PREPARE_END : RANGED_W_DASH_START,
      moveEnd: melee ? MELEE_W_DASH_END : RANGED_W_DASH_END,
      lockUntilActionEnd: melee,
      movementCancelled: false,
    }
    if (!melee) {
      p.rangedDashInvulnUntil = Math.max(
        p.rangedDashInvulnUntil,
        world.time + 0.55,
      )
      p.invulnUntil = Math.max(p.invulnUntil, p.rangedDashInvulnUntil)
    }
    p.vel.x = 0
    p.vel.y = 0
  }

  return true
}

/** 매 틱 도는 킷 상태(지속 궁극기 등). */
export function stepKits(world: World): void {
  const action = pendingImpact(world, 'skill')
  if (action && action.slot) {
    retargetPendingImpact(world, action)
    const table = world.playerClass === 'melee' ? MELEE : RANGED
    const fn = table[action.slot]
    if (fn) {
      fn(world, {
        angle: action.angle,
        targetX: action.targetX,
        targetY: action.targetY,
      })
    }
    markPlayerActionResolved(world, action)
  }

  if (world.playerClass === 'melee') stepMeleeUlt(world)
}

/**
 * 근접 패시브 「참흔」.
 *
 * 게이지의 원천이 전적으로 "내 옆에 적이 몇 마리 있는가"다.
 * 스킬 사용은 1도 주지 않는다 — 그래야 해금 개수가 게이지 속도에
 * 영향을 주지 않고, 해금 순서가 강함에 영향을 주지 않는다.
 */
export function stepGauge(world: World, dt: number): void {
  if (world.playerClass !== 'melee') return
  const p = world.player
  const pool = world.enemies

  let weight = 0
  queryCircle(pool, world.enemyHash, p.pos.x, p.pos.y, world.stats.atkRange, (i) => {
    // 덩치가 크면 벨 곳이 많다.
    weight += ENEMY_TYPES[pool.type[i]!]!.radius >= 0.6 ? 2 : 1
  })

  if (weight > 0) {
    p.gauge = Math.min(100, p.gauge + Math.min(weight, 6) * 18 * dt)
    if (p.gauge >= 100) p.empowered = true
  } else {
    // 떨어지면 서서히 빠진다. 즉시 0이면 잠깐 물러난 것만으로 리듬이 끊긴다.
    p.gauge = Math.max(0, p.gauge - 40 * dt)
  }
}

/**
 * 「월참」 — 승격된 평타. 단일 타격이 부채꼴 광역이 된다.
 * @returns 처리했으면 true (일반 평타를 대체한다)
 */
export function tryEmpoweredAttack(world: World, angle?: number): boolean {
  const p = world.player
  if (world.playerClass !== 'melee' || !p.empowered) return false

  const pool = world.enemies
  const now = world.time
  if (angle === undefined) {
    aimDir(world, dir)
  } else {
    dir.x = Math.cos(angle)
    dir.y = Math.sin(angle)
  }

  if (world.playerAction?.source !== 'skill') {
    emitActionStart(world, 'empowered', Math.atan2(dir.y, dir.x), world.time)
  }
  if (world.attacks.length < 16) {
    world.attacks.push({ angle: Math.atan2(dir.y, dir.x), kind: 'empowered' })
  }

  // 월참은 "승격된 평타"다. 스킬이 아니라 평타 계열이므로 스킬 랭크가 아니라
  // 공격력 스탯을 따라야 한다. 32를 하드코딩하고 있어서 「예리함」 같은
  // 공격력 강화가 근접 클래스의 주력 딜에 전혀 안 먹었다 —
  // 플레이어가 카드를 골라도 아무 일이 안 일어나는 부류의 버그다.
  const swipeDamage = effectiveAtkDamage(world.stats) * EMPOWERED_ATTACK_MUL

  let heal = 0
  // 100도 부채꼴 = 반각 50도
  queryCone(pool, world.enemyHash, p.pos.x, p.pos.y, dir.x, dir.y, 3.4, Math.cos(0.873), (i) => {
    applyMark(pool, i, now, MARK_DURATION)
    damageEnemy(world, i, swipeDamage)
    heal += 1.5
  })

  if (world.upgradesTaken.has(upgradeTraitToken('echoing-crescent'))) {
    pushBlast(world, {
      kind: 1,
      x: p.pos.x + dir.x * 1.2,
      y: p.pos.y + dir.y * 1.2,
      radius: 3.4,
      damage: swipeDamage * 0.45,
      impulse: 0,
      markDuration: MARK_DURATION,
      slowMul: 1,
      slowDuration: 0,
      fireAt: now + 0.3,
    })
  }

  // 회복 상한이 이 클래스의 성패를 가른다.
  // 상한을 크게 두면 군중에서 접촉 피해를 전부 지운다. 4.5 상한은
  // 붙어 싸운 보상은 남기되 무적 장치가 되지 않는 계측값이다.
  p.hp = Math.min(world.stats.maxHp, p.hp + Math.min(heal, 4.5))
  p.speedBoostUntil = Math.max(p.speedBoostUntil, now + 1.2)

  // 스킬 쿨다운을 당긴다 — 평타가 스킬을 강화하는 순환이 여기서 닫힌다.
  for (const id of ['q', 'w', 'e'] as const) {
    const s = world.skills[id]
    if (s.unlocked && s.cooldown > 0) s.cooldown = Math.max(0, s.cooldown - 0.5)
  }

  p.gauge = 0
  p.empowered = false

  emitRing(world, p.pos.x, p.pos.y, 3.4, 3)
  return true
}
