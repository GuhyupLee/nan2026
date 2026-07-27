import * as THREE from 'three'

import type { SkillId } from '../sim/skills.ts'
import type { PlayerClass, World } from '../sim/types.ts'
import type { Vec2 } from '../sim/vec.ts'
import { length, lerp, lerpAngle } from '../sim/vec.ts'
import { createArena } from './arena.ts'
import {
  type CharacterAction,
  type CharacterRig,
  createCharacterRig,
} from './characters.ts'
import { EnemyRenderer } from './enemies.ts'

/**
 * 쿼터뷰 카메라 오프셋. 피치 ≈ atan(14/10.8) ≈ 52°. LoL·이터널 리턴 계열 각도.
 *
 * 거리는 계측해서 정했다. 처음에는 (0,22,17)이었는데 그 거리에서 캐릭터가
 * 화면 세로의 7%밖에 안 됐다 — 파츠를 8개로 만들든 49개로 만들든 구분이
 * 안 되는 크기다. 당겨서 약 14%로 맞췄다. 이터널 리턴 프레이밍에 가깝다.
 *
 * 부수 효과가 더 크다: 시야가 좁아지면 적이 위협적으로 느껴지고,
 * "화면을 가득 채운 적" 장면이 250마리가 아니라 100마리로 나온다(성능 이득).
 */
const CAM_OFFSET = new THREE.Vector3(0, 14, 10.8)

/** 시야각. 좁을수록 원근 왜곡이 줄어 MOBA다운 평면적 화면이 된다. */
const CAM_FOV = 40

/** 16:9보다 좁은 화면에서도 가로 전장 시야가 지나치게 잘리지 않게 한다. */
const CAM_REFERENCE_ASPECT = 16 / 9

/** 카메라 추적 반응 속도. 클수록 즉각적. */
const CAM_FOLLOW = 14

const BG_COLOR = 0x05070d
const TARGET_CYAN = 0x56c7e8
const TARGET_CRIMSON = 0xe25063
const TARGET_GREEN = 0x67bd78

const TARGET_RANGES: Readonly<Record<PlayerClass, Readonly<Record<'q' | 'w' | 'e' | 'r', number>>>> = {
  ranged: { q: 16, w: 8, e: 14, r: 30 },
  melee: { q: 5, w: 7, e: 9, r: 13 },
}

/**
 * 렌더러.
 *
 * 시뮬레이션 상태를 읽기만 한다. 절대 수정하지 않는다.
 * 이 단방향 의존(render → sim)이 헤드리스 밸런싱의 전제다.
 */
export class Renderer {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera

  private readonly gl: THREE.WebGLRenderer
  private readonly lightRig: THREE.Group
  private readonly sun: THREE.DirectionalLight
  private readonly enemyRenderer: EnemyRenderer
  private readonly targetingGroup: THREE.Group
  private readonly targetingRingGeometry: THREE.RingGeometry
  private readonly targetingLineGeometry: THREE.PlaneGeometry
  private readonly targetingRange: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  private readonly targetingLine: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
  private readonly targetingEnd: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  private charRig: CharacterRig
  private charClass: PlayerClass = 'ranged'
  /** 공격·시전 중 이동 보간이 모션 방향을 덮지 않게 잠깐 고정하는 방향. */
  private actionFacing = 0
  private actionFacingUntil = -Infinity
  /** 렌더 프레임 간격(초). 이벤트 수명 애니메이션에 쓴다. */
  private lastFrameTime = 0

  private readonly camTarget = new THREE.Vector3()
  private readonly raycaster = new THREE.Raycaster()
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly ndc = new THREE.Vector2()
  private readonly hit = new THREE.Vector3()
  private readonly proj = new THREE.Vector3()

  private readonly container: HTMLElement
  private readonly coarsePointer = window.matchMedia('(pointer: coarse)')
  private readonly resizeObserver: ResizeObserver
  private width = 1
  private height = 1
  private cameraDistanceScale = 1
  private pixelRatio = 0
  private shadowMapSize = 2048

