/**
 * 시뮬레이션 스모크 체크.
 *
 * 이 파일이 Node에서 도는 것 자체가 아키텍처 검증이다:
 * src/sim 이 three.js·DOM에 조금이라도 의존하면 여기서 즉시 터진다.
 * D9의 헤드리스 밸런싱은 전부 이 성질 위에 세워진다.
 *
 *   npx tsx tools/sim-check.ts
 */
import { ARENA_RADIUS, DT, FLASH_COOLDOWN } from '../src/sim/constants.ts'
import { damageEnemy } from '../src/sim/damage.ts'
import {
  BOSS_MAX_HP,
  BOSS_SPAWN_TIME,
  TYPE_BOSS,
  TYPE_WALKER,
  createEnemyPool,
  removeEnemy,
  spawnBoss,
  spawnEnemy,
  targetAliveCount,
} from '../src/sim/enemies.ts'
import {
  MAX_LEVEL,
  TARGET_LEVEL_TIMES,
  XP_FOR_NEXT,
  pendingReward,
  rollUpgrades,
  type UpgradeCandidate,
} from '../src/sim/progression.ts'
import { createRng } from '../src/sim/rng.ts'
import {
  SKILL_Q,
  consumeCooldown,
  cooldownProgress,
  createSkillBook,
  isReady,
  lockedChoosableSkills,
  tickSkills,
  unlockSkill,
  unlockedCount,
} from '../src/sim/skills.ts'
import { effectiveAtkDamage, effectiveAtkInterval } from '../src/sim/stats.ts'
import { createInput } from '../src/sim/types.ts'
import { length } from '../src/sim/vec.ts'
import { createWorld, grantXp, resolveLevelUp, stepWorld } from '../src/sim/world.ts'

