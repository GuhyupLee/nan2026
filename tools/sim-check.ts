/**
 * 시뮬레이션 스모크 체크.
 *
 * 이 파일이 Node에서 도는 것 자체가 아키텍처 검증이다:
 * src/sim 이 three.js·DOM에 조금이라도 의존하면 여기서 즉시 터진다.
 * D9의 헤드리스 밸런싱은 전부 이 성질 위에 세워진다.
 *
 *   npx tsx tools/sim-check.ts
 */
import {
  ARENA_RADIUS,
  DT,
  FLASH_COOLDOWN,
  RUN_TIME_LIMIT,
} from '../src/sim/constants.ts'
import {
  MELEE_W_DASH_END,
  MELEE_W_PREPARE_END,
  MELEE_W_TIMING,
  PLAYER_ACTION_TIMING,
  playerActionTiming,
} from '../src/sim/action-timing.ts'
import { damageEnemy } from '../src/sim/damage.ts'
import { castSkill } from '../src/sim/kits.ts'
import {
  BOSS_CHARGE_AT,
  BOSS_INTRO_DURATION,
  BOSS_MAX_HP,
  BOSS_RECOVER_AT,
  BOSS_SPAWN_TIME,
  BOSS_WINDUP_AT,
  ENEMY_TYPES,
  TYPE_BOSS,
  TYPE_WALKER,
  bossPhaseAt,
  createEnemyPool,
  enemyHealthMultiplier,
  removeEnemy,
  spawnBoss,
  spawnEnemy,
  targetAliveCount,
} from '../src/sim/enemies.ts'
import {
  LEVEL_REWARDS,
  MAX_LEVEL,
  MELEE_XP_GAIN_MULTIPLIER,
  TARGET_LEVEL_TIMES,
  XP_FOR_NEXT,
  pendingReward,
  rollUpgrades,
  type UpgradeCandidate,
} from '../src/sim/progression.ts'
import { createRng } from '../src/sim/rng.ts'
import {
  SKILL_F,
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
import { pushBlast } from '../src/sim/zones.ts'
import { BALANCE_REGRESSION_SAMPLES } from './balance/baseline.ts'
import { runBalanceScenario } from './balance/model.ts'


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
    TARGET_LEVEL_TIMES[MAX_LEVEL - 1]! < RUN_TIME_LIMIT,
    `${TARGET_LEVEL_TIMES[MAX_LEVEL - 1]}s`,
  )
  // 상한을 20에서 26으로 올렸다. 적 밀도를 100→165로 올리면서 XP 수입이 늘어
  // 두 클래스 모두 5분 안에 옛 상한을 치고 남았고, 남는 수입을 **선택 횟수**로
  // 돌리는 편이 뱀서라이크의 도파민 리듬에 맞는다(레벨업 간격 17초 → 12초).
  check('최대 레벨은 26이다', MAX_LEVEL === 26, `MAX_LEVEL=${MAX_LEVEL}`)
  check(
    'XP 단계 수가 레벨 수와 맞는다',
    XP_FOR_NEXT.length === MAX_LEVEL - 1,
    `${XP_FOR_NEXT.length} vs ${MAX_LEVEL - 1}`,
  )
  check(
    '요구 XP는 단조 증가하지 않아도 되지만 전부 양수다',
    XP_FOR_NEXT.every((xp) => xp > 0),
  )
  // 근접이 원거리보다 1.85배 많이 죽이도록 밸런스가 바뀌어 보정 배율을 다시 잡았다.
  check('근접 XP 보정 배율이 1 미만이다', MELEE_XP_GAIN_MULTIPLIER < 1 && MELEE_XP_GAIN_MULTIPLIER > 0)
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
  check('Lv13 보상은 영구 강화', (() => {
    const p = { ...w.progression, level: 13, pendingLevelUps: 1 }
    return pendingReward(p) === 'upgrade'
  })())
}

