import * as THREE from 'three'

import type { World } from '../sim/types.ts'

/**
 * 결과 화면의 히어로 샷.
 *
 * ## 왜 필요한가
 *
 * 결과가 확정되면 렌더러는 이미 캐릭터에 승리·패배 포즈를 잡는다. 그런데
 * 그 포즈를 **아무도 본 적이 없다** — 결과 오버레이의 배경이 93% 불투명이라
 * 화면을 거의 덮고, 남은 틈으로는 부감 52° 카메라가 잡은 손톱만 한 실루엣만
 * 보인다. 공들여 만든 포즈와 환경이 그 순간 통째로 버려지고 있었다.
 *
 * 오버워치의 결과 화면이 하는 일은 단순하다 — **카메라를 캐릭터에게 가져가고,
 * 조명을 다시 짜고, UI를 옆으로 비킨다.** 여기서도 같은 세 가지를 한다.
 *
 * ## 부감을 버리는 이유
 *
 * 전투 카메라는 정보를 위한 각도다. 부감 52°는 바닥의 장판과 적의 배치를
 * 읽으라고 만든 것이고, 그 각도에서 캐릭터는 화면 세로의 14%짜리 점이다.
 * 결과 화면에는 읽을 정보가 없으므로 그 제약이 사라진다. 눈높이로 내려가
 * 얼굴과 무기와 실루엣을 보여 주는 것이 그 순간의 유일한 임무다.
 *
 * ## 카메라 전환은 게임 좌표를 건드리지 않는다
 *
 * 이 모듈은 카메라와 조명만 만진다. 시뮬레이션은 이미 멈춰 있고,
 * `worldToScreen`을 쓰는 HUD는 결과 화면에서 숨겨진다. 그래서 전환 중에
 * 좌표가 흔들려도 게임 로직에 영향이 없다.
 */

/** 전환에 걸리는 시간(초). 너무 빠르면 카메라가 튀고, 느리면 결과를 못 본다. */
const TRANSITION_DURATION = 1.15
const REDUCED_MOTION_TRANSITION_DURATION = 0.32

/**
 * 승리와 패배는 **다른 카메라와 다른 조명**을 쓴다.
 *
 * 같은 구도에 색만 바꾸면 두 결과가 같은 사건으로 읽힌다. 승리는 눈높이보다
 * 살짝 아래에서 올려다보며 인물을 세우고, 패배는 위에서 내려다보며 인물을
 * 작게 만든다 — 카메라 높이 하나가 문장보다 많은 말을 한다.
 */
interface HeroShot {
  /** 캐릭터를 잡는 거리(m). */
  distance: number
  /** 부감 각도(라디안). 양수면 내려다본다. */
  pitch: number
  /** 바라보는 높이(m). */
  pivotHeight: number
  /** 키 라이트 색과 세기. */
  keyColor: number
  keyIntensity: number
  /** 림 라이트 색과 세기. */
  rimColor: number
  rimIntensity: number
  fillIntensity: number
  /** 전환이 끝난 뒤의 공전 속도(초당 라디안). */
  orbitSpeed: number
}

const VICTORY_SHOT: HeroShot = {
  distance: 4.15,
  // 전투의 52°에서 크게 내려온다. 눈높이보다 조금 위라 인물이 당당해 보인다.
  pitch: THREE.MathUtils.degToRad(11),
  // 가슴 언저리. 얼굴이 화면 상단 3분의 1에 온다.
  pivotHeight: 0.92,
  keyColor: 0xfff0dc,
  keyIntensity: 14,
  rimColor: 0x9fc4ff,
  rimIntensity: 1.5,
  fillIntensity: 0.24,
  orbitSpeed: 0.055,
}

const DEFEAT_SHOT: HeroShot = {
  // 더 멀고 더 높다. 쓰러진 인물을 내려다보는 각도라 화면에서 작아진다.
  distance: 5.4,
  pitch: THREE.MathUtils.degToRad(27),
  // 시선을 낮춘다. 서 있는 인물이 아니라 바닥을 함께 보게 된다.
  pivotHeight: 0.55,
  // 따뜻한 빛을 걷는다. 달빛만 남은 차가운 색이다.
  keyColor: 0x9fb4d6,
  keyIntensity: 7,
  rimColor: 0x6f86b4,
  rimIntensity: 0.9,
  fillIntensity: 0.16,
  // 거의 멈춘다. 패배 화면에서 카메라가 도는 것은 경쾌해서 어울리지 않는다.
  orbitSpeed: 0.018,
}

/**
 * 캐릭터를 화면 왼쪽으로 밀어내는 양(m).
 *
 * 결과 패널이 오른쪽을 차지하므로 캐릭터는 왼쪽 3분의 1에 서야 한다.
 * 카메라를 옆으로 옮기는 대신 **바라보는 점**을 오른쪽으로 밀면, 캐릭터가
 * 화면 왼쪽으로 가면서도 카메라와의 거리는 그대로라 원근이 무너지지 않는다.
 */
