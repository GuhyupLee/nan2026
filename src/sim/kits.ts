import { ARENA_RADIUS } from './constants.ts'
import { damageEnemy } from './damage.ts'
import { ENEMY_TYPES } from './enemies.ts'
import { nearestEnemy, queryCircle, queryCone, querySegment } from './query.ts'
import { consumeCooldown, skillDamageMul, type SkillId } from './skills.ts'
import { applyImpulse, applyMark, applyPull, applyRoot, applySlow } from './status.ts'
import type { World } from './types.ts'
import { pushBlast, pushZone } from './zones.ts'

/**
 * 두 클래스의 QWER.
 *
 * 설계 축: **달은 원을 파고, 해는 선을 긋는다.**
 *   일현(日弦, 원거리) — 전부 직선. 관통·후퇴·투척·빔.
 *   월아(月牙, 근접)   — 전부 원. 견인·링·부채꼴·회전.
 * 기하학이 곧 정체성이라 심사자가 두 클래스를 헷갈릴 수 없다.
 *
 * 슬롯 역할 규약은 두 클래스 공통이다:
 *   Q 기본공격기 【단일】 / W 이동기 【생존】 / E 광역기 【광역】 / R 궁극기
 * 쿨다운도 Q < W < E 순서를 지킨다 — 규약이 있으면 두 번째 캐릭터를
 * 배우는 비용이 0이 된다.
 */

/** 스킬 적중이 거는 점등 지속시간(초). 원거리 패시브의 원천. */
export const MARK_DURATION = 4

// ---------------------------------------------------------------------------
// 공통 도구
// ---------------------------------------------------------------------------

