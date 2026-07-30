import * as THREE from 'three'

import { type ArenaArc, type ArenaVisual, createArena } from '../arena.ts'
import { EnvAssetLoader } from './assets.ts'
import { Atmosphere } from './atmosphere.ts'
import { loadEnvManifest } from './manifest.ts'
import { EnvMaterialFactory } from './materials.ts'
import { GroundSampler, PropField } from './props.ts'
import { generatePlacements, SCATTER_KINDS, ScatterField } from './scatter.ts'

/**
 * 환경 레이어 오케스트레이터.
 *
 * 기존 `createArena()`(절차식 아레나)를 감싸고, Blender 에셋이 도착하면 그 위에
 * 얹거나 대체한다.
 *
 * ## 왜 절차식 아레나를 지우지 않는가
 *
 * 에셋 로딩은 비동기이고 실패할 수 있다. GLB가 없는 빌드, 네트워크 실패, 아직
 * 굽지 않은 에셋 — 어느 경우든 **게임은 그대로 실행돼야 한다.** 절차식 아레나는
 * 2 드로우콜짜리 안전망이고, 대체된 뒤에는 `visible = false`로만 꺼 두므로
 * 비용이 0이다.
 *
 * 이 구조 덕분에 에셋을 하나씩 만들어 가며 언제든 게임을 켤 수 있다. 환경
 * 아트처럼 반복이 잦은 작업에서는 이게 속도 그 자체다.
 */

export interface EnvironmentVisual extends ArenaVisual {
  /**
   * 매 렌더 프레임 호출한다.
   *
   * @param playerX 플레이어 월드 X. 산포 필드가 이 주변만 GPU에 올린다.
   */
  update(
    dt: number,
    playerX: number,
    playerZ: number,
    gatherRadius?: number,
  ): void
  /**
   * 렌더 품질 단계.
   *
   * 렌더러의 적응형 정책이 프레임 간격을 보고 한 번 내린다. 지면 텍스처
   * 블렌드(픽셀당 10샘플), 부유 입자, 안개 층 수를 함께 낮춘다.
   */
  setQuality(high: boolean): void
  /** 에셋 로딩이 끝나면 resolve. 테스트와 캡처가 기다린다. */
  readonly ready: Promise<EnvironmentStats>
}

export interface EnvironmentStats {
  loaded: string[]
  missing: string[]
  /** 상주 산포 인스턴스 수(플레이어 주변). */
  scatterResident: number
  /** 정적 환경 삼각형 수. */
  staticTriangles: number
}

/** 산포 종류 → GLB 안의 오브젝트 이름. */
const SCATTER_SOURCES: Record<string, { asset: string; objects: string[]; shadow: boolean }> = {
  pebble: { asset: 'scatter-kit', objects: ['pebble-a', 'pebble-b', 'pebble-c', 'pebble-d', 'pebble-e'], shadow: false },
  rubble: { asset: 'scatter-kit', objects: ['rubble-a', 'rubble-b', 'rubble-c', 'rubble-d'], shadow: true },
  shard: { asset: 'scatter-kit', objects: ['shard-a', 'shard-b', 'shard-c'], shadow: true },
  mossclump: { asset: 'scatter-kit', objects: ['mossclump-a', 'mossclump-b'], shadow: false },
  root: { asset: 'scatter-kit', objects: ['root-a', 'root-b'], shadow: false },
  grass: { asset: 'foliage-kit', objects: ['grass-a', 'grass-b', 'grass-c'], shadow: false },
  fern: { asset: 'foliage-kit', objects: ['fern-a'], shadow: false },
  reed: { asset: 'foliage-kit', objects: ['reed-a'], shadow: false },
  debris: {
    asset: 'debris-kit',
    objects: [
      'slab-broken-a',
      'slab-broken-b',
      'column-drum-a',
      'column-drum-b',
      'beam-a',
      'tile-pile-a',
    ],
    shadow: true,
  },
}

