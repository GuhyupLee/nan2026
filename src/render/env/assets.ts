import * as THREE from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

import type { EnvMaterialFactory } from './materials.ts'
import type { EnvAssetSpec, EnvManifest } from './manifest.ts'

/**
 * 환경 GLB 로더.
 *
 * Blender가 Draco로 압축해 내보내기 때문에 디코더가 필요하다. 압축률이
 * 4~6배라 디코더(190KB wasm) 값을 첫 에셋 하나에서 이미 뽑는다.
 *
 * ## 머티리얼 재바인딩
 *
 * GLB에는 머티리얼 **이름**만 있고 텍스처는 없다. 로드 직후 이름으로
 * `EnvMaterialFactory`의 머티리얼을 찾아 갈아끼운다. 같은 이름은 항상 같은
 * 인스턴스가 돌아오므로, 서로 다른 GLB의 메시들이 자동으로 같은 머티리얼을
 * 공유하고 three가 드로우콜을 묶는다.
 *
 * 이름을 못 찾으면 GLB의 것을 그대로 둔다(텍스처 없는 회색). 개발 빌드에서만
 * 경고를 남긴다 — 파이프라인이 반쯤 돌아간 상태가 정상적인 작업 상태라
 * 예외로 멈추면 안 된다.
 */

const IDENTITY = new THREE.Matrix4()

export interface LoadedAsset {
  spec: EnvAssetSpec
  /** GLB 안의 이름별 메시. 오브젝트를 개별로 내보냈으면 여기서 나뉘어 나온다. */
  objects: Map<string, THREE.Mesh>
  /** 애니메이션 클립. 없으면 빈 배열. */
  clips: THREE.AnimationClip[]
}

export class EnvAssetLoader {
  private readonly gltf: GLTFLoader
  private readonly draco: DRACOLoader
  private readonly factory: EnvMaterialFactory
  private readonly manifest: EnvManifest
  private readonly baseUrl: string
  private readonly missingMaterials = new Set<string>()

  constructor(manifest: EnvManifest, factory: EnvMaterialFactory, baseUrl: string) {
    this.manifest = manifest
    this.factory = factory
    this.baseUrl = baseUrl
    this.draco = new DRACOLoader()
    this.draco.setDecoderPath(`${baseUrl}draco/`)
    this.gltf = new GLTFLoader()
    this.gltf.setDRACOLoader(this.draco)
  }

  /**
   * 이름으로 에셋을 로드한다.
   *
   * 매니페스트에 없거나 파일이 없으면 `null`을 돌려준다. 호출부는 항상
   * null을 처리해야 한다 — 에셋 스크립트가 아직 안 돌았을 수 있다.
   */
  async load(name: string): Promise<LoadedAsset | null> {
    const spec = this.manifest.assets.find((asset) => asset.name === name)
    if (!spec) return null

    let gltf: Awaited<ReturnType<GLTFLoader['loadAsync']>>
    try {
      gltf = await this.gltf.loadAsync(`${this.baseUrl}${spec.path}`)
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn(`[env] 에셋 로드 실패: ${name} (${spec.path})`, error)
      }
      return null
    }

    // 노드 변환을 지오메트리에 굽는다.
    //
    // 호출부는 이 메시들의 **지오메트리만** 꺼내 `InstancedMesh`를 만든다.
    // 그때 노드의 로컬 변환은 버려진다. Blender에서 오브젝트를 원점에 두고
    // 만들었다면 문제가 없지만, 석등의 발광 코어처럼 오브젝트 원점이
    // 부모 기준으로 1.5m 위에 있으면 **그 부품만 바닥에 붙는다.**
    //
    // 실제로 그 증상이 나왔다: 석등은 납작해지고 불빛만 바닥에서 새어
    // 나왔다. 여기서 한 번 구워 두면 어떤 GLB든 부품 위치가 보존된다.
    gltf.scene.updateMatrixWorld(true)

    const objects = new Map<string, THREE.Mesh>()
    gltf.scene.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return
      if (!node.matrixWorld.equals(IDENTITY)) {
        node.geometry = node.geometry.clone()
        node.geometry.applyMatrix4(node.matrixWorld)
      }
      node.position.set(0, 0, 0)
      node.quaternion.identity()
      node.scale.setScalar(1)
      node.updateMatrix()
      this.rebind(node)
      // Blender 오브젝트 이름이 곧 키다. 이름이 겹치면 익스포터가 접미사를
      // 붙이므로 원본 이름 기준으로 정규화한다. 멀티 머티리얼 메시는
      // GLTFLoader가 `_1`, `_2` 접미사를 붙이는데 그건 보존해야 한다 —
      // 부품마다 다른 지오메트리이기 때문이다.
      objects.set(node.name.replace(/\.\d{3}$/, ''), node)
    })

    return { spec, objects, clips: gltf.animations ?? [] }
  }

  private rebind(mesh: THREE.Mesh): void {
    const source = mesh.material
    const rebindOne = (material: THREE.Material): THREE.Material => {
      const replacement = this.factory.get(material.name)
      if (replacement) {
        // GLB가 들고 온 머티리얼은 더 이상 쓰이지 않는다. 놔두면 텍스처
        // 없는 껍데기가 GPU 리소스를 잡은 채 남는다.
        material.dispose()
        return replacement
      }
      if (import.meta.env.DEV && !this.missingMaterials.has(material.name)) {
        this.missingMaterials.add(material.name)
        console.warn(
          `[env] 매니페스트에 없는 머티리얼: "${material.name}" — ` +
            '텍스처 없이 렌더된다. 해당 텍스처 스크립트를 실행했는지 확인하라.',
        )
      }
      return material
    }

    mesh.material = Array.isArray(source)
      ? source.map(rebindOne)
      : rebindOne(source)

    // 탄젠트는 **계산하지 않는다.**
    //
    // 처음에는 `computeTangents()`를 불렀다. 화면 미분 근사보다 정확할 거라
    // 생각했는데, 이 프로젝트의 UV는 `mw.uv_box()`가 만든 월드 공간 박스
    // 투영이라 면마다 UV가 끊긴다. 그런 이음매에서 computeTangents는
    // **길이 0인 탄젠트**를 만든다 — 실측으로 판석 바닥 정점 93,419개 중
    // 14,071개가 그랬다.
    //
    // 길이 0 탄젠트 → TBN 행렬의 한 축이 0 → `normalize(tbn * mapN)`이 NaN.
    // NaN 픽셀 하나는 화면에 거의 안 보이지만, **블룸의 블러가 이웃을
    // 섞으면서 NaN이 화면 전체로 번진다.** 결과는 톤매핑 후 완전한 검은
    // 화면이고, 콘솔에는 아무 경고도 없다. "블룸을 끄면 정상"이라는 증상만
    // 남아 원인을 찾는 데 오래 걸린다.
    //
    // three가 탄젠트 없이 쓰는 `getTangentFrame()`은 화면 미분 기반이라
    // UV 이음매에서도 퇴화하지 않는다. 부감 카메라에서 품질 차이는
    // 눈에 띄지 않는다.
    const geometry = mesh.geometry
    if (geometry.attributes.tangent) geometry.deleteAttribute('tangent')
    geometry.computeBoundingSphere()

    mesh.castShadow = true
    mesh.receiveShadow = true
  }

  dispose(): void {
    this.draco.dispose()
  }
}
