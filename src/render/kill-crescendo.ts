import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * 연속 처치는 정보 문구가 아니라 전투의 리듬으로 느껴져야 한다.
 *
 * 이 파일은 두 층으로 나뉜다.
 * - KillCadenceTracker: DOM·three.js와 무관한 순수 누적 규칙. 렌더와 오디오가
 *   같은 0.9초 창과 같은 티어를 사용한다.
 * - KillCrescendoFx: Blender가 만든 한 개의 스킨 메시와 한 개의 지면 셰이더로
 *   티어 상승을 보여 준다. 평상시에는 둘 다 invisible이라 draw call이 0이다.
 */

export const KILL_CADENCE_GAP = 0.9
export const KILL_CADENCE_THRESHOLDS = [10, 20, 35, 60] as const

export type KillCadenceTier = 0 | 1 | 2 | 3

export interface KillCadenceBeat {
  tier: KillCadenceTier
  count: number
  delta: number
}

export class KillCadenceTracker {
  private initialized = false
  private totalKills = 0
  private count = 0
  private lastKillAt = Number.NEGATIVE_INFINITY
  private tierValue = -1

  /**
   * 새 런이나 QA 스냅샷을 조용히 기준선으로 삼는다.
   * 이미 318킬인 결과 화면을 첫 프레임에 최고 티어로 오인하지 않기 위해서다.
   */
  reset(totalKills = 0, _now = 0): void {
    this.initialized = true
    this.totalKills = Math.max(0, Math.floor(totalKills))
    this.count = 0
    this.lastKillAt = Number.NEGATIVE_INFINITY
    this.tierValue = -1
  }

  /** 누적 직접 처치 수를 관찰하고 새 티어를 넘은 순간에만 한 번 반환한다. */
  observe(
    totalKills: number,
    now: number,
  ): KillCadenceBeat | null {
    const nextTotal = Math.max(0, Math.floor(totalKills))
    const safeNow = Number.isFinite(now) ? now : 0

    if (!this.initialized || nextTotal < this.totalKills) {
      this.reset(nextTotal, safeNow)
      return null
    }

    const delta = nextTotal - this.totalKills
    this.totalKills = nextTotal

    if (delta <= 0) {
      this.expire(safeNow)
      return null
    }
    if (safeNow - this.lastKillAt > KILL_CADENCE_GAP) {
      this.count = 0
      this.tierValue = -1
    }
    this.count += delta
    this.lastKillAt = safeNow

    let nextTier = -1
    for (let i = KILL_CADENCE_THRESHOLDS.length - 1; i >= 0; i--) {
      if (this.count >= KILL_CADENCE_THRESHOLDS[i]!) {
        nextTier = i
        break
      }
    }
    if (nextTier <= this.tierValue) return null

    this.tierValue = nextTier
    return nextTier < 0
      ? null
      : {
          tier: nextTier as KillCadenceTier,
          count: this.count,
          delta,
        }
  }

  /** 현재 시간창이 살아 있을 때만 0..3, 아니면 -1. */
  get activeTier(): number {
    return this.tierValue
  }

  get chainCount(): number {
    return this.count
  }

  private expire(now: number): void {
    if (now - this.lastKillAt <= KILL_CADENCE_GAP) return
    this.count = 0
    this.tierValue = -1
  }
}

const PULSE_DURATION = 1.15
const GOLD = new THREE.Color(0xffc96b)

