import {
  ARENA_RADIUS,
  DT,
  KILL_HEAL_CAP,
  KILL_HEAL_RATE,
  PLAYER_ACCEL,
  RUN_TIME_LIMIT,
} from './constants.ts'
import { MELEE_W_DASH_END, MELEE_W_PREPARE_END } from './action-timing.ts'
import { currentSpeed, stepAbilities } from './abilities.ts'
import { releaseFinishedPlayerAction } from './actions.ts'
import { stepAutoAttack } from './combat.ts'
import { sweepDead } from './damage.ts'
import { stepGauge, stepKits } from './kits.ts'
import { stepZones } from './zones.ts'
import {
  BOSS_MAX_HP,
  BOSS_SPAWN_TIME,
  createEnemyHash,
  createEnemyPool,
  rebuildEnemyHash,
  spawnBoss,
  stepEnemies,
  targetAliveCount,
  thinEnemiesForBoss,
  updateSpawner,
} from './enemies.ts'
import {
  MELEE_XP_GAIN_MULTIPLIER,
  RANGED_XP_GAIN_MULTIPLIER,
  addXp,
  consumeLevelUp,
  createProgression,
  upgradeTraitToken,
} from './progression.ts'
import { createRng } from './rng.ts'
import { stepEliteRewardBeats, stepRelicDrops } from './rewards.ts'
import { createSkillBook, tickSkills, unlockSkill } from './skills.ts'
import { createStats } from './stats.ts'
import type { Input, Player, PlayerClass, World } from './types.ts'
import { length, lerpAngle, normalize, vec2 } from './vec.ts'
import { createXpGemPool, stepXpGems } from './xp-gems.ts'

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
    invulnUntil: -1,
    // 예산은 가득 찬 채로 시작한다. 첫 교전에서 회복이 없으면 초반 난이도가
    // 실제 설계보다 급해 보인다.
    killHealBudget: KILL_HEAL_CAP,
    gauge: 0,
    empowered: false,
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
    // 시드는 같되 스트림을 갈라 서로 간섭하지 않게 한다.
    choiceRng: createRng((seed ^ 0x9e3779b9) >>> 0),
    arenaRadius: ARENA_RADIUS,
    playerClass,
    stats,
    player,
    playerAction: null,
    bufferedSkill: null,
    basicAttackSequence: 0,
    kills: 0,
    progression: createProgression(),
    skills,
    upgradesTaken: new Set(),
    lastAim: vec2(1, 0),
    enemies: createEnemyPool(),
    xpGems: createXpGemPool(),
    enemyHash: createEnemyHash(),
    boss: {
      spawned: false,
      spawnedAt: -1,
      active: false,
      hp: 0,
      maxHp: BOSS_MAX_HP,
    },
    eliteBeatIndex: 0,
    relicDrops: [],
    pendingRelicChoices: 0,
    relicsClaimed: 0,
    spawnEnabled: true,
    zones: [],
    blasts: [],
    ult: { active: false, nextHitAt: 0, hitsLeft: 0 },
    deaths: [],
    tracers: [],
    rings: [],
    casts: [],
    attacks: [],
    actionStarts: [],
    damageFeedback: [],
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
  releaseFinishedPlayerAction(world)

  // 격자를 가장 먼저 만든다. 스킬 시전이 이동보다 앞서므로 여기서
  // 갱신하지 않으면 스킬이 낡은(첫 틱엔 빈) 격자를 질의해 헛손질한다.
  rebuildEnemyHash(world.enemies, world.enemyHash)

  tickSkills(world.skills, DT)
  // 스킬은 이동보다 먼저 처리한다. 점멸이 위치를 바꾸므로
  // 같은 틱의 이동이 그 새 위치에서 이어져야 순간이동이 매끄럽다.
  stepAbilities(world, input)
  stepPlayer(world, input)
  const p = world.player
  const collectedXp = stepXpGems(world.xpGems, p.pos.x, p.pos.y, DT)
  if (collectedXp > 0) grantXp(world, collectedXp)
  // 정예 인장은 플레이어 이동 뒤를 추적한다. 회수로 선택 화면이 열려도
  // 현재 고정 틱은 끝까지 마치고 다음 프레임부터 멈춰 결정론을 유지한다.
  stepRelicDrops(world)

  if (world.spawnEnabled) {
    // 일반 스폰보다 먼저 정예 자리를 확보한다. 보스와 달리 정예는 세 번의
    // 고정 보상 비트이며 풀 용량으로 실패하면 다음 틱에 재시도한다.
    stepEliteRewardBeats(world)

    // 일반 스폰보다 먼저 보스 슬롯을 확보한다. 용량 부족으로 실패하면
    // spawned를 올리지 않아 다음 틱에 안전하게 다시 시도한다.
    if (!world.boss.spawned && world.time >= BOSS_SPAWN_TIME) {
      if (spawnBoss(world.enemies, world.rng, p.pos.x, p.pos.y)) {
        world.boss.spawned = true
        world.boss.spawnedAt = world.time
        world.boss.active = true
        world.boss.hp = world.boss.maxHp

        // 3:30 비트에서 실제 개체 수를 즉시 낮춘다. 목표치만 낮추면 이미
        // 살아 있는 잡몹은 남아 보스가 100마리 안에 묻힌다.
        const bossIndex = world.enemies.count - 1
        const bx = world.enemies.x[bossIndex]!
        const by = world.enemies.y[bossIndex]!
        thinEnemiesForBoss(world.enemies, targetAliveCount(world.time))

        // 렌더 전용 균열 파동. 시뮬 판정에는 관여하지 않는다.
        if (world.rings.length < 32) {
          world.rings.push({ x: bx, y: by, radius: 10, kind: 3 })
        }
      }
    }
    updateSpawner(world.enemies, world.rng, world.time, p.pos.x, p.pos.y)
  }

  const res = stepEnemies(
    world.enemies,
    world.enemyHash,
    p.pos.x,
    p.pos.y,
    world.stats.radius,
    world.time,
    world.boss.spawnedAt,
    world.relicsClaimed,
  )
  // 무적 중에는 접촉 피해를 받지 않는다. 대시·궁극기가 성립하는 근거다.
  if (res.contactDamage > 0 && world.time >= p.invulnUntil) {
    // 클래스별 피해 감소를 여기 한 곳에서만 적용한다.
    let incoming = res.contactDamage * world.stats.damageTakenMul

    const photonSpent = 'state:photon-barrier:spent'
    if (
      incoming >= p.hp &&
      world.upgradesTaken.has(upgradeTraitToken('photon-barrier')) &&
      !world.upgradesTaken.has(photonSpent)
    ) {
      world.upgradesTaken.add(photonSpent)
      p.invulnUntil = world.time + 1.2
      incoming = 0
      if (world.rings.length < 32) {
        world.rings.push({ x: p.pos.x, y: p.pos.y, radius: 3.4, kind: 0 })
      }
    }

    const guardSpent = 'state:perfect-guard:spent'
    if (
      incoming > 0 &&
      p.hp - incoming <= world.stats.maxHp * 0.5 &&
      world.upgradesTaken.has(upgradeTraitToken('perfect-guard')) &&
      !world.upgradesTaken.has(guardSpent)
    ) {
      world.upgradesTaken.add(guardSpent)
      p.gauge = Math.min(100, p.gauge + 35)
      incoming = 0
      if (world.rings.length < 32) {
        world.rings.push({ x: p.pos.x, y: p.pos.y, radius: 3, kind: 3 })
      }
    }

    p.hp = Math.max(0, p.hp - incoming)
    // 같은 틱에 보스를 먼저 쓰러뜨렸다면 승리를 사망으로 덮지 않는다.
    // 반대 순서에서도 damageEnemy가 victory를 설정하므로 동시 판정은 승리 우선이다.
    if (p.hp <= 0 && world.outcome === 'alive') world.outcome = 'dead'
  }

  // 근접 패시브 게이지는 적을 센 뒤에 돌려야 이번 틱 배치를 반영한다.
  stepGauge(world, DT)
  stepKits(world)
  // 이 틱이 끝나는 정확한 시각까지 예약된 판정을 처리한다. 그래야 5:00에
  // 발동하는 지연 폭발과 장판 피해도 제한 시간의 마지막 공격으로 인정된다.
  stepZones(world, (world.tick + 1) * DT)
  stepAutoAttack(world, world.enemies, world.enemyHash, world.tracers)

  // 사망 처리는 모든 판정이 끝난 뒤 한 번만. 질의 도중에 배열을 흔들면
  // 아직 방문하지 않은 적이 처리된 인덱스로 옮겨와 중복·누락이 생긴다.
  sweepDead(world)

  world.tick += 1
  world.time = world.tick * DT

  // 모든 공격·지연 폭발·사망 스윕이 끝난 뒤 판정한다. 제한 시각이 되는 바로 그
  // 틱에 보스를 처치했다면 damageEnemy가 설정한 victory가 timeout보다 우선한다.
  if (
    world.outcome === 'alive' &&
    world.boss.spawned &&
    world.boss.active &&
    world.time >= RUN_TIME_LIMIT
  ) {
    world.outcome = 'timeout'
  }
}

