import type { RingEvent } from './abilities.ts'
import type { DeathEvent, EnemyPool } from './enemies.ts'
import type { Progression } from './progression.ts'
import type { Rng } from './rng.ts'
import type { SkillBook } from './skills.ts'
import type { SpatialHash } from './spatial.ts'
import type { Vec2 } from './vec.ts'

/**
 * 한 틱 분량의 플레이어 입력.
 *
 * 브라우저·DOM·three.js에 대한 의존이 전혀 없다.
 * 헤드리스 밸런싱에서는 봇이 이 구조체를 직접 만들어 넣는다.
 */
export interface Input {
  /** 이동 방향. 정규화 여부는 시뮬이 책임진다. */
  move: Vec2
  /** 조준 지점(월드 좌표). 스킬샷 방향의 기준. */
  aim: Vec2
  /** 이번 틱에 "새로" 눌린 스킬 비트마스크. 누르고 있는 상태가 아니라 엣지. */
  skillsPressed: number
}

export function createInput(): Input {
  return {
    move: { x: 0, y: 0 },
    aim: { x: 1, y: 0 },
    skillsPressed: 0,
  }
}

/**
 * 플레이어 클래스. 시작 화면에서 고른다.
 *
 * QWER 세트가 통째로 다르다. 이게 리플레이의 축이다 —
 * 5분 게임에서 심사자가 두 번째 판을 돌릴 이유가 여기서 나온다.
 */
export type PlayerClass = 'ranged' | 'melee'

export interface Player {
  pos: Vec2
  /** 직전 틱 위치. 렌더러의 프레임 보간에 쓴다. */
  prevPos: Vec2
  vel: Vec2
  /** 바라보는 각도(라디안). XZ 평면에서 +X가 0. */
  facing: number
  prevFacing: number
  radius: number
  speed: number
  hp: number
  maxHp: number
  /** 자동 공격까지 남은 시간(초). */
  attackCooldown: number
  /** 이동속도 증가가 끝나는 시각(월드 시간). 회복(D)이 설정한다. */
  speedBoostUntil: number
}

/** 자동 공격 한 발의 궤적. 렌더러가 예광선을 그리고 비운다. */
export interface TracerEvent {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface World {
  seed: number
  /** 경과 틱 수. 시간의 유일한 원천. */
  tick: number
  /** 경과 시간(초). 항상 tick * DT와 같다. */
  time: number
  rng: Rng
  arenaRadius: number
  playerClass: PlayerClass
  player: Player
  progression: Progression
  skills: SkillBook

  /** 직전 틱의 조준 지점(월드 좌표). 자동 공격과 조준 표시가 읽는다. */
  lastAim: Vec2

  enemies: EnemyPool
  enemyHash: SpatialHash
  /**
   * 스폰을 돌릴 것인가.
   * 단위 테스트에서 이동·시간 같은 성질만 격리해 보려면 꺼야 한다.
   * 밸런싱 실험에서 특정 구간만 재현할 때도 쓴다.
   */
  spawnEnabled: boolean

  /**
   * 렌더 전용 출력. 시뮬은 push만 하고 렌더러가 소비 후 비운다.
   * 헤드리스 밸런싱에서는 아무도 비우지 않으므로 상한을 두고 버린다.
   */
  deaths: DeathEvent[]
  tracers: TracerEvent[]
  rings: RingEvent[]

  /**
   * 레벨업 선택 대기 중인가.
   *
   * true면 게임플레이가 멈춘다. 판정은 progression.pendingLevelUps 가 하지만,
   * 호출부가 매번 계산하지 않도록 여기에 캐시한다.
   */
  awaitingChoice: boolean

  /** 판이 끝났는가. 'alive'가 아니면 시뮬이 멈춘다. */
  outcome: 'alive' | 'dead' | 'victory'
}