const WAVE_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const WAVE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uProgress;
  uniform float uTier;
  uniform float uMotion;

  varying vec2 vUv;

  float band(float value, float center, float width) {
    return 1.0 - smoothstep(width, width + 0.018, abs(value - center));
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float radius = length(p);
    if (radius > 1.0) discard;

    float angle = atan(p.y, p.x);
    float eased = 1.0 - pow(1.0 - uProgress, 3.0);
    float front = mix(0.18, 0.92, eased);
    float outer = band(radius, front, mix(0.055, 0.018, eased));
    float inner = band(radius, front * 0.68, 0.016) * (1.0 - uProgress);

    float turns = angle * (2.0 + uTier) + eased * 5.2 * uMotion;
    float petals = smoothstep(0.52, 0.96, cos(turns));
    float petalBand = band(radius, mix(0.32, 0.78, eased), 0.07) * petals;

    // 완전한 원보다 일부가 비어 있는 호가 검격과 초승 문법으로 읽힌다.
    float cut = smoothstep(-0.38, 0.12, cos(angle - eased * 1.6 * uMotion));
    float alpha = (outer * (0.55 + cut * 0.65) + inner * 0.42 + petalBand * 0.48)
      * uOpacity;
    if (alpha <= 0.002) discard;

    vec3 hot = mix(uColor, vec3(1.0, 0.87, 0.58), 0.35 + outer * 0.28);
    gl_FragColor = vec4(hot * (1.35 + outer * 0.9), alpha);
  }
