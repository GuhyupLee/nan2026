import type { Rng } from './rng.ts'
import type { Vec2 } from './vec.ts'

/**
 * 스킬 슬롯 비트마스크.
 *
 * 키 이름이 아니라 "역할"로 정의한다. WASD 이동의 W와 MOBA의 W가 충돌하므로
 * 실제 바인딩은 Q / Space / E / R 이고, 그 매핑은 src/input.ts 가 전담한다.
 * 시뮬은 어떤 키가 눌렸는지 알 필요도, 알아서도 안 된다.
 */
export const SKILL_PRIMARY = 1 << 0 // Q  — 주력기
export const SKILL_DASH = 1 << 1 // Space — 대시 (0:50 획득)
export const SKILL_AREA = 1 << 2 // E  — 광역기 (1:40 획득)
export const SKILL_ULT = 1 << 3 // R  — 궁극기 (3:20 획득)

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
}

export interface World {
  seed: number
  /** 경과 틱 수. 시간의 유일한 원천. */
  tick: number
  /** 경과 시간(초). 항상 tick * DT와 같다. */
  time: number
  rng: Rng
  arenaRadius: number
  player: Player
}
