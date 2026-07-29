import * as THREE from 'three'

import type { ArenaArc } from '../arena.ts'
import type { LoadedAsset } from './assets.ts'

/**
 * 배치형 프롭 — 석등·화로·해태·석탑.
 *
 * 산포물(`scatter.ts`)과 다른 점은 **위치가 의미를 갖는다**는 것이다. 자갈은
 * 어디 있든 상관없지만 석등은 대칭축 위에 있어야 하고, 해태는 문을 지켜야 한다.
 * 그래서 난수 배치가 아니라 손으로 정한 표를 쓴다.
 *
 * ## 발광 코어와 실제 광원
 *
 * Blender에서 `-glow`로 끝나는 오브젝트는 발광 머티리얼을 쓴다. 그것만으로는
 * **밝게 칠한 플라스틱**이다 — 주변 바닥이 어두운 채로 남아 등불이 공중에 떠
 * 보인다. 각 발광 코어 위치에 `PointLight`를 하나씩 놓아야 비로소 등불이
 * 바닥을 물들이고 자갈에 그림자를 만든다.
 *
 * 광원 수는 성능에 직결된다. three는 광원 개수만큼 셰이더를 다시 컴파일하고
 * 픽셀마다 루프를 돈다. 그래서 **플레이어 주변 가까운 것만 켠다** — 어차피
 * 먼 등불의 빛은 화면에 도달하지 않는다.
 */

export interface PropPlacement {
  /** 매니페스트의 에셋 이름. */
  asset: string
  x: number
  z: number
  /** Y축 회전. 0이면 +X 바깥을 향한다(생성 시 -Z 기준에서 보정된다). */
  rotation: number
  scale?: number
}

/**
 * 아레나 배치표.
 *
 * 네 방위 진입로를 축으로 좌우 대칭이되 완전한 대칭은 피한다 — 완벽한 대칭은
 * 건축이 아니라 도면으로 읽힌다. 반경은 전부 회랑(31.6~33.2) 안쪽이라
 * 전투 공간(r≤30)을 침범하지 않는다.
 */
function buildPlacements(): PropPlacement[] {
  const out: PropPlacement[] = []

  // 석등 — 회랑을 따라 16개. 진입로 양옆은 비운다.
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2 + Math.PI / 16
    // 네 방위 통로에 너무 가까우면 시야를 막는다.
    const toCardinal = Math.abs(Math.sin(angle * 2))
    if (toCardinal < 0.30) continue
    const radius = 31.9 + ((i % 3) - 1) * 0.12
    out.push({
      asset: 'stone-lantern',
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      rotation: -angle,
    })
  }

  // 화로 — 네 진입로 어귀 양쪽.
  for (let d = 0; d < 4; d++) {
    const base = d * Math.PI * 0.5
    for (const side of [-1, 1]) {
      const angle = base + side * 0.115
      out.push({
        asset: 'brazier',
        x: Math.cos(angle) * 31.2,
        z: Math.sin(angle) * 31.2,
        rotation: -angle,
      })
    }
  }

  // 해태 — 남북 진입로를 지킨다. 좌우가 서로를 마주 보게 살짝 튼다.
  for (const [base, radius] of [
    [0, 30.9],
    [Math.PI, 30.9],
  ] as const) {
    for (const side of [-1, 1]) {
      const angle = base + side * 0.075
      out.push({
        asset: 'haetae',
        x: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
        // 안쪽(아레나 중심)을 보되 8° 틀어 둘이 마주 보게 한다.
        rotation: -angle + Math.PI + side * 0.14,
      })
    }
  }

  // 석탑 — 동서 축 랜드마크. 하나뿐이면 중심이 흔들리므로 둘.
  for (const base of [Math.PI * 0.5, Math.PI * 1.5]) {
    out.push({
      asset: 'stone-pagoda',
      x: Math.cos(base) * 32.4,
      z: Math.sin(base) * 32.4,
      rotation: -base + 0.09,
    })
  }

  return out
}

/** 발광 코어에서 뽑아낸 광원 후보. */
interface GlowSite {
  position: THREE.Vector3
  color: THREE.Color
}

