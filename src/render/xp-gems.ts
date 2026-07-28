import * as THREE from 'three'

import { MAX_XP_GEMS, type XpGemPool } from '../sim/xp-gems.ts'

/**
 * XP pickups are rendered as procedural, camera-facing jewels.
 *
 * The fixed simulation pool maps into one instanced quad draw. Shape, facets,
 * halo, bobbing and attraction trails are all evaluated in the shaders, so the
 * per-frame CPU path only refreshes three preallocated attribute arrays.
 */

const CAPACITY = MAX_XP_GEMS
const CONSTRAINED_CAPACITY = 192
const RENDER_ORDER = 1

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uMotion;

  attribute vec3 aOrigin;
  attribute vec3 aMotion;
  attribute vec4 aStyle;

  varying vec2 vUv;
  varying vec2 vMotionDirection;
  varying float vAttraction;
  varying float vIntensity;
  varying float vPulse;
  varying float vPhase;

  void main() {
    float phase = aStyle.z * 6.28318530718;
    float bob = sin(uTime * 2.35 + phase) * 0.085 * uMotion;
    float sway = sin(uTime * 1.45 + phase * 1.31) * 0.035 * uMotion;
    float pulse =
      1.0 +
      sin(uTime * 3.1 + phase * 0.83) * 0.035 * uMotion;

    vec3 world = aOrigin;
    world.y += bob;
    vec4 viewCenter = viewMatrix * vec4(world, 1.0);

    vec2 viewMotion =
      (viewMatrix * vec4(aMotion.x, 0.0, aMotion.y, 0.0)).xy;
    float viewSpeed = length(viewMotion);
    vec2 direction =
      viewSpeed > 0.0001 ? viewMotion / viewSpeed : vec2(0.0, 1.0);
    float attraction =
      aMotion.z *
      smoothstep(0.012, 0.32, viewSpeed) *
      uMotion;

    // A tiny lean and a generous quad leave room for the comet-like pickup
    // trail without changing the jewel silhouette itself.
    viewCenter.xy += vec2(sway * aStyle.x, 0.0);
    viewCenter.xy += direction * attraction * aStyle.x * 0.055;
    float width = aStyle.x * pulse * (0.96 + attraction * 0.08);
    float height = aStyle.x * pulse * (1.18 + attraction * 0.08);
    viewCenter.xy += vec2(position.x * width, position.y * height);

    vUv = uv;
    vMotionDirection = direction;
    vAttraction = attraction;
    vIntensity = aStyle.y;
    vPulse = pulse;
    vPhase = phase;
    gl_Position = projectionMatrix * viewCenter;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uMotion;

  varying vec2 vUv;
  varying vec2 vMotionDirection;
  varying float vAttraction;
  varying float vIntensity;
  varying float vPulse;
  varying float vPhase;

  void main() {
    vec2 p = vUv * 2.0 - 1.0;

    // Tall, cut-crystal silhouette. The two nested diamonds form an emissive
    // rim and a pale cyan core while diagonal masks imply four polished facets.
    float diamondDistance = abs(p.x) * 1.52 + abs(p.y) * 0.82;
    float body = 1.0 - smoothstep(0.76, 0.84, diamondDistance);
    float inner = 1.0 - smoothstep(0.42, 0.62, diamondDistance);
    float rim = max(0.0, body - inner * 0.72);
    float leftFacet = body * smoothstep(-0.72, 0.08, -p.x);
    float upperFacet = body * smoothstep(-0.74, 0.06, p.y);
    float centerCut =
      body *
      (1.0 - smoothstep(0.015, 0.12, abs(p.x))) *
      (1.0 - smoothstep(0.72, 0.96, abs(p.y)));

    float radius = length(p * vec2(0.93, 0.76));
    float halo = exp(-4.0 * radius * radius) * (1.0 - body * 0.58);
    float corona =
      (1.0 - smoothstep(0.32, 0.92, radius)) *
      (1.0 - smoothstep(0.0, 0.16, abs(radius - 0.56))) *
      0.16;

    // Attracted gems pull a short screen-space light ribbon behind their real
    // interpolated movement. It communicates magnetism without adding meshes.
    vec2 trailSide = vec2(-vMotionDirection.y, vMotionDirection.x);
    float behind = dot(p, -vMotionDirection);
    float across = abs(dot(p, trailSide));
    float trail =
      vAttraction *
      smoothstep(0.03, 0.18, behind) *
      (1.0 - smoothstep(0.54, 0.96, behind)) *
      (1.0 - smoothstep(0.035, 0.24, across));
    float trailCore =
      trail * (1.0 - smoothstep(0.015, 0.075, across));

    float shimmer =
      0.96 +
      0.04 * sin(uTime * 4.4 + vPhase + p.y * 4.0) * uMotion;
    vec3 deepBlue = vec3(0.015, 0.24, 0.92);
    vec3 cyan = vec3(0.06, 0.82, 1.0);
    vec3 ice = vec3(0.76, 0.98, 1.0);
    vec3 facet = mix(deepBlue, cyan, upperFacet * 0.46 + leftFacet * 0.24);
    facet = mix(facet, ice, inner * 0.58 + centerCut * 0.32);

    vec3 color =
      facet * body * (1.05 + rim * 0.72) +
      cyan * (halo * 0.88 + corona) +
      mix(deepBlue, cyan, trailCore) * trail * 0.9;
    float alpha =
      body * 0.96 +
      halo * 0.48 +
      corona * 0.3 +
      trail * 0.52;
    alpha *= min(1.0, vPulse * 0.98);

    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color * vIntensity * shimmer, min(alpha, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

type NumUniform = { value: number }

export class XpGemRenderer {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>

  private readonly parent: THREE.Object3D
  private readonly geometry: THREE.InstancedBufferGeometry
  private readonly material: THREE.ShaderMaterial
  private readonly origins = new Float32Array(CAPACITY * 3)
  /** interpolated tick movement x/z, attracted flag */
  private readonly motions = new Float32Array(CAPACITY * 3)
  /** size, intensity, stable phase, reserved */
  private readonly styles = new Float32Array(CAPACITY * 4)
  private readonly originAttr: THREE.InstancedBufferAttribute
  private readonly motionAttr: THREE.InstancedBufferAttribute
  private readonly styleAttr: THREE.InstancedBufferAttribute
  private readonly timeUniform: NumUniform = { value: 0 }
  private readonly motionUniform: NumUniform
  private readonly reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  )
  private readonly onMotionPreference = (): void => {
    this.motionUniform.value = this.reducedMotion.matches ? 0 : 1
  }

  private activeLimit = CAPACITY
  private originTime = -1
  private currentTime = 0
  private disposed = false

  constructor(parent: THREE.Object3D) {
    this.parent = parent
    this.motionUniform = { value: this.reducedMotion.matches ? 0 : 1 }

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
    this.motionAttr = new THREE.InstancedBufferAttribute(this.motions, 3)
    this.styleAttr = new THREE.InstancedBufferAttribute(this.styles, 4)
    this.originAttr.setUsage(THREE.DynamicDrawUsage)
    this.motionAttr.setUsage(THREE.DynamicDrawUsage)
    this.styleAttr.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('aOrigin', this.originAttr)
    this.geometry.setAttribute('aMotion', this.motionAttr)
    this.geometry.setAttribute('aStyle', this.styleAttr)
    this.geometry.instanceCount = 0

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.timeUniform,
        uMotion: this.motionUniform,
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
      // The camera-facing quad has stable front-face winding. Keeping it
      // FrontSide avoids Three's two-pass path for transparent DoubleSide.
      side: THREE.FrontSide,
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
  }

  /**
   * Refreshes the packed render view. Attracted gems are written first so the
   * mobile cap never hides the pickups currently flying toward the player.
   */
  update(pool: XpGemPool, alpha: number, now: number): void {
    if (this.disposed || !Number.isFinite(now)) return

    if (this.originTime < 0) this.originTime = now
    this.currentTime = Math.max(this.currentTime, now - this.originTime)
    this.timeUniform.value = this.currentTime

    const blend = !Number.isFinite(alpha)
      ? 0
      : alpha <= 0
        ? 0
        : alpha >= 1
          ? 1
          : alpha
    const sourceCount = Math.min(
      pool.count,
      pool.x.length,
      pool.y.length,
      pool.prevX.length,
      pool.prevY.length,
      pool.value.length,
      pool.attracted.length,
    )
    let rendered = 0

    for (let pass = 1; pass >= 0 && rendered < this.activeLimit; pass -= 1) {
      for (
        let source = 0;
        source < sourceCount && rendered < this.activeLimit;
        source += 1
      ) {
        if (pool.attracted[source] !== pass) continue

        const currentX = pool.x[source]!
        const currentZ = pool.y[source]!
        const previousX = pool.prevX[source]!
        const previousZ = pool.prevY[source]!
        const value = pool.value[source]!
        if (
          !Number.isFinite(currentX) ||
          !Number.isFinite(currentZ) ||
          !Number.isFinite(previousX) ||
          !Number.isFinite(previousZ) ||
          !(value > 0) ||
          !Number.isFinite(value)
        ) {
          continue
        }

        const x = previousX + (currentX - previousX) * blend
        const z = previousZ + (currentZ - previousZ) * blend
        const valueTier = Math.min(1, Math.log2(1 + value) * 0.27)
        const offset3 = rendered * 3
        const offset4 = rendered * 4
        this.origins[offset3] = x
        this.origins[offset3 + 1] = 0.62 + valueTier * 0.035
        this.origins[offset3 + 2] = z
        this.motions[offset3] = currentX - previousX
        this.motions[offset3 + 1] = currentZ - previousZ
        this.motions[offset3 + 2] = pass
        this.styles[offset4] = 0.43 + valueTier * 0.13
        this.styles[offset4 + 1] = 1.02 + valueTier * 0.24
        this.styles[offset4 + 2] = this.stablePhase(source)
        this.styles[offset4 + 3] = 0
        rendered += 1
      }
    }

    this.geometry.instanceCount = rendered
    this.mesh.visible = rendered > 0
    if (rendered > 0) this.markAttributesChanged()
  }

  /** Desktop shows the full pool; constrained devices keep one representative half. */
  setQuality(level: number): void {
    if (this.disposed) return
    this.activeLimit =
      Number.isFinite(level) && level >= 0.75
        ? CAPACITY
        : CONSTRAINED_CAPACITY
    if (this.geometry.instanceCount > this.activeLimit) {
      this.geometry.instanceCount = this.activeLimit
    }
  }

  reset(): void {
    if (this.disposed) return
    this.originTime = -1
    this.currentTime = 0
    this.timeUniform.value = 0
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

  private stablePhase(source: number): number {
    // Position cannot participate here: attracted gems move every tick, which
    // would otherwise retime their bob and shimmer while they are in flight.
    const phase = source * 0.61803398875
    return phase - Math.floor(phase)
  }

  private markAttributesChanged(): void {
    this.originAttr.needsUpdate = true
    this.motionAttr.needsUpdate = true
    this.styleAttr.needsUpdate = true
  }
}
