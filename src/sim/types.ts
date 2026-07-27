import type { RingEvent } from './abilities.ts'
import type { DeathEvent, EnemyPool } from './enemies.ts'
import type { Progression } from './progression.ts'
import type { Rng } from './rng.ts'
import type { SkillBook } from './skills.ts'
import type { SkillId } from './skills.ts'
import type { SpatialHash } from './spatial.ts'
import type { Stats } from './stats.ts'
import type { Vec2 } from './vec.ts'
import type { PendingBlast, Zone } from './zones.ts'

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
  /**
   * 현재 체력.
   * 최대치·이동속도·반지름은 강화로 바뀌므로 world.stats가 들고 있다.
   * 여기에는 "지금 값"만 남긴다.
   */
  hp: number
  /** 자동 공격까지 남은 시간(초). */
  attackCooldown: number
  /** 이동속도 증가가 끝나는 시각(월드 시간). 회복(D)이 설정한다. */
  speedBoostUntil: number
  /** 무적이 끝나는 시각. 대시·궁극기가 설정한다. */
  invulnUntil: number
  /**
   * 근접 패시브 「참흔」 게이지 0~100.
   * 원거리 클래스에서는 쓰이지 않는다.
   */
  gauge: number
  /** 다음 평타가 「월참」(광역)으로 승격되는가. */
  empowered: boolean
}

/** 지속되는 궁극기 상태. 지금은 근접 「만월난무」만 쓴다. */
export interface UltState {
  active: boolean
  /** 다음 타격 시각. */
  nextHitAt: number
  /** 남은 타격 수. */
  hitsLeft: number
}

/** 자동 공격 한 발의 궤적. 렌더러가 예광선을 그리고 비운다. */
export interface TracerEvent {
  x0: number
  y0: number
  x1: number
  y1: number
  /** 굵기 배수. 궁극기 빔처럼 굵은 것을 같은 큐로 그린다. */
  width: number
  /** 0=평타(청백) 1=스킬(시안) 2=궁극기(금백) 3=참격(크림슨) */
  kind: number
}

/** 스킬이 발동한 순간. 캐릭터 시전 모션이 이걸 보고 재생된다. */
export interface CastEvent {
  slot: SkillId
  /** 시전 방향(라디안). 모션이 이 방향을 향한다. */
  angle: number
}

/** 평타와 지속 궁극기 타격이 발생한 순간. 캐릭터 공격 모션이 소비한다. */
export interface AttackEvent {
  /** 공격 방향(라디안). XZ 평면에서 +X가 0. */
  angle: number
  kind: 'ranged' | 'melee' | 'empowered' | 'ult'
}

/**
 * UI가 보스 체력바를 그릴 때 읽는 최소 상태.
 *
 * 보스 슬롯 인덱스는 의도적으로 저장하지 않는다. 적 풀은 swap-remove를 쓰므로
 * 인덱스는 사망할 때마다 바뀔 수 있다. 보스는 고유 타입으로 찾고 이 스냅샷만
 * 피해 관문에서 동기화한다.
 */
export interface BossState {
  /** 이번 판에 이미 한 번 등장했는가. 재스폰 방지용. */
  spawned: boolean
  /** 지금 전장에 살아 있는가. 보스바 표시 조건. */
  active: boolean
  /** 현재 체력. 비활성 상태에서는 0이다. */
  hp: number
  /** 보스 최대 체력. 등장 전에도 UI가 레이아웃을 준비할 수 있게 고정값을 둔다. */
  maxHp: number
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
  /** 강화 카드가 건드리는 런타임 스탯. 게임 코드는 상수가 아니라 이걸 읽는다. */
  stats: Stats
  player: Player
  progression: Progression
  skills: SkillBook
  /** 이미 획득한 강화 id. 같은 카드가 다시 뜨지 않게 한다. */
  upgradesTaken: Set<string>

  /** 직전 틱의 조준 지점(월드 좌표). 자동 공격과 조준 표시가 읽는다. */
  lastAim: Vec2

  enemies: EnemyPool
  enemyHash: SpatialHash
  boss: BossState
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
  /** 지속 장판. */
  zones: Zone[]
  /** 지연 폭발 대기열. */
  blasts: PendingBlast[]
  ult: UltState

  deaths: DeathEvent[]
  tracers: TracerEvent[]
  rings: RingEvent[]
  /** 스킬 시전 이벤트. 렌더러가 모션·이펙트에 쓰고 비운다. */
  casts: CastEvent[]
  /** 평타·지속 궁극기 타격 이벤트. 렌더러가 공격 모션에 쓰고 비운다. */
  attacks: AttackEvent[]

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
