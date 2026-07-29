import * as THREE from 'three'

/**
 * 지면 산포물 배치.
 *
 * ## 왜 전부 한 번에 올리지 않는가
 *
 * 실측한 가시 범위는 플레이어 앞 11m·뒤 6m, 폭 33m다(SPEC.md "가시 범위").
 * 그런데 아레나는 반경 30m, 넓이 2,827m²다. 화면을 채울 밀도(패치 안에서
 * m²당 4~6포기)를 아레나 전체에 깔면 풀만 4,000포기가 넘고, 포기당 120
 * 삼각형이면 그것만으로 예산이 끝난다.
 *
 * `InstancedMesh`는 **통째로** 절두체 컬링된다 — 바운딩 스피어가 아레나
 * 전체를 덮으므로 한 포기도 걸러지지 않는다. 즉 화면 밖 3,000포기도 매
 * 프레임 정점 셰이더를 통과한다.
 *
 * 그래서 배치는 전부 미리 계산해 두되(결정적), **GPU에 올리는 건 플레이어
 * 주변 셀뿐**이다. 플레이어가 셀 경계를 넘을 때만 인스턴스 행렬을 다시
 * 채운다. 초당 10.7m로 움직이므로 8m 셀에서 약 0.75초에 한 번, 한 번에
 * 1~2천 개 행렬을 쓴다. 프레임 예산에 잡히지 않는 비용이다.
 *
 * 결과: 화면 안 밀도는 원하는 만큼 올리면서 상시 삼각형 수는 상한이 잡힌다.
 */

/** 공간 해시 셀 크기(m). 작을수록 갱신이 잦고 상주 인스턴스가 적다. */
const CELL_SIZE = 8

/**
 * 플레이어 주변 수집 반경(m).
 *
 * 화면 대각선이 닿는 최대 거리는 약 20m다. 여유를 두되 지나치게 넓히면
 * 청킹의 의미가 사라진다.
 */
const GATHER_RADIUS = 24

export interface ScatterPlacement {
  x: number
  z: number
  /** Y축 회전(라디안). */
  rotation: number
  /** 등방 스케일. */
  scale: number
  /** 살짝 기울여 놓기 위한 X/Z축 경사(라디안). */
  tiltX: number
  tiltZ: number
  /** 지면에 파묻히는 깊이(m). 자갈이 떠 있으면 즉시 가짜로 보인다. */
  sink: number
  /**
   * 지면 높이(m). 생성 시 **한 번만** 샘플링해 넣는다.
   *
   * 처음에는 update()에서 매번 레이캐스트했는데, 성벽 밖 지형이 47,000
   * 삼각형이라 소나무·바위 수백 개를 배치할 때마다 그 메시를 수백 번
   * 관통 검사했다. 셀이 바뀔 때마다 30ms 넘게 멈췄다. 배치는 결정적이라
   * 높이도 변하지 않으므로 미리 구해 두면 된다.
   */
  groundY: number
  /** 어느 변형 메시에 속하는지. */
  variant: number
}

/** 결정적 해시 난수. 시드와 좌표가 같으면 항상 같은 값이다. */
function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 이음매 없는 저주파 값 노이즈. 패치 마스크에 쓴다. */
export function patchNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const fx = x - ix
  const fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  const n00 = hash2(ix, iy, seed)
  const n10 = hash2(ix + 1, iy, seed)
  const n01 = hash2(ix, iy + 1, seed)
  const n11 = hash2(ix + 1, iy + 1, seed)
  return (n00 * (1 - ux) + n10 * ux) * (1 - uy) + (n01 * (1 - ux) + n11 * ux) * uy
}

