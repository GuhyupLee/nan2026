import * as THREE from 'three'

import type { World } from '../sim/types.ts'
import type { Vec2 } from '../sim/vec.ts'
import { lerp, lerpAngle } from '../sim/vec.ts'
import { createArena } from './arena.ts'
import { createPlayerRig } from './player.ts'

/** 쿼터뷰 카메라 오프셋. 피치 ≈ atan(22/17) ≈ 52°. LoL·이터널 리턴 계열 각도. */
const CAM_OFFSET = new THREE.Vector3(0, 22, 17)

/** 카메라 추적 반응 속도. 클수록 즉각적. */
const CAM_FOLLOW = 14

const BG_COLOR = 0x05070d

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
  private readonly playerRig: THREE.Group
  private readonly lightRig: THREE.Group

  private readonly camTarget = new THREE.Vector3()
  private readonly raycaster = new THREE.Raycaster()
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly ndc = new THREE.Vector2()
  private readonly hit = new THREE.Vector3()

  private readonly container: HTMLElement
  private width = 1
  private height = 1

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
    this.scene.fog = new THREE.Fog(BG_COLOR, 34, 96)

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 240)

    this.scene.add(createArena(arenaRadius))

    this.playerRig = createPlayerRig()
    this.scene.add(this.playerRig)

    // --- 조명 ---
    this.scene.add(new THREE.HemisphereLight(0x7093c8, 0x0a0e18, 0.85))

    const sun = new THREE.DirectionalLight(0xffffff, 2.1)
    sun.position.set(14, 26, 10)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.bias = -0.0006
    sun.shadow.normalBias = 0.03
    // 그림자 카메라를 플레이어 주변으로 좁게 잡아 해상도를 아낀다.
    const s = 22
    sun.shadow.camera.left = -s
    sun.shadow.camera.right = s
    sun.shadow.camera.top = s
    sun.shadow.camera.bottom = -s
    sun.shadow.camera.near = 1
    sun.shadow.camera.far = 80

    // 라이트를 플레이어와 함께 움직여 그림자 영역이 항상 따라오게 한다.
    this.lightRig = new THREE.Group()
    this.lightRig.add(sun)
    this.lightRig.add(sun.target)
    this.scene.add(this.lightRig)

    this.resize()
    window.addEventListener('resize', this.resize)
    // resize 이벤트만 믿으면 안 된다. 탭이 백그라운드에서 로드되거나
    // 레이아웃이 늦게 잡히면 캔버스가 0×0으로 굳고, aspect가 NaN이 되어
    // 화면이 영구히 검게 남는다. 컨테이너를 직접 관찰해 확실히 잡는다.
    new ResizeObserver(this.resize).observe(container)
  }

  readonly resize = (): void => {
    // 0을 절대 통과시키지 않는다 — aspect = 0/0 = NaN 이 투영 행렬을 망친다.
    const w = Math.max(1, this.container.clientWidth || window.innerWidth)
    const h = Math.max(1, this.container.clientHeight || window.innerHeight)
    if (w === this.width && h === this.height) return

    this.width = w
    this.height = h
    this.gl.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  /**
   * @param alpha 마지막 틱 이후 경과 비율(0..1). 프레임 보간에 쓴다.
   *              시뮬 60Hz / 화면 144Hz 조합에서도 매끄럽게 유지된다.
   */
  render(world: World, alpha: number): void {
    const p = world.player

    const px = lerp(p.prevPos.x, p.pos.x, alpha)
    const pz = lerp(p.prevPos.y, p.pos.y, alpha)
    const facing = lerpAngle(p.prevFacing, p.facing, alpha)

    this.playerRig.position.set(px, 0, pz)
    // sim의 facing(+X 기준, XZ 평면)을 three의 Y축 회전으로 옮기면 부호가 뒤집힌다.
    this.playerRig.rotation.y = -facing

    this.lightRig.position.set(px, 0, pz)

    // 카메라는 살짝 지연시켜 따라간다. 완전 고정은 뻣뻣하고, 너무 느리면 조준이 흔들린다.
    const k = 1 - Math.exp(-CAM_FOLLOW * (1 / 60))
    this.camTarget.x += (px - this.camTarget.x) * k
    this.camTarget.z += (pz - this.camTarget.z) * k

    this.camera.position.set(
      this.camTarget.x + CAM_OFFSET.x,
      CAM_OFFSET.y,
      this.camTarget.z + CAM_OFFSET.z,
    )
    this.camera.lookAt(this.camTarget.x, 0, this.camTarget.z)

    this.gl.render(this.scene, this.camera)
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

  get drawCalls(): number {
    return this.gl.info.render.calls
  }
}