`

type PulseUniforms = {
  uColor: { value: THREE.Color }
  uOpacity: { value: number }
  uProgress: { value: number }
  uTier: { value: number }
  uMotion: { value: number }
}

type GlowMaterial = THREE.MeshStandardMaterial | THREE.MeshBasicMaterial

/**
 * Blender 스킨 메시 + Three.js 지면 파동.
 *
 * 모델 로딩은 게임 시작을 막지 않는다. 파일이 늦거나 실패해도 한 드로우짜리
 * 지면 파동은 즉시 작동하고, 모델이 도착하면 다음 티어부터 자연스럽게 합류한다.
 */
export class KillCrescendoFx {
  readonly ready: Promise<boolean>

  private readonly parent: THREE.Object3D
  private readonly group = new THREE.Group()
  private readonly wave: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private readonly uniforms: PulseUniforms
  private readonly reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  )
  private readonly tint = new THREE.Color()
  private readonly materials: GlowMaterial[] = []

  private model: THREE.Object3D | null = null
  private mixer: THREE.AnimationMixer | null = null
  private action: THREE.AnimationAction | null = null
  private disposed = false
  private quality = 1
  private pulseLeft = 0
  private pulseTier: KillCadenceTier = 0
  private flowTier = -1
  private flowAmount = 0
  private modelSpin = 0

  constructor(parent: THREE.Object3D, baseUrl: string) {
    this.parent = parent
    this.group.name = 'kill-crescendo'
    this.group.visible = false
    parent.add(this.group)

    this.uniforms = {
      uColor: { value: new THREE.Color(0xffffff) },
      uOpacity: { value: 0 },
      uProgress: { value: 0 },
      uTier: { value: 0 },
      uMotion: { value: 1 },
    }
    const waveMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: WAVE_VERTEX_SHADER,
      fragmentShader: WAVE_FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      fog: false,
    })
    this.wave = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), waveMaterial)
    this.wave.name = 'kill-crescendo-wave'
    this.wave.rotation.x = -Math.PI / 2
    this.wave.position.y = 0.055
    this.wave.renderOrder = 17
    this.wave.frustumCulled = false
    this.wave.castShadow = false
    this.wave.receiveShadow = false
    this.wave.visible = false
    this.group.add(this.wave)

    const loader = new GLTFLoader()
    this.ready = loader
      .loadAsync(`${baseUrl}env/moonflow-crescendo.glb`)
      .then((gltf) => {
        if (this.disposed) {
          this.disposeLoadedScene(gltf.scene)
          return false
        }
        this.installModel(gltf.scene, gltf.animations)
        return true
      })
      .catch((error: unknown) => {
        if (import.meta.env.DEV) {
          console.warn('[fx] 연참 Blender 문양을 불러오지 못했습니다', error)
        }
        return false
      })
  }

  trigger(tier: KillCadenceTier, color: THREE.ColorRepresentation): void {
    if (this.disposed) return
    this.pulseTier = tier
    this.pulseLeft = PULSE_DURATION
    this.setTint(color)
    this.group.visible = true
    this.wave.visible = true
    this.playModelClip()
  }

  /** 같은 티어 안의 처치는 새 폭발 없이 낮은 오라만 유지한다. */
  setFlow(tier: number): void {
    this.flowTier = tier
  }

  update(x: number, z: number, dt: number): void {
    if (this.disposed) return
    if (
      this.pulseLeft <= 0 &&
      this.flowTier < 0 &&
      this.flowAmount <= 0.004
    ) {
      this.flowAmount = 0
      this.wave.visible = false
      this.group.visible = false
      if (this.model) this.model.visible = false
      if (this.action?.isRunning()) this.action.stop()
      return
    }

    const safeDt = THREE.MathUtils.clamp(dt, 0, 0.1)
    this.group.position.set(x, 0, z)

    const flowTarget = this.flowTier >= 0
      ? (0.13 + this.flowTier * 0.035) * (0.72 + this.quality * 0.28)
      : 0
    const flowRate = flowTarget > this.flowAmount ? 11 : 5.5
    this.flowAmount +=
      (flowTarget - this.flowAmount) * (1 - Math.exp(-flowRate * safeDt))

    let pulseOpacity = 0
    if (this.pulseLeft > 0) {
      this.pulseLeft = Math.max(0, this.pulseLeft - safeDt)
      const progress = 1 - this.pulseLeft / PULSE_DURATION
      const entrance = Math.min(1, progress / 0.16)
      pulseOpacity =
        Math.sin(entrance * Math.PI * 0.5) *
        (1 - progress) *
        (0.78 + this.pulseTier * 0.07) *
        (0.72 + this.quality * 0.28)
      this.uniforms.uProgress.value = progress
      this.uniforms.uOpacity.value = pulseOpacity
      this.uniforms.uTier.value = this.pulseTier
      const radius = 3.5 + this.pulseTier * 0.48
      this.wave.scale.setScalar(radius)
      this.wave.visible = pulseOpacity > 0.002
    } else {
      this.wave.visible = false
      this.uniforms.uOpacity.value = 0
    }

    const modelOpacity =
      this.quality >= 0.7
        ? Math.max(
            this.flowAmount,
            pulseOpacity * (0.8 + this.pulseTier * 0.04),
          )
        : 0
    if (this.model) {
      const motion = this.reducedMotion.matches ? 0.08 : 1
      this.modelSpin +=
        safeDt * motion * (0.18 + Math.max(0, this.flowTier) * 0.035)
      this.model.rotation.y = this.modelSpin
      this.model.visible = modelOpacity > 0.004
      const scale =
        (0.82 + Math.max(0, this.pulseTier) * 0.08) *
        (this.reducedMotion.matches ? 0.9 : 1)
      this.model.scale.setScalar(scale)
      for (const material of this.materials) {
        material.opacity = modelOpacity
        if (material instanceof THREE.MeshStandardMaterial) {
          material.emissiveIntensity =
            1.7 + modelOpacity * (2.2 + this.pulseTier * 0.5)
        }
      }
    }

    if (
      this.mixer &&
      this.model?.visible &&
      this.action?.isRunning() &&
      !this.reducedMotion.matches
    ) {
      this.mixer.update(safeDt)
    }

    this.group.visible =
      this.wave.visible ||
      (this.model?.visible ?? false) ||
      this.flowAmount > 0.004
  }

  setQuality(level: number): void {
    this.quality = THREE.MathUtils.clamp(level, 0, 1)
  }

  reset(): void {
    this.pulseLeft = 0
    this.flowTier = -1
    this.flowAmount = 0
    this.modelSpin = 0
    this.wave.visible = false
    this.group.visible = false
    if (this.model) {
      this.model.visible = false
      this.model.rotation.y = 0
    }
    this.action?.stop()
    this.mixer?.setTime(0)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.reset()
    this.parent.remove(this.group)
    this.wave.geometry.dispose()
    this.wave.material.dispose()
    if (this.mixer && this.model) {
      this.mixer.stopAllAction()
      this.mixer.uncacheRoot(this.model)
    }
    if (this.model) this.disposeLoadedScene(this.model)
    this.materials.length = 0
    this.mixer = null
    this.action = null
    this.model = null
  }

  private installModel(
    model: THREE.Object3D,
    clips: readonly THREE.AnimationClip[],
  ): void {
    const replacements = new Map<THREE.Material, GlowMaterial>()
    model.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      node.castShadow = false
      node.receiveShadow = false
      node.renderOrder = 18
      node.frustumCulled = false

      const sources = Array.isArray(node.material)
        ? node.material
        : [node.material]
      const rebound = sources.map((source) => {
        const cached = replacements.get(source)
        if (cached) return cached
        const material = source.clone() as GlowMaterial
        material.transparent = true
        material.opacity = 0
        material.depthWrite = false
        material.blending = THREE.AdditiveBlending
        if (material instanceof THREE.MeshStandardMaterial) {
          material.emissive.copy(GOLD)
          material.emissiveIntensity = 1.7
          material.roughness = Math.min(material.roughness, 0.42)
        }
        replacements.set(source, material)
        this.materials.push(material)
        source.dispose()
        return material
      })
      node.material = Array.isArray(node.material) ? rebound : rebound[0]!
    })

    model.name = 'moonflow-crescendo-model'
    // Blender의 X/Z 평면은 glTF에서 X/Y(수직)로 변환된다. YXZ 순서로
    // 눕혀 둔 뒤 Y 회전만 갱신하면 지면 법선을 유지한 채 문양이 돈다.
    model.rotation.order = 'YXZ'
    model.rotation.x = -Math.PI * 0.5
    model.position.y = 0.11
    model.visible = false
    this.model = model
    this.group.add(model)

    const clip =
      clips.find((candidate) => candidate.name.includes('moonflow-crescendo')) ??
      clips[0]
    if (clip) {
      this.mixer = new THREE.AnimationMixer(model)
      this.action = this.mixer.clipAction(clip)
      this.action.setLoop(THREE.LoopOnce, 1)
      this.action.clampWhenFinished = true
    }

    this.setTint(this.uniforms.uColor.value)
    if (this.pulseLeft > 0) this.playModelClip()
  }

  private playModelClip(): void {
    if (!this.action || !this.mixer || this.quality < 0.7) return
    this.action.reset()
    this.action.enabled = true
    this.action.paused = false
    this.action.setEffectiveTimeScale(1 + this.pulseTier * 0.08)
    this.action.play()
    if (this.reducedMotion.matches) {
      // 회전은 재우되 문양 자체는 남겨 의미를 보존한다.
      this.mixer.setTime(this.action.getClip().duration * 0.72)
      this.action.paused = true
    }
  }

  private setTint(color: THREE.ColorRepresentation): void {
    this.tint.set(color).lerp(GOLD, 0.22 + this.pulseTier * 0.08)
    this.uniforms.uColor.value.copy(this.tint)
    this.uniforms.uMotion.value = this.reducedMotion.matches ? 0.12 : 1
    for (const material of this.materials) {
      material.color.copy(this.tint)
      if (material instanceof THREE.MeshStandardMaterial) {
        material.emissive.copy(this.tint).lerp(GOLD, 0.38)
      }
    }
  }

  private disposeLoadedScene(root: THREE.Object3D): void {
    const skeletons = new Set<THREE.Skeleton>()
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      node.geometry.dispose()
      if (
        node instanceof THREE.SkinnedMesh &&
        !skeletons.has(node.skeleton)
      ) {
        skeletons.add(node.skeleton)
        node.skeleton.dispose()
      }
      const materials = Array.isArray(node.material)
        ? node.material
        : [node.material]
      for (const material of materials) material.dispose()
    })
  }
}
