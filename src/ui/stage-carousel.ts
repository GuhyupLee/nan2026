import type { RunDifficulty } from '../sim/types.ts'

export const MAIN_MENU_STAGE_ORDER = [
  'normal',
  'hard',
  'fullmoon',
] as const satisfies readonly RunDifficulty[]

export const STAGE_CAROUSEL_DRAG_THRESHOLD = 8

export interface MainMenuStageUnlocks {
  hard: boolean
  fullmoon: boolean
}

export function isMainMenuStageUnlocked(
  mode: RunDifficulty,
  unlocks: MainMenuStageUnlocks,
): boolean {
  return (
    mode === 'normal' ||
    (mode === 'hard' ? unlocks.hard : unlocks.fullmoon)
  )
}

export function closestStageIndex(
  cardCenters: readonly number[],
  viewportCenter: number,
): number {
  if (cardCenters.length === 0) return 0

  let closest = 0
  let closestDistance = Math.abs(cardCenters[0]! - viewportCenter)
  for (let index = 1; index < cardCenters.length; index += 1) {
    const distance = Math.abs(cardCenters[index]! - viewportCenter)
    if (distance >= closestDistance) continue
    closest = index
    closestDistance = distance
  }
  return closest
}

export function stageIndexForNavigation(
  code: string,
  currentIndex: number,
  stageCount: number,
): number | null {
  if (stageCount <= 0) return null
  const current = Math.max(0, Math.min(stageCount - 1, currentIndex))

  if (code === 'ArrowRight' || code === 'ArrowDown') {
    return Math.min(stageCount - 1, current + 1)
  }
  if (code === 'ArrowLeft' || code === 'ArrowUp') {
    return Math.max(0, current - 1)
  }
  if (code === 'Home') return 0
  if (code === 'End') return stageCount - 1
  return null
}

export function stageIndexForSwipe(
  deltaX: number,
  viewportWidth: number,
  currentIndex: number,
  stageCount: number,
): number | null {
  if (stageCount <= 0) return null
  const triggerDistance = Math.min(
    64,
    Math.max(36, Math.max(0, viewportWidth) * 0.12),
  )
  if (Math.abs(deltaX) < triggerDistance) return null

  const current = Math.max(0, Math.min(stageCount - 1, currentIndex))
  return deltaX < 0
    ? Math.min(stageCount - 1, current + 1)
    : Math.max(0, current - 1)
}
