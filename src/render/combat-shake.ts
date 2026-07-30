import {
  TYPE_BOSS,
  TYPE_BRUTE,
  TYPE_ELITE,
  type DeathEvent,
} from '../sim/enemies.ts'
import type {
  DamageFeedbackEvent,
  PlayerClass,
} from '../sim/types.ts'

export type DeathCameraBeat = 'boss' | 'elite' | 'brute' | null

/**
 * Converts any number of simultaneous deaths into at most one camera beat.
 * Lumen keeps local particles, damage numbers and bloom for ordinary AoE
 * kills, while boss and elite deaths remain globally readable.
 */
export function selectDeathCameraBeat(
  deaths: readonly DeathEvent[],
  playerClass: PlayerClass,
  bombPickupTriggered: boolean,
): DeathCameraBeat {
  let beat: DeathCameraBeat = null
  for (const death of deaths) {
    if (death.type === TYPE_BOSS) return 'boss'
    if (death.type === TYPE_ELITE) {
      beat = 'elite'
      continue
    }
    if (
      beat === null &&
      playerClass === 'melee' &&
      !bombPickupTriggered &&
      death.type === TYPE_BRUTE
    ) {
      beat = 'brute'
    }
  }
  return beat
}

/**
 * Ranged mass kills should not shake the camera once per target. Capped hits
 * and meaningful boss/elite impacts remain exceptions; melee retains its
 * close-contact lethal punch.
 */
export function shouldShakeDamageImpact(
  playerClass: PlayerClass,
  strongest: DamageFeedbackEvent,
  hasLethal: boolean,
): boolean {
  if (strongest.capped) return true

  const importantTarget =
    strongest.enemyType === TYPE_BOSS ||
    strongest.enemyType === TYPE_ELITE
  if (importantTarget && strongest.amount >= 32) return true

  return (
    playerClass === 'melee' &&
    (hasLethal || strongest.amount >= 48)
  )
}
