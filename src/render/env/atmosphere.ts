import * as THREE from 'three'

import type { ArenaArc } from '../arena.ts'

/**
 * 근거리 대기 — 지면 안개와 부유 입자.
 *
 * ## 왜 필요한가
 *
 * 이 카메라는 지평선을 보지 못한다(SPEC.md "가시 범위"). 화면은 지면과
 * 그 위 **빈 공기**로 나뉘는데, 지금까지 그 공기 칸은 말 그대로 아무것도
 * 없는 검정이었다. 바닥을 아무리 잘 만들어도 "잘 만든 바닥 텍스처"에서
 * 멈추고 공간감이 생기지 않는 이유가 그것이다.
 *
 * 안개와 입자는 **깊이 단서**다. 플레이어 앞뒤로 반투명 층이 겹치면 눈이
 * 거리를 읽고, 그때 비로소 바닥이 사진이 아니라 장소가 된다.
 *
 * ## 비용
 *
 * 안개는 큰 반투명 판 3장이라 오버드로가 실제 비용이다. 그래서 절차 노이즈를
 * 프래그먼트에서 계산하지 않고 **작은 노이즈 텍스처 두 번 샘플링**으로
 * 끝낸다. FBM을 화면 절반에 돌리면 그것만으로 프레임이 흔들린다.
 */

/** 안개 층 높이(m)와 각 층의 기본 불투명도. */
const FOG_LAYERS: readonly (readonly [height: number, opacity: number])[] = [
  [0.22, 0.5],
  [0.62, 0.34],
  [1.25, 0.2],
]

const FOG_RADIUS = 42

const FOG_VERTEX = /* glsl */ `
  varying vec2 vWorldXZ;
  varying vec3 vWorldPos;

  void main() {
    vec4 world = modelMatrix * vec4( position, 1.0 );
    vWorldXZ = world.xz;
    vWorldPos = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`

