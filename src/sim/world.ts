import { ARENA_RADIUS, DT, PLAYER_ACCEL } from './constants.ts'
import { currentSpeed, stepAbilities } from './abilities.ts'
import { stepAutoAttack } from './combat.ts'
import { createEnemyHash, createEnemyPool, stepEnemies, updateSpawner } from './enemies.ts'
import { addXp, consumeLevelUp, createProgression } from './progression.ts'
import { createRng } from './rng.ts'
import { createSkillBook, tickSkills, unlockSkill } from './skills.ts'
import { createStats } from './stats.ts'
import type { Input, Player, PlayerClass, World } from './types.ts'
import { length, lerpAngle, normalize, vec2 } from './vec.ts'

export function createWorld(seed: number, playerClass: PlayerClass = 'ranged'): World {
  const stats = createStats(playerClass)

  const player: Player = {
    pos: vec2(0, 0),
    prevPos: vec2(0, 0),
    vel: vec2(0, 0),
    facing: 0,
    prevFacing: 0,
    hp: stats.maxHp,
    attackCooldown: 0,
    speedBoostUntil: -1,
  }

  const skills = createSkillBook()
  // 소환사 주문은 시작부터 보유한다. QWER 슬롯은 잠긴 채 스킬바에 보여서
  // "앞으로 4개가 더 열린다"는 깊이를 첫 화면부터 광고한다.
  unlockSkill(skills, 'f', stats.flashCooldown)
  unlockSkill(skills, 'd', stats.healCooldown)

  return {
    seed,
    tick: 0,
    time: 0,
    rng: createRng(seed),
    arenaRadius: ARENA_RADIUS,
    playerClass,
    stats,
    player,
    progression: createProgression(),
    skills,
    upgradesTaken: new Set(),
    lastAim: vec2(1, 0),
    enemies: createEnemyPool(),
    enemyHash: createEnemyHash(),
    spawnEnabled: true,
    deaths: [],
    tracers: [],
    rings: [],
    awaitingChoice: false,
    outcome: 'alive',
  }
}

/**
 * 시뮬레이션을 정확히 한 틱 진행한다.
 *
 * 항상 고정 DT로만 호출된다. 가변 델타를 받지 않는 것이 결정론의 핵심이다.
 */
export function stepWorld(world: World, input: Input): void {
  // 레벨업 선택이 걸려 있으면 게임이 통째로 멈춘다. 5분 시계도 멈춘다 —
  // 카드를 읽는 시간이 생존 시간에 섞이면 비트 시트 검증이 무의미해진다.
  if (world.awaitingChoice || world.outcome !== 'alive') return

  world.lastAim.x = input.aim.x
  world.lastAim.y = input.aim.y

  tickSkills(world.skills, DT)
  // 스킬은 이동보다 먼저 처리한다. 점멸이 위치를 바꾸므로
  // 같은 틱의 이동이 그 새 위치에서 이어져야 순간이동이 매끄럽다.
  stepAbilities(world, input)
  stepPlayer(world, input)

  const p = world.player
  if (world.spawnEnabled) {
    updateSpawner(world.enemies, world.rng, world.time, p.pos.x, p.pos.y)
  }

  const res = stepEnemies(world.enemies, world.enemyHash, p.pos.x, p.pos.y, world.stats.radius)
  if (res.contactDamage > 0) {
    // 클래스별 피해 감소를 여기 한 곳에서만 적용한다.
    p.hp = Math.max(0, p.hp - res.contactDamage * world.stats.damageTakenMul)
    if (p.hp <= 0) world.outcome = 'dead'
  }

  const xp = stepAutoAttack(world, world.enemies, world.enemyHash, world.tracers)
  if (xp > 0) grantXp(world, xp)

  world.tick += 1
  world.time = world.tick * DT
}

/**
 * 렌더 전용 이벤트 큐를 비운다.
 * 렌더러가 소비한 뒤, 헤드리스에서는 매 프레임 상당 주기로 호출한다.
 */
export function drainEvents(world: World): void {
  world.deaths.length = 0
  world.tracers.length = 0
  world.rings.length = 0
}

/**
 * XP를 지급하고 레벨업 대기 상태를 갱신한다.
 * XP는 반드시 이 함수를 통해서만 들어온다 — awaitingChoice 동기화를 놓치지 않기 위해서다.
 */
export function grantXp(world: World, amount: number): void {
  addXp(world.progression, amount, world.time)
  world.awaitingChoice = world.progression.pendingLevelUps > 0
}

/**
 * 레벨업 선택 하나를 처리 완료로 표시한다.
 * 선택 효과 적용은 호출부가 먼저 끝내고 이걸 부른다.
 */
export function resolveLevelUp(world: World): void {
  consumeLevelUp(world.progression)
  world.awaitingChoice = world.progression.pendingLevelUps > 0
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

  const speed = currentSpeed(world)
  const targetVx = moveDir.x * speed
  const targetVy = moveDir.y * speed

  // 프레임레이트 독립 지수 감쇠. DT가 고정이라 사실상 상수지만,
  // 상수를 바꿔 손맛을 튜닝할 때 의미가 직관적으로 유지된다.
  const k = 1 - Math.exp(-PLAYER_ACCEL * DT)
  p.vel.x += (targetVx - p.vel.x) * k
  p.vel.y += (targetVy - p.vel.y) * k

  p.pos.x += p.vel.x * DT
  p.pos.y += p.vel.y * DT

  // --- 아레나 경계 ---
  const maxDist = world.arenaRadius - world.stats.radius
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