  constructor(container: HTMLElement, arenaRadius: number) {
    this.container = container
    this.gl = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    })
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.gl.shadowMap.enabled = true
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap
    this.gl.toneMapping = THREE.ACESFilmicToneMapping
    this.gl.toneMappingExposure = 1.05
    container.appendChild(this.gl.domElement)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(BG_COLOR)
    // 카메라가 가까워진 만큼 안개도 당긴다. 아레나 가장자리가 어둠에
    // 잠겨야 좁은 시야가 답답함이 아니라 분위기로 읽힌다.
    this.scene.fog = new THREE.Fog(BG_COLOR, 20, 58)

    this.camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.5, 240)

    this.scene.add(createArena(arenaRadius))

    this.charRig = createCharacterRig(this.charClass)
    this.scene.add(this.charRig.group)

    this.enemyRenderer = new EnemyRenderer(this.scene)

    // 타기팅 프리뷰는 단위 지오메트리를 scale만 바꿔 재사용한다.
    this.targetingGroup = new THREE.Group()
    this.targetingGroup.visible = false
    this.targetingGroup.renderOrder = 8
    this.targetingRingGeometry = new THREE.RingGeometry(0.94, 1, 64)
    this.targetingLineGeometry = new THREE.PlaneGeometry(1, 1)
    this.targetingLineGeometry.rotateX(-Math.PI / 2)

    const targetingMaterial = (opacity: number): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({
        color: TARGET_CYAN,
        transparent: true,
        opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -2,
      })

    this.targetingRange = new THREE.Mesh(this.targetingRingGeometry, targetingMaterial(0.48))
    this.targetingRange.rotation.x = -Math.PI / 2
    this.targetingRange.renderOrder = 8
    this.targetingLine = new THREE.Mesh(this.targetingLineGeometry, targetingMaterial(0.24))
    this.targetingLine.renderOrder = 7
    this.targetingEnd = new THREE.Mesh(this.targetingRingGeometry, targetingMaterial(0.68))
    this.targetingEnd.rotation.x = -Math.PI / 2
    this.targetingEnd.renderOrder = 9
    this.targetingGroup.add(this.targetingRange, this.targetingLine, this.targetingEnd)
    this.scene.add(this.targetingGroup)

    // --- 조명 ---
    this.scene.add(new THREE.HemisphereLight(0x7093c8, 0x0a0e18, 0.85))

    this.sun = new THREE.DirectionalLight(0xffffff, 2.1)
    this.sun.position.set(14, 26, 10)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize)
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.03
    // 그림자 카메라를 플레이어 주변으로 좁게 잡아 해상도를 아낀다.
    const s = 22
    this.sun.shadow.camera.left = -s
    this.sun.shadow.camera.right = s
    this.sun.shadow.camera.top = s
    this.sun.shadow.camera.bottom = -s
    this.sun.shadow.camera.near = 1
    this.sun.shadow.camera.far = 80

    // 라이트를 플레이어와 함께 움직여 그림자 영역이 항상 따라오게 한다.
    this.lightRig = new THREE.Group()
    this.lightRig.add(this.sun)
    this.lightRig.add(this.sun.target)
    this.scene.add(this.lightRig)

    this.resize()
    window.addEventListener('resize', this.resize)
    this.coarsePointer.addEventListener('change', this.resize)
    // resize 이벤트만 믿으면 안 된다. 탭이 백그라운드에서 로드되거나
    // 레이아웃이 늦게 잡히면 캔버스가 0×0으로 굳고, aspect가 NaN이 되어
    // 화면이 영구히 검게 남는다. 컨테이너를 직접 관찰해 확실히 잡는다.
    this.resizeObserver = new ResizeObserver(this.resize)
    this.resizeObserver.observe(container)
  }

  readonly resize = (): void => {
    // 0을 절대 통과시키지 않는다 — aspect = 0/0 = NaN 이 투영 행렬을 망친다.
    const w = Math.max(1, this.container.clientWidth || window.innerWidth)
    const h = Math.max(1, this.container.clientHeight || window.innerHeight)
    const sizeChanged = w !== this.width || h !== this.height

    this.width = w
    this.height = h
    const aspect = w / h
    const nextCameraScale = THREE.MathUtils.clamp(
      Math.sqrt(CAM_REFERENCE_ASPECT / aspect),
      1,
      1.75,
    )
    const framingChanged = Math.abs(nextCameraScale - this.cameraDistanceScale) > 0.001
    this.cameraDistanceScale = nextCameraScale

    const qualityChanged = this.updateRenderQuality(w, h)
    if (sizeChanged || qualityChanged) this.gl.setSize(w, h, false)
    if (sizeChanged || framingChanged) {
      this.camera.aspect = aspect
      this.camera.updateProjectionMatrix()
      this.positionCamera()
    }
  }

  /**
   * 시전 대기 중인 스킬의 실제 월드 범위를 표시한다.
   * 단위 링과 선을 이동·회전·스케일만 하므로 매 프레임 지오메트리를 만들지 않는다.
   */
  setTargeting(world: World, skill: SkillId | null, alpha = 1): void {
    if (skill === null) {
      this.targetingGroup.visible = false
      return
    }

    const player = world.player
    const playerClass = world.playerClass
    const px = lerp(player.prevPos.x, player.pos.x, alpha)
    const pz = lerp(player.prevPos.y, player.pos.y, alpha)
    const facing = lerpAngle(player.prevFacing, player.facing, alpha)
    const color =
      skill === 'd'
        ? TARGET_GREEN
        : skill === 'f'
          ? TARGET_CYAN
          : playerClass === 'ranged'
            ? TARGET_CYAN
            : TARGET_CRIMSON
    let range: number
    if (skill === 'd') range = 3.2
    else if (skill === 'f') range = world.stats.flashRange
    else range = TARGET_RANGES[playerClass][skill]
    range = Math.max(0.1, range)

    this.targetingGroup.visible = true
    this.targetingRange.material.color.setHex(color)
    this.targetingLine.material.color.setHex(color)
    this.targetingEnd.material.color.setHex(color)
    this.targetingRange.position.set(px, 0.035, pz)
    this.targetingRange.scale.set(range, range, 1)

    const centered = skill === 'd' || (playerClass === 'melee' && skill === 'e')
    this.targetingLine.visible = !centered
    this.targetingEnd.visible = !centered
    if (centered) return

    let dx = world.lastAim.x - px
    let dz = world.lastAim.y - pz
    const rawDistance = Math.hypot(dx, dz)
    if (rawDistance < 1e-5) {
      dx = Math.cos(facing)
      dz = Math.sin(facing)
    } else {
      dx /= rawDistance
      dz /= rawDistance
    }

    const distance = rawDistance < 1e-5 ? range : Math.min(rawDistance, range)
    const endX = px + dx * distance
    const endZ = pz + dz * distance
    const angle = Math.atan2(dz, dx)

    this.targetingLine.position.set(
      (px + endX) * 0.5,
      0.025,
      (pz + endZ) * 0.5,
    )
    this.targetingLine.rotation.y = -angle
    this.targetingLine.scale.set(distance, 1, 0.08)

    const endRadius = playerClass === 'ranged' && skill === 'e' ? 6 : 0.42
    this.targetingEnd.position.set(endX, 0.045, endZ)
    this.targetingEnd.scale.set(endRadius, endRadius, 1)
  }

  /**
   * @param alpha 마지막 틱 이후 경과 비율(0..1). 프레임 보간에 쓴다.
   *              시뮬 60Hz / 화면 144Hz 조합에서도 매끄럽게 유지된다.
   */
  render(world: World, alpha: number): void {
    const now = performance.now() / 1000
    // 첫 프레임과 탭 복귀 시 dt가 튀지 않게 막는다.
    const dt = this.lastFrameTime === 0 ? 1 / 60 : Math.min(now - this.lastFrameTime, 0.1)
    this.lastFrameTime = now

    const p = world.player

    const px = lerp(p.prevPos.x, p.pos.x, alpha)
    const pz = lerp(p.prevPos.y, p.pos.y, alpha)
    const facing = lerpAngle(p.prevFacing, p.facing, alpha)

    // 클래스가 바뀌면 리그를 갈아끼운다. 캐릭터 선택 직후 한 번 일어난다.
    if (world.playerClass !== this.charClass) this.swapCharacter(world.playerClass)

    this.consumeCharacterActions(world, now)

    this.charRig.group.position.set(px, 0, pz)
    // sim의 facing(+X 기준, XZ 평면)을 three의 Y축 회전으로 옮기면 부호가 뒤집힌다.
    const displayFacing = now < this.actionFacingUntil ? this.actionFacing : facing
    this.charRig.group.rotation.y = -displayFacing
    // 절차적 애니메이션은 시뮬 시간이 아니라 벽시계로 돈다 —
    // 레벨업으로 시뮬이 멈춘 동안에도 캐릭터는 숨을 쉬어야 한다.
    this.charRig.update(now, length(p.vel))

    this.enemyRenderer.update(world, alpha, dt)

    this.lightRig.position.set(px, 0, pz)

    // 카메라는 살짝 지연시켜 따라간다. 완전 고정은 뻣뻣하고, 너무 느리면 조준이 흔들린다.
    const k = 1 - Math.exp(-CAM_FOLLOW * (1 / 60))
    this.camTarget.x += (px - this.camTarget.x) * k
    this.camTarget.z += (pz - this.camTarget.z) * k

    this.positionCamera()

    this.gl.render(this.scene, this.camera)
  }

  /**
   * 터치 중심 기기나 작은 화면에서는 픽셀 처리량과 그림자 맵 비용을 낮춘다.
   * 화면 회전과 DPR 변경도 같은 resize 경로에서 즉시 반영된다.
   */
  private updateRenderQuality(width: number, height: number): boolean {
    const constrained =
      this.coarsePointer.matches || width <= 900 || Math.min(width, height) <= 700
    const nextPixelRatio = Math.min(window.devicePixelRatio || 1, constrained ? 1.35 : 2)
    const nextShadowMapSize = constrained ? 1024 : 2048
    let changed = false

    if (Math.abs(nextPixelRatio - this.pixelRatio) > 0.01) {
      this.pixelRatio = nextPixelRatio
      this.gl.setPixelRatio(nextPixelRatio)
      changed = true
    }

    if (nextShadowMapSize !== this.shadowMapSize) {
      this.shadowMapSize = nextShadowMapSize
      this.sun.shadow.mapSize.set(nextShadowMapSize, nextShadowMapSize)
      this.sun.shadow.map?.dispose()
      this.sun.shadow.map = null
      changed = true
    }

    return changed
  }

  private positionCamera(): void {
    this.camera.position.set(
      this.camTarget.x + CAM_OFFSET.x * this.cameraDistanceScale,
      CAM_OFFSET.y * this.cameraDistanceScale,
      this.camTarget.z + CAM_OFFSET.z * this.cameraDistanceScale,
    )
    this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z)
  }

  /**
   * 화면 좌표를 지면(y=0) 위의 월드 좌표로 변환한다.
   * 스킬샷 조준의 기준점이라 정확해야 한다.
   */
  screenToGround(clientX: number, clientY: number, out: Vec2): Vec2 {
    this.ndc.x = (clientX / this.width) * 2 - 1
    this.ndc.y = -(clientY / this.height) * 2 + 1
    this.raycaster.setFromCamera(this.ndc, this.camera)
    if (this.raycaster.ray.intersectPlane(this.groundPlane, this.hit)) {
      out.x = this.hit.x
      out.y = this.hit.z
    }
    return out
  }

  /**
   * 월드 좌표를 화면 픽셀로 투영한다.
   * 캐릭터 머리 위 체력바처럼 3D를 따라다니는 DOM 요소가 쓴다.
   */
  worldToScreen(x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    this.proj.set(x, y, z).project(this.camera)
    out.x = (this.proj.x * 0.5 + 0.5) * this.width
    out.y = (-this.proj.y * 0.5 + 0.5) * this.height
    // z가 1을 넘으면 카메라 뒤쪽이다
    return this.proj.z < 1
  }

  private swapCharacter(cls: PlayerClass): void {
    this.scene.remove(this.charRig.group)
    this.charRig.dispose()
    this.charClass = cls
    this.charRig = createCharacterRig(cls)
    this.actionFacingUntil = -Infinity
    this.scene.add(this.charRig.group)
  }

  /**
   * 한 렌더 프레임에 여러 시뮬 틱이 들어와도 가장 중요한 모션 하나만 고른다.
   * 우선순위는 스킬 > 궁극 후속타 > 강화 평타 > 평타다.
   */
  private consumeCharacterActions(world: World, now: number): void {
    let next: CharacterAction | null = null
    let angle = world.player.facing
    let priority = -1
    let facingHold = 0

    for (const attack of world.attacks) {
      const p =
        attack.kind === 'ult'
          ? 3
          : attack.kind === 'empowered'
            ? 2
            : 1
      if (p < priority) continue
      priority = p
      next =
        attack.kind === 'empowered'
          ? 'empowered'
          : attack.kind === 'ult'
            ? 'ult'
            : 'attack'
      angle = attack.angle
      facingHold = attack.kind === 'empowered' ? 0.36 : attack.kind === 'ult' ? 0.26 : 0.2
    }

    for (const cast of world.casts) {
      // CastEvent는 소환사 주문까지 확장될 수 있으므로 캐릭터 QWER만 리그에 전달한다.
      if (cast.slot !== 'q' && cast.slot !== 'w' && cast.slot !== 'e' && cast.slot !== 'r') continue
      priority = 4
      next = cast.slot
      angle = cast.angle
      facingHold =
        cast.slot === 'r' ? 0.72 : cast.slot === 'e' ? 0.48 : cast.slot === 'w' ? 0.34 : 0.3
    }

    if (next === null || priority < 0) return
    this.charRig.playAction(next, now)
    this.actionFacing = angle
    this.actionFacingUntil = now + facingHold
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize)
    this.coarsePointer.removeEventListener('change', this.resize)
    this.resizeObserver.disconnect()

    this.targetingGroup.visible = false
    this.scene.remove(this.targetingGroup)
    this.targetingRingGeometry.dispose()
    this.targetingLineGeometry.dispose()
    this.targetingRange.material.dispose()
    this.targetingLine.material.dispose()
    this.targetingEnd.material.dispose()

    this.charRig.dispose()
    this.enemyRenderer.dispose()
    this.sun.shadow.map?.dispose()
    this.gl.dispose()
    this.gl.domElement.remove()
  }

  get drawCalls(): number {
    return this.gl.info.render.calls
  }
}
