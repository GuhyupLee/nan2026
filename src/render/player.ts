import * as THREE from 'three'

/**
 * 플레이어 임시 리그.
 *
 * D1 단계의 자리표시자다. 나중에 Quaternius CC0 캐릭터 + 유니버설 애니메이션
 * (스킨드 메시)으로 교체된다. 교체 시 이 함수만 바꾸면 되도록
 * 바깥에서는 Group 하나로만 다룬다.
 */
export function createPlayerRig(): THREE.Group {
  const rig = new THREE.Group()

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.42, 0.85, 6, 16),
    new THREE.MeshStandardMaterial({
      color: 0x9fd8ff,
      roughness: 0.35,
      metalness: 0.1,
      emissive: 0x14384f,
      emissiveIntensity: 0.6,
    }),
  )
  body.position.y = 0.85
  body.castShadow = true
  rig.add(body)

  // 바라보는 방향 표시. facing = 0 이 +X 이므로 콘을 +X 로 눕힌다.
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.2, 0.55, 12),
    new THREE.MeshStandardMaterial({
      color: 0x4dd0ff,
      emissive: 0x2b93c9,
      emissiveIntensity: 1.4,
      roughness: 0.4,
    }),
  )
  nose.rotation.z = -Math.PI / 2
  nose.position.set(0.62, 0.85, 0)
  nose.castShadow = true
  rig.add(nose)

  // 접지감을 주는 가짜 그림자 디스크. 실제 그림자를 못 받는 상황에서도
  // 캐릭터가 바닥에 붙어 보이게 한다.
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(0.6, 24),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
    }),
  )
  blob.rotation.x = -Math.PI / 2
  blob.position.y = 0.04
  rig.add(blob)

  return rig
}
