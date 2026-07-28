import * as THREE from 'three'

/**
 * 무기 궤적 리본 — 근접 타격감의 척추.
 *
 * 쿼터뷰에서 캐릭터는 화면 세로의 13%다. 칼이 움직이는 것 자체는 그 크기에서
 * 거의 안 보인다. 실제로 "벴다"를 만드는 건 칼이 아니라 **칼이 지나간 자리**다.
 * 그래서 이 모듈이 있다.
 *
 * 원리: 매 프레임 칼날의 밑점(base)과 끝점(tip)을 월드 좌표로 받아 링 버퍼에
 * 쌓고, 인접한 두 샘플로 사각형을 만들어 리본을 잇는다. 오래된 샘플일수록
 * 알파와 폭이 줄어 꼬리가 사라진다.
 *
 * 설계 원칙 세 가지:
 *
 * 1. **리그를 모른다.** base/tip을 월드 좌표(또는 Object3D)로 받기만 한다.
 *    VRM이든 프로시저럴이든, 카타나든 지팡이든 이 파일은 구분하지 않는다.
 *    결합을 여기서 끊어야 리그가 바뀌어도 트레일이 안 깨진다.
 *
 * 2. **평상시엔 꺼둔다.** 항상 켜면 걸어다닐 때도 칼이 빛을 흘려 싸구려로
 *    보인다. `burst()`로 스윙 동안만 켠다.
 *
 * 3. **매 프레임 할당 0.** 지오메트리는 최대 크기로 한 번 잡고 `drawRange`로
 *    잘라 쓴다. 스크래치 벡터는 전부 필드다. 드로우콜은 리본 하나당 1, 샘플이
 *    2개 미만이면 `visible=false`라 0이다.
 */

/**
 * 기본 세그먼트(사각형) 수.
 *
 * 상한 계산: 수명 0.2초 = 60Hz에서 12프레임, 프레임마다 보간 샘플이 최대
 * MAX_SUBSTEPS(4)개 들어가므로 최악 48샘플이다. 그 아래로 잡으면 빠른 스윙에서
 * 꼬리가 수명보다 먼저 잘려 리본이 짧아진다. 48쿼드 = 98버텍스 = 1.2KB 업로드,
 * 비용이 없는 쪽이라 넉넉히 잡는 게 맞다.
 */
const DEFAULT_SEGMENTS = 48

/** 기본 수명(초). 카타나 스윙이 0.2~0.25초라 그 대부분을 덮는다. */
const DEFAULT_LIFETIME = 0.2

/** 기본 폭 배수. 1이면 base→tip 실측 그대로. */
const DEFAULT_WIDTH = 1

/**
 * 기본 발광 배수.
 *
 * 후처리 블룸의 하이패스는 **톤매핑 이전 선형 휘도**를 본다(three가 Rec.709
 * 계수를 자동 주입). 클래스 색의 선형 휘도는 시안 #4DD0FF = 0.539,
 * 크림슨 #FF5A6E = 0.297이다. threshold 0.9 기준으로 계산하면:
 *
 *   - 안쪽(흰색 85% 혼합) 크림슨 = 0.895 × 2.4 ≈ 2.15  → 블룸 걸림
 *   - 바깥(순수 크림슨)          = 0.297 × 2.4 ≈ 0.71  → 안 걸림
 *
 * 즉 이 값 하나로 "칼날은 타오르고 바깥 테두리는 색만 남는" 대비가 생긴다.
 * 레이어 마스킹 없이 threshold만으로 선택적 블룸이 성립하는 근거가 이 수치다.
 */
const DEFAULT_INTENSITY = 2.4

/**
 * 보간 없이 허용하는 샘플 간 최대 이동 거리(월드 유닛).
 *
 * 카메라 거리에서 1월드유닛 ≈ 화면 세로의 7.4%다(캐릭터 1.75가 13%). 900px
 * 뷰포트면 1유닛 ≈ 67px이므로 0.14유닛 ≈ 9px — 각진 게 보이기 직전 지점이다.
 * 이보다 크게 잡으면 빠른 스윙에서 리본이 다각형으로 꺾여 읽힌다.
 */