export interface ScatterKind {
  /** 지터드 그리드 한 칸의 크기(m). 작을수록 촘촘하다. */
  spacing: number
  /** 배치 반경 범위. */
  minRadius: number
  maxRadius: number
  scaleMin: number
  scaleMax: number
  /** 최대 경사(라디안). 0이면 항상 똑바로 선다. */
  maxTilt: number
  sinkMin: number
  sinkMax: number
  /** 변형 개수. 0..count-1이 균등 분배된다. */
  variants: number
  /**
   * 반경별 밀도 배율. 전투가 벌어지는 중앙은 비우고 가장자리를 채운다 —
   * 가독성 때문이기도 하고, 실제로 사람이 다니는 곳에 잡초가 안 나기 때문이다.
   */
  density(radius: number, x: number, z: number): number
}

/**
 * 네 방위 진입로 감쇠.
 *
 * 바닥 상감이 표시하는 통행로 위에는 산포물이 적어야 한다. 여기에 자갈이
 * 깔리면 "길"이라는 정보가 사라지고, 무엇보다 전투 중 가장 자주 지나는
 * 곳이라 시각적 소음이 그대로 방해가 된다.
 */
function laneFalloff(x: number, z: number): number {
  const axis = Math.min(Math.abs(x), Math.abs(z))
  return THREE.MathUtils.smoothstep(axis, 1.6, 4.6) * 0.75 + 0.25
}

