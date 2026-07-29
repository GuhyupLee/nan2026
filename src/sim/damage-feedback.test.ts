import {
  damageFeedbackPriority,
  summarizeDamageFeedback,
} from './damage-feedback.ts'
import { TYPE_BOSS, TYPE_ELITE, TYPE_WALKER } from './enemies.ts'
import type { DamageFeedbackEvent } from './types.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function hit(
  patch: Partial<DamageFeedbackEvent> = {},
): DamageFeedbackEvent {
  return {
    x: 0,
    y: 0,
    amount: 1,
    hpAfter: 99,
    maxHp: 100,
    enemyType: TYPE_WALKER,
    lethal: false,
    capped: false,
    ...patch,
  }
}

assert(
  summarizeDamageFeedback([]) === null,
  '빈 적중 묶음은 피드백을 만들면 안 됨',
)

{
  const commonKill = hit({ amount: 14, hpAfter: 0, maxHp: 14, lethal: true })
  const bossHit = hit({
    amount: 1,
    hpAfter: 2599,
    maxHp: 2600,
    enemyType: TYPE_BOSS,
  })
  const summary = summarizeDamageFeedback([commonKill, bossHit])
  assert(summary?.strongest === bossHit, '보스 적중이 일반 처치보다 먼저 보존되지 않음')
}

{
  const summary = summarizeDamageFeedback([
    hit({ amount: 26, hpAfter: 0, maxHp: 26, lethal: true }),
  ])
  assert(summary?.tier === 'heavy', '일반 적 처치가 강한 적중으로 분류되지 않음')
}

{
  const summary = summarizeDamageFeedback([
    hit({
      amount: 620,
      hpAfter: 0,
      maxHp: 620,
      enemyType: TYPE_ELITE,
      lethal: true,
    }),
  ])
  assert(summary?.tier === 'finisher', '정예 처치가 피니셔로 분류되지 않음')
}

{
  const chips = Array.from({ length: 10 }, (_, index) =>
    hit({ x: index, amount: 1, maxHp: 100 }),
  )
  const summary = summarizeDamageFeedback(chips)
  assert(summary?.tier === 'solid', '동시 다중 적중의 군중 강도가 반영되지 않음')
  assert(summary.count === 10, '적중 묶음 개수가 보존되지 않음')
}

{
  const chip = hit()
  const lethal = hit({ amount: 100, hpAfter: 0, lethal: true })
  assert(
    damageFeedbackPriority(lethal) > damageFeedbackPriority(chip),
    '일반 처치가 잡피해보다 높은 큐 우선순위를 얻지 못함',
  )
}

console.log('damage-feedback: 6 suites passed')