const SUBSTEP_ARC = 0.14

/**
 * 한 프레임에 끼워 넣을 보간 샘플 상한.
 *
 * 60Hz 카타나 스윙(반경 ≈1, 160°/0.22초)이면 프레임당 팁 이동이 0.21유닛 →
 * 2스텝이면 충분하다. 4로 잡으면 30fps나 궁극기 급속 스윙까지 덮으면서
 * 링 버퍼가 한 프레임에 통째로 갈리는 일은 막는다.
 */
const MAX_SUBSTEPS = 4

/**
 * 이 이상 프레임이 벌어지면 직전 포즈를 믿지 않고 리본을 버린다.
 *
 * 렌더러가 dt를 0.1초에 클램프하므로(탭 복귀·레벨업 오버레이 복귀) 0.09를
 * 넘었다는 건 클램프가 걸렸거나 11fps 이하라는 뜻이다. 그 사이 무기는 사실상
 * 순간이동했고, 직전 포즈와 이어 붙이면 화면을 가로지르는 거대한 번짐이 된다.
 * 한 프레임 리본을 포기하는 쪽이 압도적으로 싸다.
 */
const STALE_DT = 0.09

/** 꼬리 끝의 폭 비율. 0이면 뾰족해서 날카롭지만 끊어져 보인다. */
const TAIL_WIDTH = 0.35

/** 바깥(tip) 모서리 알파 비율. 1이면 리본 가장자리가 칼로 자른 듯 딱딱해진다. */
const TIP_EDGE_ALPHA = 0.32

/** 안쪽(칼날) 모서리의 흰색 혼합 하한과 신선도에 따른 추가분. 최대 0.85. */
const HOT_CORE_MIN = 0.35
const HOT_CORE_GAIN = 0.5

/** 바깥 모서리의 흰색 혼합 최대치. 여기까지 희어지면 클래스 색이 죽는다. */
const HOT_EDGE_GAIN = 0.22

export interface WeaponTrailOptions {
  /** 클래스 색. 일현 시안 0x4DD0FF, 월아 크림슨 0xFF5A6E. */
  color: THREE.ColorRepresentation
  /** 사각형 개수. 모바일 품질 강등의 1번 손잡이. */
  segments?: number
  /** 샘플 수명(초). 길수록 꼬리가 길다. 품질 강등의 2번 손잡이. */
  lifetime?: number
  /** 폭 배수. base→tip 길이에 곱한다. */
  width?: number
  /** 발광 배수. 블룸 threshold를 넘길지 결정한다. */
  intensity?: number
}

export class WeaponTrail {
  /**
   * 리본 메시. 외부에 여는 이유는 하나다 — 선택적 블룸을 레이어 마스킹으로
   * 하게 될 때 `trail.mesh.layers.enable(BLOOM_LAYER)`가 필요하다.
   */
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>

  private readonly parent: THREE.Object3D
  private readonly geometry: THREE.BufferGeometry
  private readonly material: THREE.MeshBasicMaterial
  private readonly posAttr: THREE.BufferAttribute
  private readonly colAttr: THREE.BufferAttribute
  private readonly posArr: Float32Array
  private readonly colArr: Float32Array

  /** 샘플 링 버퍼. 6개씩 (bx,by,bz,tx,ty,tz). 객체를 안 쓰는 이유는 GC다. */
  private readonly buf: Float32Array
  /**
   * 샘플 생성 시각. Float32면 세션이 길어졌을 때(performance.now가 1e4초를
   * 넘을 때) 해상도가 1ms까지 떨어져 0.2초 수명의 페이드가 계단이 된다.
   */
  private readonly birth: Float64Array
  private readonly capacity: number
  private start = 0
  private count = 0

  private readonly lifetime: number
  private readonly width: number
  private intensity: number

  /** 클래스 색과 흰색 끝점을 미리 곱해둔 값. 루프 안에서 Color를 안 만든다. */
  private cr = 0
  private cg = 0
  private cb = 0
  private hr = 0
  private hg = 0
  private hb = 0
  private readonly tint = new THREE.Color()

  private srcBase: THREE.Object3D | null = null
  private srcTip: THREE.Object3D | null = null

