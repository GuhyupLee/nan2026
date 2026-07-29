import * as THREE from 'three'

/**
 * Short-lived hit sparks emitted by SkillFx.
 *
 * Animation is evaluated on the GPU from immutable spawn attributes. The CPU
 * only removes expired instances, so a busy frame still uses one draw call and
 * does not create garbage per particle or per frame.
 */

const CAPACITY = 192
const MIN_ACTIVE_LIMIT = 24
const MAX_BURSTS_PER_FRAME = 24
const COALESCE_DISTANCE_SQ = 0.18 * 0.18
const TAU = Math.PI * 2
const RENDER_ORDER = 24
const DEFAULT_RANDOM_SEED = 0x6d2b79f5

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;

  attribute vec3 aOrigin;
  attribute vec3 aVelocity;
  attribute vec4 aLife;
  attribute vec3 aColor;

  varying vec2 vUv;
  varying vec3 vColor;
  varying float vFade;

  void main() {
    float lifetime = max(aLife.y, 0.05);
    float age = clamp(uTime - aLife.x, 0.0, lifetime);
    float progress = age / lifetime;

    vec3 velocity = aVelocity + vec3(0.0, -9.2 * age, 0.0);
    vec3 world = aOrigin + aVelocity * age;
    world.y = max(0.06, world.y - 4.6 * age * age);

    vec4 viewCenter = viewMatrix * vec4(world, 1.0);
    vec2 projectedVelocity = (viewMatrix * vec4(velocity, 0.0)).xy;
    float projectedLength = length(projectedVelocity);
    vec2 direction =
      projectedLength > 0.0001 ? projectedVelocity / projectedLength : vec2(0.0, 1.0);

    // A small deterministic turn keeps a burst organic without a noise texture.
    float turn = (aLife.w - 0.5) * progress * 1.15;
    float turnSin = sin(turn);
    float turnCos = cos(turn);
    direction = mat2(turnCos, -turnSin, turnSin, turnCos) * direction;
    vec2 side = vec2(-direction.y, direction.x);

    float width = aLife.z * mix(0.72, 0.22, progress);
    float streak = aLife.z
      * (2.5 + min(projectedLength * 0.075, 1.25))
      * mix(1.0, 0.48, progress);
    viewCenter.xy +=
      side * position.x * width +
      direction * position.y * streak;

    vUv = uv;
    vColor = aColor;
    vFade = 1.0 - smoothstep(0.42, 1.0, progress);
    gl_Position = projectionMatrix * viewCenter;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vFade;

  void main() {
    vec2 p = abs(vUv * 2.0 - 1.0);
    float shard = 1.0 - smoothstep(0.48, 1.0, p.x + p.y * 0.34);
    float core = 1.0 - smoothstep(0.0, 0.28, p.x);
    float cap = 1.0 - smoothstep(0.72, 1.0, p.y);
    float alpha = shard * cap * vFade;
    if (alpha <= 0.002) discard;

    vec3 hot = mix(vColor, vec3(1.0, 0.97, 0.88), core * 0.72);
    gl_FragColor = vec4(hot * (0.9 + core * 1.15), alpha);
  }
`

type NumUniform = { value: number }

export class ImpactParticles {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>

  private readonly parent: THREE.Object3D
  private readonly geometry: THREE.InstancedBufferGeometry
  private readonly material: THREE.ShaderMaterial
  private readonly origins = new Float32Array(CAPACITY * 3)
  private readonly velocities = new Float32Array(CAPACITY * 3)
  /** birth time, lifetime, size, turn seed */
  private readonly lives = new Float32Array(CAPACITY * 4)
  private readonly colors = new Float32Array(CAPACITY * 3)
  private readonly frameBurstX = new Float32Array(MAX_BURSTS_PER_FRAME)
  private readonly frameBurstZ = new Float32Array(MAX_BURSTS_PER_FRAME)
  private readonly originAttr: THREE.InstancedBufferAttribute
  private readonly velocityAttr: THREE.InstancedBufferAttribute
  private readonly lifeAttr: THREE.InstancedBufferAttribute
  private readonly colorAttr: THREE.InstancedBufferAttribute
  private readonly timeUniform: NumUniform = { value: 0 }
  private readonly tint = new THREE.Color()
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly onMotionPreference = (): void => {
    // Do not leave a large, fast burst on screen after the preference changes.
    if (this.reducedMotion.matches) this.reset()
    this.refreshActiveLimit()
  }

  private count = 0
  private activeLimit = CAPACITY
  private burstBudget = MAX_BURSTS_PER_FRAME
  private frameBurstCount = 0
  private replacementCursor = 0
  private quality = 1
  private originTime = -1
  private currentTime = 0
  private randomState = DEFAULT_RANDOM_SEED
  private burstSerial = 0
  private disposed = false

  constructor(parent: THREE.Object3D) {
    this.parent = parent

    this.geometry = new THREE.InstancedBufferGeometry()
    this.geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([
        -1, -1, 0,
        1, -1, 0,
        1, 1, 0,
        -1, 1, 0,
      ], 3),
    )
    this.geometry.setAttribute(
      'uv',
      new THREE.Float32BufferAttribute([
        0, 0,
        1, 0,
        1, 1,
        0, 1,
      ], 2),
    )
    this.geometry.setIndex([0, 1, 2, 0, 2, 3])

    this.originAttr = new THREE.InstancedBufferAttribute(this.origins, 3)
    this.velocityAttr = new THREE.InstancedBufferAttribute(this.velocities, 3)
    this.lifeAttr = new THREE.InstancedBufferAttribute(this.lives, 4)
    this.colorAttr = new THREE.InstancedBufferAttribute(this.colors, 3)
    this.originAttr.setUsage(THREE.DynamicDrawUsage)
    this.velocityAttr.setUsage(THREE.DynamicDrawUsage)
    this.lifeAttr.setUsage(THREE.DynamicDrawUsage)
    this.colorAttr.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('aOrigin', this.originAttr)
    this.geometry.setAttribute('aVelocity', this.velocityAttr)
    this.geometry.setAttribute('aLife', this.lifeAttr)
    this.geometry.setAttribute('aColor', this.colorAttr)
    this.geometry.instanceCount = 0

    this.material = new THREE.ShaderMaterial({
      uniforms: { uTime: this.timeUniform },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.mesh.renderOrder = RENDER_ORDER
    this.mesh.frustumCulled = false
    this.mesh.matrixAutoUpdate = false
    this.mesh.updateMatrix()
    this.mesh.castShadow = false
    this.mesh.receiveShadow = false
    this.mesh.visible = false
    parent.add(this.mesh)

    this.reducedMotion.addEventListener('change', this.onMotionPreference)
    this.refreshActiveLimit()
  }

  /**
   * Emits a directional fan with a few radial shards.
   * All storage is preallocated; a saturated pool overwrites in round-robin order.
   */
  burst(x: number, z: number, angle: number, color: number): void {
    if (
      this.disposed ||
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      !Number.isFinite(angle)
    ) {
      return
    }

    // Several SkillFx paths can report the same endpoint in one frame.
    // Coalesce them before touching the particle buffers.
    for (let i = 0; i < this.frameBurstCount; i++) {
      const dx = x - this.frameBurstX[i]!
      const dz = z - this.frameBurstZ[i]!
      if (dx * dx + dz * dz <= COALESCE_DISTANCE_SQ) return
    }
    if (this.frameBurstCount >= this.burstBudget) return
    this.frameBurstX[this.frameBurstCount] = x
    this.frameBurstZ[this.frameBurstCount] = z
    this.frameBurstCount++

    const reduced = this.reducedMotion.matches
    const qualityCount = 3 + Math.round(this.quality * 4)
    const particleCount = reduced
      ? Math.max(2, Math.round(qualityCount * 0.36))
      : qualityCount
    const motionScale = reduced ? 0.38 : 0.78 + this.quality * 0.22
    const lifetimeScale = reduced ? 0.64 : 1

    this.tint.setHex(color & 0xffffff)
    const baseR = this.tint.r
    const baseG = this.tint.g
    const baseB = this.tint.b
    const warm = baseR > baseB * 1.04
    const accentR = warm ? 1 : 0.72
    const accentG = warm ? 0.68 : 0.94
    const accentB = warm ? 0.2 : 1

    const salt =
      (Math.round(x * 64) ^
        Math.imul(Math.round(z * 64), 0x45d9f3b) ^
        Math.imul(++this.burstSerial, 0x27d4eb2d)) >>>
      0
    this.randomState = (this.randomState ^ salt) >>> 0
    if (this.randomState === 0) this.randomState = DEFAULT_RANDOM_SEED

    const sideX = -Math.sin(angle)
    const sideZ = Math.cos(angle)
    for (let i = 0; i < particleCount; i++) {
      const index = this.acquireIndex()
      const radial = i % 4 === 3
      const direction =
        i === 0
          ? angle
          : radial
            ? this.random() * TAU
            : angle + (this.random() - 0.5) * Math.PI * 1.55
      const speed =
        (i === 0 ? 10.8 : 4.1 + this.random() * 5.9) * motionScale
      const lateral = (this.random() - 0.5) * 0.55
      const originOffset = index * 3
      this.origins[originOffset] = x + sideX * lateral
      this.origins[originOffset + 1] = 0.38 + this.random() * 0.56
      this.origins[originOffset + 2] = z + sideZ * lateral
      this.velocities[originOffset] = Math.cos(direction) * speed
      this.velocities[originOffset + 1] =
        (2.7 + this.random() * 4.8) * motionScale
      this.velocities[originOffset + 2] = Math.sin(direction) * speed

      const lifeOffset = index * 4
      this.lives[lifeOffset] = this.currentTime - this.random() * 0.012
      this.lives[lifeOffset + 1] =
        (0.2 + this.random() * 0.17) * lifetimeScale
      this.lives[lifeOffset + 2] =
        (i === 0 ? 0.24 : 0.12 + this.random() * 0.12) *
        (0.88 + this.quality * 0.12)
      this.lives[lifeOffset + 3] = this.random()

      const accentMix = i % 4 === 0 ? 0.44 : this.random() * 0.12
      this.colors[originOffset] = baseR + (accentR - baseR) * accentMix
      this.colors[originOffset + 1] = baseG + (accentG - baseG) * accentMix
      this.colors[originOffset + 2] = baseB + (accentB - baseB) * accentMix
    }

    this.geometry.instanceCount = this.count
    this.mesh.visible = this.count > 0
    this.markAttributesChanged()
  }

  /**
   * Advances only the shared clock and removes expired packed instances.
   * Particle positions and fading are evaluated in the vertex shader.
   */
  update(now: number): void {
    if (this.disposed || !Number.isFinite(now)) return
    this.frameBurstCount = 0
    if (this.originTime < 0) this.originTime = now
    this.currentTime = Math.max(this.currentTime, now - this.originTime)
    this.timeUniform.value = this.currentTime

    let moved = false
    let i = 0
    while (i < this.count) {
      const lifeOffset = i * 4
      if (
        this.currentTime - this.lives[lifeOffset]! <
        this.lives[lifeOffset + 1]!
      ) {
        i++
        continue
      }

      const last = this.count - 1
      if (i !== last) {
        this.copyParticle(last, i)
        moved = true
      }
      this.count = last
    }

    if (this.replacementCursor >= this.count) this.replacementCursor = 0
    this.geometry.instanceCount = this.count
    this.mesh.visible = this.count > 0
    if (moved) this.markAttributesChanged()
  }

  /** 0..1 quality controls both per-burst density and the live pool ceiling. */
  setQuality(level: number): void {
    if (this.disposed) return
    this.quality = THREE.MathUtils.clamp(level, 0, 1)
    this.refreshActiveLimit()
  }

  reset(): void {
    if (this.disposed) return
    this.count = 0
    this.replacementCursor = 0
    this.originTime = -1
    this.currentTime = 0
    this.timeUniform.value = 0
    this.randomState = DEFAULT_RANDOM_SEED
    this.burstSerial = 0
    this.frameBurstCount = 0
    this.geometry.instanceCount = 0
    this.mesh.visible = false
  }

  dispose(): void {
    if (this.disposed) return
    this.reset()
    this.disposed = true
    this.reducedMotion.removeEventListener('change', this.onMotionPreference)
    this.parent.remove(this.mesh)
    this.geometry.dispose()
    this.material.dispose()
  }

  private refreshActiveLimit(): void {
    const qualityLimit = Math.round(CAPACITY * (0.25 + this.quality * 0.75))
    const motionScale = this.reducedMotion.matches ? 0.45 : 1
    this.activeLimit = Math.max(
      MIN_ACTIVE_LIMIT,
      Math.min(CAPACITY, Math.round(qualityLimit * motionScale)),
    )
    const qualityBurstBudget = Math.max(
      6,
      Math.round(3 + this.quality * (MAX_BURSTS_PER_FRAME - 3)),
    )
    this.burstBudget = this.reducedMotion.matches
      ? Math.min(8, qualityBurstBudget)
      : qualityBurstBudget
    if (this.count > this.activeLimit) {
      this.count = this.activeLimit
      this.geometry.instanceCount = this.count
      this.mesh.visible = this.count > 0
    }
    if (this.replacementCursor >= this.count) this.replacementCursor = 0
  }

  private acquireIndex(): number {
    if (this.count < this.activeLimit) {
      const index = this.count
      this.count++
      return index
    }
    const index = this.replacementCursor
    this.replacementCursor = (this.replacementCursor + 1) % this.count
    return index
  }

  private copyParticle(from: number, to: number): void {
    const from3 = from * 3
    const to3 = to * 3
    this.origins[to3] = this.origins[from3]!
    this.origins[to3 + 1] = this.origins[from3 + 1]!
    this.origins[to3 + 2] = this.origins[from3 + 2]!
    this.velocities[to3] = this.velocities[from3]!
    this.velocities[to3 + 1] = this.velocities[from3 + 1]!
    this.velocities[to3 + 2] = this.velocities[from3 + 2]!
    this.colors[to3] = this.colors[from3]!
    this.colors[to3 + 1] = this.colors[from3 + 1]!
    this.colors[to3 + 2] = this.colors[from3 + 2]!

    const from4 = from * 4
    const to4 = to * 4
    this.lives[to4] = this.lives[from4]!
    this.lives[to4 + 1] = this.lives[from4 + 1]!
    this.lives[to4 + 2] = this.lives[from4 + 2]!
    this.lives[to4 + 3] = this.lives[from4 + 3]!
  }

  private markAttributesChanged(): void {
    this.originAttr.needsUpdate = true
    this.velocityAttr.needsUpdate = true
    this.lifeAttr.needsUpdate = true
    this.colorAttr.needsUpdate = true
  }

  private random(): number {
    let state = this.randomState
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    this.randomState = state >>> 0
    return this.randomState / 0x100000000
  }
}
