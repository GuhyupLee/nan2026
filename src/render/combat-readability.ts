import * as THREE from 'three'

import { pickAutoAttackTarget } from '../sim/combat.ts'
import {
  BOSS_CHARGE_AT,
  BOSS_CHARGE_SPEED,
  BOSS_RECOVER_AT,
  BOSS_WINDUP_AT,
  ENEMY_CONTACT_REACH,
  ENEMY_TYPES,
  TYPE_BOSS,
  TYPE_BRUTE,
  TYPE_ELITE,
  bossCycleTime,
  bossPhaseAt,
  createEnemyHash,
} from '../sim/enemies.ts'
import type { World } from '../sim/types.ts'
import { lerp } from '../sim/vec.ts'

const MAX_HEALTH_BARS = 32
const MAX_TARGET_RINGS = 8
const MAX_CHARGE_DISTANCE =
  BOSS_CHARGE_SPEED * (BOSS_RECOVER_AT - BOSS_CHARGE_AT)

const RANGED_TARGET = new THREE.Color(0x62d9f7)
const MELEE_TARGET = new THREE.Color(0xff6578)
const ELITE_TARGET = new THREE.Color(0xe8bd61)
const BOSS_TARGET = new THREE.Color(0xf25a8c)
const NORMAL_HEALTH = new THREE.Color(0xe9edf2)
const BRUTE_HEALTH = new THREE.Color(0xff9a61)

const BAR_VERTEX = /* glsl */ `
attribute float aHp;
attribute vec3 aAccent;

varying vec2 vUv;
varying float vHp;
varying vec3 vAccent;

void main() {
  vUv = uv;
  vHp = aHp;
  vAccent = aAccent;
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
}
`

const BAR_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying float vHp;
varying vec3 vAccent;