export const SCATTER_KINDS: Record<string, ScatterKind> = {
  pebble: {
    spacing: 1.15,
    minRadius: 2.2,
    maxRadius: 33,
    scaleMin: 0.55,
    scaleMax: 1.5,
    maxTilt: 0.5,
    sinkMin: 0.01,
    sinkMax: 0.045,
    variants: 5,
    density(radius, x, z) {
      // 가장자리로 갈수록 쓸려 쌓인다.
      const edge = THREE.MathUtils.smoothstep(radius, 12, 31)
      const patch = patchNoise(x * 0.09, z * 0.09, 7717)
      return (0.18 + edge * 0.62) * (0.35 + patch * 1.1) * laneFalloff(x, z)
    },
  },
  rubble: {
    spacing: 3.1,
    minRadius: 5,
    maxRadius: 33,
    scaleMin: 0.6,
    scaleMax: 1.45,
    maxTilt: 0.34,
    sinkMin: 0.02,
    sinkMax: 0.07,
    variants: 4,
    density(radius, x, z) {
      const edge = THREE.MathUtils.smoothstep(radius, 16, 32)
      const patch = patchNoise(x * 0.055 + 30, z * 0.055, 3313)
      return (0.06 + edge * 0.72) * (0.2 + patch * 1.4) * laneFalloff(x, z)
    },
  },
  shard: {
    spacing: 2.6,
    minRadius: 9,
    maxRadius: 33,
    scaleMin: 0.7,
    scaleMax: 1.3,
    maxTilt: 0.62,
    sinkMin: 0.005,
    sinkMax: 0.03,
    variants: 3,
    density(radius, x, z) {
      // 기와 조각은 성벽 아래에서 떨어진 것이므로 가장자리에만 있다.
      const edge = THREE.MathUtils.smoothstep(radius, 22, 32)
      return edge * (0.25 + patchNoise(x * 0.07 - 12, z * 0.07, 991) * 1.2)
    },
  },
  mossclump: {
    spacing: 2.4,
    minRadius: 11,
    maxRadius: 33,
    scaleMin: 0.7,
    scaleMax: 1.6,
    maxTilt: 0.1,
    sinkMin: 0.005,
    sinkMax: 0.02,
    variants: 2,
    density(radius, x, z) {
      const edge = THREE.MathUtils.smoothstep(radius, 14, 30)
      const patch = patchNoise(x * 0.075 + 60, z * 0.075, 5501)
      // 이끼는 뭉쳐서 난다. 임계를 세게 걸어 덩어리로 만든다.
      return edge * Math.max(0, patch - 0.42) * 3.1
    },
  },
  root: {
    spacing: 4.4,
    minRadius: 17,
    maxRadius: 33,
    scaleMin: 0.75,
    scaleMax: 1.35,
    maxTilt: 0.06,
    sinkMin: 0.002,
    sinkMax: 0.012,
    variants: 2,
    density(radius, x, z) {
      const edge = THREE.MathUtils.smoothstep(radius, 20, 32)
      return edge * (0.2 + patchNoise(x * 0.06 + 90, z * 0.06, 2207) * 1.0)
    },
  },
  grass: {
    spacing: 0.85,
    minRadius: 6,
    maxRadius: 34,
    // 원본 포기가 0.18~0.36m다. 기본 스케일로 뿌렸더니 부감 카메라에서
    // 세로 12픽셀짜리 점이 되어 아예 안 보였다. 실제 마당 잡초 높이인
    // 0.3~0.8m 구간으로 끌어올린다. 캐릭터(1.6m)를 가리지 않는 상한이다.
    scaleMin: 1.5,
    scaleMax: 3.1,
    maxTilt: 0.14,
    sinkMin: 0.005,
    sinkMax: 0.02,
    variants: 3,
    density(radius, x, z) {
      const edge = THREE.MathUtils.smoothstep(radius, 10, 30)
      // 두 겹 노이즈로 큰 군락 안에 작은 빈틈을 만든다. 한 겹이면 경계가
      // 매끈해서 물감으로 칠한 것처럼 보인다.
      const broad = patchNoise(x * 0.048, z * 0.048, 1409)
      const fine = patchNoise(x * 0.19 + 40, z * 0.19, 8821)
      const mask = Math.max(0, broad * 0.75 + fine * 0.45 - 0.52) * 3.2
      return edge * mask * laneFalloff(x, z)
    },
  },
  fern: {
    spacing: 3.6,
    minRadius: 20,
    maxRadius: 34,
    scaleMin: 1.4,
    scaleMax: 2.4,
    maxTilt: 0.16,
    sinkMin: 0.005,
    sinkMax: 0.02,
    variants: 1,
    density(radius, x, z) {
      const edge = THREE.MathUtils.smoothstep(radius, 23, 33)
      return edge * Math.max(0, patchNoise(x * 0.08 + 15, z * 0.08, 6203) - 0.40) * 2.6
    },
  },
  // --- 성벽 밖 (r=35~46) --------------------------------------------------
  //
  // 성벽(3.4m) 너머라 **하부만 보인다.** 그래도 실루엣이 겹치는 것만으로
  // 깊이가 크게 늘어난다. 여기 있는 것들은 전부 지형 높이를 따라간다.
  debris: {
    spacing: 3.4,
    minRadius: 34.5,
    maxRadius: 44,
    scaleMin: 0.7,
    scaleMax: 1.5,
    maxTilt: 0.42,
    sinkMin: 0.02,
    sinkMax: 0.12,
    variants: 6,
    density(radius, x, z) {
      // 성벽 바로 아래가 가장 많다 — 위에서 떨어진 것들이다.
      const nearWall = 1 - THREE.MathUtils.smoothstep(radius, 35, 42)
      return (0.15 + nearWall * 0.75) * (0.2 + patchNoise(x * 0.06 + 5, z * 0.06, 6607) * 1.3)
    },
  },
  boulder: {
    spacing: 5.6,
    minRadius: 35.5,
    maxRadius: 46,
    scaleMin: 0.65,
    scaleMax: 1.5,
    maxTilt: 0.16,
    sinkMin: 0.1,
    sinkMax: 0.4,
    variants: 5,
    density(radius, x, z) {
      const out = THREE.MathUtils.smoothstep(radius, 35, 44)
      return (0.2 + out * 0.7) * (0.25 + patchNoise(x * 0.045 - 20, z * 0.045, 7013) * 1.2)
    },
  },
  pine: {
    spacing: 7.2,
    minRadius: 36,
    maxRadius: 46,
    scaleMin: 0.7,
    scaleMax: 1.25,
    maxTilt: 0.07,
    sinkMin: 0.05,
    sinkMax: 0.2,
    variants: 2,
    density(radius, x, z) {
      const out = THREE.MathUtils.smoothstep(radius, 36, 43)
      // 문 앞 시야 통로에는 나무를 두지 않는다. 네 방위에서 밖을 볼 때
      // 나무가 정면을 막으면 성문 밖이 그냥 벽이 된다.
      const lane = THREE.MathUtils.smoothstep(Math.min(Math.abs(x), Math.abs(z)), 2.5, 8)
      return out * lane * Math.max(0, patchNoise(x * 0.05 + 70, z * 0.05, 8123) - 0.30) * 2.4
    },
  },
  bamboo: {
    spacing: 6.4,
    minRadius: 36,
    maxRadius: 45,
    scaleMin: 0.75,
    scaleMax: 1.3,
    maxTilt: 0.05,
    sinkMin: 0.05,
    sinkMax: 0.18,
    variants: 1,
    density(radius, x, z) {
      const out = THREE.MathUtils.smoothstep(radius, 36, 43)
      const lane = THREE.MathUtils.smoothstep(Math.min(Math.abs(x), Math.abs(z)), 2.5, 8)
      // 대나무는 무리 지어 난다. 임계를 세게 걸어 군락 몇 개만 만든다.
      return out * lane * Math.max(0, patchNoise(x * 0.04 - 88, z * 0.04, 9311) - 0.46) * 3.6
    },
  },
  reed: {
    spacing: 3.0,
    minRadius: 24,
    maxRadius: 34,
    scaleMin: 1.6,
    scaleMax: 2.9,
    maxTilt: 0.2,
    sinkMin: 0.005,
    sinkMax: 0.015,
    variants: 1,
    density(radius, x, z) {
      const edge = THREE.MathUtils.smoothstep(radius, 26, 33)
      return edge * Math.max(0, patchNoise(x * 0.09 - 55, z * 0.09, 4457) - 0.44) * 2.8
    },
  },
}