/**
 * 동시에 켜 두는 최대 광원 수.
 *
 * three는 광원 개수가 바뀔 때마다 모든 머티리얼을 재컴파일한다. 고정 개수의
 * 풀을 만들어 위치만 옮기면 그 비용이 0이 된다. 6개면 화면 안 등불을 전부
 * 덮는다 — 가시 범위가 플레이어 앞 11m뿐이라 그보다 많이 보이지 않는다.
 */
const MAX_LIGHTS = 6

/** 광원이 실제로 기여하는 거리. 이보다 멀면 켤 이유가 없다. */
const LIGHT_RANGE = 13

/**
 * 지형 높이 샘플러.
 *
 * 위에서 아래로 레이를 쏴 지면 y를 구한다. 배치 시점에 한 번만 쓰므로
 * 성능은 문제가 되지 않고, 지형을 다시 구워도 프롭이 알아서 따라 올라온다.
 */
class GroundSampler {
  private readonly raycaster = new THREE.Raycaster()
  private readonly origin = new THREE.Vector3()
  private readonly down = new THREE.Vector3(0, -1, 0)
  private readonly targets: THREE.Object3D[]

  constructor(targets: THREE.Object3D[]) {
    this.targets = targets
    // 회랑 높이는 1m 미만이지만, 레이 시작을 넉넉히 위에서 잡아야 계단
    // 윗면을 놓치지 않는다.
    this.raycaster.far = 12
  }

  heightAt(x: number, z: number): number {
    if (this.targets.length === 0) return 0
    this.origin.set(x, 8, z)
    this.raycaster.set(this.origin, this.down)
    const hits = this.raycaster.intersectObjects(this.targets, true)
    // 가장 높은 교점을 쓴다. 계단 위에 놓아야지 그 아래 광장 바닥에
    // 놓으면 안 된다.
    return hits.length > 0 ? hits[0].point.y : 0
  }
}

export class PropField {
  readonly group = new THREE.Group()

  private readonly sites: GlowSite[] = []
  private readonly lights: THREE.PointLight[] = []
  private readonly instanced: THREE.InstancedMesh[] = []
  private lastCellX = Number.NaN
  private lastCellZ = Number.NaN
  private flickerTime = 0

