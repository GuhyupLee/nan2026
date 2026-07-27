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
  update(time: number, speed: number): void
  playAction(action: CharacterAction, time: number): void
  dispose(): void
}

/** 캐릭터 신장. 아레나·카메라·적 크기가 이 값을 기준으로 잡혀 있다. */
export const CHARACTER_HEIGHT = 1.75