  private readonly pendBase = new THREE.Vector3()
  private readonly pendTip = new THREE.Vector3()
  private hasPending = false

  private readonly curBase = new THREE.Vector3()
  private readonly curTip = new THREE.Vector3()
  private readonly prevBase = new THREE.Vector3()
  private readonly prevTip = new THREE.Vector3()
  private prevTime = 0
  private hasPrev = false

  private readonly d0 = new THREE.Vector3()
  private readonly d1 = new THREE.Vector3()
  private readonly dirU = new THREE.Vector3()
  private readonly tmpBase = new THREE.Vector3()
  private readonly tmpTip = new THREE.Vector3()

  private running = false
  private burstLeft = 0

  constructor(parent: THREE.Object3D, options: WeaponTrailOptions) {
    this.parent = parent
    const segments = Math.max(2, Math.floor(options.segments ?? DEFAULT_SEGMENTS))
    // 0 이하 수명은 나눗셈에서 Infinity를 만들어 알파가 NaN이 된다.
    this.lifetime = Math.max(0.02, options.lifetime ?? DEFAULT_LIFETIME)
    this.width = Math.max(0.01, options.width ?? DEFAULT_WIDTH)
    this.intensity = Math.max(0, options.intensity ?? DEFAULT_INTENSITY)

    this.capacity = segments + 1
    this.buf = new Float32Array(this.capacity * 6)
    this.birth = new Float64Array(this.capacity)

    this.posArr = new Float32Array(this.capacity * 2 * 3)
    // 4채널이어야 three가 USE_COLOR_ALPHA를 켜서 버텍스 알파가 산다
    // (WebGLPrograms: color 어트리뷰트 itemSize === 4일 때만).
    // 3채널로 만들면 페이드가 통째로 사라지고 리본이 각진 판때기가 된다.
    this.colArr = new Float32Array(this.capacity * 2 * 4)

    this.posAttr = new THREE.BufferAttribute(this.posArr, 3)
    this.posAttr.setUsage(THREE.DynamicDrawUsage)
    this.colAttr = new THREE.BufferAttribute(this.colArr, 4)
    this.colAttr.setUsage(THREE.DynamicDrawUsage)

    // 인덱스는 링 버퍼 회전과 무관하다 — 매 프레임 살아 있는 샘플을 항상
    // 슬롯 0부터 순서대로 다시 채우기 때문이다. 그래서 한 번만 만들면 된다.
    const index = new Uint16Array(segments * 6)
    for (let q = 0; q < segments; q++) {
      const v = q * 2
      const o = q * 6
      index[o] = v
      index[o + 1] = v + 1
      index[o + 2] = v + 3
      index[o + 3] = v
      index[o + 4] = v + 3
      index[o + 5] = v + 2
    }

    this.geometry = new THREE.BufferGeometry()
    this.geometry.setAttribute('position', this.posAttr)
    this.geometry.setAttribute('color', this.colAttr)
    this.geometry.setIndex(new THREE.BufferAttribute(index, 1))
    this.geometry.setDrawRange(0, 0)

    this.material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      // 안개를 끈다. 가산 블렌딩에서 안개는 "어둡게"가 아니라 "안개색을 더하기"로
      // 작동해서 멀리 있는 궤적이 파랗게 뜬다.
      fog: false,
    })

    this.mesh = new THREE.Mesh(this.geometry, this.material)
    // 정점을 이미 월드 좌표로 쓴다. 메시는 원점에 고정이므로 매 프레임
    // 행렬을 다시 만들 이유가 없다.
    this.mesh.matrixAutoUpdate = false
    this.mesh.updateMatrix()
    // 바운딩 구가 매 프레임 바뀌는데 갱신하지 않으므로 컬링을 맡기면
    // 스윙 도중 리본이 통째로 사라진다. 삼각형 100개짜리라 컬링 이득도 없다.
    this.mesh.frustumCulled = false
    this.mesh.visible = false
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false

    this.setColor(options.color)
    parent.add(this.mesh)
  }

  /** 클래스가 바뀌면 색만 갈아끼운다. 지오메트리를 다시 만들 이유가 없다. */
  setColor(color: THREE.ColorRepresentation): void {
    this.tint.set(color)
    this.cr = this.tint.r * this.intensity
    this.cg = this.tint.g * this.intensity
    this.cb = this.tint.b * this.intensity
    // 흰색 끝점은 "클래스 색을 흰색으로 당긴" 값이다. 순백으로 두면 칼날에서
    // 클래스 정체성이 사라진다 — 시안이든 크림슨이든 똑같이 하얗게 보인다.
    this.hr = (this.tint.r + (1 - this.tint.r) * 0.85) * this.intensity
    this.hg = (this.tint.g + (1 - this.tint.g) * 0.85) * this.intensity
    this.hb = (this.tint.b + (1 - this.tint.b) * 0.85) * this.intensity
  }

  /** 런타임 발광 조절. 모바일에서 블룸을 끌 때 같이 낮춘다. */
  setIntensity(value: number): void {
    this.intensity = Math.max(0, value)
    this.setColor(this.tint)
  }

  /**
   * 무기 메시의 밑점/끝점 Object3D를 물린다. 이후 `update`가 알아서 읽는다.
   * `null, null`로 부르면 떼어낸다(리그 교체 시).
   *
   * 월드 좌표는 `getWorldPosition`으로 뽑는데, 이건 내부에서
   * `updateWorldMatrix(true, false)`를 먼저 돌려 부모 사슬을 강제 갱신한다.
   * 그래서 리그가 이번 프레임에 세운 본 로컬 회전이 즉시 반영되고, 궤적이
   * 칼보다 한 프레임 뒤처지는 문제가 생기지 않는다(vrm-rig가 무기 방향을
   * 잡을 때 같은 이유로 손 본을 직접 갱신한다).
   */
  setSource(base: THREE.Object3D | null, tip: THREE.Object3D | null): void {
    this.srcBase = base
    this.srcTip = tip
  }

  /**
   * 이번 프레임 포즈를 직접 넘긴다. `setSource` 대신 쓰거나, 물려 둔 소스를
   * 이 프레임만 덮어쓸 때 쓴다. 좌표는 **월드** 기준이다.
   */
  sample(base: THREE.Vector3, tip: THREE.Vector3): void {
    this.pendBase.copy(base)
    this.pendTip.copy(tip)
    this.hasPending = true
  }

  /**
   * 켜고 끈다. 켜는 순간 기존 리본을 버린다 — 안 버리면 지난번 스윙이 끝난
   * 자리와 이번 스윙 시작점이 한 사각형으로 이어져 화면을 가로지르는 띠가 된다.
   */
  setActive(on: boolean): void {
    if (on === this.running) return
    this.running = on
    if (on) this.clearRibbon()
    else this.burstLeft = 0
  }

  /**
   * 스윙 한 번 동안만 켠다. 이미 켜져 있으면 남은 시간만 늘린다 — 연타로
   * 스윙이 겹칠 때 리본을 끊지 않기 위해서다.
   */
  burst(durationSec: number): void {
    this.setActive(true)
    if (durationSec > this.burstLeft) this.burstLeft = durationSec
  }

  /** 리본과 직전 포즈를 통째로 버린다. 리그 교체·판 시작에 쓴다. */
  reset(): void {
    this.running = false
    this.burstLeft = 0
    this.clearRibbon()
    this.hasPrev = false
    this.hasPending = false
  }

  /**
   * @param time 벽시계 초(`performance.now() / 1000`). 시뮬 시간이 아니다 —
   *             레벨업 카드로 시뮬이 멈춰도 궤적은 사라져야 한다.
   * @param dt   렌더 프레임 간격(초). 렌더러가 0.1에 클램프해 넘겨준다.
   *
   * 반드시 `sample()` 다음에, 그리고 리그의 `update()` 다음에 부른다.
   */
  update(time: number, dt: number): void {
    if (this.burstLeft > 0) {
      this.burstLeft -= dt
      if (this.burstLeft <= 0) {
        this.burstLeft = 0
        this.setActive(false)
      }
    }

    if (dt >= STALE_DT) this.reset()

    let sampled = false
    if (this.hasPending) {
      this.curBase.copy(this.pendBase)
      this.curTip.copy(this.pendTip)
      this.hasPending = false
      sampled = true
    } else if (this.srcBase && this.srcTip) {
      this.srcBase.getWorldPosition(this.curBase)
      this.srcTip.getWorldPosition(this.curTip)
      sampled = true
    }

    if (sampled) {
      if (this.running) this.emit(time)
      // 꺼져 있어도 직전 포즈는 계속 갱신한다. 그래야 다음 `burst`의 첫
      // 프레임부터 사각형이 하나 생겨 스윙 앞머리가 잘리지 않는다.
      this.prevBase.copy(this.curBase)
      this.prevTip.copy(this.curTip)
      this.prevTime = time
      this.hasPrev = true
    } else {
      // 이번 프레임에 포즈를 못 받았다 = 호출부가 샘플링을 쉬었다는 뜻이다.
      // 그 사이 무기가 어디로 갔는지 알 수 없으므로 이어 붙이면 안 된다.
      this.hasPrev = false
    }

    this.expire(time)
    this.rebuild(time)
  }

  dispose(): void {
    this.parent.remove(this.mesh)
    this.geometry.dispose()
    this.material.dispose()
  }

  // -------------------------------------------------------------------------
  // 내부
  // -------------------------------------------------------------------------

  private clearRibbon(): void {
    this.start = 0
    this.count = 0
    this.geometry.setDrawRange(0, 0)
    this.mesh.visible = false
  }

  /**
   * 직전 포즈와 현재 포즈 사이를 채워 넣는다.
   *
   * 끝점을 그냥 선형 보간하면 호가 현(弦)으로 펴져서, 보간을 넣어도 리본이
   * 여전히 각져 보인다. base는 선형으로 옮기되 base→tip **방향**은 구면
   * 보간해야 팁이 진짜 원호를 그린다. 근접 클래스의 정체성이 "원"이라
   * 이 차이가 그대로 캐릭터 성격이 된다.
   */
  private emit(time: number): void {
    const cb = this.curBase
    const ct = this.curTip

    if (!this.hasPrev) {
      this.push(cb.x, cb.y, cb.z, ct.x, ct.y, ct.z, time)
      return
    }

    const pb = this.prevBase
    const pt = this.prevTip
    this.d0.subVectors(pt, pb)
    this.d1.subVectors(ct, cb)
    const l0 = this.d0.length()
    const l1 = this.d1.length()
    // 길이가 0이면 방향이 정의되지 않아 acos가 NaN을 뱉는다.
    const arc = l0 > 1e-5 && l1 > 1e-5
    if (arc) {
      this.d0.multiplyScalar(1 / l0)
      this.d1.multiplyScalar(1 / l1)
    }

    const travel = Math.max(pb.distanceTo(cb), pt.distanceTo(ct))
    const steps = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(travel / SUBSTEP_ARC)))
    const dtSample = time - this.prevTime

    for (let s = 1; s <= steps; s++) {
      const u = s / steps
      this.tmpBase.lerpVectors(pb, cb, u)
      if (arc) {
        this.slerpDir(u)
        this.tmpTip.copy(this.tmpBase).addScaledVector(this.dirU, l0 + (l1 - l0) * u)
      } else {
        this.tmpTip.lerpVectors(pt, ct, u)
      }
      // 생성 시각도 같이 보간한다. 안 하면 끼워 넣은 샘플들이 전부 같은 나이라
      // 페이드가 프레임 단위로 계단이 진다.
      this.push(
        this.tmpBase.x,
        this.tmpBase.y,
        this.tmpBase.z,
        this.tmpTip.x,
        this.tmpTip.y,
        this.tmpTip.z,
        this.prevTime + dtSample * u,
      )
    }
  }

  /** d0 → d1 구면 보간 결과를 dirU에 쓴다. 둘 다 단위벡터라고 가정한다. */
  private slerpDir(u: number): void {
    const dot = Math.min(1, Math.max(-1, this.d0.dot(this.d1)))
    // 거의 같은 방향: sin(theta)로 나누다 0/0이 된다. 선형 보간이 오차 이하다.
    if (dot > 0.9995) {
      this.dirU.copy(this.d0).lerp(this.d1, u).normalize()
      return
    }
    // 정반대: 회전축이 하나로 정해지지 않는다. 한 프레임에 180° 도는 스윙은
    // 어차피 표현 불가이므로 도착 방향으로 즉시 붙인다.
    if (dot < -0.9995) {
      this.dirU.copy(this.d1)
      return
    }
    const theta = Math.acos(dot)
    const inv = 1 / Math.sin(theta)
    const a = Math.sin((1 - u) * theta) * inv
    const b = Math.sin(u * theta) * inv
    this.dirU.copy(this.d0).multiplyScalar(a).addScaledVector(this.d1, b)
  }

  private push(
    bx: number,
    by: number,
    bz: number,
    tx: number,
    ty: number,
    tz: number,
    born: number,
  ): void {
    // 상한을 넘으면 가장 오래된 것을 버린다. 방금 휘두른 칼이 잘리는 것보다
    // 꼬리가 짧아지는 쪽이 낫다.
    if (this.count === this.capacity) {
      this.start = (this.start + 1) % this.capacity
      this.count--
    }
    const i = ((this.start + this.count) % this.capacity) * 6
    this.buf[i] = bx
    this.buf[i + 1] = by
    this.buf[i + 2] = bz
    this.buf[i + 3] = tx
    this.buf[i + 4] = ty
    this.buf[i + 5] = tz
    this.birth[(this.start + this.count) % this.capacity] = born
    this.count++
  }

  /** 샘플은 항상 시간 순으로 들어오므로 앞에서부터 떼면 된다. */
  private expire(time: number): void {
    while (this.count > 0) {
      if (time - this.birth[this.start]! < this.lifetime) break
      this.start = (this.start + 1) % this.capacity
      this.count--
    }
  }

  private rebuild(time: number): void {
    const n = this.count
    if (n < 2) {
      // 사각형이 하나도 안 나온다. visible=false면 three가 드로우콜 자체를
      // 건너뛰므로 평상시 비용이 정확히 0이다.
      this.geometry.setDrawRange(0, 0)
      this.mesh.visible = false
      return
    }

    const pos = this.posArr
    const col = this.colArr
    const buf = this.buf
    const invLife = 1 / this.lifetime

    for (let k = 0; k < n; k++) {
      const i = (this.start + k) % this.capacity
      const b = i * 6
      const bx = buf[b]!
      const by = buf[b + 1]!
      const bz = buf[b + 2]!

      // f = 신선도. 1이 방금, 0이 수명 끝.
      const age = (time - this.birth[i]!) * invLife
      const f = 1 - (age < 0 ? 0 : age > 1 ? 1 : age)

      // 폭은 base 쪽으로 수축시킨다. 칼은 손목을 축으로 도니까 꼬리가 좁아질
      // 방향도 축(=base) 쪽이어야 자연스럽다. 중심으로 모으면 리본이
      // 허리가 잘록한 리본처럼 보인다.
      const w = this.width * (TAIL_WIDTH + (1 - TAIL_WIDTH) * f)
      const v = k * 6
      pos[v] = bx
      pos[v + 1] = by
      pos[v + 2] = bz
      pos[v + 3] = bx + (buf[b + 3]! - bx) * w
      pos[v + 4] = by + (buf[b + 4]! - by) * w
      pos[v + 5] = bz + (buf[b + 5]! - bz) * w

      // 알파는 제곱으로 떨어뜨린다. 선형이면 꼬리가 오래 남아 리본이
      // 무겁고 끈적해 보인다 — 참격은 빨리 사라져야 날카롭다.
      const a = f * f
      const core = HOT_CORE_MIN + HOT_CORE_GAIN * f
      const edge = HOT_EDGE_GAIN * f
      const c = k * 8
      col[c] = this.cr + (this.hr - this.cr) * core
      col[c + 1] = this.cg + (this.hg - this.cg) * core
      col[c + 2] = this.cb + (this.hb - this.cb) * core
      col[c + 3] = a
      col[c + 4] = this.cr + (this.hr - this.cr) * edge
      col[c + 5] = this.cg + (this.hg - this.cg) * edge
      col[c + 6] = this.cb + (this.hb - this.cb) * edge
      // 바깥 모서리 알파를 낮춰 리본 가장자리를 흐린다. 같은 알파로 두면
      // 궤적이 종이를 오린 것처럼 딱딱해진다.
      col[c + 7] = a * TIP_EDGE_ALPHA
    }

    this.posAttr.needsUpdate = true
    this.colAttr.needsUpdate = true
    this.geometry.setDrawRange(0, (n - 1) * 6)
    this.mesh.visible = true
  }
}