  /**
   * @param terrain 프롭을 앉힐 지형 메시들. 회랑·계단은 최대 0.63m 올라와
   *   있어서, 전부 y=0에 놓으면 석등이 계단에 반쯤 파묻힌다. 좌표를 손으로
   *   적어 두면 지형을 다시 구울 때마다 어긋나므로 실제로 레이캐스트한다.
   */
  constructor(assets: Map<string, LoadedAsset>, terrain: THREE.Object3D[]) {
    this.group.name = 'env-props'
    const placements = buildPlacements()
    const ground = new GroundSampler(terrain)

    // 에셋별로 묶어 InstancedMesh 하나씩 만든다. 석등 13개가 드로우콜
    // 13개가 되면 그것만으로 예산의 절반이다.
    const byAsset = new Map<string, PropPlacement[]>()
    for (const placement of placements) {
      const list = byAsset.get(placement.asset)
      if (list) list.push(placement)
      else byAsset.set(placement.asset, [placement])
    }

    const matrix = new THREE.Matrix4()
    const quaternion = new THREE.Quaternion()
    const euler = new THREE.Euler()
    const position = new THREE.Vector3()
    const scale = new THREE.Vector3()

    for (const [assetName, list] of byAsset) {
      const asset = assets.get(assetName)
      if (!asset) continue

      for (const [objectName, mesh] of asset.objects) {
        const isGlow = objectName.endsWith('-glow')
        const instanced = new THREE.InstancedMesh(
          mesh.geometry,
          mesh.material,
          list.length,
        )
        instanced.name = `prop-${objectName}`
        // 발광 코어는 그림자를 만들면 안 된다. 광원 안에 있는 물체가
        // 자기 빛을 가로막아 등불 아래가 오히려 어두워진다.
        instanced.castShadow = !isGlow
        instanced.receiveShadow = !isGlow
        instanced.frustumCulled = false

        for (let i = 0; i < list.length; i++) {
          const placement = list[i]
          position.set(placement.x, ground.heightAt(placement.x, placement.z), placement.z)
          euler.set(0, placement.rotation, 0)
          quaternion.setFromEuler(euler)
          scale.setScalar(placement.scale ?? 1)
          matrix.compose(position, quaternion, scale)
          instanced.setMatrixAt(i, matrix)

          if (isGlow) {
            // 발광 코어의 로컬 위치를 월드로 옮겨 광원 자리를 잡는다.
            // 지오메트리 바운딩 중심이 곧 불꽃의 중심이다.
            mesh.geometry.computeBoundingSphere()
            const center = mesh.geometry.boundingSphere?.center ?? new THREE.Vector3()
            const world = center.clone().applyMatrix4(matrix)
            const material = mesh.material as THREE.MeshStandardMaterial
            this.sites.push({
              position: world,
              color: (material.emissive ?? new THREE.Color(1, 0.7, 0.4)).clone(),
            })
          }
        }
        instanced.instanceMatrix.needsUpdate = true
        this.group.add(instanced)
        this.instanced.push(instanced)
      }
    }

    for (let i = 0; i < MAX_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffb271, 0, LIGHT_RANGE, 2)
      light.name = `prop-light-${i}`
      // 점광원 그림자는 큐브맵 6면이라 하나만 켜도 프레임이 무너진다.
      // 등불은 분위기 광원이고 그림자는 태양(달)이 담당한다.
      light.castShadow = false
      light.visible = false
      this.group.add(light)
      this.lights.push(light)
    }
  }

  /**
   * 플레이어 주변 가까운 발광 코어에만 광원을 붙인다.
   *
   * 셀이 바뀔 때만 다시 고른다. 흔들림(깜빡임)은 매 프레임 갱신한다 —
   * 고정 밝기 등불은 즉시 조명이 아니라 스티커로 읽힌다.
   */
  update(dt: number, playerX: number, playerZ: number, arc: Readonly<ArenaArc>): void {
    this.flickerTime += dt

    const cellX = Math.round(playerX / 6)
    const cellZ = Math.round(playerZ / 6)
    if (cellX !== this.lastCellX || cellZ !== this.lastCellZ) {
      this.lastCellX = cellX
      this.lastCellZ = cellZ
      this.assignLights(playerX, playerZ)
    }

    // 월식이 진행될수록 등불이 상대적으로 강해진다. 달빛이 빠지는 자리를
    // 인공광이 메우는 그림이라, 같은 밝기여도 후반부가 훨씬 극적으로 보인다.
    const boost = 1 + arc.eclipse * 0.5 + arc.boss * 0.35
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i]
      if (!light.visible) continue
      // 광원마다 다른 위상. 전부 같이 깜빡이면 불이 아니라 조광기로 보인다.
      const phase = i * 2.399
      const flicker =
        0.86 +
        Math.sin(this.flickerTime * 7.3 + phase) * 0.06 +
        Math.sin(this.flickerTime * 17.1 + phase * 1.7) * 0.04 +
        Math.sin(this.flickerTime * 3.1 + phase * 0.5) * 0.05
      light.intensity = (light.userData.baseIntensity as number) * flicker * boost
    }
  }

  private assignLights(playerX: number, playerZ: number): void {
    const ranked = this.sites
      .map((site) => ({
        site,
        distance: Math.hypot(site.position.x - playerX, site.position.z - playerZ),
      }))
      .filter((row) => row.distance < LIGHT_RANGE + 4)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_LIGHTS)

    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i]
      const row = ranked[i]
      if (!row) {
        light.visible = false
        light.intensity = 0
        continue
      }
      light.position.copy(row.site.position)
      light.color.copy(row.site.color)
      // 세기는 눈으로 맞췄다. 물리 감쇠(decay 2)에서 8이면 반경 2m 정도가
      // 확실히 밝고 그 밖으로 부드럽게 떨어진다.
      light.userData.baseIntensity = 8
      light.intensity = 8
      light.visible = true
    }
  }

  dispose(): void {
    for (const mesh of this.instanced) mesh.dispose()
    this.instanced.length = 0
    this.lights.length = 0
    this.sites.length = 0
  }
}
