import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'

/**
 * 후처리 스택.
 *
 * 이 파일이 이펙트 오버홀에서 가장 임팩트가 크다. 지금까지 이 게임은 발광
 * 머티리얼(emissive)을 잔뜩 쓰면서 블룸이 없었다. 블룸 없는 emissive는
 * **밝은 색으로 칠한 플라스틱**이지 빛이 아니다 — 지팡이 보주, 칼날 라인,
 * 예광선, 장판이 전부 그래서 싸구려로 보였다. 픽셀을 번지게 하는 이 한 단계가
 * 그 전부를 한꺼번에 고친다.
 *
 * ## 패스 순서와 색공간 (틀리면 화면이 통째로 망가진다)
 *
 * three는 **렌더 타겟으로 그릴 때 톤매핑과 출력 색공간을 끈다**(WebGLRenderer가
 * `currentRenderTarget !== null`이면 toneMapping을 NoToneMapping으로, 색공간을
 * 작업 색공간으로 강제한다). 그래서 EffectComposer를 붙이는 순간:
 *
 *   RenderPass  → 선형(linear) HDR 타겟에 그린다. 톤매핑 안 됨 — **이게 맞다**
 *   Bloom       → 선형에서 밝기 임계값을 판단하고 번진다. 톤매핑된 값에
 *                 임계값을 걸면 밝은 영역이 전부 1.0 근처로 뭉쳐 구분이 안 된다
 *   Grade       → 비네트·색수차·틴트. 역시 선형에서
 *   OutputPass  → **여기서** 렌더러의 ACESFilmic + sRGB를 적용한다. 반드시 마지막
 *
 * OutputPass를 빼면 화면이 감마 보정 없이 나가 시커멓게 되고, 순서를 바꾸면
 * 감마가 두 번 먹어 뿌옇게 뜬다. 둘 다 "조용히 망가지는" 종류라 눈으로
 * 확인하지 않으면 원인을 못 찾는다.
 *
 * 프로젝트의 다른 이펙트 셰이더(skillfx·impact)가 `<tonemapping_fragment>`와
 * `<colorspace_fragment>`를 포함하고 있는데, 렌더 타겟 경로에서는 three가
 * TONE_MAPPING define을 안 켜고 출력 색공간을 선형으로 두므로 두 청크가 저절로
 * 항등이 된다. 후처리를 켜고 끄는 것만으로 저쪽을 손댈 필요가 없다.
 */

export type PostQuality = 'high' | 'low' | 'off'

/**
 * 색 보정 + 비네트 + 화면 틴트.
 *
 * 선형 색공간에서 돈다(OutputPass 앞). 세 가지를 한 패스에 합친 이유는
 * 풀스크린 패스 하나가 1080p에서 200만 프래그먼트라 개수를 늘릴 이유가 없어서다.
 */