/**
 * 배치를 미리 계산한다. 같은 시드는 항상 같은 배열을 낸다.
 *
 * 지터드 그리드를 쓴다 — 순수 난수는 뭉치고 벌어져서 "흩뿌린" 게 아니라
 * "얼룩진" 것으로 보이고, 정격자는 즉시 인공물로 읽힌다. 격자 한 칸에 하나씩
 * 두되 칸 안에서 위치를 흔드는 방식이 둘 사이의 타협점이고, 밀도 함수로
 * 칸을 통째로 비우면 자연스러운 군락이 생긴다.
 */
export function generatePlacements(
  kind: ScatterKind,
  seed: number,
): ScatterPlacement[] {
  const out: ScatterPlacement[] = []
  const steps = Math.ceil((kind.maxRadius * 2) / kind.spacing)
  const origin = -kind.maxRadius

  for (let gz = 0; gz < steps; gz++) {
    for (let gx = 0; gx < steps; gx++) {
      const jitterX = hash2(gx, gz, seed)
      const jitterZ = hash2(gx, gz, seed + 101)
      const x = origin + (gx + jitterX) * kind.spacing
      const z = origin + (gz + jitterZ) * kind.spacing
      const radius = Math.hypot(x, z)
      if (radius < kind.minRadius || radius > kind.maxRadius) continue

      const roll = hash2(gx, gz, seed + 202)
      if (roll > kind.density(radius, x, z)) continue

      const r3 = hash2(gx, gz, seed + 303)
      const r4 = hash2(gx, gz, seed + 404)
      const r5 = hash2(gx, gz, seed + 505)
      const r6 = hash2(gx, gz, seed + 606)
      out.push({
        x,
        z,
        rotation: r3 * Math.PI * 2,
        // 스케일을 제곱으로 편향시켜 작은 것이 많고 큰 것이 드물게 한다.
        // 균등 분포는 전부 비슷한 크기로 보인다.
        scale: kind.scaleMin + (kind.scaleMax - kind.scaleMin) * r4 * r4,
        tiltX: (r5 - 0.5) * 2 * kind.maxTilt,
        tiltZ: (r6 - 0.5) * 2 * kind.maxTilt,
        sink: kind.sinkMin + (kind.sinkMax - kind.sinkMin) * r5,
        // 평지가 기본값. 지형이 있는 곳은 ScatterField가 생성 시 덮어쓴다.
        groundY: 0,
        variant: Math.floor(r6 * kind.variants) % kind.variants,
      })
    }
  }
  return out
}

