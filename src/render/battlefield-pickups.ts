import * as THREE from 'three'

import {
  BATTLEFIELD_PICKUP_LIFETIME,
  MAX_BATTLEFIELD_PICKUPS,
  PICKUP_BOMB,
  PICKUP_HEAL,
  PICKUP_MAGNET,
  type BattlefieldPickupKind,
  type BattlefieldPickupPool,
} from '../sim/battlefield-pickups.ts'

/**
 * Battlefield utility drops use one instanced draw for both their real
 * ground-plane ring and their camera-facing airborne sigil.
 *
 * The pool is deliberately tiny, so every valid pickup remains visible on
 * constrained devices. Quality only trims secondary shader detail.
 */

const CAPACITY = MAX_BATTLEFIELD_PICKUPS
const RENDER_ORDER = 2
const EFFECT_NONE = -1

const HEAL_EFFECT_DURATION = 0.42
const MAGNET_EFFECT_DURATION = 0.72
const BOMB_EFFECT_DURATION = 0.9

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uSimTime;
  uniform float uMotion;

  attribute float aPart;
  attribute vec3 aOrigin;
  attribute vec4 aStyle;

  varying vec2 vUv;
  varying float vPart;
  varying float vKind;
  varying float vLife;
  varying float vWarning;
  varying float vPhase;
  varying float vEffect;
  varying float vProgress;

  void main() {
    float kind = aStyle.x;
    float effect = step(0.5, aStyle.w);
    float phase = aStyle.z * 6.28318530718;
    float age = max(0.0, uSimTime - aStyle.y);
    float remaining = ${BATTLEFIELD_PICKUP_LIFETIME.toFixed(1)} - age;
    float life =
      smoothstep(0.0, 4.8, remaining) *
      smoothstep(0.0, 0.22, age + 0.05);
    float warning = 1.0 - smoothstep(0.0, 8.0, remaining);

    float effectDuration =
      mix(
        mix(${HEAL_EFFECT_DURATION.toFixed(2)}, ${MAGNET_EFFECT_DURATION.toFixed(2)}, step(0.5, kind)),
        ${BOMB_EFFECT_DURATION.toFixed(2)},
        step(1.5, kind)
      );
    float progress = clamp((uTime - aStyle.y) / effectDuration, 0.0, 1.0);
    life = mix(life, 1.0 - smoothstep(0.58, 1.0, progress), effect);
    warning *= 1.0 - effect;

    float motion = uMotion;
    float bob =
      sin(uTime * 2.7 + phase) *
      0.13 *
      motion *
      (1.0 - effect);
    float breathe =
      1.0 +
      sin(uTime * 3.8 + phase * 0.73) *
      0.045 *
      motion *
      (1.0 - effect);
    float effectWave = sin(progress * 3.14159265359);
    float effectScale =
      1.0 +
      effect *
      (
        mix(0.36, 1.55, progress) +
        step(0.5, kind) * 0.32 +
        step(1.5, kind) * 0.58
      ) *
      mix(0.72, 1.0, motion);

    vec4 clipPosition;
    if (aPart < 0.5) {
      float floorScale =
        (1.34 + kind * 0.08) *
        breathe *
        mix(1.0, effectScale, effect);
      vec3 world = aOrigin;
      world.xz += position.xy * floorScale;
      world.y = 0.045 + effect * 0.018;
      clipPosition = projectionMatrix * viewMatrix * vec4(world, 1.0);
    } else {
      vec3 world = aOrigin;
      world.y =
        0.92 +
        bob +
        effect * (0.08 + effectWave * 0.48 * motion);
      vec4 viewCenter = viewMatrix * vec4(world, 1.0);
      float width =
        (1.04 + kind * 0.05) *
        breathe *
        mix(1.0, effectScale, effect);
      float height =
        (1.22 + kind * 0.05) *
        breathe *
        mix(1.0, effectScale, effect);
      viewCenter.xy += vec2(position.x * width, position.y * height);
      clipPosition = projectionMatrix * viewCenter;
    }

    vUv = uv;
    vPart = aPart;
    vKind = kind;
    vLife = life;
    vWarning = warning;
    vPhase = phase;
    vEffect = effect;
    vProgress = progress;
    gl_Position = clipPosition;
  }