/** 커서 방향 단위벡터. 커서가 발밑이면 바라보는 방향으로 대체한다. */
function aimDir(world: World, out: { x: number; y: number }): void {
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

function emitCast(world: World, slot: SkillId, angle: number): void {
  if (world.casts.length < 8) world.casts.push({ slot, angle })
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
 * 스킬 랭크가 반영된 피해.
 *
 * 모든 스킬 피해가 이 함수를 거친다. 각 스킬이 직접 곱하면 반드시
 * 하나가 빠지고, 그 스킬만 찍어도 안 세지는 버그가 된다.
 */
function dmg(world: World, slot: SkillId, base: number): number {
  return base * skillDamageMul(world.skills, slot)
}

/** 거리순으로 정렬된 적을 모으는 임시 버퍼. */
const hits: { i: number; d2: number }[] = []

function collectSorted(): { i: number; d2: number }[] {
  hits.sort((a, b) => a.d2 - b.d2)
  return hits
}

// ---------------------------------------------------------------------------
// 일현 (日弦) — 원거리. 선(線)
// ---------------------------------------------------------------------------

/** Q 섬광(閃絃) — 관통 + 맨 앞 속박. QWE 중 최단 쿨다운. */
function rangedQ(world: World): void {
  const p = world.player
  const now = world.time
  aimDir(world, dir)

  const x1 = p.pos.x + dir.x * 16
  const y1 = p.pos.y + dir.y * 16

  hits.length = 0
  querySegment(world.enemies, world.enemyHash, p.pos.x, p.pos.y, x1, y1, 0.9, (i, d2) => {
    hits.push({ i, d2 })
  })
  const sorted = collectSorted()

  // 수직 방향 — 맞은 적을 좌우로 갈라 통로를 뚫는다.
  const nx = -dir.y
  const ny = dir.x

  for (let k = 0; k < sorted.length && k < 8; k++) {
    const i = sorted[k]!.i
    const pool = world.enemies
    applyMark(pool, i, now, MARK_DURATION)
    applySlow(pool, i, now, 1.6, 0.45)

    // 축의 어느 쪽인지에 따라 바깥으로 민다. 축 위에 정확히 걸린 적은
    // 인덱스 홀짝으로 방향을 정해 결정론을 유지한다.
    const rx = pool.x[i]! - p.pos.x
    const ry = pool.y[i]! - p.pos.y
    let side = rx * nx + ry * ny
    if (side === 0) side = i % 2 === 0 ? 1 : -1
    const s = side > 0 ? 1 : -1
    applyImpulse(pool, i, nx * s, ny * s, 16)

    if (k === 0) {
      applyRoot(pool, i, now, 0.6)
      damageEnemy(world, i, dmg(world, 'q', 70))
    } else {
      damageEnemy(world, i, dmg(world, 'q', 40))
    }
  }

  emitBeam(world, p.pos.x, p.pos.y, x1, y1, 1.2, 1)
  emitCast(world, 'q', Math.atan2(dir.y, dir.x))
}

/** W 굴절(屈折) — 커서 반대쪽으로 도약하고 있던 자리에 빛기둥을 남긴다. */
function rangedW(world: World): void {
  const p = world.player
  const now = world.time
  aimDir(world, dir)

  const fromX = p.pos.x
  const fromY = p.pos.y
  // 커서 "반대쪽"으로 물러난다 — 원거리 클래스의 생존은 거리 회복이다.
  teleport(world, fromX - dir.x * 8, fromY - dir.y * 8)
  p.invulnUntil = now + 0.4

  // 있던 자리에 남는 빛기둥. 밀어냄 7.0/s는 워커(3.4)의 2배,
  // 러셔(6.4)와 비슷하다 — 느린 다수는 완전히 밀려나고 빠른 소수만
  // 제자리걸음을 한다. 이 대비가 두 잡몹을 화면에서 구분되게 만든다.
  pushZone(world, {
    kind: 0,
    x: fromX,
    y: fromY,
    radius: 3.6,
    expireAt: now + 3,
    nextTickAt: now,
    tickInterval: 0.25,
    tickDamage: 4.5,
    pushSpeed: 7,
    slowMul: 1,
    slowDuration: 0,
    markDuration: 0.6,
  })

  emitRing(world, fromX, fromY, 3.6, 0)
  emitRing(world, p.pos.x, p.pos.y, 2, 0)
  emitCast(world, 'w', Math.atan2(-dir.y, -dir.x))
}

/** E 분광(分光) — 던져서 터뜨리고 그 자리를 둔화 장판으로 남긴다. */
function rangedE(world: World): void {
  const p = world.player
  const now = world.time

  let tx = world.lastAim.x
  let ty = world.lastAim.y
  const dx = tx - p.pos.x
  const dy = ty - p.pos.y
  const d = Math.hypot(dx, dy)
  if (d > 14) {
    tx = p.pos.x + (dx / d) * 14
    ty = p.pos.y + (dy / d) * 14
  }

  // 0.30초 지연은 연출이 아니라 가독성이다. 즉발이면 250마리 화면에서
  // 무엇이 일어났는지 읽을 시간이 없다.
  pushBlast(world, {
    kind: 0,
    x: tx,
    y: ty,
    radius: 6,
    damage: dmg(world, 'e', 125),
    impulse: 26,
    markDuration: MARK_DURATION,
    slowMul: 1,
    slowDuration: 0,
    fireAt: now + 0.3,
  })

  pushZone(world, {
    kind: 1,
    x: tx,
    y: ty,
    radius: 5,
    expireAt: now + 3.3,
    nextTickAt: now + 0.3,
    tickInterval: 0.25,
    tickDamage: 4,
    pushSpeed: 0,
    slowMul: 0.45,
    slowDuration: 0.4,
    markDuration: 0.6,
  })

  emitRing(world, tx, ty, 6, 2)
  emitCast(world, 'e', Math.atan2(ty - p.pos.y, tx - p.pos.x))
}

/** R 일현(日弦) — 화면 끝에서 끝까지. 직선 위의 모든 것이 사라진다. */
function rangedR(world: World): void {
  const p = world.player
  const now = world.time
  aimDir(world, dir)

  // 길이 64는 아레나 지름 60을 넘긴다 — 언제나 화면 끝에서 끝까지다.
  const x0 = p.pos.x - dir.x * 2
  const y0 = p.pos.y - dir.y * 2
  const x1 = p.pos.x + dir.x * 62
  const y1 = p.pos.y + dir.y * 62

  const nx = -dir.y
  const ny = dir.x
  const pool = world.enemies

  querySegment(pool, world.enemyHash, x0, y0, x1, y1, 3.4, (i) => {
    applyMark(pool, i, now, 5)
    const rx = pool.x[i]! - p.pos.x
    const ry = pool.y[i]! - p.pos.y
    let side = rx * nx + ry * ny
    if (side === 0) side = i % 2 === 0 ? 1 : -1
    applyImpulse(pool, i, nx * (side > 0 ? 1 : -1), ny * (side > 0 ? 1 : -1), 32)
    // 잡몹은 예외 없이 전멸한다. 예외가 없어야 심사자가 한 번 보고 규칙을 배운다.
    damageEnemy(world, i, dmg(world, 'r', 1700))
  })

  emitBeam(world, x0, y0, x1, y1, 5.5, 2)
  emitCast(world, 'r', Math.atan2(dir.y, dir.x))
}

// ---------------------------------------------------------------------------
// 월아 (月牙) — 근접. 원(圓)
// ---------------------------------------------------------------------------

/** Q 인월참(引月斬) — 앞의 적을 칼끝 거리로 끌어다 꿰뚫는다. */
function meleeQ(world: World): void {
  const p = world.player
  const now = world.time
  aimDir(world, dir)
  const pool = world.enemies

  const x1 = p.pos.x + dir.x * 5
  const y1 = p.pos.y + dir.y * 5

  hits.length = 0
  querySegment(pool, world.enemyHash, p.pos.x, p.pos.y, x1, y1, 1.6, (i, d2) => {
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

    damageEnemy(world, i, dmg(world, 'q', k === 0 ? 76 : 38))
  }

  emitBeam(world, p.pos.x, p.pos.y, x1, y1, 2.4, 3)
  emitCast(world, 'q', Math.atan2(dir.y, dir.x))
}

/** W 이합참(離合斬) — 가려는 쪽으로 꿰뚫고 나간다. 그동안 무적. */
function meleeW(world: World): void {
  const p = world.player
  const now = world.time
  const pool = world.enemies

  // 이동 방향 우선 — 도망칠 때 손이 이미 그쪽을 향하고 있다.
  let dx = p.vel.x
  let dy = p.vel.y
  if (Math.hypot(dx, dy) < 0.5) {
    aimDir(world, dir)
    dx = dir.x
    dy = dir.y
  } else {
    const l = Math.hypot(dx, dy)
    dx /= l
    dy /= l
  }

  const fromX = p.pos.x
  const fromY = p.pos.y
  const toX = fromX + dx * 7
  const toY = fromY + dy * 7

  teleport(world, toX, toY)
  p.invulnUntil = now + 0.3

  // 지나온 경로
  querySegment(pool, world.enemyHash, fromX, fromY, p.pos.x, p.pos.y, 2.2, (i) => {
    applyMark(pool, i, now, MARK_DURATION)
    damageEnemy(world, i, dmg(world, 'w', 60))
  })
  // 착지 지점 — 경로와 겹치면 120이 들어가 브루트가 정확히 한 사이클에 죽는다.
  queryCircle(pool, world.enemyHash, p.pos.x, p.pos.y, 3.5, (i) => {
    applyImpulse(pool, i, pool.x[i]! - p.pos.x, pool.y[i]! - p.pos.y, 30)
    damageEnemy(world, i, dmg(world, 'w', 60))
  })

  emitBeam(world, fromX, fromY, p.pos.x, p.pos.y, 3, 3)
  emitRing(world, p.pos.x, p.pos.y, 3.5, 3)
  emitCast(world, 'w', Math.atan2(dy, dx))
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

  emitRing(world, p.pos.x, p.pos.y, 9, 3)
  emitCast(world, 'e', p.facing)
}

/** R 만월난무(滿月亂舞) — 사라져서 여섯 번 벤다. 마지막에 크게 회복한다. */
function meleeR(world: World): void {
  const now = world.time
  world.ult.active = true
  world.ult.hitsLeft = 6
  world.ult.nextHitAt = now + 0.15
  world.player.invulnUntil = now + 2.85

  emitRing(world, world.player.pos.x, world.player.pos.y, 5, 3)
  emitCast(world, 'r', world.player.facing)
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

  if (world.attacks.length < 16) {
    world.attacks.push({ angle: attackAngle, kind: 'ult' })
  }

  const radius = last ? 7 : 3.4
  const damage = last ? 430 : 260
  queryCircle(pool, world.enemyHash, p.pos.x, p.pos.y, radius, (i) => {
    applyMark(pool, i, now, MARK_DURATION)
    damageEnemy(world, i, dmg(world, 'r', damage))
  })

  emitRing(world, p.pos.x, p.pos.y, radius, 3)

  if (last) {
    // 마지막 타격의 회복이 근접 클래스 스킬에서 나오는 유일한 큰 회복이다.
    p.hp = Math.min(world.stats.maxHp, p.hp + 58)
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

const RANGED: Record<string, (w: World) => void> = {
  q: rangedQ,
  w: rangedW,
  e: rangedE,
  r: rangedR,
}
const MELEE: Record<string, (w: World) => void> = {
  q: meleeQ,
  w: meleeW,
  e: meleeE,
  r: meleeR,
}

/**
 * QWER 하나를 시전한다.
 * @returns 실제로 나갔으면 true
 */
export function castSkill(world: World, slot: SkillId): boolean {
  // 궁극기가 도는 중에는 다른 스킬을 받지 않는다 — 무적으로 사라진 상태다.
  if (world.ult.active) return false
  const table = world.playerClass === 'melee' ? MELEE : RANGED
  const fn = table[slot]
  if (!fn) return false
  if (!consumeCooldown(world.skills, slot)) return false
  fn(world)
  return true
}

/** 매 틱 도는 킷 상태(지속 궁극기 등). */
export function stepKits(world: World): void {
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
export function tryEmpoweredAttack(world: World): boolean {
  const p = world.player
  if (world.playerClass !== 'melee' || !p.empowered) return false

  const pool = world.enemies
  const now = world.time
  aimDir(world, dir)

  if (world.attacks.length < 16) {
    world.attacks.push({ angle: Math.atan2(dir.y, dir.x), kind: 'empowered' })
  }

  let heal = 0
  // 100도 부채꼴 = 반각 50도
  queryCone(pool, world.enemyHash, p.pos.x, p.pos.y, dir.x, dir.y, 3.4, Math.cos(0.873), (i) => {
    applyMark(pool, i, now, MARK_DURATION)
    damageEnemy(world, i, 32)
    heal += 1.5
  })

  // 회복 상한이 이 클래스의 성패를 가른다.
  // 상한 10으로 두니 군중에서 게이지가 1초 미만에 차서 초당 10 회복이 되고,
  // 접촉 피해와 맞먹어 8/8 시드가 무상처로 완주했다. 붙어 싸운 보상이지
  // 무적 장치가 되면 안 된다.
  p.hp = Math.min(world.stats.maxHp, p.hp + Math.min(heal, 4))
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
