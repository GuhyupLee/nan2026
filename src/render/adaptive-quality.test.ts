import {
  ADAPTIVE_QUALITY_DEFAULTS,
  AdaptiveQualityPolicy,
} from './adaptive-quality.ts'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function feed(
  policy: AdaptiveQualityPolicy,
  frameSeconds: number,
  durationSeconds: number,
): number {
  let transitions = 0
  const frames = Math.ceil(durationSeconds / frameSeconds)
  for (let frame = 0; frame < frames; frame += 1) {
    if (policy.observe(frameSeconds)) transitions += 1
  }
  return transitions
}

// A healthy 60 FPS session never leaves the high tier.
{
  const policy = new AdaptiveQualityPolicy()
  assert(feed(policy, 1 / 60, 20) === 0, '60 FPS에서 품질이 내려감')
  assert(!policy.downgraded, '정상 프레임 세션이 low tier로 고정됨')
}

// A desktop just above the slow threshold remains high quality indefinitely.
{
  const policy = new AdaptiveQualityPolicy()
  assert(feed(policy, 1 / 45, 30) === 0, '45 FPS에서 품질이 내려감')
  assert(!policy.downgraded, '저속 임계값 위에서 low tier로 고정됨')
}

// A consistently slow desktop must cross warmup + sustained-slow windows first.
{
  const policy = new AdaptiveQualityPolicy()
  assert(feed(policy, 1 / 30, 6.5) === 0, '지속 시간 전에 품질이 내려감')
  assert(feed(policy, 1 / 30, 1) === 1, '30 FPS 지속 부하를 감지하지 못함')
  assert(policy.downgraded, '저품질 전환 상태가 보존되지 않음')
  policy.resetObservation()
  assert(policy.downgraded, '측정 리셋이 one-way 품질 전환을 되돌림')
  assert(feed(policy, 1 / 60, 10) === 0, '저품질 전환이 두 번 발생함')
}

// Recovery above the hysteresis band clears partial slow evidence.
{
  const policy = new AdaptiveQualityPolicy()
  assert(feed(policy, 1 / 30, 5) === 0, '부분 부하만으로 품질이 내려감')
  assert(feed(policy, 1 / 60, 3) === 0, '회복 중 품질이 내려감')
  assert(feed(policy, 1 / 30, 3.5) === 0, '회복 전 부하 시간이 남아 있음')
  assert(feed(policy, 1 / 30, 1.5) === 1, '회복 후 새 지속 부하를 감지하지 못함')
}

// A background-tab gap resets EMA, warmup, and accumulated slow time.
{
  const policy = new AdaptiveQualityPolicy()
  assert(feed(policy, 1 / 30, 6.5) === 0, '스톨 전 품질이 너무 일찍 내려감')
  assert(
    policy.observe(ADAPTIVE_QUALITY_DEFAULTS.stallFrameSeconds) === false,
    '탭 스톨 자체가 품질 전환을 일으킴',
  )
  assert(
    Math.abs(
      policy.emaFrameSeconds -
        ADAPTIVE_QUALITY_DEFAULTS.initialFrameSeconds,
    ) < 1e-9,
    '탭 스톨이 EMA를 초기화하지 않음',
  )
  assert(feed(policy, 1 / 30, 6.5) === 0, '탭 복귀 뒤 이전 부하 시간이 남아 있음')
  assert(feed(policy, 1 / 30, 1) === 1, '탭 복귀 뒤 새 지속 부하를 감지하지 못함')
}

console.log('adaptive-quality: 5 suites passed')
