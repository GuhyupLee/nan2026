import type * as THREE from 'three'

/**
 * 캐릭터 리그 공용 계약.
 *
 * 구현이 둘이다 — VRoid에서 뽑은 VRM(`vrm-rig.ts`)과 코드로 만든 프로시저럴
 * 모델(`characters.ts`). 렌더러는 어느 쪽인지 몰라도 되게 이 인터페이스만 본다.
 * VRM 파일이 없거나 로드에 실패하면 프로시저럴로 폴백하므로, 에셋이 없는
 * 환경(CI·클론 직후)에서도 게임은 그대로 돌아간다.
 */

export type CharacterAction = 'attack' | 'empowered' | 'ult' | 'q' | 'w' | 'e' | 'r'

export interface CharacterRig {
  group: THREE.Group
  /**
   * 어느 구현인지. 렌더러는 부팅 시점에 리그를 한 번 만드는데 그때는 VRM
   * 다운로드가 아직 안 끝나 프로시저럴이 잡힌다. 이 표시가 없으면 같은
   * 클래스를 골랐을 때 교체 조건(`world.playerClass !== charClass`)이 성립하지
   * 않아 프로시저럴 모델이 그대로 남는다 — 실제로 원거리에서 그렇게 됐다.
   */
  source: 'vrm' | 'procedural'
  update(time: number, speed: number): void
  playAction(action: CharacterAction, time: number): void
  /**
   * 발사점의 월드 좌표를 `out`에 채운다. 없으면 false.
   *
   * 시뮬은 예광선을 플레이어 중심(발밑 높이)에서 쏜다 — 판정에는 그게 맞지만
   * 그림으로는 빔이 배에서 나온다. 원거리 캐릭터는 지팡이 보주가 쏘는
   * 연출이라 렌더러가 시작점을 여기로 옮겨야 한다.
   */
  muzzleWorld?(out: THREE.Vector3): boolean
  dispose(): void
}

/** 캐릭터 신장. 아레나·카메라·적 크기가 이 값을 기준으로 잡혀 있다. */
export const CHARACTER_HEIGHT = 1.75
