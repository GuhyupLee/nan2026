import { RUN_TIME_LIMIT } from './constants.ts'
import type { World } from './types.ts'

/**
 * 점수.
 *
 * 시뮬에 둔다 — 같은 시드로 같은 플레이를 하면 같은 점수가 나와야 하고,
 * 헤드리스 밸런싱이 "이 빌드가 몇 점을 내는가"를 측정할 수 있어야 한다.
 * UI에 두면 둘 다 불가능해진다.
 *
 * 설계 의도:
 * - 처치 수가 기본 축이다. 5분 내내 하는 일이 그것이므로.
 * - 승리 보너스를 크게 준다. 잡몹만 쓸어담고 보스를 못 잡으면 안 된다.
 * - 남은 시간에 비례해 보너스를 준다 — 빨리 잡을수록 높다. 이게 없으면
 *   "안전하게 시간 끌기"가 최적 전략이 되어 5분이 지루해진다.
 */
export interface ScoreBreakdown {
  /** 처치 점수. */
  kills: number
  /** 레벨 점수. */
  level: number
  /** 보스 처치 보너스. 패배면 0. */
  victory: number
  /** 남은 시간 보너스. 패배면 0. */
  speed: number
  total: number
}

const POINTS_PER_KILL = 10
const POINTS_PER_LEVEL = 50
const VICTORY_BONUS = 2000
const POINTS_PER_SECOND_LEFT = 50

export function computeScore(world: World): ScoreBreakdown {
  const kills = world.kills * POINTS_PER_KILL
  const level = world.progression.level * POINTS_PER_LEVEL

  const won = world.outcome === 'victory'
  const secondsLeft = won ? Math.max(0, RUN_TIME_LIMIT - world.time) : 0
  const victory = won ? VICTORY_BONUS : 0
  const speed = Math.round(secondsLeft * POINTS_PER_SECOND_LEFT)

  return {
    kills,
    level,
    victory,
    speed,
    total: kills + level + victory + speed,
  }
}