const HERO_SCREEN_OFFSET = 1.02

/**
 * 정면에서 살짝 비껴 서는 각도(라디안).
 *
 * 정확히 정면은 증명사진이 된다. 3/4 각도로 서야 얼굴과 어깨선이 함께
 * 읽히고 무기가 실루엣에 걸린다.
 */
const HERO_THREE_QUARTER = 0.42

/** 좁은 화면에서는 캐릭터를 덜 밀어낸다 — 패널이 아래로 내려가기 때문이다. */
const NARROW_ASPECT = 1.05

export interface CinematicLights {
  key: THREE.SpotLight
  rim: THREE.DirectionalLight
  fill: THREE.HemisphereLight
}

export class OutcomeCinematic {
  /** 0이면 전투 카메라, 1이면 히어로 샷. */
  private progress = 0
  private active = false
  private orbit = 0
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  private readonly lights: CinematicLights
  private readonly group = new THREE.Group()

  private readonly pivot = new THREE.Vector3()
  private readonly desiredPosition = new THREE.Vector3()
  private readonly desiredTarget = new THREE.Vector3()
  private readonly right = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()

  /**
   * 전환이 시작될 때의 요(yaw).
   *
   * 매 프레임 카메라 방향에서 다시 뽑으면 전환 중에 기준이 계속 흔들려
   * 궤도가 요동친다. 시작 순간에 한 번 고정한다.
   */
  private baseYaw = 0
  /** 마지막으로 반영한 결과. 값이 바뀔 때만 구도를 다시 고른다. */
  private lastOutcome: World['outcome'] = 'alive'
  /** 현재 결과에 맞는 구도. `setOutcome`에서 고른다. */
  private shot: HeroShot = VICTORY_SHOT

  constructor(scene: THREE.Scene) {
    this.group.name = 'outcome-cinematic'

    // 키 라이트. 스포트라이트를 쓰는 이유는 감쇠가 있어야 캐릭터만
    // 떠오르고 배경은 어둠에 남기 때문이다. 방향광은 아레나 전체를 같이
    // 밝혀서 "무대"가 만들어지지 않는다.
    // 감쇠 2(물리 정확)에 원뿔을 좁게. 처음에 감쇠 1.4로 넓게 쐈더니 빛이
    // 바닥 전체로 번져 캐릭터가 하얗게 타고 무대감이 사라졌다.
    const key = new THREE.SpotLight(0xfff0dc, 0, 12, Math.PI * 0.17, 0.62, 2)
    key.name = 'cinematic-key'
    key.castShadow = false

    // 림 라이트. 캐릭터 뒤쪽에서 윤곽을 그어 배경과 분리한다. 이것 하나가
    // "잘 만든 3D"와 "배경에 파묻힌 3D"를 가른다.
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0)
    rim.name = 'cinematic-rim'
    rim.castShadow = false

    // 채움광. 그림자 쪽이 완전히 검게 죽지 않을 만큼만.
    const fill = new THREE.HemisphereLight(0x5c6f92, 0x14181f, 0)
    fill.name = 'cinematic-fill'

