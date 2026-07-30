import { RUN_TIME_LIMIT } from './constants.ts'
import { BOSS_MAX_HP, BOSS_SPAWN_TIME } from './enemies.ts'
import type { RunDifficulty } from './types.ts'

export interface DifficultyRules {
  id: RunDifficulty
  label: string
  bossSpawnTime: number
  runTimeLimit: number
  bossMaxHp: number
  bossPhaseCount: 2 | 3
  bossPhaseTwoRatio: number
  bossPhaseThreeRatio: number | null
  enemySpeedMultiplier: number
  enemyHealthMultiplier: number
  extendedHealthGrowthMultiplier: number
  contactDamageMultiplier: number
  bossHazardDamageMultiplier: number
  scoreMultiplier: number
  extendedProgression: boolean
  repeatEliteStart: number
  repeatEliteInterval: number
  bossArenaTarget: number
}

const RULES: Record<RunDifficulty, DifficultyRules> = {
  normal: {
    id: 'normal',
    label: '보통',
    bossSpawnTime: BOSS_SPAWN_TIME,
    runTimeLimit: RUN_TIME_LIMIT,
    bossMaxHp: BOSS_MAX_HP,
    bossPhaseCount: 2,
    bossPhaseTwoRatio: 0.5,
    bossPhaseThreeRatio: null,
    enemySpeedMultiplier: 1,
    enemyHealthMultiplier: 1,
    extendedHealthGrowthMultiplier: 1,
    contactDamageMultiplier: 1,
    bossHazardDamageMultiplier: 1,
    scoreMultiplier: 1,
    extendedProgression: false,
    repeatEliteStart: Number.POSITIVE_INFINITY,
    repeatEliteInterval: 40,
    bossArenaTarget: Number.POSITIVE_INFINITY,
  },
  hard: {
    id: 'hard',
    label: '월식',
    bossSpawnTime: BOSS_SPAWN_TIME,
    runTimeLimit: RUN_TIME_LIMIT,
    bossMaxHp: BOSS_MAX_HP,
    bossPhaseCount: 2,
    bossPhaseTwoRatio: 0.5,
    bossPhaseThreeRatio: null,
    enemySpeedMultiplier: 1.1,
    enemyHealthMultiplier: 1,
    extendedHealthGrowthMultiplier: 1,
    contactDamageMultiplier: 1.25,
    bossHazardDamageMultiplier: 1,
    scoreMultiplier: 1.5,
    extendedProgression: false,
    repeatEliteStart: Number.POSITIVE_INFINITY,
    repeatEliteInterval: 40,
    bossArenaTarget: Number.POSITIVE_INFINITY,
  },
  fullmoon: {
    id: 'fullmoon',
    label: '만월',
    // 10분을 버틴 뒤 최종 보스가 열리고, 3페이즈를 읽을 2분을 준다.
    bossSpawnTime: 600,
    runTimeLimit: 720,
    // 기본 보스와 같은 33% 상향을 적용해 난이도 사이 상대 배율을 유지한다.
    bossMaxHp: 19_152,
    bossPhaseCount: 3,
    bossPhaseTwoRatio: 2 / 3,
    bossPhaseThreeRatio: 1 / 3,
    // 만월의 난도는 체력·피해·추가 패턴에서 만든다. 이동속도 증가는
    // 회피 여지를 없애므로 보통과 같은 속도를 유지한다.
    enemySpeedMultiplier: 1,
    enemyHealthMultiplier: 1.15,
    extendedHealthGrowthMultiplier: 0.55,
    contactDamageMultiplier: 1.5,
    bossHazardDamageMultiplier: 1.3,
    scoreMultiplier: 2.25,
    extendedProgression: true,
    repeatEliteStart: 255,
    repeatEliteInterval: 60,
    // 장기 밀도는 보스 직전까지 계속 오르지만, 등장 순간에는 패턴을 읽을 방을 만든다.
    bossArenaTarget: 60,
  },
}

export function normalizeRunDifficulty(value: unknown): RunDifficulty {
  return value === 'hard' || value === 'fullmoon' ? value : 'normal'
}

export function difficultyRules(difficulty: RunDifficulty): DifficultyRules {
  return RULES[difficulty]
}

export function runDifficultyLabel(difficulty: RunDifficulty): string {
  return RULES[difficulty].label
}

export function usesExtendedProgression(difficulty: RunDifficulty): boolean {
  return RULES[difficulty].extendedProgression
}