/**
 * 렌더 전용 이벤트 큐를 비운다.
 * 렌더러가 소비한 뒤, 헤드리스에서는 매 프레임 상당 주기로 호출한다.
 */
export function drainEvents(world: World): void {
  world.deaths.length = 0
  world.tracers.length = 0
  world.rings.length = 0
  world.casts.length = 0
  world.attacks.length = 0
  world.actionStarts.length = 0
  world.damageFeedback.length = 0
}

/**
 * XP를 지급하고 레벨업 대기 상태를 갱신한다.
 * XP는 반드시 이 함수를 통해서만 들어온다 — awaitingChoice 동기화를 놓치지 않기 위해서다.
 */
export function grantXp(world: World, amount: number): void {
  const classMultiplier =
    world.playerClass === 'melee'
      ? MELEE_XP_GAIN_MULTIPLIER
      : RANGED_XP_GAIN_MULTIPLIER
  addXp(world.progression, amount * classMultiplier, world.time)
  world.awaitingChoice =
    world.pendingRelicChoices > 0 || world.progression.pendingLevelUps > 0
}

/**
 * 레벨업 선택 하나를 처리 완료로 표시한다.
 * 선택 효과 적용은 호출부가 먼저 끝내고 이걸 부른다.
 */
export function resolveLevelUp(world: World): void {
  consumeLevelUp(world.progression)
  world.awaitingChoice =
    world.pendingRelicChoices > 0 || world.progression.pendingLevelUps > 0
}

