import { TYPE_BOSS, TYPE_ELITE } from './enemies.ts'
import type { DamageFeedbackEvent } from './types.ts'

export type HitFeedbackTier = 'light' | 'solid' | 'heavy' | 'finisher'

export interface HitFeedbackSummary {
  strongest: DamageFeedbackEvent
  count: number
  intensity: number
  tier: HitFeedbackTier
  hasLethal: boolean
  hasCapped: boolean
}

export function isImportantDamageFeedback(
  event: DamageFeedbackEvent,
): boolean {
  return event.enemyType === TYPE_BOSS || event.enemyType === TYPE_ELITE
}

/**
 * Keeps scarce renderer feedback slots deterministic and gameplay-relevant.
 * Enemy indices are deliberately absent because the enemy pool swap-removes.
 */
export function damageFeedbackPriority(
  event: DamageFeedbackEvent,
): number {
  const hpFraction = clamp01(event.amount / Math.max(1, event.maxHp))
  const targetWeight =
    event.enemyType === TYPE_BOSS
      ? 500
      : event.enemyType === TYPE_ELITE
        ? 400
        : 0
  return (
    targetWeight +
    (event.lethal ? 250 : 0) +
    (event.capped ? 80 : 0) +
    hpFraction * 100
  )
}

/**
 * Collapses all confirmed contacts collected since the previous render into
 * one peak. Camera and audio use the peak while local sparks can stay bounded.
 */
export function summarizeDamageFeedback(
  events: readonly DamageFeedbackEvent[],
): HitFeedbackSummary | null {
  if (events.length === 0) return null

  let strongest = events[0]!
  let strongestPriority = damageFeedbackPriority(strongest)
  let peakIntensity = feedbackIntensity(strongest)
  let hasLethal = strongest.lethal
  let hasCapped = strongest.capped

  for (let i = 1; i < events.length; i++) {
    const event = events[i]!
    const priority = damageFeedbackPriority(event)
    if (priority > strongestPriority) {
      strongest = event
      strongestPriority = priority
    }
    peakIntensity = Math.max(peakIntensity, feedbackIntensity(event))
    hasLethal ||= event.lethal
    hasCapped ||= event.capped
  }

  const crowdLift = Math.min(0.22, Math.log2(events.length + 1) * 0.065)
  const intensity = clamp01(peakIntensity + crowdLift)
  const importantFinisher =
    strongest.lethal && isImportantDamageFeedback(strongest)
  const tier: HitFeedbackTier =
    importantFinisher || intensity >= 0.78
      ? 'finisher'
      : intensity >= 0.45
        ? 'heavy'
        : intensity >= 0.2
          ? 'solid'
          : 'light'

  return {
    strongest,
    count: events.length,
    intensity,
    tier,
    hasLethal,
    hasCapped,
  }
}

function feedbackIntensity(event: DamageFeedbackEvent): number {
  const hpFraction = clamp01(event.amount / Math.max(1, event.maxHp))
  const rawAmount = clamp01(event.amount / 300)
  const important = isImportantDamageFeedback(event)
  const weighted =
    hpFraction * 0.52 +
    rawAmount * 0.18 +
    (event.lethal ? (important ? 0.2 : 0.12) : 0) +
    (event.capped ? 0.15 : 0)
  return important ? Math.max(0.24, weighted) : weighted
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
}