/**
 * 성벽 밖 자연물. 지형 높이를 따라가야 하므로 아레나 안 산포와 분리한다.
 *
 * 바위 5종은 각각 별도 GLB다 — 하나의 키트로 묶지 않은 것은 Blender 쪽
 * 결정이고, 여기서는 로드한 뒤 변형 배열로 합친다.
 */
const OUTER_SOURCES: Record<
  string,
  { assets: string[]; objects: (string | null)[]; shadow: boolean }
> = {
  boulder: {
    assets: ['boulder-a', 'boulder-b', 'boulder-c', 'boulder-d', 'boulder-e'],
    objects: [null, null, null, null, null],
    shadow: true,
  },
  pine: { assets: ['pine-tall', 'pine-bent'], objects: [null, null], shadow: true },
  bamboo: { assets: ['bamboo-clump'], objects: [null], shadow: true },
}

/** 산포 종류별 배치 시드. 겹치면 자갈과 풀이 같은 자리에 난다. */
const SCATTER_SEED: Record<string, number> = {
  pebble: 10_301,
  rubble: 20_509,
  shard: 30_703,
  mossclump: 40_927,
  root: 51_131,
  grass: 61_337,
  fern: 71_549,
  reed: 81_761,
  debris: 91_997,
  boulder: 102_181,
  pine: 112_397,
  bamboo: 122_609,
}

/**
 * 성벽 24칸 중 문루·각루가 차지하는 자리.
 *
 * 네 방위(0/6/12/18)는 문루, 대각선(3/9/15/21)은 각루가 대신 선다. 이 칸에
 * 성벽 조각을 그대로 두면 문 안에 벽이 박힌다.
 */
const GATE_SLOTS = new Set([0, 6, 12, 18])
const TOWER_SLOTS = new Set([3, 9, 15, 21])

