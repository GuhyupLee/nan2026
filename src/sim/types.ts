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

export type PlayerActionKind =
  | 'attack'
  | 'empowered'
  | 'ult'
  | 'q'
  | 'w'
  | 'e'
  | 'r'

export type PlayerActionSource = 'attack' | 'skill'

export interface PendingPlayerAction {
  source: PlayerActionSource
  kind: PlayerActionKind
  /** 평타면 null, QWER면 해당 슬롯. */
  slot: SkillId | null
  /** 시작 시 고정한 시전 방향. */
  angle: number
  /** 지면 지정 스킬을 위해 시작 시 고정한 조준점. */
  targetX: number
  targetY: number
  /** 입력을 받아들인 정확한 시뮬레이션 시각. */
  startedAt: number
  /** 실제 판정이 발생하는 월드 시각. */
  impactAt: number
  /** 후딜까지 끝나 다음 행동을 받을 수 있는 월드 시각. */
  endAt: number
  resolved: boolean
  /** 근거리 W의 결정론적 월드 이동. 애니메이션은 인플레이스 상태를 유지한다. */
  meleeDash?: {
    originX: number
    originY: number
    destinationX: number
    destinationY: number
  }
}

export interface ActionStartEvent {
  kind: PlayerActionKind
  angle: number
  /** 액션이 시작된 정확한 시뮬레이션 시각. */
  startedAt: number
}

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
   * 처치 회복의 남은 예산(HP 단위). 토큰 버킷이다.
   *
   * 처치당 회복에 상한이 없으면 뱀서라이크에서 회복이 피해를 압도한다.
   * 계측: 5분에 3,045킬 × 0.6 = 최대 1,800 회복 대 받은 피해 54.
   * 체력이 구조적으로 줄어들 수가 없어서 위험시간이 0%였다.
   *
   * 매 틱 `KILL_HEAL_RATE`만큼 차오르고 `KILL_HEAL_CAP`에서 멈춘다.
   * 잡몹을 한 번에 쓸어도 그 순간 회복은 예산만큼만 나가고, 대신 조용한
   * 구간에 예산이 차서 "몰아친 뒤 숨 고르기"라는 리듬이 생긴다.
   */
  killHealBudget: number
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

/**
 * 스킬이 발동한 순간.
 *
 * 시전 모션뿐 아니라 이펙트도 이 이벤트를 직접 소비한다. 순간이동 스킬은
 * 렌더 시점의 player.pos만 보면 출발점을 복구할 수 없으므로, 선분 양 끝을
 * 시전 순간에 함께 저장한다. 중심형 스킬은 시작점과 도착점이 같다.
 */
export interface CastEvent {
  slot: SkillId
  /** 시전 방향(라디안). 모션이 이 방향을 향한다. */
  angle: number
  /** 시전이 시작된 월드 좌표. */
  originX: number
  originY: number
  /** 투사체 도착점·돌진 착지점. 중심형 스킬은 origin과 같다. */
  targetX: number
  targetY: number
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
  /** 실제 스폰 시각. 등장 연출과 패턴 주기의 공통 기준점. */
  spawnedAt: number
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
  /**
   * 보상 카드 추첨 전용 난수. 시뮬 rng와 반드시 분리한다.
   *
   * 같은 스트림을 쓰면 "카드를 몇 장 뽑았는가"가 이후 적 스폰 종류·각도·거리를
   * 바꾼다. 그러면 헤드리스 밸런싱이 UI 선택을 그대로 재생하지 않는 한
   * 판을 재현할 수 없고, 결정론 계약이 UI에 인질로 잡힌다.
   */
  choiceRng: Rng
  arenaRadius: number
  playerClass: PlayerClass
  /** 강화 카드가 건드리는 런타임 스탯. 게임 코드는 상수가 아니라 이걸 읽는다. */
  stats: Stats
  player: Player
  /** 현재 선딜·후딜 중인 QWER. 평타는 조작감을 위해 즉시 판정한다. */
  playerAction: PendingPlayerAction | null
  /** 이번 판 누적 처치 수. 점수의 기본 축. */
  kills: number
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
  /** 렌더러가 판정보다 먼저 전투 애니메이션을 시작하는 데 쓰는 이벤트. */
  actionStarts: ActionStartEvent[]

  /**
   * 레벨업 선택 대기 중인가.
   *
   * true면 게임플레이가 멈춘다. 판정은 progression.pendingLevelUps 가 하지만,
   * 호출부가 매번 계산하지 않도록 여기에 캐시한다.
   */
  awaitingChoice: boolean

  /** 판이 끝났는가. 'alive'가 아니면 시뮬이 멈춘다. */
  outcome: 'alive' | 'dead' | 'timeout' | 'victory'
}