const FOG_FRAGMENT = /* glsl */ `
  uniform sampler2D uNoise;
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uScale;
  uniform vec3 uPlayer;

  varying vec2 vWorldXZ;
  varying vec3 vWorldPos;

  void main() {
    // 두 겹을 서로 다른 속도·방향으로 흘린다. 한 겹이면 텍스처가 통째로
    // 미끄러지는 게 보이고, 두 겹이 어긋나면 뭉게지는 것처럼 읽힌다.
    vec2 uv0 = vWorldXZ * uScale + vec2( uTime * 0.0075, uTime * 0.0042 );
    vec2 uv1 = vWorldXZ * uScale * 1.73 - vec2( uTime * 0.0051, uTime * 0.0088 );
    float n = texture2D( uNoise, uv0 ).r * 0.62 + texture2D( uNoise, uv1 ).r * 0.38;
    // 임계를 걸어 균일한 뿌연 막이 아니라 덩어리로 만든다.
    float density = smoothstep( 0.42, 0.86, n );

    // 아레나 가장자리로 갈수록 짙어진다. 전투가 벌어지는 중앙을 흐리면
    // 가독성이 떨어지고, 가장자리는 오히려 경계를 부드럽게 감춰 준다.
    float radius = length( vWorldXZ );
    density *= smoothstep( 6.0, 26.0, radius );

    // 카메라에 너무 가까운 층은 화면을 덮어 버린다. 근거리에서 빠르게 죽인다.
    float toCamera = distance( cameraPosition, vWorldPos );
    density *= smoothstep( 6.0, 15.0, toCamera );
    density *= 1.0 - smoothstep( 46.0, 68.0, toCamera );

    // 플레이어 주변은 비워 둔다. 캐릭터에 안개가 겹치면 실루엣이 뭉개져
    // 자기 위치를 읽기 어려워진다 — 이건 연출이 아니라 조작 문제가 된다.
    density *= smoothstep( 2.2, 6.5, distance( vWorldXZ, uPlayer.xz ) );

    float alpha = density * uOpacity;
    if ( alpha < 0.004 ) discard;
    gl_FragColor = vec4( uColor, alpha );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

const MOTE_VERTEX = /* glsl */ `
  attribute float aSeed;
  attribute float aSize;

  uniform float uTime;
  uniform vec3 uCenter;
  uniform float uSpan;
  uniform float uRise;

  varying float vAlpha;
  varying float vSeed;

  void main() {
    vSeed = aSeed;

    // 입자를 월드에 고정하지 않고 **플레이어 주변 상자 안에서 순환**시킨다.
    // 아레나 전체에 뿌리면 화면 안에 남는 건 극히 일부라 수천 개가 필요하다.
    // 상자를 따라다니게 하면 400개로 항상 화면이 찬다.
    vec3 base = position;
    float t = uTime * ( 0.11 + aSeed * 0.16 );
    base.y = mod( base.y + t * uRise, uSpan );
    // 좌우로 천천히 표류. 위상을 씨앗으로 흩어 같은 궤적이 안 보이게 한다.
    base.x += sin( uTime * ( 0.23 + aSeed * 0.3 ) + aSeed * 41.0 ) * 0.9;
    base.z += cos( uTime * ( 0.19 + aSeed * 0.27 ) + aSeed * 27.0 ) * 0.9;

    vec3 world = vec3(
      uCenter.x + mod( base.x + uSpan * 0.5, uSpan ) - uSpan * 0.5,
      base.y,
      uCenter.z + mod( base.z + uSpan * 0.5, uSpan ) - uSpan * 0.5
    );

    // 위아래 끝에서 사라져야 순환 지점이 안 보인다.
    float lifeFade = smoothstep( 0.0, 0.9, base.y ) * ( 1.0 - smoothstep( uSpan * 0.55, uSpan, base.y ) );
    // 깜빡임. 티끌이 빛을 스칠 때만 보이는 현상이라 대비를 세게 준다.
    float twinkle = 0.35 + 0.65 * pow( max( 0.0, sin( uTime * ( 1.7 + aSeed * 2.4 ) + aSeed * 61.0 ) ), 3.0 );
    vAlpha = lifeFade * twinkle;

    vec4 view = viewMatrix * vec4( world, 1.0 );
    gl_Position = projectionMatrix * view;
    // 화면상 크기 상한이 중요하다. 처음에 260을 곱했더니 거리 18m에서
    // 입자가 7~45픽셀이 되어 **눈이 내리는 것처럼** 보였다. 티끌은 거의
    // 점이어야 하고, 존재감은 크기가 아니라 **깜빡임**에서 나온다.
    gl_PointSize = clamp( aSize * ( 46.0 / max( 1.0, -view.z ) ), 1.0, 4.5 );
  }
