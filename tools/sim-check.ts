/**
 * 시뮬레이션 스모크 체크.
 *
 * 이 파일이 Node에서 도는 것 자체가 아키텍처 검증이다:
 * src/sim 이 three.js·DOM에 조금이라도 의존하면 여기서 즉시 터진다.
 * D9의 헤드리스 밸런싱은 전부 이 성질 위에 세워진다.
 *
 *   npx tsx tools/sim-check.ts
 */
import { ARENA_RADIUS, DT } from '../src/sim/constants.ts'
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
  consumeCooldown,
  createSkillBook,
  isReady,
  lockedChoosableSkills,
  tickSkills,
  unlockSkill,
  unlockedCount,
} from '../src/sim/skills.ts'
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

/** 월드를 ticks만큼 진행시킨다. */
function run(seed: number, ticks: number, moveX: number, moveY: number) {
  const world = createWorld(seed)
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
  const limit = ARENA_RADIUS - w.player.radius
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
}

// --- 스킬 런타임 ---
{
  const book = createSkillBook()
  check('처음에는 전부 잠겨 있다', unlockedCount(book) === 0)
  check('선택 가능한 스킬은 3개', lockedChoosableSkills(book).length === 3)
  check('궁극기는 선택 대상이 아니다', !lockedChoosableSkills(book).includes('ult'))

  unlockSkill(book, 'dash', 3)
  check('해금 즉시 사용 가능', isReady(book, 'dash'))
  check('해금하면 후보에서 빠진다', !lockedChoosableSkills(book).includes('dash'))
  check('해금 안 된 스킬은 못 쓴다', !isReady(book, 'area'))

  check('사용하면 쿨다운이 걸린다', consumeCooldown(book, 'dash') && !isReady(book, 'dash'))
  check('쿨다운 중에는 재사용 실패', !consumeCooldown(book, 'dash'))
  tickSkills(book, 1.5)
  check('쿨다운이 절반 남았을 때는 아직 못 쓴다', !isReady(book, 'dash'))
  tickSkills(book, 1.6)
  check('쿨다운이 끝나면 다시 쓸 수 있다', isReady(book, 'dash'))
  check('쿨다운은 음수로 내려가지 않는다', book.dash.cooldown === 0)
}

console.log('')
if (failures > 0) {
  console.error(`${failures}건 실패\n`)
  process.exit(1)
}
console.log('전부 통과\n')