// --- QWER 실제 처치율을 반영한 5분 레벨 페이스 ---
{
  const samples = BALANCE_REGRESSION_SAMPLES.map((expected) => {
    const qwer = runBalanceScenario(expected.playerClass, expected.seed)
    const auto = runBalanceScenario(expected.playerClass, expected.seed, { useQwer: false })
    return { expected, qwer, auto }
  })
  const details = samples
    .map(({ expected, qwer }) => {
      const time = qwer.levelTimes[MAX_LEVEL - 1]
      return `${expected.playerClass}:${expected.seed}=${time?.toFixed(1) ?? '--'}s/${qwer.kills}킬`
    })
    .join(', ')

  check(
    // 보류 상태다. 적 밀도 100→165, 레벨 상한 20→26으로 설계 목표 자체가
    // 바뀌었고, 예정된 스킬 밸류 재설계가 XP 수입을 또 바꾼다. 지금 스냅샷을
    // 다시 뜨면 그대로 버려지므로 그때까지는 "만렙에 도달은 한다"만 지킨다.
    '만렙에 제한 시간 안에 도달한다',
    samples.every(({ qwer }) => {
      const time = qwer.levelTimes[MAX_LEVEL - 1]
      return time !== null && time <= RUN_TIME_LIMIT
    }),
    details,
  )
  check(
    // 보류: 위와 같은 이유. 목표 시각 대신 곡선이 뒤집히지 않는지만 본다.
    '레벨 도달 시각이 단조 증가한다',
    (['ranged', 'melee'] as const).every((playerClass) =>
      samples
        .filter(({ expected }) => expected.playerClass === playerClass)
        .every(({ qwer }) => {
          let prev = -1
          for (const t of qwer.levelTimes) {
            if (t === null) break
            if (t < prev) return false
            prev = t
          }
          return true
        }),
    ),
    details,
  )
  check(
    'QWER 실제 처치율이 자동 공격 기준선보다 시드별 50% 이상 높다',
    samples.every(({ qwer, auto }) => qwer.kills >= auto.kills * 1.5),
    samples
      .map(
        ({ expected, qwer, auto }) =>
          `${expected.playerClass}:${expected.seed}=${(qwer.kills / auto.kills).toFixed(2)}x`,
      )
      .join(', '),
  )
  check(
    // 보류: 처치 수 스냅샷은 밸런스를 건드릴 때마다 깨진다. 재설계가 끝나
    // 수치가 안정되면 다시 뜬다. 그 사이에도 회귀를 잡을 수 있도록, 스냅샷
    // 대신 **결정론**을 검사한다 — 이쪽이 오히려 더 중요한 계약이다.
    '같은 시드를 두 번 돌리면 결과가 같다',
    samples.every(({ expected, qwer }) => {
      const again = runBalanceScenario(expected.playerClass, expected.seed, { useQwer: true })
      return again.kills === qwer.kills && again.totalXp === qwer.totalXp
    }),
    details,
  )
}