const GRADE_SHADER = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** 비네트 세기. 0이면 끈다. */
    uVignette: { value: 0.42 },
    /** 화면 가장자리 색수차(픽셀 단위 오프셋). 중앙은 항상 0이다. */
    uAberration: { value: 1.6 },
    /** 채도. 1이 원본. */
    uSaturation: { value: 1.12 },
    /** 화면 전체 틴트 색과 세기. 피격·처치 순간에 쓴다. */
    uTint: { value: new THREE.Color(0, 0, 0) },
    uTintAmount: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette;
    uniform float uAberration;
    uniform float uSaturation;
    uniform vec3 uTint;
    uniform float uTintAmount;
    uniform vec2 uResolution;
    varying vec2 vUv;

    void main() {
      vec2 c = vUv - 0.5;
      // 중심에서 먼 정도. 가로세로 비를 보정하지 않는다 — 보정하면 와이드
      // 화면에서 비네트가 원형이 되어 좌우가 안 어두워진다. 뱀서라이크는
      // 화면 가운데(플레이어)로 시선을 모아야 하므로 화면 모양을 따라가는 게 맞다.
      float d = length(c) * 1.414;

      // 색수차는 가장자리에서만. 중앙에서 쓰면 UI와 숫자가 흐려 보인다.
      vec2 off = c * (uAberration * d * d) / uResolution;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      // 채도. 선형 휘도 가중치를 쓴다.
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(lum), col, uSaturation);

      // 비네트. smoothstep으로 경계가 보이지 않게 완만하게.
      col *= 1.0 - uVignette * smoothstep(0.35, 1.15, d);

      // 화면 틴트는 곱이 아니라 합이다. 곱하면 어두운 배경에서 아무 일도
      // 일어나지 않는데, 이 게임 아레나는 거의 검다.
      col += uTint * uTintAmount;

      gl_FragColor = vec4(col, 1.0);
    }
  `,
}

/**
 * 블룸 기본값. 전부 눈으로 맞췄다.
 *
 * 처음에 strength 0.62 / radius 0.42 / threshold 0.9로 잡았더니 화면이 하얗게
 * 터졌다. 원인은 skillfx가 이미 발광 게인을 threshold 0.9를 넘도록 올려둔
 * 것(시안 ×2.1, 크림슨 ×3.4)이라 두 배로 먹었기 때문이다. 게인을 내리지 않고
 * 블룸 쪽을 낮춘 이유는, 게인은 "후처리가 꺼진 저사양 경로"에서도 이펙트가
 * 보이게 하는 값이라 그쪽을 건드리면 off 품질에서 이펙트가 사라진다.
 *
 * radius를 오히려 키운 것도 의도다 — 세기를 줄이면서 반경을 넓히면 총 밝기는
 * 같아도 하얀 코어 대신 부드러운 번짐이 된다. 발광체가 "탔다"가 아니라
 * "빛난다"로 읽히는 지점이 여기다.
 */
const BLOOM = {
  // 0.30에서 한 번 더 내렸다. 뱀서라이크는 한 화면에 발광 이펙트가 열 개
  // 넘게 동시에 살아 있는데, 헤일로는 서로 **합쳐진다**. 하나만 놓고 맞춘
  // 값이 실제 전투에서는 화면 전체를 물들이는 안개가 됐다.
  strength: 0.2,
  // 반경도 같은 이유로 줄였다. 넓을수록 겹침이 심해진다.
  radius: 0.4,
  /** 이 값을 넘는 선형 휘도만 번진다. 발광체만 걸리도록 높게 잡았다. */
  threshold: 1.0,
}

export class PostFx {
  private readonly gl: THREE.WebGLRenderer
  private readonly scene: THREE.Scene
  private readonly camera: THREE.Camera
  private composer: EffectComposer
  private readonly bloom: UnrealBloomPass
  private readonly grade: ShaderPass
  private quality: PostQuality = 'high'

  /** 화면 틴트의 남은 시간과 총 길이. 절대 시각을 안 쓰는 이유는 오버레이로
   *  렌더가 통째로 건너뛰어도 상태가 굳지 않게 하기 위해서다. */
  private tintLeft = 0
  private tintDur = 1
  private tintPeak = 0

  private bloomBoost = 1
  private width = 1
  private height = 1
  private pixelRatio = 1

  constructor(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.gl = gl
    this.scene = scene
    this.camera = camera

    this.composer = new EffectComposer(gl)
    this.composer.addPass(new RenderPass(scene, camera))

    // 해상도는 setSize에서 다시 잡는다. 여기 값은 자리를 만들기만 한다.
    this.bloom = new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      BLOOM.strength,
      BLOOM.radius,
      BLOOM.threshold,
    )
    this.composer.addPass(this.bloom)

    this.grade = new ShaderPass(GRADE_SHADER)
    this.composer.addPass(this.grade)

    // 반드시 마지막. 렌더러의 ACESFilmic + sRGB가 여기서 적용된다.
    this.composer.addPass(new OutputPass())
  }

  /**
   * @param w CSS 픽셀 폭. **0이 들어올 수 있다** — 부팅 순간 캔버스가 0×0인
   *   프레임이 실제로 있었고, 그때 렌더 타겟을 0으로 만들면 이후 프레임이
   *   전부 검게 나온다. 여기서 막는다.
   */
  setSize(w: number, h: number, pixelRatio: number): void {
    this.width = Math.max(1, Math.floor(w))
    this.height = Math.max(1, Math.floor(h))
    this.pixelRatio = Math.max(0.5, pixelRatio)

    this.composer.setPixelRatio(this.pixelRatio)
    this.composer.setSize(this.width, this.height)
    // 블룸은 자체 밉 체인을 CSS 픽셀이 아니라 실제 버퍼 크기로 잡아야
    // 고DPI에서 번짐 반경이 절반으로 줄지 않는다.
    this.bloom.setSize(this.width * this.pixelRatio, this.height * this.pixelRatio)
    this.grade.uniforms.uResolution.value.set(
      this.width * this.pixelRatio,
      this.height * this.pixelRatio,
    )
  }

  /**
   * 품질 단계.
   *
   * 'off'는 composer를 아예 건너뛰고 `gl.render`를 직접 부른다. 저사양 기기와
   * 후처리 자체가 실패하는 환경(컨텍스트 손실 후 복구 등)의 탈출구다.
   */
  setQuality(q: PostQuality): void {
    this.quality = q
    if (q === 'off') return
    // 'low'는 해상도를 반으로 떨어뜨리는 대신 블룸만 약하게 한다. 블룸의
    // 비용은 밉 체인 크기에 비례하므로 픽셀 비율을 낮추는 게 가장 크게 먹는다.
    this.composer.setPixelRatio(q === 'low' ? Math.min(1, this.pixelRatio) : this.pixelRatio)
    this.bloom.strength = (q === 'low' ? BLOOM.strength * 0.75 : BLOOM.strength) * this.bloomBoost
    this.grade.uniforms.uAberration.value = q === 'low' ? 0 : 1.6
  }

  /**
   * 화면 전체를 짧게 물들인다. 피격(붉게)·처치·궁극기 발동에 쓴다.
   *
   * 후처리에서 하는 게 가장 싸다 — 이미 화면 전체를 도는 패스에 uniform 하나를
   * 더하는 것이라 추가 비용이 0에 가깝다. 풀스크린 쿼드를 따로 그리면
   * 드로우콜과 오버드로가 늘어난다.
   */
  flash(color: number, strength: number, durationSec: number): void {
    // 진행 중인 틴트보다 약하면 무시한다. 연타로 화면이 계속 물들면
    // 피격 경고가 배경이 되어 오히려 정보를 잃는다.
    const now = this.tintLeft > 0 ? (this.tintLeft / this.tintDur) * this.tintPeak : 0
    if (strength <= now) return
    this.grade.uniforms.uTint.value.setHex(color)
    this.tintPeak = strength
    this.tintDur = Math.max(0.016, durationSec)
    this.tintLeft = this.tintDur
  }

  /** 궁극기 순간처럼 화면 전체가 밝아져야 할 때 블룸을 잠깐 키운다. */
  setBloomBoost(k: number): void {
    this.bloomBoost = Math.max(0.2, Math.min(3, k))
    this.bloom.strength =
      (this.quality === 'low' ? BLOOM.strength * 0.75 : BLOOM.strength) * this.bloomBoost
  }

  render(dt: number): void {
    if (this.tintLeft > 0) {
      this.tintLeft = Math.max(0, this.tintLeft - dt)
      // 제곱으로 죽인다. 선형이면 끝자락이 오래 남아 화면이 물든 채로 보인다.
      const k = this.tintLeft / this.tintDur
      this.grade.uniforms.uTintAmount.value = k * k * this.tintPeak
    } else if (this.grade.uniforms.uTintAmount.value !== 0) {
      this.grade.uniforms.uTintAmount.value = 0
    }

    if (this.quality === 'off') {
      this.gl.render(this.scene, this.camera)
      return
    }
    this.composer.render(dt)
  }

  dispose(): void {
    this.composer.dispose()
  }
}

/* ---------------------------------------------------------------------------
 * 통합 방법 (renderer.ts)
 *
 * 1) 생성자 끝, 카메라와 씬이 모두 만들어진 뒤:
 *      this.post = new PostFx(this.gl, this.scene, this.camera)
 *
 * 2) 크기를 잡는 곳(ResizeObserver 콜백 / setSize)에서 gl.setSize 바로 뒤:
 *      this.post.setSize(w, h, this.gl.getPixelRatio())
 *    gl.setSize보다 **뒤**여야 한다. 앞이면 첫 프레임이 이전 크기로 나간다.
 *
 * 3) `this.gl.render(this.scene, this.camera)` 한 줄을 통째로 교체:
 *      this.post.render(dt)
 *
 * 4) updateRenderQuality()에서:
 *      this.post.setQuality(constrained ? 'low' : 'high')
 *
 * 5) 이벤트 배선(선택):
 *      플레이어 피격  → this.post.flash(0xff3040, 0.30, 0.22)
 *      궁극기 발동    → this.post.flash(classHex, 0.22, 0.35)
 *      보스 처치      → this.post.flash(0xffffff, 0.55, 0.6)
 *
 * 6) dispose(): this.post.dispose()
 * ------------------------------------------------------------------------- */
