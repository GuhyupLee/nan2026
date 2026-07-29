import * as THREE from 'three'

import type { Renderer } from '../renderer.ts'
import type { World } from '../../sim/types.ts'

/**
 * 개발 전용 오프라인 캡처 훅.
 *
 * ## 왜 필요한가
 *
 * 환경 아트를 만드는 동안 렌더 결과를 계속 눈으로 봐야 하는데, 자동화된
 * 브라우저 탭은 `document.hidden === true`인 채로 돌아간다. 그 상태에서
 * `requestAnimationFrame`은 정지하므로 게임 루프가 멈추고, 스크린샷을 찍어도
 * 마지막으로 합성된 (대개 빈) 프레임만 나온다.
 *
 * 이 훅은 rAF를 우회해 **호출 즉시 한 프레임을 직접 렌더하고 같은 태스크 안에서
 * 캔버스를 읽는다.** `preserveDrawingBuffer`가 꺼져 있어도 렌더와 읽기 사이에
 * 합성이 끼지 않으므로 픽셀이 살아 있다.
 *
 * ## 배포 빌드에 들어가지 않는다
 *
 * `import.meta.env.DEV` 안에서만 설치된다. Vite가 프로덕션 번들에서 이 분기를
 * 통째로 제거한다.
 */

export interface DevShotOptions {
  /** 시뮬 시각(초). 5분 아크의 어느 지점을 볼지 고른다. */
  time?: number
  /** 보스 등장 상태를 강제한다. */
  boss?: boolean
  /** 보스 2페이즈까지 진행시킨다. */
  phaseTwo?: boolean
  /** 캡처 서버로 보낼 파일 이름. 비우면 data URL만 돌려준다. */
  name?: string
  /** 캡처 서버 포트. */
  port?: number
  /** JPEG 품질. */
  quality?: number
  /** 렌더를 몇 번 반복할지. 셰이더 컴파일·IBL 워밍업 때문에 2 이상을 권한다. */
  warmup?: number
  /** 캡처 해상도. 탭에 레이아웃이 없어도 이 크기로 강제한다. */
  width?: number
  height?: number
  /** 플레이어를 이 위치로 옮겨 찍는다. 구도를 바꿔 볼 때 쓴다. */
  at?: { x: number; z: number }
}

export interface DevShotApi {
  renderer: Renderer
  /** 콘솔에서 씬을 직접 조립해 볼 수 있게 three 네임스페이스를 그대로 노출한다. */
  THREE: typeof THREE
  getWorld(): World
  shot(options?: DevShotOptions): Promise<string>
  /**
   * 카메라 가시 범위 측정용 마커를 세운다.
   *
   * 이 게임 카메라는 부감 52°에 FOV 40°다. 그 조합에서 **지평선은 화면에
   * 절대 들어오지 않고**, 멀리 있는 높은 물체는 화면 위로 잘려 나간다.
   * 어떤 에셋이 실제로 보이는지 계산이 아니라 눈으로 확인해야 예산을
   * 낭비하지 않는다.
   */
  probe(enabled: boolean): number
}

declare global {
  interface Window {
    __mw?: DevShotApi
  }
}

export function installDevShot(renderer: Renderer, getWorld: () => World): void {
  if (!import.meta.env.DEV) return

  let probeGroup: THREE.Group | null = null

  const api: DevShotApi = {
    renderer,
    THREE,
    getWorld,
    probe(enabled: boolean): number {
      if (probeGroup) {
        renderer.scene.remove(probeGroup)
        probeGroup.traverse((node) => {
          if (node instanceof THREE.Mesh) {
            node.geometry.dispose()
            ;(node.material as THREE.Material).dispose()
          }
        })
        probeGroup = null
      }
      if (!enabled) return 0

      probeGroup = new THREE.Group()
      probeGroup.name = 'devshot-probe'
      let count = 0
      // 반경 10m 간격의 링마다 색이 다른 기둥을 세운다. 높이 눈금은 1m마다
      // 밝기가 바뀌어 화면에서 몇 미터가 잘렸는지 셀 수 있다.
      const rings: Array<[number, number]> = [
        [10, 0x2f9e6a],
        [20, 0x3d7fd0],
        [30, 0xd0a13d],
        [34, 0xd04a4a],
        [44, 0x9a4ad0],
        [70, 0xffffff],
      ]
      for (const [radius, color] of rings) {
        for (let i = 0; i < 12; i++) {
          const angle = (i / 12) * Math.PI * 2
          for (let level = 0; level < 8; level++) {
            const mesh = new THREE.Mesh(
              new THREE.BoxGeometry(0.5, 1, 0.5),
              new THREE.MeshBasicMaterial({
                color,
                // 1m 눈금마다 밝기를 번갈아 준다.
                opacity: level % 2 === 0 ? 1 : 0.45,
                transparent: level % 2 !== 0,
              }),
            )
            mesh.position.set(
              Math.cos(angle) * radius,
              level + 0.5,
              Math.sin(angle) * radius,
            )
            probeGroup.add(mesh)
            count++
          }
        }
      }
      renderer.scene.add(probeGroup)
      return count
    },
    async shot(options: DevShotOptions = {}): Promise<string> {
      const world = getWorld()
      // 자동화 탭은 화면에 합성되지 않아 레이아웃이 0×0이다. 매번 강제한다.
      renderer.forceSize(options.width ?? 1600, options.height ?? 900)

      const restore = {
        time: world.time,
        spawned: world.boss.spawned,
        spawnedAt: world.boss.spawnedAt,
        phaseTwoAt: world.boss.phaseTwoAt,
        px: world.player.pos.x,
        py: world.player.pos.y,
      }
      if (options.at) {
        world.player.pos.x = options.at.x
        world.player.pos.y = options.at.z
      }

      // 시뮬을 실제로 굴리지 않고 **읽기 값만** 잠깐 바꾼다. 렌더러는 sim을
      // 읽기만 하므로 이걸로 아크의 어느 지점이든 즉시 볼 수 있고, 끝나면
      // 원래대로 되돌려 진행 중인 판에 영향을 주지 않는다.
      if (options.time !== undefined) world.time = options.time
      if (options.boss) {
        world.boss.spawned = true
        world.boss.spawnedAt = Math.max(0, (options.time ?? world.time) - 6)
      }
      if (options.phaseTwo) {
        world.boss.spawned = true
        world.boss.spawnedAt = Math.max(0, (options.time ?? world.time) - 20)
        world.boss.phaseTwoAt = Math.max(0, (options.time ?? world.time) - 8)
      }

      const passes = Math.max(1, options.warmup ?? 3)
      for (let i = 0; i < passes; i++) renderer.render(world, 1)

      const canvas = renderer.domElement
      const url = canvas.toDataURL('image/jpeg', options.quality ?? 0.9)

      world.time = restore.time
      world.boss.spawned = restore.spawned
      world.boss.spawnedAt = restore.spawnedAt
      world.boss.phaseTwoAt = restore.phaseTwoAt
      world.player.pos.x = restore.px
      world.player.pos.y = restore.py

      if (options.name) {
        const port = options.port ?? 5199
        await fetch(`http://localhost:${port}/${options.name}`, {
          method: 'POST',
          body: url,
        })
        return options.name
      }
      return url
    },
  }

  window.__mw = api
}