/**
 * 화면에 가장 먼저 떠 있는 보상을 하나 소진한다.
 * 전리품과 레벨업이 같은 틱에 겹치면 전리품을 먼저 처리하고 레벨업은 보존한다.
 */
export function resolveRewardChoice(world: World): void {
  if (world.pendingRelicChoices > 0) world.pendingRelicChoices -= 1
  else consumeLevelUp(world.progression)
  world.awaitingChoice =
    world.pendingRelicChoices > 0 || world.progression.pendingLevelUps > 0
}

const moveDir = vec2()

function stepPlayer(world: World, input: Input): void {
  const p = world.player
  const action = world.playerAction
  const meleeDash = action?.meleeDash

  // 처치 회복 예산을 채운다. 상한이 있어야 회복이 피해를 압도하지 않는다.
  p.killHealBudget = Math.min(KILL_HEAL_CAP, p.killHealBudget + KILL_HEAL_RATE * DT)

  // 렌더 보간용으로 직전 상태를 먼저 보관한다.
  p.prevPos.x = p.pos.x
  p.prevPos.y = p.pos.y
  p.prevFacing = p.facing

  // --- 이동 ---
  if (world.ult.active || meleeDash) {
    moveDir.x = 0
    moveDir.y = 0
    p.vel.x = 0
    p.vel.y = 0
  } else {
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
  }

  if (meleeDash && action) {
    // 이번 고정 틱 뒤의 상태는 다음 시뮬레이션 시각을 나타낸다.
    // 그 시각을 샘플링해야 0.16..0.32초 돌진과 애니메이션이 맞고,
    // prevPos -> pos 렌더 보간도 순간이동 없이 유지된다.
    const sampleAt = (world.tick + 1) * DT
    const elapsed = sampleAt - action.startedAt
    const linearProgress = Math.max(
      0,
      Math.min(1, (elapsed - MELEE_W_PREPARE_END) / (MELEE_W_DASH_END - MELEE_W_PREPARE_END)),
    )
    const progress = linearProgress * linearProgress * (3 - 2 * linearProgress)
    p.pos.x =
      meleeDash.originX + (meleeDash.destinationX - meleeDash.originX) * progress
    p.pos.y =
      meleeDash.originY + (meleeDash.destinationY - meleeDash.originY) * progress

    if (linearProgress > 0 && elapsed <= MELEE_W_DASH_END + DT) {
      p.invulnUntil = Math.max(p.invulnUntil, action.startedAt + MELEE_W_DASH_END)
    }
  } else {
    p.pos.x += p.vel.x * DT
    p.pos.y += p.vel.y * DT
  }

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
  if (!world.ult.active && !meleeDash) {
    const ax = input.aim.x - p.pos.x
    const ay = input.aim.y - p.pos.y
    if (ax * ax + ay * ay > 1e-6) {
      const targetFacing = Math.atan2(ay, ax)
      p.facing = lerpAngle(p.facing, targetFacing, 0.35)
    }
  }
}