`

const MOTE_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;

  varying float vAlpha;
  varying float vSeed;

  void main() {
    // 부드러운 원. 사각 점은 즉시 파티클 시스템으로 읽힌다.
    vec2 d = gl_PointCoord - 0.5;
    float r = dot( d, d );
    if ( r > 0.25 ) discard;
    float core = 1.0 - smoothstep( 0.0, 0.25, r );

    // 씨앗마다 색온도를 살짝 달리한다. 전부 같은 색이면 스프라이트로 보인다.
    vec3 tint = mix( uColor, uColor.bgr * 0.85 + 0.15, fract( vSeed * 7.3 ) * 0.35 );
    gl_FragColor = vec4( tint * uIntensity, core * core * vAlpha );
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** 아크 단계별 안개 색. 하늘의 지평선 색과 어긋나면 안개만 떠 보인다. */
const FOG_COLOR: readonly number[] = [0x2c3f5c, 0x2e3856, 0x392c50, 0x4b1f38, 0x571528]
/** 부유 입자 색. 후반에는 재가 날리는 쪽으로 간다. */
const MOTE_COLOR: readonly number[] = [0xbcd2f2, 0xb4c4ee, 0xc4aee2, 0xe89ab0, 0xf58a8a]

function sampleArc(
  target: THREE.Color,
  palette: readonly number[],
  arc: Readonly<ArenaArc>,
): void {
  target
    .setHex(palette[0])
    .lerp(new THREE.Color(palette[1]), arc.dusk)
    .lerp(new THREE.Color(palette[2]), arc.eclipse)
    .lerp(new THREE.Color(palette[3]), arc.boss)
    .lerp(new THREE.Color(palette[4]), arc.phaseTwo)
}

/**
 * 안개용 노이즈 텍스처.
 *
 * 셰이더에서 FBM을 돌리는 대신 한 번 만들어 두고 두 번 샘플링한다. 큰
 * 반투명 판이 화면 절반을 덮는데 프래그먼트마다 옥타브를 도는 건 사치다.
 */
function createNoiseTexture(size = 128): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)

  const hash = (x: number, y: number): number => {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const value = (px: number, py: number, period: number): number => {
    const gx = (px / size) * period
    const gy = (py / size) * period
    const ix = Math.floor(gx)
    const iy = Math.floor(gy)
    const fx = gx - ix
    const fy = gy - iy
    const ux = fx * fx * (3 - 2 * fx)
    const uy = fy * fy * (3 - 2 * fy)
    // 주기로 감싸야 텍스처가 이음매 없이 타일링된다.
    const w = (n: number): number => ((n % period) + period) % period
    const n00 = hash(w(ix), w(iy))
    const n10 = hash(w(ix + 1), w(iy))
    const n01 = hash(w(ix), w(iy + 1))
    const n11 = hash(w(ix + 1), w(iy + 1))
    return (n00 * (1 - ux) + n10 * ux) * (1 - uy) + (n01 * (1 - ux) + n11 * ux) * uy
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n =
        value(x, y, 4) * 0.5 + value(x, y, 8) * 0.3 + value(x, y, 16) * 0.2
      const byte = Math.max(0, Math.min(255, Math.round(n * 255)))
      const index = (y * size + x) * 4
      data[index] = byte
      data[index + 1] = byte
      data[index + 2] = byte
      data[index + 3] = 255
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

export interface AtmosphereOptions {
  /** 부유 입자 수. 저사양에서 줄인다. */
  moteCount?: number
  /** 입자가 도는 상자의 한 변(m). */
  moteSpan?: number
}

export class Atmosphere {
  readonly group = new THREE.Group()

  private readonly noise: THREE.DataTexture
  private readonly fogMaterials: THREE.ShaderMaterial[] = []
  private readonly fogGeometry: THREE.CircleGeometry
  private readonly moteMaterial: THREE.ShaderMaterial
  private readonly moteGeometry: THREE.BufferGeometry
  private readonly motes: THREE.Points
  private readonly fogColor = new THREE.Color()
  private readonly moteColor = new THREE.Color()
  private time = 0
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

  constructor(options: AtmosphereOptions = {}) {
    this.group.name = 'atmosphere'
    this.noise = createNoiseTexture()

    // --- 지면 안개 -------------------------------------------------------
    this.fogGeometry = new THREE.CircleGeometry(FOG_RADIUS, 64)
    for (const [height, opacity] of FOG_LAYERS) {
      const material = new THREE.ShaderMaterial({
        name: `ground-fog-${height}`,
        vertexShader: FOG_VERTEX,
        fragmentShader: FOG_FRAGMENT,
        transparent: true,
        // 깊이를 쓰지 않는다. 층끼리 서로를 가리면 계단이 보이고, 지면과
        // 겹치는 경계에서 하드 엣지가 생긴다.
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
        uniforms: {
          uNoise: { value: this.noise },
          uColor: { value: new THREE.Color(FOG_COLOR[0]) },
          uOpacity: { value: opacity },
          uTime: { value: 0 },
          // 층마다 다른 스케일. 같으면 세 겹이 한 겹으로 보인다.
          uScale: { value: 0.018 + height * 0.006 },
          uPlayer: { value: new THREE.Vector3() },
        },
      })
      const mesh = new THREE.Mesh(this.fogGeometry, material)
      mesh.name = `ground-fog-${height}`
      mesh.rotation.x = -Math.PI / 2
      mesh.position.y = height
      // 반투명 층은 불투명 지오메트리 뒤에 그려야 한다.
      mesh.renderOrder = 4
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.fogMaterials.push(material)
    }

    // --- 부유 입자 -------------------------------------------------------
    const count = options.moteCount ?? 420
    const span = options.moteSpan ?? 46
    const positions = new Float32Array(count * 3)
    const seeds = new Float32Array(count)
    const sizes = new Float32Array(count)
    // 결정적 배치. 판이 바뀌어도 같은 패턴이라 리플레이가 흔들리지 않는다.
    let state = 0x9e3779b9
    const rand = (): number => {
      state = (Math.imul(state ^ (state >>> 15), 2246822519) + 374761393) >>> 0
      return state / 4294967296
    }
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rand() - 0.5) * span
      positions[i * 3 + 1] = rand() * span * 0.55
      positions[i * 3 + 2] = (rand() - 0.5) * span
      seeds[i] = rand()
      // 크기를 제곱 편향. 큰 입자가 드물어야 티끌로 보인다.
      sizes[i] = 0.85 + rand() * rand() * 2.0
    }

    this.moteGeometry = new THREE.BufferGeometry()
    this.moteGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.moteGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1))
    this.moteGeometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))

    this.moteMaterial = new THREE.ShaderMaterial({
      name: 'atmosphere-motes',
      vertexShader: MOTE_VERTEX,
      fragmentShader: MOTE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // 가산 합성. 티끌은 빛을 가리는 게 아니라 반사해 더한다.
      blending: THREE.AdditiveBlending,
      fog: false,
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uSpan: { value: span },
        uRise: { value: 0.55 },
        uColor: { value: new THREE.Color(MOTE_COLOR[0]) },
        uIntensity: { value: 0.34 },
      },
    })

    this.motes = new THREE.Points(this.moteGeometry, this.moteMaterial)
    this.motes.name = 'atmosphere-motes'
    this.motes.renderOrder = 6
    this.motes.frustumCulled = false
    this.group.add(this.motes)
  }

  update(dt: number, playerX: number, playerZ: number, arc: Readonly<ArenaArc>): void {
    // reduced-motion에서도 안개는 남긴다. 흐르는 속도만 줄인다 — 깊이 단서
    // 자체를 없애면 화면이 다시 평평해져 접근성 이득보다 손해가 크다.
    this.time += dt * (this.reducedMotion.matches ? 0.25 : 1)

    sampleArc(this.fogColor, FOG_COLOR, arc)
    sampleArc(this.moteColor, MOTE_COLOR, arc)

    // 월식이 깊어질수록 안개가 올라온다. 보스 단계에서 가장 짙다.
    const density = 1 + arc.dusk * 0.25 + arc.eclipse * 0.4 + arc.boss * 0.55 + arc.phaseTwo * 0.3
    for (let i = 0; i < this.fogMaterials.length; i++) {
      const uniforms = this.fogMaterials[i].uniforms
      uniforms.uTime.value = this.time
      ;(uniforms.uColor.value as THREE.Color).copy(this.fogColor)
      uniforms.uOpacity.value = FOG_LAYERS[i][1] * density
      ;(uniforms.uPlayer.value as THREE.Vector3).set(playerX, 0, playerZ)
    }

    const moteUniforms = this.moteMaterial.uniforms
    moteUniforms.uTime.value = this.time
    ;(moteUniforms.uCenter.value as THREE.Vector3).set(playerX, 0, playerZ)
    ;(moteUniforms.uColor.value as THREE.Color).copy(this.moteColor)
    moteUniforms.uIntensity.value = 0.34 + arc.eclipse * 0.12 + arc.boss * 0.2
    // 후반에는 재가 떠오르듯 상승 속도가 붙는다.
    moteUniforms.uRise.value = 0.55 + arc.boss * 0.5 + arc.phaseTwo * 0.4
  }

  /** 저사양 경로. 입자를 끄고 안개 층을 하나만 남긴다. */
  setQuality(high: boolean): void {
    this.motes.visible = high
    for (let i = 1; i < this.fogMaterials.length; i++) {
      const mesh = this.group.children[i] as THREE.Mesh
      mesh.visible = high
    }
  }

  dispose(): void {
    this.noise.dispose()
    this.fogGeometry.dispose()
    for (const material of this.fogMaterials) material.dispose()
    this.moteGeometry.dispose()
    this.moteMaterial.dispose()
  }
}