/* ---------------------------------------------------------------------------
 * 통합 방법 (renderer.ts — 사람이 직렬로 붙인다)
 * ---------------------------------------------------------------------------
 *
 * 이 모듈은 three 말고 아무것도 import 하지 않는다. 그대로 붙으면 된다.
 *
 * [0] 선행 조건 — 리그가 칼날의 밑점/끝점을 내줘야 한다
 *
 *   지금 CharacterRig(rig.ts:14)는 `muzzleWorld`(발사점 하나)만 노출한다.
 *   리본에는 점이 둘 필요하다. rig.ts 인터페이스에 한 줄 추가한다:
 *
 *     /** 칼날 밑점과 끝점. 무기 궤적 리본이 매 프레임 월드 좌표로 읽는다. *\/
 *     blade?: { base: THREE.Object3D; tip: THREE.Object3D }
 *
 *   그리고 무기를 만드는 두 곳에서 빈 Object3D 두 개를 무기 그룹에 붙인다.
 *   로컬 좌표는 실제 지오메트리에서 뽑은 값이다:
 *
 *   - vrm-rig.ts buildWeapon() 근접(카타나, :514-524)
 *       base = (0, 0.10, 0)    // 츠바가 y=0.09
 *       tip  = (0, 1.10, 0.04) // 칼끝 콘이 y=1.06, 살짝 넘겨 잡는다
 *   - vrm-rig.ts buildWeapon() 원거리(지팡이, :531-538)
 *       base = (0, 0.46, 0)    // 상단 링(y=0.65) 아래 샤프트
 *       tip  = (0, 0.94, 0)    // 보주(ORB_Y=0.75) 위
 *   - characters.ts buildWola() 카타나(:311-317)
 *       base = (0, 0.05, 0)  /  tip = (0, 1.20, 0)
 *   - characters.ts buildLumen() 지팡이(:206-214)
 *       base = (0, 0.45, 0)  /  tip = (0, 0.92, 0)
 *
 *   `new THREE.Object3D()`는 렌더 비용이 0이다(지오메트리가 없으면 three가
 *   드로우 대상으로 잡지 않는다). 무기 그룹의 자식이라 스케일 보정
 *   (vrm-rig.ts:637의 1/handScale)도 자동으로 따라간다.
 *
 *   리그가 blade를 안 주면(폴백 프로시저럴 등) `setSource(null, null)`로 두면
 *   된다 — update()가 조용히 아무것도 안 하고 mesh.visible이 false로 남는다.
 *
 * [1] import
 *
 *     import { WeaponTrail } from './trails.ts'
 *
 * [2] 필드 + 상수
 *
 *     private readonly weaponTrail: WeaponTrail
 *
 *     // 클래스별 리본 성격. "달은 원을 파고, 해는 선을 긋는다"를 폭과 수명으로 지킨다.
 *     const TRAIL_OPTS: Record<PlayerClass, WeaponTrailOptions> = {
 *       // 카타나 날이 0.86유닛뿐이라 실측 폭 그대로면 캐릭터 13% 크기에서
 *       // 리본이 실처럼 보인다. 25% 넘겨 잡아야 호가 읽힌다.
 *       melee:  { color: 0xff5a6e, segments: 48, lifetime: 0.22, width: 1.25, intensity: 2.6 },
 *       // 지팡이는 휘두르지 않고 겨눈다. 짧고 좁아야 "선"으로 읽힌다.
 *       ranged: { color: 0x4dd0ff, segments: 32, lifetime: 0.14, width: 0.9,  intensity: 2.2 },
 *     }
 *
 * [3] 생성 — 생성자에서 `this.scene.add(this.charRig.group)` (renderer.ts:115) 다음
 *
 *     this.weaponTrail = new WeaponTrail(this.scene, TRAIL_OPTS[this.charClass])
 *     const blade0 = this.charRig.blade
 *     this.weaponTrail.setSource(blade0?.base ?? null, blade0?.tip ?? null)
 *
 *     부모는 scene이다. 정점을 월드 좌표로 쓰기 때문에 캐릭터 그룹에 붙이면
 *     캐릭터가 움직일 때 이미 남긴 궤적까지 같이 끌려간다.
 *
 * [4] 갱신 — render() 안, `this.charRig.update(now, length(p.vel))` (renderer.ts:316)
 *     **바로 다음 줄**. `this.enemyRenderer.update(...)` 보다 앞이다.
 *
 *     this.weaponTrail.update(now, dt)
 *
 *     반드시 charRig.update 뒤여야 한다. 리그가 이번 프레임 본 회전을 세운
 *     뒤에 읽어야 궤적이 칼과 같은 프레임에 놓인다. now·dt는 renderer.ts:284-286에
 *     이미 있는 값을 그대로 쓴다(dt는 0.1 클램프 — 이 모듈이 그 값에 맞춰
 *     스테일 판정을 한다).
 *
 * [5] 스윙 트리거 — consumeCharacterActions() 안,
 *     `this.charRig.playAction(next, now)` (renderer.ts:445) 다음 줄
 *
 *     // facingHold가 곧 모션 길이다(renderer.ts:431,440). 여기에 여운을 조금 더한다.
 *     this.weaponTrail.burst(facingHold + 0.06)
 *
 *     이벤트 배열은 읽기만 한다. 비우는 건 drainEvents(main.ts:189) 단독이고,
 *     audio.update(main.ts:187)가 같은 배열을 뒤에 읽으므로 절대 건드리면 안 된다.
 *     이 모듈은 애초에 world를 받지 않는다.
 *
 * [6] 클래스 교체 — swapCharacter() 안, 새 리그를 scene에 넣은 다음
 *
 *     this.weaponTrail.setColor(TRAIL_OPTS[cls].color)
 *     const blade = this.charRig.blade
 *     this.weaponTrail.setSource(blade?.base ?? null, blade?.tip ?? null)
 *     this.weaponTrail.reset()   // 이전 무기 위치와 이어 붙는 번짐을 끊는다
 *
 *     (색/발광만 바뀐다. segments·lifetime·width는 생성 시 고정이라 클래스마다
 *      다르게 하려면 dispose 후 재생성해야 한다 — 지오메트리가 100버텍스라
 *      한 판에 한 번 다시 만드는 비용은 무시해도 된다.)
 *
 * [7] 정리 — dispose() 안, `this.charRig.dispose()` (renderer.ts:463) 옆
 *
 *     this.weaponTrail.dispose()
 *
 * [8] 후처리(블룸)와의 관계
 *
 *     threshold 기반 "무료" 선택적 블룸을 쓰는 경우 추가 배선이 없다. intensity
 *     기본값 2.4가 안쪽 모서리 선형 휘도를 2.1 근처로 올려 threshold 0.9를
 *     넘긴다. 레이어 마스킹(2-컴포저)을 쓰기로 했다면 한 줄만 더:
 *
 *       this.weaponTrail.mesh.layers.enable(BLOOM_LAYER)
 *
 *     블룸이 아예 없는 품질 단계에서는 `setIntensity(1.2)`로 낮춘다 —
 *     블룸 없이 2.4를 그대로 쓰면 ACES가 흰색으로 뭉개 색이 날아간다.
 *
 * [9] 모바일 품질
 *
 *     생성 시 `segments`를 24, `lifetime`을 0.14로 낮추면 정점·업로드가 절반이
 *     된다. 완전히 끄려면 `setActive(false)`가 아니라 [5]의 burst 호출을 건너뛴다
 *     (setActive(false)는 burst가 다시 켜버린다).
 *
 * 비용: 드로우콜 +1 (스윙 중에만, 평상시 0). 삼각형 최대 96.
 *       업로드 프레임당 ≈1.6KB. 힙 할당 0.
 * --------------------------------------------------------------------------- */