interface VariantBucket {
  mesh: THREE.InstancedMesh
  /** 이 변형에 속하는 배치. 셀 키로 묶어 둔다. */
  cells: Map<number, ScatterPlacement[]>
  capacity: number
}

function cellKey(cx: number, cz: number): number {
  // 셀 좌표는 -8..8 범위라 16비트로 충분하다.
  return ((cx + 512) << 10) | (cz + 512)
}

/**
 * 한 종류(자갈, 풀 등)의 산포 필드.
 *
 * 변형마다 `InstancedMesh` 하나를 갖고, 플레이어 주변 셀의 배치만 채운다.
 */
export class ScatterField {
  readonly group = new THREE.Group()

  private readonly buckets: VariantBucket[] = []
  private readonly matrix = new THREE.Matrix4()
  private readonly quaternion = new THREE.Quaternion()
  private readonly euler = new THREE.Euler()
  private readonly position = new THREE.Vector3()
  private readonly scaleVec = new THREE.Vector3()
  private lastCellX = Number.NaN
  private lastCellZ = Number.NaN

  /** 실제로 GPU에 올라간 인스턴스 수. 예산 감사에 쓴다. */
  residentCount = 0

  /**
   * 상주 인스턴스 비율. 저사양에서 낮춘다.
   *
   * 밀도를 줄이는 게 아니라 **가까운 것부터 채우고 잘라 낸다**. 밀도를
   * 낮추면 배치가 통째로 달라져 같은 자리에 갔을 때 풀이 사라졌다 나타나고,
   * 그건 성능 저하보다 더 눈에 띈다.
   */
  private budget = 1

  /**
   * 지면 높이 함수. 평지가 아닌 곳(성벽 밖 지형)에 뿌릴 때 넘긴다.
   *
   * 아레나 안은 z가 ±0.05 안이라 무시해도 되지만, 바깥 지형은 r=48에서
   * -6m까지 떨어진다. 그대로 y=0에 놓으면 소나무가 공중에 뜬다.
   */
  constructor(
    name: string,
    variants: THREE.Mesh[],
    placements: ScatterPlacement[],
    options: { castShadow: boolean; heightAt?: (x: number, z: number) => number },
  ) {
    this.group.name = `scatter-${name}`
    // 지형 높이는 여기서 한 번만 굽는다. 매 갱신마다 레이캐스트하면
    // 셀을 넘을 때마다 프레임이 30ms 넘게 멈춘다(placement.groundY 주석 참조).
    if (options.heightAt) {
      for (const placement of placements) {
        placement.groundY = options.heightAt(placement.x, placement.z)
      }
    }

    // 변형별로 셀에 묶는다. 최대 상주 수를 미리 알아야 InstancedMesh 용량을
    // 잡을 수 있으므로, 가장 붐비는 위치를 실제로 훑어 상한을 구한다.
    const perVariant: Map<number, ScatterPlacement[]>[] = variants.map(() => new Map())
    for (const placement of placements) {
      const variant = Math.min(placement.variant, variants.length - 1)
      const key = cellKey(
        Math.floor(placement.x / CELL_SIZE),
        Math.floor(placement.z / CELL_SIZE),
      )
      const table = perVariant[variant]
      const bucket = table.get(key)
      if (bucket) bucket.push(placement)
      else table.set(key, [placement])
    }

    const span = Math.ceil(GATHER_RADIUS / CELL_SIZE)
    for (let index = 0; index < variants.length; index++) {
      const cells = perVariant[index]
      const capacity = Math.max(1, worstCaseResident(cells, span))
      const source = variants[index]
      const mesh = new THREE.InstancedMesh(source.geometry, source.material, capacity)
      mesh.name = `${name}-${index}`
      mesh.castShadow = options.castShadow
      mesh.receiveShadow = true
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.count = 0
      // 인스턴스가 플레이어를 따라다니므로 바운딩이 계속 바뀐다. 컬링을
      // 끄는 편이 매번 재계산하는 것보다 싸고, 어차피 항상 화면 안이다.
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.buckets.push({ mesh, cells, capacity })
    }
  }