let failures = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    console.log(`  ok    ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * 월드를 ticks만큼 진행시킨다.
 * 이동·시간 같은 성질을 격리해 보기 위해 스폰을 끈다 —
 * 켜두면 적이 플레이어를 죽여서 무엇을 재는지 알 수 없게 된다.
 */
function run(seed: number, ticks: number, moveX: number, moveY: number) {
  const world = createWorld(seed)
  world.spawnEnabled = false
  const input = createInput()
  input.move.x = moveX
  input.move.y = moveY
  input.aim.x = 5
  input.aim.y = 5
  for (let i = 0; i < ticks; i++) stepWorld(world, input)
  return world
}

console.log('\nsim smoke check\n')

// --- 시간 ---
{
  const w = run(1, 600, 0, 0)
  check('600틱 후 tick 카운트', w.tick === 600, `tick=${w.tick}`)
  check(
    '600틱 후 경과 시간이 10초',
    Math.abs(w.time - 600 * DT) < 1e-9,
    `time=${w.time}`,
  )
}

// --- 이동 ---
{
  const w = run(1, 120, 1, 0)
  check('입력이 있으면 플레이어가 움직인다', w.player.pos.x > 1, `x=${w.player.pos.x.toFixed(2)}`)
  const idle = run(1, 120, 0, 0)
  check(
    '입력이 없으면 제자리',
    Math.abs(idle.player.pos.x) < 1e-6 && Math.abs(idle.player.pos.y) < 1e-6,
  )
}

// --- 아레나 경계 ---
{
  // 대각선으로 오래 밀어붙여도 절대 밖으로 못 나가야 한다.
  const w = run(1, 3600, 1, 1)
  const d = length(w.player.pos)
  const limit = ARENA_RADIUS - w.stats.radius
  check(
    '아레나 밖으로 나가지 않는다',
    d <= limit + 1e-6,
    `dist=${d.toFixed(4)} limit=${limit.toFixed(4)}`,
  )
  check('경계까지는 실제로 도달한다', d > limit - 0.05, `dist=${d.toFixed(4)}`)
}

// --- 결정론 ---
{
  const a = run(12345, 900, 1, -0.4)
  const b = run(12345, 900, 1, -0.4)
  const same =
    a.player.pos.x === b.player.pos.x &&
    a.player.pos.y === b.player.pos.y &&
    a.player.facing === b.player.facing &&
    a.rng.state() === b.rng.state()
  check('같은 시드 + 같은 입력 = 완전히 같은 결과', same)

  const c = run(999, 900, 1, -0.4)
  check(
    '다른 시드는 rng 상태가 다르다',
    a.rng.state() !== c.rng.state(),
    `${a.rng.state()} vs ${c.rng.state()}`,
  )
}

// --- 수치 안정성 ---
{
  const w = run(7, 18000, 0.3, -1) // 5분치
  const finite =
    Number.isFinite(w.player.pos.x) &&
    Number.isFinite(w.player.pos.y) &&
    Number.isFinite(w.player.vel.x) &&
    Number.isFinite(w.player.facing)
  check('5분(18000틱) 후에도 NaN/Infinity 없음', finite)
}

// --- 비트 시트 스펙 정합성 ---
{
  check(
    '목표 시각 표와 XP 표의 길이가 맞는다',
    TARGET_LEVEL_TIMES.length === MAX_LEVEL && XP_FOR_NEXT.length === MAX_LEVEL - 1,
  )
  check(
    '목표 시각이 단조 증가한다',
    TARGET_LEVEL_TIMES.every((t, i) => i === 0 || t > TARGET_LEVEL_TIMES[i - 1]!),
  )
  check(
    '만렙 도달 목표가 5분 안이다',
    TARGET_LEVEL_TIMES[MAX_LEVEL - 1]! < 300,
    `${TARGET_LEVEL_TIMES[MAX_LEVEL - 1]}s`,
  )
}

// --- 레벨업 ---
{
  const w = createWorld(1)
  w.spawnEnabled = false
  const idle = createInput()
  for (let i = 0; i < 600; i++) stepWorld(w, idle) // 정확히 10초

  grantXp(w, XP_FOR_NEXT[0]!)
  check('필요 XP를 채우면 레벨업', w.progression.level === 2)
  check(
    '레벨 도달 시각이 기록된다',
    Math.abs(w.progression.levelTimes[1]! - 10) < 1e-9,
    `${w.progression.levelTimes[1]}`,
  )
  check('Lv2 보상은 스킬 해금', pendingReward(w.progression) === 'unlock-choice')
  check('Lv8 보상은 궁극기', (() => {
    const p = { ...w.progression, level: 8, pendingLevelUps: 1 }
    return pendingReward(p) === 'unlock-ult'
  })())
}

// --- 선택 대기 중에는 게임이 멈춘다 ---
{
  const w = createWorld(1)
  w.spawnEnabled = false
  grantXp(w, 100000) // 한 번에 만렙까지
  check('큰 XP 한 번에 여러 레벨이 오른다', w.progression.level === MAX_LEVEL)
  check('레벨업이 밀려 있으면 선택 대기', w.awaitingChoice)
  check(
    '밀린 레벨업 수가 오른 레벨 수와 같다',
    w.progression.pendingLevelUps === MAX_LEVEL - 1,
    `${w.progression.pendingLevelUps}`,
  )
  check('만렙 초과 XP는 버려진다', w.progression.xp === 0)

  const moving = createInput()
  moving.move.x = 1
  const tick0 = w.tick
  for (let i = 0; i < 120; i++) stepWorld(w, moving)
  check('선택 대기 중에는 시간이 멈춘다', w.tick === tick0 && w.player.pos.x === 0)

  while (w.progression.pendingLevelUps > 0) resolveLevelUp(w)
  check('선택을 다 처리하면 대기가 풀린다', !w.awaitingChoice)

  for (let i = 0; i < 120; i++) stepWorld(w, moving)
  check('재개 후 다시 진행한다', w.tick === tick0 + 120 && w.player.pos.x > 0)
}

// --- 선택지 추첨 ---
{
  const pool: UpgradeCandidate[] = [
    { id: 'a', available: true, weight: 1 },
    { id: 'b', available: true, weight: 1 },
    { id: 'c', available: true, weight: 3 },
    { id: 'd', available: false, weight: 5 }, // 전제 미충족
    { id: 'e', available: true, weight: 1 },
    { id: 'f', available: true, weight: 0 }, // 가중치 0
  ]

  const a = rollUpgrades(createRng(7), pool, 3)
  const b = rollUpgrades(createRng(7), pool, 3)
  check('같은 시드면 같은 카드가 나온다', JSON.stringify(a) === JSON.stringify(b))
  check('카드 3장', a.length === 3, `${a.length}`)
  check('중복 없음', new Set(a.map((c) => c.id)).size === a.length)
  check(
    '전제 미충족·가중치 0 후보는 제외',
    a.every((c) => c.id !== 'd' && c.id !== 'f'),
    a.map((c) => c.id).join(','),
  )

  const short = rollUpgrades(createRng(1), pool.slice(0, 2), 3)
  check('후보가 모자라면 있는 만큼만 낸다', short.length === 2, `${short.length}`)

  const none = rollUpgrades(createRng(1), [], 3)
  check('후보가 없어도 터지지 않는다', none.length === 0)

  // 이미 뽑은 카드는 다시 나오면 안 된다 — 5분에 강화는 5번뿐이다
  const taken = new Set(['a', 'b'])
  const excluded = rollUpgrades(createRng(3), pool, 3, taken)
  check(
    '이미 획득한 강화는 제외된다',
    excluded.every((c) => !taken.has(c.id)),
    excluded.map((c) => c.id).join(','),
  )
  check(
    '제외 후 남은 후보만큼만 나온다',
    excluded.length === 2,
    `${excluded.length}`,
  )

  const w = createWorld(1)
  check('월드가 획득 강화 집합을 들고 있다', w.upgradesTaken instanceof Set && w.upgradesTaken.size === 0)
}

// --- 클래스 스탯 분기 ---
{
  const r = createWorld(1, 'ranged')
  const m = createWorld(1, 'melee')

  check('근딜이 체력이 높다', m.stats.maxHp > r.stats.maxHp, `${m.stats.maxHp} vs ${r.stats.maxHp}`)
  check('근딜이 피해를 덜 받는다', m.stats.damageTakenMul < r.stats.damageTakenMul)
  check(
    '근딜 사거리가 훨씬 짧다 — 파고들어야 한다',
    m.stats.atkRange < r.stats.atkRange / 3,
    `${m.stats.atkRange} vs ${r.stats.atkRange}`,
  )
  // 근딜이 더 단단해야 하지만 격차가 벌어지면 원딜이 전멸한다.
  // 처음 1.94배로 뒀더니 8시드에서 원딜 0/8, 근딜 8/8이었다.
  // 상한을 테스트로 못박아 다시 벌어지지 않게 한다.
  {
    const ratio =
      m.stats.maxHp / m.stats.damageTakenMul / (r.stats.maxHp / r.stats.damageTakenMul)
    check('근딜이 원딜보다 단단하다', ratio > 1.1, `${ratio.toFixed(2)}배`)
    check('다만 격차가 1.5배를 넘지 않는다', ratio < 1.5, `${ratio.toFixed(2)}배`)
  }
  check('시작 체력은 최대 체력과 같다', m.player.hp === m.stats.maxHp && r.player.hp === r.stats.maxHp)

  // 강화가 실제로 스탯을 바꿀 수 있어야 한다 — world.stats 도입의 목적
  r.stats.atkDamageMul = 1.5
  check('공격력 배수가 실효 공격력에 반영된다', effectiveAtkDamage(r.stats) === r.stats.atkDamage * 1.5)
  r.stats.atkIntervalMul = 0.0001
  check('공격 간격에 하한이 있다', effectiveAtkInterval(r.stats) >= 0.06)
}

// --- 스킬 런타임 ---
{
  const book = createSkillBook()
  check('맨 처음에는 전부 잠겨 있다', unlockedCount(book) === 0)
  check('선택 가능한 주력 스킬은 Q/W/E 3개', lockedChoosableSkills(book).length === 3)
  check('궁극기 R은 선택 대상이 아니다', !lockedChoosableSkills(book).includes('r'))
  check(
    '소환사 주문 D/F도 선택 대상이 아니다',
    !lockedChoosableSkills(book).includes('d') && !lockedChoosableSkills(book).includes('f'),
  )

  unlockSkill(book, 'w', 3)
  check('해금 즉시 사용 가능', isReady(book, 'w'))
  check('해금하면 후보에서 빠진다', !lockedChoosableSkills(book).includes('w'))
  check('해금 안 된 스킬은 못 쓴다', !isReady(book, 'e'))

  check('사용하면 쿨다운이 걸린다', consumeCooldown(book, 'w') && !isReady(book, 'w'))
  check('쿨다운 중에는 재사용 실패', !consumeCooldown(book, 'w'))
  check('쿨다운 진행률이 1에서 시작', Math.abs(cooldownProgress(book, 'w') - 1) < 1e-9)
  tickSkills(book, 1.5)
  check('쿨다운이 절반 남았을 때는 아직 못 쓴다', !isReady(book, 'w'))
  check(
    '쿨다운 진행률이 절반',
    Math.abs(cooldownProgress(book, 'w') - 0.5) < 1e-9,
    `${cooldownProgress(book, 'w')}`,
  )
  tickSkills(book, 1.6)
  check('쿨다운이 끝나면 다시 쓸 수 있다', isReady(book, 'w'))
  check('쿨다운은 음수로 내려가지 않는다', book.w.cooldown === 0)
  check('사용 가능하면 진행률 0', cooldownProgress(book, 'w') === 0)
}

// --- 소환사 주문은 시작부터 보유 ---
{
  const w = createWorld(1)
  check('점멸 F는 시작부터 사용 가능', isReady(w.skills, 'f'))
  check('회복 D는 시작부터 사용 가능', isReady(w.skills, 'd'))
  check('QWER은 시작 시 전부 잠김', !w.skills.q.unlocked && !w.skills.r.unlocked)
  check('시작 해금 수는 2개', unlockedCount(w.skills) === 2)
  check(
    '점멸 쿨다운이 상수와 일치',
    w.skills.f.maxCooldown === FLASH_COOLDOWN,
    `${w.skills.f.maxCooldown}`,
  )
}

// --- 클래스 ---
{
  check('기본 클래스는 원딜', createWorld(1).playerClass === 'ranged')
  check('근딜로도 만들 수 있다', createWorld(1, 'melee').playerClass === 'melee')
  const a = createWorld(42, 'ranged')
  const b = createWorld(42, 'melee')
  check('클래스가 달라도 시드 상태는 같다', a.rng.state() === b.rng.state())
}

// --- 적 시스템 ---
{
  const w = createWorld(7)
  const input = createInput()
  input.aim.x = 10
  input.aim.y = 0

  for (let i = 0; i < 60; i++) stepWorld(w, input)
  check('스폰이 돌아간다', w.enemies.count > 0, `count=${w.enemies.count}`)
  check(
    '적이 아레나 밖으로 나가지 않는다',
    Array.from({ length: w.enemies.count }).every((_, i) =>
      Math.hypot(w.enemies.x[i]!, w.enemies.y[i]!) <= ARENA_RADIUS + 1e-3,
    ),
  )

  // 초반 목표 마릿수는 4. 스폰이 폭주하지 않아야 한다.
  check('목표 마릿수를 크게 넘지 않는다', w.enemies.count <= 8, `count=${w.enemies.count}`)

  // 적이 접근하면 자동 공격이 잡기 시작한다
  for (let i = 0; i < 60 * 20; i++) stepWorld(w, input)
  check('20초 후에도 살아있다', w.outcome === 'alive', `outcome=${w.outcome} hp=${w.player.hp.toFixed(1)}`)
  check('자동 공격이 적을 잡아 XP가 오른다', w.progression.totalXp > 0, `xp=${w.progression.totalXp}`)
  check('레벨이 올랐다', w.progression.level >= 2, `lv=${w.progression.level}`)
}

// --- 스폰 커브가 비트 시트와 맞는가 ---
{
  check('0초 목표는 4마리', Math.round(targetAliveCount(0)) === 4)
  check('3:20 목표가 최대(100)', Math.round(targetAliveCount(200)) === 100)
  check(
    '보스 등장(3:30)에 잡몹이 줄어든다',
    targetAliveCount(210) < targetAliveCount(200),
    `${targetAliveCount(210)} vs ${targetAliveCount(200)}`,
  )
  check('커브가 음수로 가지 않는다', [0, 60, 120, 180, 240, 300].every((t) => targetAliveCount(t) > 0))
}

// --- 결정론: 적이 있어도 유지되는가 ---
{
  const play = (seed: number) => {
    const w = createWorld(seed)
    const input = createInput()
    input.move.x = 1
    input.aim.x = 8
    for (let i = 0; i < 60 * 15; i++) stepWorld(w, input)
    return w
  }
  const a = play(2024)
  const b = play(2024)
  check(
    '적·전투가 돌아도 같은 시드면 같은 결과',
    a.enemies.count === b.enemies.count &&
      a.player.hp === b.player.hp &&
      a.progression.totalXp === b.progression.totalXp &&
      a.rng.state() === b.rng.state(),
    `${a.enemies.count}/${b.enemies.count} hp ${a.player.hp}/${b.player.hp}`,
  )
}

// --- 보스 스폰·체력 상태·승리 ---
{
  const makeBossWorld = (seed: number) => {
    const w = createWorld(seed)
    // 긴 준비 구간을 돌리지 않고 정확히 3:30 경계에서 한 틱 진행한다.
    w.tick = Math.round(BOSS_SPAWN_TIME / DT)
    w.time = w.tick * DT
    w.player.attackCooldown = Infinity
    w.player.invulnUntil = Infinity
    stepWorld(w, createInput())
    return w
  }

  const w = makeBossWorld(808)
  const bossCount = Array.from({ length: w.enemies.count }).filter(
    (_, i) => w.enemies.type[i] === TYPE_BOSS,
  ).length
  check('3:30에 고유 보스가 한 번 등장한다', bossCount === 1, `count=${bossCount}`)
  check(
    'World가 활성 보스의 현재/최대 체력을 제공한다',
    w.boss.spawned &&
      w.boss.active &&
      w.boss.hp === BOSS_MAX_HP &&
      w.boss.maxHp === BOSS_MAX_HP,
    `${w.boss.hp}/${w.boss.maxHp}`,
  )

  for (let i = 0; i < 120; i++) stepWorld(w, createInput())
  const afterCount = Array.from({ length: w.enemies.count }).filter(
    (_, i) => w.enemies.type[i] === TYPE_BOSS,
  ).length
  check('보스는 다음 틱에 중복 스폰되지 않는다', afterCount === 1, `count=${afterCount}`)

  const bossIndex = Array.from({ length: w.enemies.count }).findIndex(
    (_, i) => w.enemies.type[i] === TYPE_BOSS,
  )
  damageEnemy(w, bossIndex, BOSS_MAX_HP / 2)
  check(
    '보스 피격 시 World 체력이 즉시 동기화된다',
    Math.abs(w.boss.hp - BOSS_MAX_HP / 2) < 1e-3,
    `hp=${w.boss.hp}`,
  )
  damageEnemy(w, bossIndex, BOSS_MAX_HP)
  check(
    '보스 처치 즉시 victory가 되고 보스바가 비활성화된다',
    w.outcome === 'victory' && !w.boss.active && w.boss.hp === 0,
    `outcome=${w.outcome} active=${w.boss.active}`,
  )

  // 스킬은 접촉 피해보다 먼저 처리된다. 보스를 쓰러뜨린 바로 그 틱에
  // 플레이어 체력도 0이 되더라도 최종 일격을 승리로 인정한다.
  const simultaneous = createWorld(810, 'ranged')
  simultaneous.spawnEnabled = false
  spawnBoss(
    simultaneous.enemies,
    simultaneous.rng,
    simultaneous.player.pos.x,
    simultaneous.player.pos.y,
  )
  simultaneous.boss.spawned = true
  simultaneous.boss.active = true
  simultaneous.boss.hp = 1
  const simultaneousBoss = simultaneous.enemies.count - 1
  simultaneous.enemies.x[simultaneousBoss] = 0.5
  simultaneous.enemies.y[simultaneousBoss] = 0
  simultaneous.enemies.prevX[simultaneousBoss] = 0.5
  simultaneous.enemies.prevY[simultaneousBoss] = 0
  simultaneous.enemies.hp[simultaneousBoss] = 1
  simultaneous.player.hp = 0.001
  unlockSkill(simultaneous.skills, 'q', 3.5)
  const finalBlow = createInput()
  finalBlow.aim.x = 4
  finalBlow.skillsPressed = SKILL_Q
  stepWorld(simultaneous, finalBlow)
  check(
    '보스 처치와 플레이어 사망이 같은 틱이면 승리가 우선된다',
    simultaneous.outcome === 'victory',
    `outcome=${simultaneous.outcome}`,
  )

  const a = makeBossWorld(909)
  const b = makeBossWorld(909)
  const ai = Array.from({ length: a.enemies.count }).findIndex((_, i) => a.enemies.type[i] === TYPE_BOSS)
  const bi = Array.from({ length: b.enemies.count }).findIndex((_, i) => b.enemies.type[i] === TYPE_BOSS)
  check(
    '보스 스폰과 첫 이동도 같은 시드에서 결정론적이다',
    a.enemies.x[ai] === b.enemies.x[bi] &&
      a.enemies.y[ai] === b.enemies.y[bi] &&
      a.rng.state() === b.rng.state(),
  )
}

// --- 보스 슬롯이 swap-remove로 이동해도 상태 배열이 함께 이동하는가 ---
{
  const pool = createEnemyPool()
  const rng = createRng(77)
  spawnEnemy(pool, rng, 0, 0, TYPE_WALKER)
  spawnBoss(pool, rng, 0, 0)
  pool.markExpire[1] = 321
  pool.slowUntil[1] = 654
  pool.hitToken[1] = 987
  removeEnemy(pool, 0)
  check(
    'swap-remove가 보스 타입과 모든 상태 배열을 함께 옮긴다',
    pool.count === 1 &&
      pool.type[0] === TYPE_BOSS &&
      pool.maxHp[0] === BOSS_MAX_HP &&
      pool.markExpire[0] === 321 &&
      pool.slowUntil[0] === 654 &&
      pool.hitToken[0] === 987,
  )
}

console.log('')
if (failures > 0) {
  console.error(`${failures}건 실패\n`)
  process.exit(1)
}
console.log('전부 통과\n')