export function createEnvironment(
  radius: number,
  gl: THREE.WebGLRenderer,
  baseUrl: string,
): EnvironmentVisual {
  const group = new THREE.Group()
  group.name = 'environment'

  const fallback = createArena(radius)
  group.add(fallback.group)

  // 대기 연출은 Blender 에셋과 무관하다. 로딩을 기다릴 이유가 없고,
  // 에셋이 하나도 없는 빌드에서도 공간감은 있어야 한다.
  const atmosphere = new Atmosphere()
  group.add(atmosphere.group)

  let factory: EnvMaterialFactory | null = null
  const fields: ScatterField[] = []
  let props: PropField | null = null
  let currentArc: Readonly<ArenaArc> | null = null
  let disposed = false
  /** 에셋이 늦게 도착해도 이미 정해진 품질 단계를 따라가게 기억해 둔다. */
  let highQuality = true

  const stats: EnvironmentStats = {
    loaded: [],
    missing: [],
    scatterResident: 0,
    staticTriangles: 0,
  }

  const ready = (async (): Promise<EnvironmentStats> => {
    const manifest = await loadEnvManifest(baseUrl)
    if (disposed) return stats
    if (manifest.assets.length === 0) {
      // 파이프라인이 아직 안 돌았다. 절차식 아레나만 남기고 조용히 끝낸다.
      return stats
    }

    factory = new EnvMaterialFactory(
      manifest,
      baseUrl,
      gl.capabilities.getMaxAnisotropy(),
    )
    // 로딩 중에 아크가 이미 진행됐을 수 있다. 첫 프레임부터 색이 맞아야 한다.
    if (currentArc) factory.applyArc(currentArc)
    factory.setQuality(highQuality)

    const loader = new EnvAssetLoader(manifest, factory, baseUrl)

    // --- 지형 -----------------------------------------------------------
    const terrain = await Promise.all([
      loader.load('plaza-floor'),
      loader.load('moon-altar'),
      loader.load('outer-terrace'),
    ])
    if (disposed) return stats

    let replacedFloor = false
    let replacedBoundary = false
    /** 프롭을 앉힐 지면. 레이캐스트 대상이라 발광 상감 같은 얇은 판은 뺀다. */
    const groundMeshes: THREE.Object3D[] = []
    /** 성벽 밖 지형. 나무·바위를 앉힐 때 높이를 여기서 읽는다. */
    const outerGround: THREE.Object3D[] = []
    for (const asset of terrain) {
      if (!asset) continue
      stats.loaded.push(asset.spec.name)
      stats.staticTriangles += asset.spec.triangles
      for (const [objectName, mesh] of asset.objects) {
        if (!objectName.includes('inlay')) groundMeshes.push(mesh)
      }
      for (const mesh of asset.objects.values()) {
        // 지면은 그림자를 만들지 않는다. 평평한 판이 자기 자신에게 드리우면
        // 얕은 요철에서 여드름(shadow acne)만 생기고 얻는 게 없다.
        mesh.castShadow = false
        mesh.receiveShadow = true
        group.add(mesh)
      }
      if (asset.spec.name === 'plaza-floor') replacedFloor = true
      if (asset.spec.name === 'outer-terrace') replacedBoundary = true
    }

    const fallbackFloor = fallback.group.getObjectByName('arena-floor')
    const fallbackBoundary = fallback.group.getObjectByName(
      'arena-boundary-and-landmarks',
    )
    if (replacedFloor && fallbackFloor) fallbackFloor.visible = false
    if (replacedBoundary && fallbackBoundary) fallbackBoundary.visible = false

    // --- 산포 -----------------------------------------------------------
    const kitCache = new Map<string, Awaited<ReturnType<EnvAssetLoader['load']>>>()
    for (const [kindName, source] of Object.entries(SCATTER_SOURCES)) {
      if (!kitCache.has(source.asset)) {
        kitCache.set(source.asset, await loader.load(source.asset))
      }
      if (disposed) return stats
      const kit = kitCache.get(source.asset)
      if (!kit) {
        if (!stats.missing.includes(source.asset)) stats.missing.push(source.asset)
        continue
      }

      const variants = source.objects
        .map((name) => kit.objects.get(name))
        .filter((mesh): mesh is THREE.Mesh => mesh !== undefined)
      if (variants.length === 0) {
        stats.missing.push(`${source.asset}:${source.objects[0]}`)
        continue
      }

      const kind = SCATTER_KINDS[kindName]
      const placements = generatePlacements(
        // 변형이 GLB에 덜 들어 있으면 있는 만큼만 쓴다. 없는 인덱스를
        // 가리키면 그 배치가 통째로 사라진다.
        { ...kind, variants: variants.length },
        SCATTER_SEED[kindName],
      )
      const field = new ScatterField(kindName, variants, placements, {
        castShadow: source.shadow,
      })
      fields.push(field)
      group.add(field.group)
      stats.loaded.push(`${kindName}×${placements.length}`)
    }

    // --- 성벽 링 ---------------------------------------------------------
    //
    // 15° 조각 24개가 원을 이룬다. 세 변형을 결정적 패턴으로 섞는데, 순수
    // 난수를 쓰면 무너진 구간이 몰리거나 한 바퀴 내내 멀쩡한 시드가 나온다.
    // 소수 간격으로 배치하면 어디서 봐도 세 상태가 섞여 보인다.
    const wallVariants = await Promise.all([
      loader.load('wall-intact'),
      loader.load('wall-worn'),
      loader.load('wall-breached'),
    ])
    if (disposed) return stats

    const availableWalls = wallVariants.filter(
      (asset): asset is NonNullable<typeof asset> => asset !== null,
    )
    if (availableWalls.length > 0) {
      const WALL_SEGMENTS = 24
      // 인덱스 → 변형. 7과 11은 24와 서로소라 한 바퀴 도는 동안 규칙이
      // 눈에 잡히지 않는다.
      const pick = (index: number): number => {
        if (availableWalls.length === 1) return 0
        const worn = (index * 7) % 24 < 9 ? 1 : 0
        const breached = (index * 11) % 24 < 4 ? 2 : worn
        return Math.min(breached, availableWalls.length - 1)
      }

      const buckets = availableWalls.map(() => [] as number[])
      for (let i = 0; i < WALL_SEGMENTS; i++) {
        if (GATE_SLOTS.has(i) || TOWER_SLOTS.has(i)) continue
        buckets[pick(i)].push(i)
      }

      for (let v = 0; v < availableWalls.length; v++) {
        const asset = availableWalls[v]
        const indices = buckets[v]
        if (indices.length === 0) continue
        stats.loaded.push(`${asset.spec.name}×${indices.length}`)
        stats.staticTriangles += asset.spec.triangles * indices.length

        // **인스턴싱하지 않는다.**
        //
        // InstancedMesh는 통째로 절두체 컬링된다. 성벽 24칸의 바운딩은
        // 반경 34m 원 전체라 한 칸도 걸러지지 않아, 화면에 두세 칸만
        // 보여도 24칸 × 3.5천 삼각형이 매 프레임(+ 그림자 패스에서 한 번 더)
        // 전부 통과한다. 실측에서 이것 때문에 삼각형이 1.19M까지 올라갔다.
        //
        // 개별 메시로 두면 드로우콜은 늘지만 실제로 보이는 건 서너 칸뿐이라
        // 정점 처리량이 5분의 1로 떨어진다. 브라우저 게임에서는 이쪽이 맞다.
        for (const [, mesh] of asset.objects) {
          for (const index of indices) {
            const piece = new THREE.Mesh(mesh.geometry, mesh.material)
            piece.name = `wall-${asset.spec.name}-${index}`
            piece.castShadow = true
            piece.receiveShadow = true
            // 조각은 이미 r=34에 굽은 상태로 만들어졌고 +Y를 중심으로 한다.
            piece.rotation.y = -(index / WALL_SEGMENTS) * Math.PI * 2
            piece.updateMatrix()
            piece.matrixAutoUpdate = false
            group.add(piece)
          }
        }
      }
    } else {
      stats.missing.push('wall-*')
    }

    // --- 문루와 각루 -----------------------------------------------------
    //
    // 성벽 링의 빈 칸에 세운다. 조각과 같은 방식으로 이미 굽은 상태로
    // 만들어졌으므로 Y축 회전만 준다.
    for (const [assetName, slots] of [
      ['gatehouse', GATE_SLOTS],
      ['corner-tower', TOWER_SLOTS],
    ] as const) {
      const asset = await loader.load(assetName)
      if (disposed) return stats
      if (!asset) {
        stats.missing.push(assetName)
        continue
      }
      stats.loaded.push(`${assetName}×${slots.size}`)
      stats.staticTriangles += asset.spec.triangles * slots.size

      const indices = [...slots]
      // 성벽과 같은 이유로 개별 메시다(위 주석 참조). 문루는 조각당
      // 26,000 삼각형이라 컬링 여부의 차이가 특히 크다.
      for (const [, mesh] of asset.objects) {
        for (const index of indices) {
          const piece = new THREE.Mesh(mesh.geometry, mesh.material)
          piece.name = `structure-${assetName}-${index}`
          piece.castShadow = true
          piece.receiveShadow = true
          piece.rotation.y = -(index / 24) * Math.PI * 2
          piece.updateMatrix()
          piece.matrixAutoUpdate = false
          group.add(piece)
        }
      }
    }

    // --- 바깥 지형 -------------------------------------------------------
    const outer = await loader.load('outer-terrain')
    if (disposed) return stats
    if (outer) {
      stats.loaded.push(outer.spec.name)
      stats.staticTriangles += outer.spec.triangles
      for (const mesh of outer.objects.values()) {
        outerGround.push(mesh)
        // 바깥 지형은 그림자를 받기만 한다. 성벽 밖으로 드리우는 그림자는
        // 화면에 거의 안 나오는데 그림자 카메라 범위만 넓힌다.
        mesh.castShadow = false
        mesh.receiveShadow = true
        group.add(mesh)
      }
    } else {
      stats.missing.push('outer-terrain')
    }

    // --- 성벽 밖 자연물 ---------------------------------------------------
    //
    // 바깥 지형은 r=48에서 -6m까지 떨어진다. 평지 가정으로 뿌리면 나무가
    // 공중에 뜨므로 지형에 레이캐스트해 높이를 얻는다.
    if (outerGround.length > 0) {
      const sampler = new GroundSampler(outerGround)
      const heightAt = (x: number, z: number): number => sampler.heightAt(x, z)

      for (const [kindName, source] of Object.entries(OUTER_SOURCES)) {
        const variants: THREE.Mesh[] = []
        for (let i = 0; i < source.assets.length; i++) {
          const asset = await loader.load(source.assets[i])
          if (disposed) return stats
          if (!asset) continue
          const wanted = source.objects[i]
          const mesh = wanted
            ? asset.objects.get(wanted)
            : asset.objects.values().next().value
          if (mesh) variants.push(mesh)
        }
        if (variants.length === 0) {
          stats.missing.push(`outer:${kindName}`)
          continue
        }
        const placements = generatePlacements(
          { ...SCATTER_KINDS[kindName], variants: variants.length },
          SCATTER_SEED[kindName],
        )
        const field = new ScatterField(kindName, variants, placements, {
          castShadow: source.shadow,
          heightAt,
        })
        field.setQuality(highQuality)
        fields.push(field)
        group.add(field.group)
        stats.loaded.push(`${kindName}×${placements.length}`)
      }
    }

    // --- 배치형 프롭 -----------------------------------------------------
    const propAssets = new Map<string, NonNullable<Awaited<ReturnType<EnvAssetLoader['load']>>>>()
    for (const name of ['stone-lantern', 'brazier', 'haetae', 'stone-pagoda']) {
      const asset = await loader.load(name)
      if (disposed) return stats
      if (asset) {
        propAssets.set(name, asset)
        stats.loaded.push(asset.spec.name)
        stats.staticTriangles += asset.spec.triangles
      } else {
        stats.missing.push(name)
      }
    }
    if (propAssets.size > 0) {
      props = new PropField(propAssets, groundMeshes)
      group.add(props.group)
    }

    // 원본 메시는 인스턴스의 지오메트리·머티리얼만 빌려 쓴 것이라 씬에
    // 넣지 않는다. GLB 씬 그래프에 남아 있어도 group에 add하지 않았으므로
    // 렌더되지 않는다.

    return stats
  })().catch((error): EnvironmentStats => {
    if (import.meta.env.DEV) console.warn('[env] 환경 로딩 실패', error)
    return stats
  })

  return {
    group,
    ready,
    applyArc(arc: Readonly<ArenaArc>): void {
      currentArc = arc
      fallback.applyArc(arc)
      factory?.applyArc(arc)
    },
    update(
      dt: number,
      playerX: number,
      playerZ: number,
      gatherRadius?: number,
    ): void {
      if (currentArc) atmosphere.update(dt, playerX, playerZ, currentArc)
      if (!factory) return
      factory.advanceWind(dt)
      let resident = 0
      for (const field of fields) {
        field.update(playerX, playerZ, gatherRadius)
        resident += field.residentCount
      }
      stats.scatterResident = resident
      if (props && currentArc) props.update(dt, playerX, playerZ, currentArc)
    },
    setQuality(high: boolean): void {
      highQuality = high
      atmosphere.setQuality(high)
      factory?.setQuality(high)
      for (const field of fields) field.setQuality(high)
    },
    dispose(): void {
      disposed = true
      fallback.dispose()
      atmosphere.dispose()
      for (const field of fields) field.dispose()
      fields.length = 0
      props?.dispose()
      factory?.dispose()
    },
  }
}