  /**
   * 플레이어 위치에 맞춰 상주 인스턴스를 갱신한다.
   *
   * 셀이 바뀌지 않았으면 아무것도 하지 않는다 — 대부분의 프레임이 여기서 끝난다.
   */
  update(playerX: number, playerZ: number): void {
    const cellX = Math.floor(playerX / CELL_SIZE)
    const cellZ = Math.floor(playerZ / CELL_SIZE)
    if (cellX === this.lastCellX && cellZ === this.lastCellZ) return
    this.lastCellX = cellX
    this.lastCellZ = cellZ

    const span = Math.ceil(GATHER_RADIUS / CELL_SIZE)
    let total = 0
    for (const bucket of this.buckets) {
      let written = 0
      const limit = Math.max(1, Math.floor(bucket.capacity * this.budget))
      // 가까운 셀부터 채운다. 예산이 모자라면 먼 것이 잘린다.
      for (let ring = 0; ring <= span && written < limit; ring++) {
        for (let dz = -ring; dz <= ring && written < limit; dz++) {
          for (let dx = -ring; dx <= ring && written < limit; dx++) {
            // 이번 링의 테두리만 본다. 안쪽은 이전 반복에서 이미 처리했다.
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue
            const list = bucket.cells.get(cellKey(cellX + dx, cellZ + dz))
            if (!list) continue
            for (const placement of list) {
              if (written >= limit) break
              this.position.set(placement.x, placement.groundY - placement.sink, placement.z)
              this.euler.set(placement.tiltX, placement.rotation, placement.tiltZ)
              this.quaternion.setFromEuler(this.euler)
              this.scaleVec.setScalar(placement.scale)
              this.matrix.compose(this.position, this.quaternion, this.scaleVec)
              bucket.mesh.setMatrixAt(written, this.matrix)
              written++
            }
          }
        }
      }
      bucket.mesh.count = written
      bucket.mesh.instanceMatrix.needsUpdate = true
      total += written
    }
    this.residentCount = total
  }

  /**
   * 저사양 경로. 상주 비율을 낮추고 즉시 다시 채운다.
   *
   * `lastCell`을 무효화해야 다음 update가 실제로 다시 쓴다 — 안 그러면
   * 플레이어가 셀을 넘을 때까지 예전 개수가 남는다.
   */
  setQuality(high: boolean): void {
    const next = high ? 1 : 0.45
    if (next === this.budget) return
    this.budget = next
    this.lastCellX = Number.NaN
    this.lastCellZ = Number.NaN
  }

  dispose(): void {
    for (const bucket of this.buckets) {
      bucket.mesh.dispose()
      this.group.remove(bucket.mesh)
    }
    this.buckets.length = 0
  }
}

/**
 * 어느 위치에 서도 이 변형이 동시에 몇 개까지 올라올 수 있는지 구한다.
 *
 * 전체 개수로 용량을 잡으면 메모리가 낭비되고, 눈대중으로 잡으면 붐비는
 * 구역에서 조용히 잘려 나간다(그 자리만 풀이 안 나는데 원인을 찾기 어렵다).
 * 실제 셀 점유를 훑어 최댓값을 구하는 게 확실하다.
 */
function worstCaseResident(
  cells: Map<number, ScatterPlacement[]>,
  span: number,
): number {
  let worst = 0
  for (const key of cells.keys()) {
    const cx = (key >> 10) - 512
    const cz = (key & 0x3ff) - 512
    let sum = 0
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        sum += cells.get(cellKey(cx + dx, cz + dz))?.length ?? 0
      }
    }
    if (sum > worst) worst = sum
  }
  return worst
}