void main() {
  float frame =
    step(vUv.x, 0.055) + step(0.945, vUv.x) +
    step(vUv.y, 0.14) + step(0.86, vUv.y);
  float innerX = clamp((vUv.x - 0.06) / 0.88, 0.0, 1.0);
  float filled = 1.0 - step(vHp, innerX);
  vec3 loss = vec3(0.12, 0.055, 0.07);
  vec3 color = mix(loss, vAccent, filled);
  color = mix(color, vec3(0.025, 0.032, 0.044), min(1.0, frame));
  float shine = smoothstep(0.52, 0.86, vUv.y) * 0.16 * filled;
  gl_FragColor = vec4(color + vAccent * shine, 0.94);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

const CHARGE_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const CHARGE_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform float uProgress;
uniform float uCharging;
uniform float uMotion;

varying vec2 vUv;

void main() {
  float lateral = abs(vUv.y - 0.5) * 2.0;
  float fade = smoothstep(0.0, 0.045, vUv.x) * (1.0 - smoothstep(0.94, 1.0, vUv.x));
  float rails =
    smoothstep(0.72, 0.84, lateral) *
    (1.0 - smoothstep(0.9, 0.98, lateral));
  float core = (1.0 - smoothstep(0.58, 0.96, lateral)) * 0.11;
  float swept = 1.0 - smoothstep(uProgress - 0.08, uProgress + 0.025, vUv.x);
  float chevronPhase = fract(vUv.x * 13.0 - uTime * 1.6 * uMotion + lateral * 0.42);
  float chevrons =
    step(0.7, chevronPhase) *
    (1.0 - smoothstep(0.5, 0.88, lateral)) *
    (0.16 + uCharging * 0.12);
  float alpha = fade * (rails * 0.68 + core + swept * 0.09 + chevrons);
  vec3 color = mix(vec3(0.56, 0.035, 0.075), vec3(1.0, 0.36, 0.14), rails + chevrons);
  gl_FragColor = vec4(color, min(0.68, alpha));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * 적 선택·체력·보스 돌진처럼 판정에 꼭 필요한 정보만 지면에 얹는다.
 *
 * 숫자와 모델 수가 늘어도 드로우콜은 링 1 + 체력바 1 + 보스 예고 1로 고정된다.
 * 실제 공격 대상 계산과 접촉 폭 상수를 시뮬레이션과 공유해 표시가 판정과
 * 어긋나지 않게 한다.
 */
export class CombatReadabilityFx {
  private readonly scene: THREE.Scene
  private readonly ringMesh: THREE.InstancedMesh
  private readonly barMesh: THREE.InstancedMesh
  private readonly barHp: THREE.InstancedBufferAttribute
  private readonly barAccent: THREE.InstancedBufferAttribute
  private readonly chargeMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private readonly chargeUniforms: {
    uTime: { value: number }
    uProgress: { value: number }
    uCharging: { value: number }
    uMotion: { value: number }
  }

  private readonly matrix = new THREE.Matrix4()
  private readonly position = new THREE.Vector3()
  private readonly quaternion = new THREE.Quaternion()
  private readonly scale = new THREE.Vector3()
  private readonly axisY = new THREE.Vector3(0, 1, 0)
  private readonly targetHash = createEnemyHash()

  constructor(scene: THREE.Scene) {
    this.scene = scene

    const ringGeometry = new THREE.RingGeometry(0.78, 1, 64)
    ringGeometry.rotateX(-Math.PI / 2)
    this.ringMesh = new THREE.InstancedMesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 0.76,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -3,
      }),
      MAX_TARGET_RINGS,
    )
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.ringMesh.count = 0
    this.ringMesh.frustumCulled = false
    this.ringMesh.renderOrder = 7
    scene.add(this.ringMesh)

    const barGeometry = new THREE.PlaneGeometry(1, 1)
    barGeometry.rotateX(-Math.PI / 2)
    this.barHp = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_HEALTH_BARS),
      1,
    )
    this.barAccent = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_HEALTH_BARS * 3),
      3,
    )
    barGeometry.setAttribute('aHp', this.barHp)
    barGeometry.setAttribute('aAccent', this.barAccent)
    this.barMesh = new THREE.InstancedMesh(
      barGeometry,
      new THREE.ShaderMaterial({
        vertexShader: BAR_VERTEX,
        fragmentShader: BAR_FRAGMENT,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -4,
      }),
      MAX_HEALTH_BARS,
    )
    this.barMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.barMesh.count = 0
    this.barMesh.frustumCulled = false
    this.barMesh.renderOrder = 8
    scene.add(this.barMesh)

    const chargeGeometry = new THREE.PlaneGeometry(1, 1)
    chargeGeometry.rotateX(-Math.PI / 2)
    this.chargeUniforms = {
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uCharging: { value: 0 },
      uMotion: {
        value: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 1,
      },
    }
    this.chargeMesh = new THREE.Mesh(
      chargeGeometry,
      new THREE.ShaderMaterial({
        vertexShader: CHARGE_VERTEX,
        fragmentShader: CHARGE_FRAGMENT,
        uniforms: this.chargeUniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        polygonOffset: true,
        polygonOffsetFactor: -5,
      }),
    )
    this.chargeMesh.visible = false
    this.chargeMesh.frustumCulled = false
    this.chargeMesh.renderOrder = 6
    scene.add(this.chargeMesh)
  }

  update(world: World, alpha: number): void {
    const preferCluster = world.playerClass === 'ranged' && !world.boss.active
    if (preferCluster) {
      this.targetHash.rebuild(
        world.enemies.count,
        world.enemies.x,
        world.enemies.y,
      )
    }
    const target = pickAutoAttackTarget(
      world.enemies,
      this.targetHash,
      world.player.pos.x,
      world.player.pos.y,
      world.lastAim.x,
      world.lastAim.y,
      world.stats.atkRange,
      preferCluster,
    )
    this.drawRings(world, alpha, target)
    this.drawHealthBars(world, alpha, target)
    this.drawBossCharge(world, alpha)
  }

  private setMatrix(
    slot: number,
    mesh: THREE.InstancedMesh,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): void {
    this.position.set(x, y, z)
    this.quaternion.identity()
    this.scale.set(sx, sy, sz)
    this.matrix.compose(this.position, this.quaternion, this.scale)
    mesh.setMatrixAt(slot, this.matrix)
  }

  private drawRings(world: World, alpha: number, target: number): void {
    const pool = world.enemies
    let count = 0
    const pulse = 1 + Math.sin(world.time * 5.4) * 0.045

    count = this.addRing(
      world,
      alpha,
      target,
      world.playerClass === 'melee' ? MELEE_TARGET : RANGED_TARGET,
      count,
      pulse,
    )
    for (let i = 0; i < pool.count && count < MAX_TARGET_RINGS; i++) {
      if (i === target) continue
      const type = pool.type[i]!
      if (type === TYPE_ELITE) {
        count = this.addRing(world, alpha, i, ELITE_TARGET, count, pulse)
      } else if (type === TYPE_BOSS) {
        count = this.addRing(world, alpha, i, BOSS_TARGET, count, pulse)
      }
    }

    this.ringMesh.count = count
    this.ringMesh.instanceMatrix.needsUpdate = true
    if (this.ringMesh.instanceColor) this.ringMesh.instanceColor.needsUpdate = true
  }

  private addRing(
    world: World,
    alpha: number,
    i: number,
    color: THREE.Color,
    count: number,
    pulse: number,
  ): number {
    const pool = world.enemies
    if (
      i < 0 ||
      i >= pool.count ||
      count >= MAX_TARGET_RINGS ||
      pool.hp[i]! <= 0
    ) {
      return count
    }
    const type = pool.type[i]!
    const radius =
      ENEMY_TYPES[type]!.radius * (type === TYPE_BOSS ? 1.34 : 1.5) * pulse
    const x = lerp(pool.prevX[i]!, pool.x[i]!, alpha)
    const z = lerp(pool.prevY[i]!, pool.y[i]!, alpha)
    this.setMatrix(count, this.ringMesh, x, 0.032, z, radius, 1, radius)
    this.ringMesh.setColorAt(count, color)
    return count + 1
  }

  private drawHealthBars(world: World, alpha: number, target: number): void {
    const pool = world.enemies
    let count = 0

    count = this.addHealthBar(world, alpha, target, count)
    for (let i = 0; i < pool.count && count < MAX_HEALTH_BARS; i++) {
      if (i !== target && pool.type[i] === TYPE_ELITE) {
        count = this.addHealthBar(world, alpha, i, count)
      }
    }
    for (let i = 0; i < pool.count && count < MAX_HEALTH_BARS; i++) {
      if (
        i !== target &&
        pool.type[i] !== TYPE_ELITE &&
        pool.hpVisibleUntil[i]! > world.time
      ) {
        count = this.addHealthBar(world, alpha, i, count)
      }
    }

    this.barMesh.count = count
    this.barMesh.instanceMatrix.needsUpdate = true
    this.barHp.needsUpdate = true
    this.barAccent.needsUpdate = true
  }

  private addHealthBar(
    world: World,
    alpha: number,
    i: number,
    count: number,
  ): number {
    const pool = world.enemies
    if (
      i < 0 ||
      i >= pool.count ||
      count >= MAX_HEALTH_BARS ||
      pool.hp[i]! <= 0 ||
      pool.type[i] === TYPE_BOSS
    ) {
      return count
    }
    const type = pool.type[i]!
    const def = ENEMY_TYPES[type]!
    const hp = Math.max(0, Math.min(1, pool.hp[i]! / Math.max(1, pool.maxHp[i]!)))
    const x = lerp(pool.prevX[i]!, pool.x[i]!, alpha)
    const z = lerp(pool.prevY[i]!, pool.y[i]!, alpha)
    const width = Math.max(0.92, def.radius * 2.25)
    const accent =
      type === TYPE_ELITE
        ? ELITE_TARGET
        : type === TYPE_BRUTE
          ? BRUTE_HEALTH
          : NORMAL_HEALTH
    this.setMatrix(
      count,
      this.barMesh,
      x,
      0.052,
      z + def.radius + 0.38,
      width,
      1,
      type === TYPE_ELITE ? 0.22 : 0.17,
    )
    this.barHp.setX(count, hp)
    this.barAccent.setXYZ(count, accent.r, accent.g, accent.b)
    return count + 1
  }

  private drawBossCharge(world: World, alpha: number): void {
    const pool = world.enemies
    let boss = -1
    for (let i = 0; i < pool.count; i++) {
      if (pool.type[i] === TYPE_BOSS && pool.hp[i]! > 0) {
        boss = i
        break
      }
    }
    if (boss < 0) {
      this.chargeMesh.visible = false
      return
    }

    const phase = bossPhaseAt(world.time, world.boss.spawnedAt)
    if (phase !== 'windup' && phase !== 'charge') {
      this.chargeMesh.visible = false
      return
    }

    const dx = pool.bossChargeDirX[boss]!
    const dz = pool.bossChargeDirY[boss]!
    const directionLength = Math.hypot(dx, dz)
    if (directionLength <= 1e-6) {
      this.chargeMesh.visible = false
      return
    }

    const nx = dx / directionLength
    const nz = dz / directionLength
    const x = lerp(pool.prevX[boss]!, pool.x[boss]!, alpha)
    const z = lerp(pool.prevY[boss]!, pool.y[boss]!, alpha)
    const cycle = bossCycleTime(world.time, world.boss.spawnedAt)
    const arenaLimit = world.arenaRadius - ENEMY_TYPES[TYPE_BOSS]!.radius
    const along = x * nx + z * nz
    const discriminant = Math.max(0, along * along - (x * x + z * z - arenaLimit * arenaLimit))
    const exitDistance = Math.max(0, -along + Math.sqrt(discriminant))
    const remainingChargeTime =
      phase === 'charge'
        ? Math.max(0, BOSS_RECOVER_AT - cycle)
        : BOSS_RECOVER_AT - BOSS_CHARGE_AT
    const travelDistance = Math.min(
      MAX_CHARGE_DISTANCE,
      BOSS_CHARGE_SPEED * remainingChargeTime,
    )
    const length = Math.min(travelDistance, exitDistance)
    if (length <= 0.05) {
      this.chargeMesh.visible = false
      return
    }
    const width =
      2 *
      (ENEMY_TYPES[TYPE_BOSS]!.radius + world.stats.radius + ENEMY_CONTACT_REACH)

    this.position.set(x + nx * length * 0.5, 0.04, z + nz * length * 0.5)
    this.quaternion.setFromAxisAngle(this.axisY, -Math.atan2(nz, nx))
    this.chargeMesh.position.copy(this.position)
    this.chargeMesh.quaternion.copy(this.quaternion)
    this.chargeMesh.scale.set(length, 1, width)
    this.chargeMesh.visible = true

    const progress =
      phase === 'charge'
        ? 1
        : Math.max(
            0,
            Math.min(1, (cycle - BOSS_WINDUP_AT) / (BOSS_CHARGE_AT - BOSS_WINDUP_AT)),
          )
    this.chargeUniforms.uTime.value = world.time
    this.chargeUniforms.uProgress.value = progress
    this.chargeUniforms.uCharging.value =
      cycle >= BOSS_CHARGE_AT && cycle < BOSS_RECOVER_AT ? 1 : 0
  }

  dispose(): void {
    this.scene.remove(this.ringMesh, this.barMesh, this.chargeMesh)
    this.ringMesh.geometry.dispose()
    ;(this.ringMesh.material as THREE.Material).dispose()
    this.barMesh.geometry.dispose()
    ;(this.barMesh.material as THREE.Material).dispose()
    this.chargeMesh.geometry.dispose()
    this.chargeMesh.material.dispose()
  }
}