    this.group.add(key, key.target, rim, rim.target, fill)
    scene.add(this.group)
    this.lights = { key, rim, fill }
  }

  /**
   * 결과가 확정됐는지 알린다. 매 프레임 호출해도 안전하다.
   *
   * @param facing 시뮬의 캐릭터 방향(+X 기준 라디안). 카메라를 **정면**에
   *   세우는 데 쓴다. 전투 카메라 방향을 그대로 쓰면 캐릭터가 마지막으로
   *   향했던 쪽에 따라 등을 보이는 일이 생긴다 — 실제로 처음 구현에서
   *   승리 화면이 뒤통수만 보여 줬다.
   */
  setOutcome(outcome: World['outcome'], facing: number): void {
    // **불린이 아니라 값으로 비교한다.**
    //
    // 처음에는 `outcome !== 'alive'`만 보고 전환했는데, 그러면 결과가 확정된
    // 뒤에 값이 바뀌어도(승리 → 패배) 구도가 갱신되지 않는다. 실제 플레이는
    // alive에서 한 번만 넘어가므로 드러나지 않지만, QA 훅으로 결과를 바꿔
    // 확인할 때 승리 화면에 패배 조명이 그대로 남는 것을 실제로 봤다.
    // 상태 기계가 한 방향이라고 가정하면 진단이 어려운 버그가 남는다.
    if (outcome === this.lastOutcome) return
    this.lastOutcome = outcome
    const next = outcome !== 'alive'
    this.active = next
    if (next) {
      this.shot = outcome === 'victory' ? VICTORY_SHOT : DEFEAT_SHOT
      // 카메라 위치는 pivot + (sin(yaw), ·, cos(yaw))로 잡는다. 캐릭터가
      // 향하는 월드 방향은 (cos f, ·, sin f)이므로 그 앞에 서려면
      // sin(yaw)=cos f, cos(yaw)=sin f — 즉 yaw = π/2 − f다.
      this.baseYaw = Math.PI / 2 - facing + HERO_THREE_QUARTER
      this.orbit = 0
    }
  }

  /** 전환 진행도. 렌더러가 안개·노출 같은 다른 값을 함께 재울 때 읽는다. */
  get amount(): number {
    return this.progress
  }

  advance(dt: number): void {
    const duration = this.reducedMotion.matches
      ? REDUCED_MOTION_TRANSITION_DURATION
      : TRANSITION_DURATION
    const step = dt / Math.max(0.016, duration)
    this.progress = THREE.MathUtils.clamp(
      this.progress + (this.active ? step : -step * 2.2),
      0,
      1,
    )
    if (this.progress > 0 && !this.reducedMotion.matches) {
      this.orbit += dt * this.shot.orbitSpeed * this.progress
    }
    if (this.progress === 0) this.orbit = 0
  }

  /**
   * 전투 카메라 위에 히어로 샷을 섞는다.
   *
   * `camera`는 이미 전투 위치와 lookAt이 적용된 상태로 들어온다. 여기서
   * 위치와 바라보는 점을 각각 보간하므로, 진행도 0에서는 전투 화면과
   * 픽셀 단위로 동일하다.
   */
  apply(
    camera: THREE.PerspectiveCamera,
    characterX: number,
    characterZ: number,
    aspect: number,
  ): void {
    if (this.progress <= 0) return

    // 부드럽게. 선형이면 시작과 끝에서 카메라가 끊긴 것처럼 튄다.
    const t = this.progress * this.progress * (3 - 2 * this.progress)

    const shot = this.shot
    this.pivot.set(characterX, shot.pivotHeight, characterZ)

    const yaw = this.baseYaw + this.orbit
    const horizontal = Math.cos(shot.pitch) * shot.distance
    this.desiredPosition.set(
      this.pivot.x + Math.sin(yaw) * horizontal,
      this.pivot.y + Math.sin(shot.pitch) * shot.distance,
      this.pivot.z + Math.cos(yaw) * horizontal,
    )

    // 화면 오른쪽으로 시선을 밀어 캐릭터를 왼쪽 3분의 1에 세운다.
    // 세로로 긴 화면에서는 패널이 아래로 내려가므로 밀어낼 필요가 없다.
    this.forward.subVectors(this.pivot, this.desiredPosition).normalize()
    this.right.crossVectors(this.forward, camera.up).normalize()
    const offset =
      aspect < NARROW_ASPECT ? 0 : HERO_SCREEN_OFFSET * Math.min(1, aspect / 1.6)
    this.desiredTarget.copy(this.pivot).addScaledVector(this.right, offset)

    camera.position.lerp(this.desiredPosition, t)
    // lookAt은 보간할 수 없으므로 목표점 자체를 섞는다. 전투 시선(캐릭터
    // 발밑)에서 히어로 시선(가슴 + 오프셋)으로 자연스럽게 넘어간다.
    const battleTargetX = characterX
    const battleTargetZ = characterZ
    camera.lookAt(
      THREE.MathUtils.lerp(battleTargetX, this.desiredTarget.x, t),
      THREE.MathUtils.lerp(0, this.desiredTarget.y, t),
      THREE.MathUtils.lerp(battleTargetZ, this.desiredTarget.z, t),
    )

    this.updateLights(t)
  }

  private updateLights(t: number): void {
    const { key, rim, fill } = this.lights

    // 키 라이트는 카메라 왼쪽 위 앞에서. 정면에서 쏘면 그림자가 사라져
    // 얼굴이 납작해진다.
    key.position.set(
      this.pivot.x + this.right.x * -2.1 - this.forward.x * 2.4,
      this.pivot.y + 2.6,
      this.pivot.z + this.right.z * -2.1 - this.forward.z * 2.4,
    )
    key.target.position.copy(this.pivot)
    key.target.updateMatrixWorld()
    // 세기는 눈으로 맞췄다. 감쇠 2에서 거리 3.5m면 조도가 intensity/12쯤이라
    // 14가 달빛(2.1)의 약 절반으로 얹혀 얼굴이 살되 타지 않는다.
    key.color.setHex(this.shot.keyColor)
    key.intensity = this.shot.keyIntensity * t

    // 림은 반대편 뒤에서. 캐릭터 윤곽만 그으면 되므로 방향광으로 충분하다.
    rim.position.set(
      this.pivot.x + this.right.x * 3.2 + this.forward.x * 3.0,
      this.pivot.y + 1.5,
      this.pivot.z + this.right.z * 3.2 + this.forward.z * 3.0,
    )
    rim.target.position.copy(this.pivot)
    rim.target.updateMatrixWorld()
    rim.color.setHex(this.shot.rimColor)
    rim.intensity = this.shot.rimIntensity * t

    fill.intensity = this.shot.fillIntensity * t
    fill.position.copy(this.pivot)
  }

  dispose(): void {
    this.group.removeFromParent()
    this.lights.key.dispose()
    this.lights.rim.dispose()
    this.lights.fill.dispose()
  }
}