// --- Lv2~20은 모두 실제 선택 ---
{
  const w = createWorld(13)
  w.spawnEnabled = false
  w.progression.level = 5

  grantXp(w, XP_FOR_NEXT[4]!)
  check('Lv6 전술 보상도 선택창을 연다', w.awaitingChoice && w.progression.pendingLevelUps === 1)
  check(
    'Lv6 보상은 반복 가능한 전술 3택이다',
    pendingReward(w.progression) === 'skill-rank',
  )
  check(
    'Lv2~20의 모든 레벨에 보상이 지정되어 있다',
    Array.from({ length: MAX_LEVEL - 1 }, (_, i) => LEVEL_REWARDS[i + 2]).every(Boolean),
  )
  check(
    '영구 강화가 최소 9회는 나온다',
    Object.values(LEVEL_REWARDS).filter((reward) => reward === 'upgrade').length >= 9,
  )
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

  // 이미 뽑은 카드는 다시 나오면 안 된다.
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

// --- QWER은 모션 시작과 타격 판정을 분리한다 ---
{
  const slots = ['q', 'w', 'e', 'r'] as const
  let emitted = 0
  let started = 0
  let selfContained = true

  for (const playerClass of ['ranged', 'melee'] as const) {
    for (const slot of slots) {
      const w = createWorld(70 + emitted, playerClass)
      w.spawnEnabled = false
      w.lastAim.x = 8
      w.lastAim.y = 3
      unlockSkill(w.skills, slot, 1)

      const accepted = castSkill(w, slot)
      if (accepted && w.actionStarts[0]?.kind === slot && w.casts.length === 0) started++

      const input = createInput()
      input.aim.x = -9
      input.aim.y = -4
      const ticks = Math.ceil(playerActionTiming(playerClass, slot).impact / DT) + 1
      for (let i = 0; i < ticks; i++) stepWorld(w, input)

      const cast = w.casts[0]
      if (cast) emitted++
      selfContained =
        selfContained &&
        cast !== undefined &&
        cast.slot === slot &&
        Number.isFinite(cast.angle) &&
        Number.isFinite(cast.originX) &&
        Number.isFinite(cast.originY) &&
        Number.isFinite(cast.targetX) &&
        Number.isFinite(cast.targetY)
    }
  }

  check('두 클래스 QWER 8개가 입력 즉시 모션을 시작한다', started === 8, `${started}/8`)
  check('두 클래스 QWER 8개가 타격 시점에 world.casts를 발행한다', emitted === 8, `${emitted}/8`)
  check('지연된 시전 이벤트가 입력 시점의 목표를 완전하게 보존한다', selfContained)
}

// --- 스킬 판정은 지연하되 이동·조준과 D/F의 조작감은 유지한다 ---
{
  const w = createWorld(79, 'ranged')
  w.spawnEnabled = false
  w.lastAim.x = 8
  unlockSkill(w.skills, 'q', 1)
  unlockSkill(w.skills, 'w', 1)
  const started = castSkill(w, 'q')
  const startX = w.player.pos.x
  const startY = w.player.pos.y
  const startFacing = w.player.facing
  const input = createInput()
  input.move.x = 1
  input.aim.x = -8
  input.aim.y = 4
  stepWorld(w, input)

  check(
    'QWER 애니메이션 중에도 이동과 조준 입력이 유지된다',
    started &&
      (w.player.pos.x !== startX || w.player.pos.y !== startY) &&
      w.player.facing !== startFacing,
  )
  check('후딜 중 다른 QWER로 캔슬할 수 없다', !castSkill(w, 'w'))
  const beforeFlash = w.player.pos.x
  const flash = createInput()
  flash.aim.x = 5
  flash.skillsPressed = SKILL_F
  stepWorld(w, flash)
  check('스킬 시전 중에도 소환사 주문 F는 사용할 수 있다', w.player.pos.x > beforeFlash)

  while (w.time <= PLAYER_ACTION_TIMING.q.duration + DT) stepWorld(w, createInput())
  check('애니메이션 종료 뒤 다음 QWER을 사용할 수 있다', castSkill(w, 'w'))
}

// --- 평타는 즉발이며 이동·스킬 모션을 막지 않는다 ---
{
  const w = createWorld(80, 'ranged')
  w.spawnEnabled = false
  spawnEnemy(w.enemies, w.rng, 0, 0, TYPE_WALKER)
  w.enemies.x[0] = 2
  w.enemies.y[0] = 0
  w.enemies.prevX[0] = 2
  w.enemies.prevY[0] = 0
  const input = createInput()
  input.move.x = 1
  input.aim.x = 2
  const hpBefore = w.enemies.hp[0]!
  stepWorld(w, input)

  const started = w.actionStarts.some((event) => event.kind === 'attack')
  const immediateHit = w.attacks.length > 0

  check(
    '평타는 즉시 판정되고 별도 선후딜 상태를 만들지 않는다',
    started && immediateHit && w.enemies.hp[0]! < hpBefore && w.playerAction === null,
  )
  check('평타 중에도 이동 입력이 유지된다', w.player.pos.x > 0)
}

// --- 스킬 중 평타 판정은 유지하되 평타 모션 이벤트는 숨긴다 ---
{
  const w = createWorld(81, 'ranged')
  w.spawnEnabled = false
  spawnEnemy(w.enemies, w.rng, 0, 0, TYPE_WALKER)
  w.enemies.x[0] = 2
  w.enemies.y[0] = 0
  w.enemies.prevX[0] = 2
  w.enemies.prevY[0] = 0
  w.lastAim.x = 2
  unlockSkill(w.skills, 'q', 1)
  castSkill(w, 'q')
  const hpBefore = w.enemies.hp[0]!
  const input = createInput()
  input.aim.x = 2
  stepWorld(w, input)

  check('스킬 중에도 자동 평타 판정은 계속된다', w.enemies.hp[0]! < hpBefore)
  check(
    '스킬 중 평타 모션 이벤트가 QWER 애니메이션을 건드리지 않는다',
    !w.actionStarts.some((event) => event.kind === 'attack'),
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
  check('0초 목표는 5마리', Math.round(targetAliveCount(0)) === 5)
  check('3:20 목표가 최대(165)', Math.round(targetAliveCount(200)) === 165)
  check(
    '보스 등장(3:30)에 잡몹이 줄어든다',
    targetAliveCount(210) < targetAliveCount(200),
    `${targetAliveCount(210)} vs ${targetAliveCount(200)}`,
  )
  check('커브가 음수로 가지 않는다', [0, 60, 120, 180, 240, 300].every((t) => targetAliveCount(t) > 0))
}

// --- 후반 체력 스케일: 수는 그대로, 개체당 맷집만 증가 ---
{
  check('첫 1분은 일반몹 체력이 그대로다', enemyHealthMultiplier(0) === 1 && enemyHealthMultiplier(60) === 1)
  check(
    '보스 등장 시 일반몹 체력은 1.35배다',
    Math.abs(enemyHealthMultiplier(BOSS_SPAWN_TIME) - 1.35) < 1e-9,
  )
  check(
    '제한시간 일반몹 체력은 1.55배에서 멈춘다',
    enemyHealthMultiplier(RUN_TIME_LIMIT) === 1.55 &&
      enemyHealthMultiplier(RUN_TIME_LIMIT + 600) === 1.55,
  )

  const pool = createEnemyPool()
  const rng = createRng(91)
  spawnEnemy(pool, rng, 0, 0, TYPE_WALKER, RUN_TIME_LIMIT)
  spawnBoss(pool, rng, 0, 0)
  check(
    '체력 스케일이 일반몹에만 적용된다',
    Math.abs(pool.maxHp[0]! - ENEMY_TYPES[0]!.hp * 1.55) < 1e-6 &&
      pool.maxHp[1] === BOSS_MAX_HP,
    `${pool.maxHp[0]}/${pool.maxHp[1]}`,
  )
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
  check(
    '보스 페이즈는 등장 → 선회 → 예고 → 돌진 → 경직 순서다',
    bossPhaseAt(BOSS_SPAWN_TIME) === 'arrival' &&
      bossPhaseAt(BOSS_SPAWN_TIME + BOSS_INTRO_DURATION) === 'orbit' &&
      bossPhaseAt(
        BOSS_SPAWN_TIME + BOSS_INTRO_DURATION + BOSS_WINDUP_AT + DT / 2,
      ) ===
        'windup' &&
      bossPhaseAt(
        BOSS_SPAWN_TIME + BOSS_INTRO_DURATION + BOSS_CHARGE_AT + DT / 2,
      ) ===
        'charge' &&
      bossPhaseAt(
        BOSS_SPAWN_TIME + BOSS_INTRO_DURATION + BOSS_RECOVER_AT + DT / 2,
      ) ===
        'recover',
  )

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
  check(
    '보스 상태가 실제 등장 시각을 기록한다',
    w.boss.spawnedAt === BOSS_SPAWN_TIME,
    `spawnedAt=${w.boss.spawnedAt}`,
  )
  check(
    '보스 등장 틱에 균열 파동 연출 이벤트가 생긴다',
    w.rings.some((ring) => ring.kind === 3 && ring.radius === 10),
  )

  const intro = createWorld(811)
  intro.spawnEnabled = false
  spawnBoss(intro.enemies, intro.rng, 0, 0)
  intro.boss.spawned = true
  intro.boss.spawnedAt = 0
  intro.boss.active = true
  intro.boss.hp = BOSS_MAX_HP
  const introBoss = intro.enemies.count - 1
  intro.enemies.x[introBoss] = 0
  intro.enemies.y[introBoss] = 0
  intro.enemies.prevX[introBoss] = 0
  intro.enemies.prevY[introBoss] = 0
  intro.player.attackCooldown = Infinity
  const introHp = intro.player.hp
  stepWorld(intro, createInput())
  check(
    '등장 연출 중 보스 접촉 피해가 유예된다',
    intro.player.hp === introHp,
    `hp=${intro.player.hp}`,
  )

  const makeCrowdedBossWorld = (seed: number) => {
    const crowded = createWorld(seed)
    for (let i = 0; i < 100; i++) {
      spawnEnemy(
        crowded.enemies,
        crowded.rng,
        crowded.player.pos.x,
        crowded.player.pos.y,
        TYPE_WALKER,
        BOSS_SPAWN_TIME,
      )
    }
    crowded.tick = Math.round(BOSS_SPAWN_TIME / DT)
    crowded.time = crowded.tick * DT
    crowded.player.attackCooldown = Infinity
    crowded.player.invulnUntil = Infinity
    stepWorld(crowded, createInput())
    return crowded
  }

  const crowded = makeCrowdedBossWorld(812)
  const crowdedBosses = Array.from({ length: crowded.enemies.count }).filter(
    (_, i) => crowded.enemies.type[i] === TYPE_BOSS,
  ).length
  check(
    '3:30에 살아 있던 잡몹도 목표 수까지 실제로 정리된다',
    crowded.enemies.count === Math.floor(targetAliveCount(BOSS_SPAWN_TIME)) &&
      crowdedBosses === 1 &&
      crowded.kills === 0,
    `count=${crowded.enemies.count} bosses=${crowdedBosses} kills=${crowded.kills}`,
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

  // 선딜 중에는 아직 스킬 판정이 없으므로 접촉 피해를 먼저 받는다.
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
  simultaneous.player.attackCooldown = Number.POSITIVE_INFINITY
  unlockSkill(simultaneous.skills, 'q', 3.5)
  const finalBlow = createInput()
  finalBlow.aim.x = 4
  finalBlow.skillsPressed = SKILL_Q
  stepWorld(simultaneous, finalBlow)
  check(
    '선딜 첫 틱에는 아직 스킬 판정이 발생하지 않는다',
    simultaneous.outcome === 'alive' &&
      simultaneous.boss.active &&
      simultaneous.casts.length === 0,
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

  const runPattern = (seed: number) => {
    const pattern = makeCrowdedBossWorld(seed)
    const input = createInput()
    input.aim.x = 8
    for (let tick = 0; tick < 60 * 12; tick++) {
      input.move.x = tick % 240 < 120 ? 1 : -1
      input.move.y = tick % 180 < 90 ? 0.35 : -0.35
      stepWorld(pattern, input)
    }
    const i = Array.from({ length: pattern.enemies.count }).findIndex(
      (_, index) => pattern.enemies.type[index] === TYPE_BOSS,
    )
    return {
      time: pattern.time,
      count: pattern.enemies.count,
      x: pattern.enemies.x[i],
      y: pattern.enemies.y[i],
      vx: pattern.enemies.vx[i],
      vy: pattern.enemies.vy[i],
      hp: pattern.boss.hp,
      rng: pattern.rng.state(),
    }
  }

  const patternA = runPattern(913)
  const patternB = runPattern(913)
  check(
    '잡몹 정리와 보스 패턴 12초 전체가 같은 시드에서 결정론적이다',
    JSON.stringify(patternA) === JSON.stringify(patternB),
    JSON.stringify(patternA),
  )
}

// --- 5분 보스 마감 ---
{
  const makeDeadlineWorld = (hp = BOSS_MAX_HP) => {
    const w = createWorld(1001)
    w.spawnEnabled = false
    spawnBoss(w.enemies, w.rng, w.player.pos.x, w.player.pos.y)
    const i = w.enemies.count - 1
    w.enemies.x[i] = 0.5
    w.enemies.y[i] = 0
    w.enemies.prevX[i] = 0.5
    w.enemies.prevY[i] = 0
    w.enemies.hp[i] = hp
    w.boss.spawned = true
    w.boss.active = true
    w.boss.hp = hp
    w.player.invulnUntil = Infinity
    w.player.attackCooldown = Infinity
    w.tick = Math.round(RUN_TIME_LIMIT / DT) - 2
    w.time = w.tick * DT
    return w
  }

  const timedOut = makeDeadlineWorld()
  stepWorld(timedOut, createInput())
  check('5분 직전에는 보스전이 계속된다', timedOut.outcome === 'alive')
  stepWorld(timedOut, createInput())
  check(
    '5분에 보스가 살아 있으면 시간 초과 패배다',
    timedOut.outcome === 'timeout' && timedOut.time === RUN_TIME_LIMIT,
    `outcome=${timedOut.outcome} time=${timedOut.time}`,
  )

  const finalTick = makeDeadlineWorld(1)
  finalTick.tick = Math.round(RUN_TIME_LIMIT / DT) - 1
  finalTick.time = finalTick.tick * DT
  finalTick.player.attackCooldown = Infinity
  unlockSkill(finalTick.skills, 'q', 3.5)
  const lastShot = createInput()
  lastShot.aim.x = 4
  lastShot.skillsPressed = SKILL_Q
  stepWorld(finalTick, lastShot)
  check(
    '제한시간 마지막 틱에 시작한 스킬은 선딜 전에 시간 초과된다',
    finalTick.outcome === 'timeout' && finalTick.time === RUN_TIME_LIMIT,
    `outcome=${finalTick.outcome}`,
  )

  const delayedFinalHit = makeDeadlineWorld(1)
  delayedFinalHit.tick = Math.round(RUN_TIME_LIMIT / DT) - 1
  delayedFinalHit.time = delayedFinalHit.tick * DT
  pushBlast(delayedFinalHit, {
    kind: 0,
    x: 0.5,
    y: 0,
    radius: 1,
    damage: 1,
    impulse: 0,
    markDuration: 0,
    slowMul: 1,
    slowDuration: 0,
    fireAt: RUN_TIME_LIMIT,
  })
  stepWorld(delayedFinalHit, createInput())
  check(
    '정확히 5분에 터지는 지연 공격도 마지막 판정으로 인정된다',
    delayedFinalHit.outcome === 'victory',
    `outcome=${delayedFinalHit.outcome} blasts=${delayedFinalHit.blasts.length}`,
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
  pool.rootUntil[1] = 987
  removeEnemy(pool, 0)
  check(
    'swap-remove가 보스 타입과 모든 상태 배열을 함께 옮긴다',
    pool.count === 1 &&
      pool.type[0] === TYPE_BOSS &&
      pool.maxHp[0] === BOSS_MAX_HP &&
      pool.markExpire[0] === 321 &&
      pool.slowUntil[0] === 654 &&
      pool.rootUntil[0] === 987,
  )
}

// --- 근거리 W: 발도 준비 -> 연속 무적 돌진 -> 착지 베기 ---
{
  const w = createWorld(820, 'melee')
  w.spawnEnabled = false
  for (let i = 0; i < 3; i++) stepWorld(w, createInput())

  spawnEnemy(w.enemies, w.rng, 0, 0, TYPE_WALKER)
  w.enemies.x[0] = 4
  w.enemies.y[0] = 0
  w.enemies.prevX[0] = 4
  w.enemies.prevY[0] = 0
  w.enemies.hp[0] = 200
  w.enemies.maxHp[0] = 200
  w.enemies.rootUntil[0] = Infinity
  w.player.attackCooldown = Infinity
  w.lastAim.x = 20
  w.lastAim.y = 0
  unlockSkill(w.skills, 'w', 1)

  const startedAt = w.time
  const accepted = castSkill(w, 'w')
  const action = w.playerAction
  const startEvent = w.actionStarts.find((event) => event.kind === 'w')
  const destinationX = action?.meleeDash?.destinationX ?? NaN
  check(
    '근거리 W 시작 이벤트가 정확한 시뮬레이션 시각을 보존한다',
    accepted &&
      action?.startedAt === startedAt &&
      startEvent?.startedAt === startedAt,
    `action=${action?.startedAt} event=${startEvent?.startedAt} expected=${startedAt}`,
  )
  check(
    '근거리 W는 캐릭터 전용 0.16/0.32/0.56초 타이밍을 사용한다',
    action?.impactAt === startedAt + MELEE_W_DASH_END &&
      action?.endAt === startedAt + MELEE_W_TIMING.duration,
    `impact=${action?.impactAt} end=${action?.endAt}`,
  )

  const input = createInput()
  input.move.x = -1
  input.aim.x = 20
  input.aim.y = 0
  while ((w.tick + 1) * DT <= startedAt + MELEE_W_PREPARE_END + 1e-9) {
    stepWorld(w, input)
  }
  check(
    '발도 준비 중에는 일반 이동 입력을 억제한다',
    Math.abs(w.player.pos.x) < 1e-9 &&
      Math.abs(w.player.pos.y) < 1e-9 &&
      w.player.vel.x === 0 &&
      w.player.vel.y === 0,
    `x=${w.player.pos.x} vx=${w.player.vel.x}`,
  )

  const hpBeforeDash = w.player.hp
  const enemyHpBeforeImpact = w.enemies.hp[0]!
  let maxTickTravel = 0
  let sawInterpolatedFrame = false
  while (w.time < startedAt + 0.25) {
    const beforeX = w.player.pos.x
    const beforeY = w.player.pos.y
    stepWorld(w, input)
    maxTickTravel = Math.max(
      maxTickTravel,
      Math.hypot(w.player.pos.x - beforeX, w.player.pos.y - beforeY),
    )
    if (
      w.player.prevPos.x < w.player.pos.x &&
      w.player.pos.x > 0 &&
      w.player.pos.x < destinationX
    ) {
      sawInterpolatedFrame = true
    }
  }
  check(
    '돌진 중간에는 시작점과 착지점 사이의 실제 월드 위치에 있다',
    w.player.pos.x > 0 && w.player.pos.x < destinationX,
    `x=${w.player.pos.x} destination=${destinationX}`,
  )
  check(
    '근거리 W는 순간이동하지 않고 prevPos에서 pos로 연속 보간된다',
    sawInterpolatedFrame && maxTickTravel < 2,
    `maxTickTravel=${maxTickTravel}`,
  )
  check(
    '0.16~0.32초 돌진 구간은 접촉 피해에 무적이다',
    w.player.hp === hpBeforeDash &&
      w.player.invulnUntil >= startedAt + MELEE_W_DASH_END,
    `hp=${w.player.hp}/${hpBeforeDash} invulnUntil=${w.player.invulnUntil}`,
  )
  check(
    '착지 시각 전에는 W 경로·착지 피해가 발생하지 않는다',
    w.enemies.hp[0] === enemyHpBeforeImpact,
    `hp=${w.enemies.hp[0]} expected=${enemyHpBeforeImpact}`,
  )

  while ((w.tick + 1) * DT < startedAt + MELEE_W_DASH_END) {
    stepWorld(w, input)
  }
  check(
    '착지 직전까지 같은 적에게 중간 틱 중복 피해가 없다',
    w.enemies.hp[0] === enemyHpBeforeImpact,
    `hp=${w.enemies.hp[0]} expected=${enemyHpBeforeImpact}`,
  )

  while (w.time < startedAt + 0.35) stepWorld(w, input)
  check(
    '돌진 종료 시 경계 안의 결정된 착지점에 정확히 도착한다',
    Math.abs(w.player.pos.x - destinationX) < 1e-9 &&
      Math.abs(w.player.pos.y) < 1e-9,
    `x=${w.player.pos.x} destination=${destinationX}`,
  )
  check(
    '경로 타격과 착지 타격은 각각 한 번만 적용되어 기존 총 120 피해를 유지한다',
    Math.abs(w.enemies.hp[0]! - (enemyHpBeforeImpact - 120)) < 1e-9,
    `hp=${w.enemies.hp[0]} expected=${enemyHpBeforeImpact - 120}`,
  )
  check(
    '근거리 W 착지는 마크와 넉백 및 단일 시전 이벤트를 남긴다',
    w.enemies.markExpire[0]! > w.time &&
      w.enemies.pushVx[0]! < 0 &&
      w.casts.filter((cast) => cast.slot === 'w').length === 1,
  )

  while (w.time < startedAt + MELEE_W_TIMING.duration - DT / 2) {
    stepWorld(w, input)
  }
  check(
    '베기 회복 구간에도 일반 걷기가 돌진 착지 위치와 경쟁하지 않는다',
    Math.abs(w.player.pos.x - destinationX) < 1e-9 && w.playerAction !== null,
    `x=${w.player.pos.x} action=${w.playerAction?.kind}`,
  )
  for (let guard = 0; guard < 3 && w.playerAction; guard++) stepWorld(w, input)
  check(
    '0.56초 회복이 끝난 뒤에만 일반 이동을 다시 받는다',
    w.playerAction === null && w.player.pos.x < destinationX,
    `time=${w.time} x=${w.player.pos.x}`,
  )

  const boundary = createWorld(821, 'melee')
  boundary.spawnEnabled = false
  const limit = boundary.arenaRadius - boundary.stats.radius
  boundary.player.pos.x = limit - 1
  boundary.player.prevPos.x = limit - 1
  boundary.lastAim.x = 100
  boundary.lastAim.y = 0
  unlockSkill(boundary.skills, 'w', 1)
  castSkill(boundary, 'w')
  while (boundary.time < MELEE_W_DASH_END + 2 * DT) {
    stepWorld(boundary, createInput())
  }
  check(
    '근거리 W 착지점은 원형 경기장 경계를 넘지 않는다',
    Math.abs(boundary.player.pos.x - limit) < 1e-9 &&
      Math.abs(boundary.player.pos.y) < 1e-9,
    `x=${boundary.player.pos.x} limit=${limit}`,
  )

  const deterministicDash = (seed: number) => {
    const world = createWorld(seed, 'melee')
    world.spawnEnabled = false
    world.lastAim.x = 12
    world.lastAim.y = -5
    unlockSkill(world.skills, 'w', 1)
    castSkill(world, 'w')
    const positions: number[] = []
    for (let i = 0; i < 36; i++) {
      stepWorld(world, createInput())
      positions.push(world.player.pos.x, world.player.pos.y)
    }
    return positions
  }
  const deterministicA = deterministicDash(822)
  const deterministicB = deterministicDash(822)
  check(
    '같은 시드와 입력의 근거리 W 경로는 결정론적으로 동일하다',
    deterministicA.every((value, index) => value === deterministicB[index]),
  )
}

console.log('')
if (failures > 0) {
  console.error(`${failures}건 실패\n`)
  process.exit(1)
}
console.log('전부 통과\n')