`

const FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uMotion;
  uniform float uQuality;

  varying vec2 vUv;
  varying float vPart;
  varying float vKind;
  varying float vLife;
  varying float vWarning;
  varying float vPhase;
  varying float vEffect;
  varying float vProgress;

  float band(float value, float center, float width) {
    return 1.0 - smoothstep(width, width + 0.025, abs(value - center));
  }

  float boxSdf(vec2 point, vec2 bounds) {
    vec2 distanceToEdge = abs(point) - bounds;
    return
      length(max(distanceToEdge, 0.0)) +
      min(max(distanceToEdge.x, distanceToEdge.y), 0.0);
  }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float radius = length(p);
    float healMask = 1.0 - step(0.5, vKind);
    float magnetMask = step(0.5, vKind) * (1.0 - step(1.5, vKind));
    float bombMask = step(1.5, vKind);

    vec3 healColor = vec3(0.16, 1.0, 0.39);
    vec3 magnetColor = vec3(0.03, 0.82, 1.0);
    vec3 bombColor = vec3(1.0, 0.21, 0.035);
    vec3 accentColor =
      healColor * healMask +
      magnetColor * magnetMask +
      bombColor * bombMask;
    vec3 hotColor =
      vec3(0.82, 1.0, 0.86) * healMask +
      vec3(0.72, 0.98, 1.0) * magnetMask +
      vec3(1.0, 0.77, 0.16) * bombMask;

    float motionPulse =
      0.84 +
      0.16 *
      sin(uTime * 5.2 + vPhase + vWarning * uTime * 5.5) *
      uMotion;
    float warningPulse =
      mix(
        0.84,
        0.58 + 0.42 * sin(uTime * 9.5 + vPhase),
        uMotion
      );
    vec3 warningColor = vec3(1.0, 0.32, 0.035);
    accentColor = mix(
      accentColor,
      warningColor,
      vWarning * warningPulse * 0.62
    );
    hotColor = mix(hotColor, vec3(1.0, 0.74, 0.2), vWarning * 0.46);

    float alpha = 0.0;
    vec3 color = vec3(0.0);

    if (vPart < 0.5) {
      float mainRing = band(radius, 0.69, 0.052);
      float innerRing = band(radius, 0.45, 0.018) * (0.22 + 0.36 * uQuality);
      float outerGlow =
        exp(-5.4 * abs(radius - 0.69)) *
        (1.0 - smoothstep(0.92, 1.08, radius));
      float centerGlow = exp(-4.8 * radius * radius) * 0.16;

      float angle = atan(p.y, p.x);
      float ticks =
        pow(max(0.0, cos(angle * (6.0 + vKind * 2.0))), 22.0) *
        band(radius, 0.87, 0.065) *
        uQuality;
      float collapse =
        mix(
          1.0,
          0.56 + 0.44 * sin((radius - vProgress * 0.78) * 21.0),
          vEffect * magnetMask
        );

      float floorEnergy =
        (mainRing * 0.92 + innerRing + outerGlow * 0.19 + centerGlow + ticks * 0.5) *
        collapse;
      color =
        accentColor * floorEnergy +
        hotColor * (mainRing * 0.28 + ticks * 0.38);
      alpha =
        mainRing * 0.74 +
        innerRing * 0.34 +
        outerGlow * 0.12 +
        centerGlow * 0.12 +
        ticks * 0.34;
    } else {
      float halo = exp(-3.5 * radius * radius);
      float corona = band(radius, 0.64, 0.065);
      float core = 1.0 - smoothstep(0.31, 0.54, radius);
      float coreHot = 1.0 - smoothstep(0.03, 0.24, radius);

      float horizontal = boxSdf(p, vec2(0.48, 0.135));
      float vertical = boxSdf(p, vec2(0.135, 0.48));
      float healCross =
        1.0 - smoothstep(-0.015, 0.035, min(horizontal, vertical));
      float healRim =
        band(radius, 0.52, 0.038) *
        (0.48 + 0.52 * smoothstep(-0.35, 0.75, p.y));

      float magnetOuter = band(radius, 0.51, 0.065);
      float magnetInner = band(radius, 0.27, 0.035);
      float magnetGap =
        1.0 - smoothstep(0.04, 0.2, p.y + 0.08);
      float magnetRing = magnetOuter * (1.0 - magnetGap * 0.92);
      float magnetTips =
        (1.0 - smoothstep(0.08, 0.2, abs(abs(p.x) - 0.43))) *
        (1.0 - smoothstep(0.0, 0.2, abs(p.y + 0.18)));
      float suctionRadius = fract(radius * 2.45 - uTime * 0.72 * uMotion);
      float suction =
        band(suctionRadius, 0.52, 0.09) *
        (1.0 - smoothstep(0.08, 0.8, radius)) *
        (0.28 + 0.52 * uQuality);

      float angle = atan(p.y, p.x);
      float bombRays =
        pow(abs(cos(angle * 6.0)), 13.0) *
        smoothstep(0.18, 0.36, radius) *
        (1.0 - smoothstep(0.54, 0.91, radius));
      float bombRing = band(radius, 0.47, 0.05);
      float bombCore =
        (1.0 - smoothstep(0.16, 0.45, radius)) *
        (0.8 + bombRays * 0.35);

      float shape =
        healMask * (healCross + healRim * 0.48) +
        magnetMask * (magnetRing + magnetInner * 0.56 + magnetTips * 0.75 + suction * 0.5) +
        bombMask * (bombCore + bombRays * 0.8 + bombRing * 0.42);
      float hotShape =
        healMask * healCross +
        magnetMask * (magnetInner + magnetTips * 0.58) +
        bombMask * (coreHot + bombRays * 0.44);

      float effectPeak = sin(vProgress * 3.14159265359) * vEffect;
      float effectRing =
        band(radius, mix(0.16, 0.86, vProgress), 0.075) *
        effectPeak;
      float effectCore =
        (1.0 - smoothstep(0.06, 0.43, radius)) *
        (1.0 - vProgress) *
        vEffect;

      color =
        accentColor *
        (
          shape * (1.2 + motionPulse * 0.25) +
          halo * (0.34 + 0.2 * uQuality) +
          corona * 0.34 +
          effectRing * 1.25
        ) +
        hotColor *
        (hotShape * 0.86 + coreHot * 0.24 + effectCore * 1.35);
      alpha =
        min(1.0, shape * 0.94) +
        halo * (0.16 + 0.09 * uQuality) +
        corona * 0.2 +
        effectRing * 0.52 +
        effectCore * 0.55;
    }

    float effectFade =
      mix(1.0, 1.0 - smoothstep(0.55, 1.0, vProgress), vEffect);
    alpha *= vLife * effectFade;
    color *=
      vLife *
      (0.94 + 0.18 * motionPulse) *
      mix(1.0, 1.34, vEffect);

    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, min(alpha, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

type NumUniform = { value: number }

export class BattlefieldPickupRenderer {
  readonly mesh: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>

  private readonly parent: THREE.Object3D
  private readonly geometry: THREE.InstancedBufferGeometry
  private readonly material: THREE.ShaderMaterial
  private readonly origins = new Float32Array(CAPACITY * 3)
  /** kind, pickup spawn/effect start, stable phase, activation-effect flag */
  private readonly styles = new Float32Array(CAPACITY * 4)
  private readonly originAttr: THREE.InstancedBufferAttribute
  private readonly styleAttr: THREE.InstancedBufferAttribute
  private readonly timeUniform: NumUniform = { value: 0 }
  private readonly simTimeUniform: NumUniform = { value: 0 }
  private readonly qualityUniform: NumUniform = { value: 1 }
  private readonly motionUniform: NumUniform
  private readonly reducedMotion = window.matchMedia(
    '(prefers-reduced-motion: reduce)',
  )
  private readonly onMotionPreference = (): void => {
    this.motionUniform.value = this.reducedMotion.matches ? 0 : 1
  }

  private originTime = -1
  private currentTime = 0
  private effectKind = EFFECT_NONE
  private effectX = 0
  private effectZ = 0
  private effectStartedAt = -Infinity
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
        0, 0,
        1, 0,
        1, 1,
        0, 1,
      ], 2),
    )
    this.geometry.setAttribute(
      'aPart',
      new THREE.Float32BufferAttribute([
        0, 0, 0, 0,
        1, 1, 1, 1,
      ], 1),
    )
    this.geometry.setIndex([
      0, 2, 1, 0, 3, 2,
      4, 5, 6, 4, 6, 7,
    ])

    this.originAttr = new THREE.InstancedBufferAttribute(this.origins, 3)
    this.styleAttr = new THREE.InstancedBufferAttribute(this.styles, 4)
    this.originAttr.setUsage(THREE.DynamicDrawUsage)
    this.styleAttr.setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('aOrigin', this.originAttr)
    this.geometry.setAttribute('aStyle', this.styleAttr)
    this.geometry.instanceCount = 0

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: this.timeUniform,
        uSimTime: this.simTimeUniform,
        uMotion: this.motionUniform,
        uQuality: this.qualityUniform,
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
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
   * Updates at most eight instances. A just-collected activation gets the
   * first slot; the consumed pickup has normally already freed that slot.
   */
  update(pool: BattlefieldPickupPool, simTime: number, now: number): void {
    if (this.disposed || !Number.isFinite(now)) return

    if (this.originTime < 0) this.originTime = now
    this.currentTime = Math.max(this.currentTime, now - this.originTime)
    this.timeUniform.value = this.currentTime
    if (Number.isFinite(simTime)) {
      this.simTimeUniform.value = Math.max(this.simTimeUniform.value, simTime)
    }

    let rendered = 0
    if (this.effectIsActive()) {
      this.writeInstance(
        rendered,
        this.effectX,
        this.effectZ,
        this.effectKind as BattlefieldPickupKind,
        this.effectStartedAt,
        0.5,
        1,
      )
      rendered += 1
    } else {
      this.effectKind = EFFECT_NONE
    }

    const requestedCount = Number.isFinite(pool.count)
      ? Math.max(0, Math.floor(pool.count))
      : 0
    const sourceCount = Math.min(
      requestedCount,
      pool.x.length,
      pool.y.length,
      pool.kind.length,
      pool.spawnedAt.length,
    )

    for (
      let source = 0;
      source < sourceCount && rendered < CAPACITY;
      source += 1
    ) {
      const x = pool.x[source]!
      const z = pool.y[source]!
      const kind = pool.kind[source]!
      const spawnedAt = pool.spawnedAt[source]!
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(z) ||
        !Number.isFinite(spawnedAt) ||
        (kind !== PICKUP_HEAL && kind !== PICKUP_MAGNET && kind !== PICKUP_BOMB) ||
        this.simTimeUniform.value - spawnedAt >= BATTLEFIELD_PICKUP_LIFETIME
      ) {
        continue
      }

      const phase = this.stablePhase(x, z, kind, spawnedAt)
      this.writeInstance(
        rendered,
        x,
        z,
        kind,
        spawnedAt,
        phase,
        0,
      )
      rendered += 1
    }

    this.geometry.instanceCount = rendered
    this.mesh.visible = rendered > 0
    if (rendered > 0) {
      this.originAttr.needsUpdate = true
      this.styleAttr.needsUpdate = true
    }
  }

  /**
   * Starts one preallocated collection flourish at the player. When several
   * pickups activate in one tick, the stronger visual wins: bomb > magnet >
   * heal. Counter ownership stays in Renderer so this cannot self-retrigger.
   */
  triggerActivation(
    kind: BattlefieldPickupKind,
    x: number,
    z: number,
  ): void {
    if (
      this.disposed ||
      !Number.isFinite(x) ||
      !Number.isFinite(z) ||
      (kind !== PICKUP_HEAL && kind !== PICKUP_MAGNET && kind !== PICKUP_BOMB)
    ) {
      return
    }

    if (
      this.effectIsActive() &&
      this.effectPriority(kind) < this.effectPriority(this.effectKind)
    ) {
      return
    }

    this.effectKind = kind
    this.effectX = x
    this.effectZ = z
    this.effectStartedAt = this.currentTime
  }

  setQuality(level: number): void {
    if (this.disposed) return
    this.qualityUniform.value = Number.isFinite(level)
      ? THREE.MathUtils.clamp(level, 0.35, 1)
      : 1
  }

  reset(): void {
    if (this.disposed) return
    this.originTime = -1
    this.currentTime = 0
    this.effectKind = EFFECT_NONE
    this.effectStartedAt = -Infinity
    this.timeUniform.value = 0
    this.simTimeUniform.value = 0
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

  private effectIsActive(): boolean {
    if (this.effectKind === EFFECT_NONE) return false
    return (
      this.currentTime - this.effectStartedAt <
      this.effectDuration(this.effectKind)
    )
  }

  private effectDuration(kind: number): number {
    if (kind === PICKUP_BOMB) return BOMB_EFFECT_DURATION
    if (kind === PICKUP_MAGNET) return MAGNET_EFFECT_DURATION
    return HEAL_EFFECT_DURATION
  }

  private effectPriority(kind: number): number {
    if (kind === PICKUP_BOMB) return 3
    if (kind === PICKUP_MAGNET) return 2
    if (kind === PICKUP_HEAL) return 1
    return 0
  }

  private stablePhase(
    x: number,
    z: number,
    kind: number,
    spawnedAt: number,
  ): number {
    const phase =
      x * 0.1031 +
      z * 0.11369 +
      kind * 0.2113248654 +
      spawnedAt * 0.013
    return phase - Math.floor(phase)
  }

  private writeInstance(
    target: number,
    x: number,
    z: number,
    kind: BattlefieldPickupKind,
    startedAt: number,
    phase: number,
    effect: 0 | 1,
  ): void {
    const offset3 = target * 3
    const offset4 = target * 4
    this.origins[offset3] = x
    this.origins[offset3 + 1] = 0
    this.origins[offset3 + 2] = z
    this.styles[offset4] = kind
    this.styles[offset4 + 1] = startedAt
    this.styles[offset4 + 2] = phase
    this.styles[offset4 + 3] = effect
  }
}
