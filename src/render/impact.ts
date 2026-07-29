import * as THREE from 'three'

import { MAX_ENEMIES } from '../sim/enemies.ts'

/**
 * 타격감 — 히트스톱 · 화면 흔들림 · 데미지 숫자 · 피격 플래시.
 *
 * 뱀서라이크에서 "때리는 맛"은 피해량 숫자가 아니라 **때린 순간 세계가
 * 반응한다는 신호**에서 온다. 그 신호를 만드는 네 장치를 한 모듈에 모았다.
 * 넷 다 같은 순간에 같은 세기로 터져야 하나의 타격으로 읽히기 때문에,
 * 세기 계산과 상한을 한 곳에서 잡는 것이 흩어놓는 것보다 훨씬 안전하다.
 *
 * 이 모듈은 **아무것도 직접 조작하지 않는다.**
 * - 시뮬 시간을 멈추지 않는다. 배율(`timeScale`)만 내놓고 호출부가 쓴다.
 *   시뮬은 고정 60Hz 결정론이라 내부에서 느려질 방법이 없고, 있어서도 안 된다.
 * - 카메라를 옮기지 않는다. 오프셋(`offset`/`roll`)만 내놓고 렌더러가 더한다.
 * - 적 색을 칠하지 않는다. "누가 언제까지 번쩍이는가"만 들고 있고
 *   적 렌더러가 읽어 간다.
 *
 * 시간 기준: 전부 **벽시계**다. 히트스톱으로 늦춰진 시간을 여기에 다시
 * 먹이면 화면이 멈춘 동안 흔들림과 숫자까지 같이 멈춰서, 타격감이 아니라
 * 프레임 드랍으로 읽힌다. 그건 정확히 반대 효과다.
 */

// ---------------------------------------------------------------------------
// 히트스톱
// ---------------------------------------------------------------------------

/**
 * 한 번의 히트스톱이 가질 수 있는 최대 길이(초).
 *
 * 0.12초 = 60Hz에서 7틱. 이보다 길면 "묵직하다"가 아니라 "끊긴다"로 넘어간다.
 * 격투 게임의 히트스톱이 대체로 3~8프레임인 것과 같은 이유다.
 */
const HITSTOP_MAX_DURATION = 0.12

/**
 * 최대 강도에서 남기는 시간 배율.
 *
 * 완전한 0으로 얼리지 않는 이유는 입력 때문이다. 시뮬 틱이 아예 안 돌면
 * 그동안의 조작이 통째로 버려져서, 히트스톱이 강할수록 조작이 씹힌다.
 * 0.06이면 화면은 멈춘 것처럼 보이면서 입력은 흘러간다.
 */
const HITSTOP_FLOOR = 0.06

/**
 * 히트스톱 예산(초)과 초당 회복량.
 *
 * "겹치면 강한 쪽이 이긴다"만으로는 연타를 못 막는다. 평타 간격 0.28초에
 * 관통 5까지 있으면 초당 수십 번 요청이 들어오고, 매번 조금씩 이기면서
 * 슬로모션에 갇힌다. 그래서 총량에 하드 리밋을 건다 — 장기적으로 벽시계의
 * 22%까지만 히트스톱에 쓸 수 있고, 순간 몰림은 0.14초까지 허용한다.
 */
const HITSTOP_BUDGET = 0.14
const HITSTOP_BUDGET_REFILL = 0.22

// ---------------------------------------------------------------------------
// 화면 흔들림
// ---------------------------------------------------------------------------

/**
 * 트라우마 상한.
 *
 * 흔들림 세기는 trauma²이라 1.0을 허용하면 최대치에서 화면을 못 본다.
 * 0.9로 자르면 세기 상한이 0.81이 되어 "크게 흔들렸다"와 "조작 불가"
 * 사이에 머문다.
 */
const TRAUMA_MAX = 0.9

/**
 * 세기 1일 때의 화면 이동량(월드 유닛).
 *
 * 카메라 거리 ≈ 17.7, FOV 40, 1080p 기준 1월드유닛 ≈ 82px이다.
 * 0.42 × (트라우마 상한 0.81) ≈ 0.34유닛 ≈ 28px. 캐릭터 키가 약 140px이니
 * 최대 흔들림이 캐릭터의 1/5쯤 움직이는 셈 — 화면이 얻어맞은 것처럼 보이되
 * 조준은 계속 가능한 크기다.
 */
const SHAKE_AMPLITUDE = 0.42

/**
 * 최대 롤 각도(라디안). 1.26°.
 *
 * 롤은 아주 조금만 넣어야 한다. 쿼터뷰는 바닥 격자가 화면을 지배해서
 * 회전이 즉시 눈에 띄고, 2°만 넘어가도 멀미가 온다.
 */
const SHAKE_ROLL_MAX = 0.022

/** 기본 진동수(Hz). 60fps에서 한 주기가 약 3프레임 — 흐려지지 않고 덜컹거린다. */
const SHAKE_DEFAULT_FREQUENCY = 21

/**
 * 트라우마 최소 감쇠율(1/초).
 *
 * 요청이 아무리 긴 여운을 달라고 해도 이 아래로는 못 내려간다.
 * 상한 트라우마 0.9가 1.06초 안에는 반드시 사라진다는 보장이다.
 */
const SHAKE_MIN_DECAY = 0.85

/**
 * 화면 위쪽 방향의 월드 벡터.
 *
 * 카메라는 절대 회전하지 않는다(renderer.ts의 CAM_OFFSET = (0,14,10.8)에
 * 거리 배율만 곱한다). 그래서 카메라 축이 상수이고, 미리 계산해 둘 수 있다.
 * 정면 = -normalize(0,14,10.8), 오른쪽 = +X, 위 = 오른쪽 × 정면.
 * 흔들림을 이 두 축 위에서 만들어야 "화면이 흔들린다"로 읽힌다.
 * 월드 XZ로 흔들면 쿼터뷰에서는 위아래 성분이 거의 안 보인다.
 */
const SCREEN_UP_Y = 0.6108
const SCREEN_UP_Z = -0.7918

// ---------------------------------------------------------------------------
// 데미지 숫자
// ---------------------------------------------------------------------------

export type DamageStyle = 'normal' | 'crit' | 'capped' | 'heal' | 'xp'

/**
 * 아틀라스 글리프. 숫자 10개 + 부호 2개.
 * '+'는 회복·XP 접두, '!'는 치명타 접미로 쓴다.
 */
const GLYPHS = '0123456789+!'
const GLYPH_PLUS = 10
const GLYPH_BANG = 11
const ATLAS_COLS = 4
const ATLAS_ROWS = 3
/** 셀 한 변(px). 128이면 최대 확대(치명타)에서도 뭉개지지 않는다. */
const ATLAS_CELL = 128
/**
 * 글자 크기·외곽선·그림자(px).
 *
 * 셀 안에 다 들어가야 한다. 84px 볼드 숫자의 잉크 상자는 약 47×61,
 * 외곽선 10(바깥 5)을 더하면 57×71, 그림자 번짐 10을 더하면 77×91이다.
 * 128 셀에 여유가 남아 밉맵을 켜도 옆 셀이 새어 들어오지 않는다.
 */
const GLYPH_FONT_PX = 84
const GLYPH_OUTLINE_PX = 10
const GLYPH_SHADOW_PX = 10

/** 동시에 떠 있을 수 있는 숫자 개수와, 숫자 하나의 최대 글리프 수. */
const MAX_NUMBERS = 32
const NUMBER_MAX_DIGITS = 6
const MAX_GLYPHS_PER_NUMBER = NUMBER_MAX_DIGITS + 1
const MAX_GLYPHS = MAX_NUMBERS * MAX_GLYPHS_PER_NUMBER
const NUMBER_MAX_VALUE = 999999
/** Skill FX occupy renderOrder 2..23; combat text stays in a dedicated overlay band. */
const DAMAGE_NUMBER_RENDER_ORDER = 100

/**
 * 기본 쿼드 한 변(월드 유닛).
 *
 * 84px 폰트의 대문자 높이는 셀의 약 0.46이다. 0.86 × 0.46 ≈ 0.40유닛,
 * 1080p에서 약 33px. 이 카메라에서 캐릭터가 140px인데 숫자가 33px이면
 * 읽히면서도 화면을 잡아먹지 않는다.
 */
const NUMBER_QUAD = 0.86

/**
 * 글자 간격(쿼드 크기 배수).
 *
 * 84px 볼드 숫자의 진행폭은 셀의 약 0.36이다. 0.40으로 두면 잉크 사이에
 * 아주 얇은 틈만 남아 여러 자리가 하나의 덩어리로 읽힌다.
 */
const GLYPH_ADVANCE = 0.4

/**
 * 숫자가 나타나는 높이(월드 유닛).
 *
 * 호출부는 월드 XZ만 준다(적 높이를 알 필요가 없어야 한다). 잡몹 중심이
 * 0.33~0.62, 보스가 1.36이므로 1.2로 잡으면 잡몹 위로 뜨고 보스는
 * 몸통에서 솟아오른다. 어느 쪽이든 발밑에 깔리지 않는다.
 */
const NUMBER_SPAWN_Y = 1.2

interface NumberStyleDef {
  color: number
  /** 기본 쿼드 크기 배수. */
  scale: number
  /** 수명(초). */
  life: number
  /** 총 상승 높이(월드 유닛). */
  rise: number
  /** 등장 순간의 크기 오버슈트. */
  punch: number
  /** 좌우로 흩어지는 총 거리(월드 유닛). */
  drift: number
  alpha: number
}

/**
 * 스타일 표.
 *
 * 색은 클래스 정체색(시안 #4DD0FF / 크림슨 #FF5A6E)을 피한다. 숫자가
 * 클래스 색을 쓰면 스킬 이펙트와 섞여서 "내가 준 피해"라는 신호가 흐려진다.
 * - normal: 따뜻한 흰색. 가장 자주 뜨므로 가장 조용해야 한다.
 * - crit:   금색 + 1.55배. 크기와 색이 동시에 바뀌어야 멀리서 구분된다.
 * - capped: 보라색 + 느낌표. 보스 일격 상한이 작동했음을 별도 규칙으로 읽힌다.
 * - heal:   RING_COLORS[1]과 같은 초록. 회복 링과 같은 색이어야 한 사건으로 읽힌다.
 * - xp:     옅은 하늘색 + 0.78배 + 낮은 알파. 정보량이 가장 적으니 가장 약하게.
 */
const NUMBER_STYLES: Readonly<Record<DamageStyle, NumberStyleDef>> = {
  normal: { color: 0xfff0dc, scale: 1, life: 0.72, rise: 1.25, punch: 0.2, drift: 0.32, alpha: 0.95 },
  crit: { color: 0xffc24d, scale: 1.55, life: 0.95, rise: 1.7, punch: 0.6, drift: 0.5, alpha: 1 },
  capped: { color: 0xc98cff, scale: 1.25, life: 0.9, rise: 1.55, punch: 0.4, drift: 0.4, alpha: 1 },
  heal: { color: 0x7df0a0, scale: 1.1, life: 0.9, rise: 1.5, punch: 0.25, drift: 0.22, alpha: 1 },
  xp: { color: 0x9fe8ff, scale: 0.78, life: 0.55, rise: 1, punch: 0.12, drift: 0.4, alpha: 0.75 },
}

/** 떠 있는 숫자 하나. 풀에서 재사용하므로 필드는 전부 미리 잡아 둔다. */
interface NumberPop {
  active: boolean
  x: number
  z: number
  /** 아틀라스 셀 인덱스 나열. 문자열을 만들지 않으려고 바이트로 들고 있다. */
  glyphs: Uint8Array
  count: number
  style: NumberStyleDef
  /** 실제 피해 강도에서 온 제한된 크기 배수. 같은 스타일 안의 무게 차이다. */
  emphasis: number
  /** 진행도 0..1. */
  t: number
  /** 좌우 이동량(부호 포함). */
  drift: number
}

// ---------------------------------------------------------------------------
// 적 피격 플래시
// ---------------------------------------------------------------------------

/** 플래시 길이 클램프(초). 0.05 미만은 프레임에 안 잡히고, 0.2 초과는 잔상으로 남는다. */
const FLASH_MIN_DURATION = 0.05
const FLASH_MAX_DURATION = 0.2

const TAU = Math.PI * 2

/**
 * 숫자 아틀라스를 굽는다.
 *
 * 흰 글자 + 검은 외곽선 + 검은 그림자로 굽는 것이 핵심이다. 셰이더에서
 * rgb에 색을 곱하면 흰 획만 물들고 외곽선은 검은색 그대로 남는다. 그래서
 * 색을 어떻게 주든 밝은 가산 이펙트 위에서도 글자가 읽힌다 —
 * 스타일별로 아틀라스를 따로 굽지 않고 색만 바꿔도 되는 이유다.
 */
function bakeGlyphAtlas(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS_COLS * ATLAS_CELL
  canvas.height = ATLAS_ROWS * ATLAS_CELL

  const ctx = canvas.getContext('2d')
  // 컨텍스트를 못 얻는 환경(메모리 압박·컨텍스트 한도)에서도 게임은 돌아야 한다.
  // 숫자만 빈 텍스처로 남고 나머지 타격감은 그대로 동작한다.
  if (ctx !== null) {
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = `900 ${GLYPH_FONT_PX}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
    ctx.lineJoin = 'round'
    ctx.miterLimit = 2

    for (let g = 0; g < GLYPHS.length; g++) {
      const ch = GLYPHS[g]!
      const cx = (g % ATLAS_COLS) * ATLAS_CELL + ATLAS_CELL * 0.5
      // CanvasTexture는 flipY가 기본 true라 UV의 row 0이 캔버스 아래쪽이다.
      // 굽는 줄을 뒤집어 두면 셰이더에서 보정할 일이 없다.
      const row = Math.floor(g / ATLAS_COLS)
      const cy = (ATLAS_ROWS - 1 - row) * ATLAS_CELL + ATLAS_CELL * 0.5

      ctx.shadowColor = 'rgba(0,0,0,0.9)'
      ctx.shadowBlur = GLYPH_SHADOW_PX
      ctx.strokeStyle = '#000'
      ctx.lineWidth = GLYPH_OUTLINE_PX
      // 두 번 긋는다. 한 번이면 안티에일리어싱된 외곽이 반투명으로 남아
      // 밝은 배경 위에서 검은 테두리가 회색으로 흐려진다.
      ctx.strokeText(ch, cx, cy)
      ctx.strokeText(ch, cx, cy)

      ctx.shadowBlur = 0
      ctx.fillStyle = '#fff'
      ctx.fillText(ch, cx, cy)
    }
  }

  const tex = new THREE.CanvasTexture(canvas)
  // sRGB로 표시해야 GPU가 샘플링 단계에서 선형으로 풀어 준다. 이걸 빼면
  // 글자가 배경 대비 과하게 밝아지고 톤매핑 뒤에 하얗게 뜬다.
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  // 숫자는 바닥에 거의 눕지 않지만 화면 가장자리에서 기울어 보인다.
  // 4면 충분하고, three가 기기 상한으로 잘라 준다.
  tex.anisotropy = 4
  return tex
}

const NUMBER_VERTEX_SHADER = /* glsl */ `
attribute float aGlyph;
attribute vec4 aTint;

uniform vec2 uGrid;

varying vec2 vUv;
varying vec4 vTint;

void main() {
  // instanceMatrix에는 위치와 스케일만 담는다. 빌보드 회전은 여기서 만든다 —
  // 뷰 공간에서 중심을 잡고 xy로만 벌리면 카메라가 어디에 있든 정면을 본다.
  // CPU에서 카메라 쿼터니언을 매 인스턴스에 곱하는 것보다 훨씬 싸다.
  vec4 viewCenter = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  viewCenter.xy += position.xy * vec2(instanceMatrix[0].x, instanceMatrix[1].y);
  gl_Position = projectionMatrix * viewCenter;

  float col = mod(aGlyph, uGrid.x);
  float row = floor(aGlyph / uGrid.x);
  vUv = (uv + vec2(col, row)) / uGrid;
  vTint = aTint;
}
`

const NUMBER_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uAtlas;

varying vec2 vUv;
varying vec4 vTint;

void main() {
  vec4 texel = texture2D(uAtlas, vUv);
  float a = texel.a * vTint.a;
  // 글리프 바깥은 셀의 절반이 넘는다. 여기서 버리면 그만큼 블렌딩을 아낀다.
  if (a < 0.004) discard;
  gl_FragColor = vec4(texel.rgb * vTint.rgb, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

/**
 * 타격 피드백 묶음.
 *
 * 드로우콜은 데미지 숫자 1개만 늘어난다(글리프 전부가 한 InstancedMesh다).
 * 히트스톱·흔들림·플래시는 그리는 것이 없어 0이다.
 */
export class ImpactFx {
  // --- 히트스톱 ---
  private hitstopRemain = 0
  private hitstopStrength = 0
  private hitstopSpent = 0
  private timeScaleValue = 1

  // --- 흔들림 ---
  private trauma = 0
  /** 0이면 "설정 안 됨". 첫 요청이 값을 정하고, 트라우마가 마르면 다시 0으로 돌아간다. */
  private traumaDecay = 0
  private frequency = SHAKE_DEFAULT_FREQUENCY
  /**
   * 진동 위상. 시간 × 진동수로 매번 계산하지 않고 누적한다 —
   * 요청이 진동수를 바꾸는 순간 sin의 인자가 점프해서 딱 끊기기 때문이다.
   */
  private shakePhase = 0
  private shakeScale = 1
  private qualityShakeScale = 1
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly onMotionPreference = (): void => {
    this.applyShakeScale()
    if (this.reducedMotion.matches) {
      this.hitstopRemain = 0
      this.hitstopStrength = 0
      this.timeScaleValue = 1
    }
  }
  private readonly offsetVec = new THREE.Vector3()
  private rollValue = 0

  // --- 데미지 숫자 ---
  private readonly scene: THREE.Scene
  private readonly mesh: THREE.InstancedMesh
  private readonly atlas: THREE.CanvasTexture
  private readonly glyphAttr: THREE.InstancedBufferAttribute
  private readonly tintAttr: THREE.InstancedBufferAttribute
  private readonly glyphData: Float32Array
  private readonly tintData: Float32Array
  private readonly numbers: NumberPop[] = []
  /**
   * 다음 숫자가 흩어질 방향. 황금각(137.5°)씩 돌린다.
   *
   * 난수로 뿌리면 연속 두 개가 같은 쪽으로 겹치는 일이 자주 생긴다.
   * 황금각은 어떤 개수로 잘라 봐도 가장 고르게 퍼지는 각도라, 같은 자리에
   * 연달아 뜨는 숫자들이 저절로 부채꼴로 갈라진다.
   */
  private driftAngle = 0

  // --- 피격 플래시 ---
  private readonly flashEnd = new Float64Array(MAX_ENEMIES)
  private readonly flashSpan = new Float64Array(MAX_ENEMIES)

  /** 마지막 update의 벽시계 시각(초). 플래시 만료 판정의 기준. */
  private now = performance.now() / 1000

  // 매 프레임 재사용하는 임시값. 프레임당 할당 0의 전제다.
  private readonly m = new THREE.Matrix4()
  private readonly qIdentity = new THREE.Quaternion()
  private readonly pos = new THREE.Vector3()
  private readonly scl = new THREE.Vector3()
  private readonly color = new THREE.Color()

  constructor(scene: THREE.Scene) {
    this.scene = scene

    for (let i = 0; i < MAX_NUMBERS; i++) {
      this.numbers.push({
        active: false,
        x: 0,
        z: 0,
        glyphs: new Uint8Array(MAX_GLYPHS_PER_NUMBER),
        count: 0,
        style: NUMBER_STYLES.normal,
        emphasis: 1,
        t: 0,
        drift: 0,
      })
    }

    this.atlas = bakeGlyphAtlas()

    // 단위 쿼드 하나를 모든 글리프가 공유한다. 인스턴스마다 다른 것은
    // 행렬(위치·크기)과 아래 두 속성뿐이다.
    const geometry = new THREE.PlaneGeometry(1, 1)
    this.glyphData = new Float32Array(MAX_GLYPHS)
    this.tintData = new Float32Array(MAX_GLYPHS * 4)
    this.glyphAttr = new THREE.InstancedBufferAttribute(this.glyphData, 1)
    this.tintAttr = new THREE.InstancedBufferAttribute(this.tintData, 4)
    this.glyphAttr.setUsage(THREE.DynamicDrawUsage)
    this.tintAttr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute('aGlyph', this.glyphAttr)
    geometry.setAttribute('aTint', this.tintAttr)

    const material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: this.atlas },
        uGrid: { value: new THREE.Vector2(ATLAS_COLS, ATLAS_ROWS) },
      },
      vertexShader: NUMBER_VERTEX_SHADER,
      fragmentShader: NUMBER_FRAGMENT_SHADER,
      transparent: true,
      // 숫자는 적에게 가려지면 정보로서 실패한다. 깊이 판정을 끄고
      // renderOrder로 맨 위에 올린다. 검은 외곽선이 있어서 무엇 위에 겹쳐도 읽힌다.
      depthTest: false,
      depthWrite: false,
    })

    this.mesh = new THREE.InstancedMesh(geometry, material, MAX_GLYPHS)
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.count = 0
    // 인스턴스가 매 프레임 흩어지므로 메시 단위 바운딩은 의미가 없다.
    this.mesh.frustumCulled = false
    // 스킬 FX(최대 renderOrder 23)까지 모두 그린 뒤 전투 정보를 마지막에 합성한다.
    this.mesh.renderOrder = DAMAGE_NUMBER_RENDER_ORDER
    scene.add(this.mesh)

    // 렌더 품질 갱신이 뒤에서 setShakeScale(1)을 호출해도 접근성 배율은
    // 별도로 곱한다. 한 변수에 섞으면 리사이즈 한 번에 설정이 풀린다.
    this.reducedMotion.addEventListener('change', this.onMotionPreference)
    this.applyShakeScale()
  }

  // -------------------------------------------------------------------------
  // 히트스톱
  // -------------------------------------------------------------------------

  /**
   * 히트스톱을 요청한다.
   *
   * @param strength    0..1. 1이면 거의 정지.
   * @param durationSec 0..0.12로 잘린다.
   *
   * 누적 규칙은 두 겹이다.
   * 1) 진행 중인 히트스톱보다 약한 요청은 통째로 무시한다. 약한 잔타가
   *    큰 타격의 정지를 계속 연장하면 슬로모션에 갇힌다.
   * 2) 그래도 같은 세기 연타는 막지 못하므로 예산으로 총량을 자른다.
   */
  requestHitstop(strength: number, durationSec: number): void {
    const motionScale = this.reducedMotion.matches ? 0.25 : 1
    const s = THREE.MathUtils.clamp(strength * motionScale, 0, 1)
    const d = Math.min(Math.max(durationSec * motionScale, 0), HITSTOP_MAX_DURATION)
    if (s <= 0 || d <= 0) return
    if (this.hitstopRemain > 0 && s < this.hitstopStrength) return

    // 예산은 요청 길이가 아니라 **실제로 늘어난 정지 시간**만 쓴다.
    // 같은 프레임의 관통 5타가 각각 0.04초를 요청해도 화면에 생기는 정지는
    // 0.04초 하나뿐이다. 예전에는 0.20초를 쓴 것으로 계산해 다음 타격이
    // 통째로 사라졌다. 남은 정지보다 긴 부분만 청구하고 예산도 넘지 않는다.
    const extension = Math.max(0, d - this.hitstopRemain)
    const admitted = Math.min(
      extension,
      Math.max(0, HITSTOP_BUDGET - this.hitstopSpent),
    )
    if (extension > 0 && admitted <= 0) return

    this.hitstopSpent += admitted
    this.hitstopRemain += admitted
    this.hitstopStrength = s
    // 요청 프레임의 다음 시뮬레이션 스텝부터 바로 감속한다. update()에서만
    // 값을 계산하면 피격 프레임 뒤에 한 프레임이 더 지나 타격 정지가 늦게 느껴진다.
    this.timeScaleValue = Math.min(
      this.timeScaleValue,
      1 - s * (1 - HITSTOP_FLOOR),
    )
  }

  /**
   * 시뮬에 넘길 dt에 곱할 배율. 1이면 평소 속도.
   *
   * update()에서 갱신되므로 한 프레임 늦게 반영된다. 타격은 시뮬 틱 안에서
   * 일어나고 정지는 그 다음 프레임부터 걸리는 셈인데, 8~16ms라 눈에 안 잡히고
   * 오히려 "맞는 순간 → 멈춤" 순서가 자연스럽다.
   */
  get timeScale(): number {
    return this.timeScaleValue
  }

  // -------------------------------------------------------------------------
  // 화면 흔들림
  // -------------------------------------------------------------------------

  /**
   * 화면 흔들림을 요청한다.
   *
   * @param strength    0..1. 트라우마에 더해진다.
   * @param durationSec 이 요청이 자기 몫을 태우는 데 걸릴 시간.
   * @param frequency   진동수(Hz). 낮으면 묵직하고 높으면 날카롭다.
   *
   * 트라우마 모델을 쓴다. 세기 = trauma²이라 약한 타격 여러 번은 거의
   * 안 흔들리고, 트라우마가 0.7을 넘는 순간부터 급격히 커진다. 선형으로 하면
   * 평타마다 화면이 계속 미세하게 떨려서 전체가 지저분해진다.
   */
  shake(strength: number, durationSec: number, frequency = SHAKE_DEFAULT_FREQUENCY): void {
    const s = THREE.MathUtils.clamp(strength, 0, 1)
    if (s <= 0) return

    const d = THREE.MathUtils.clamp(durationSec, 0.06, 1.2)
    this.trauma = Math.min(TRAUMA_MAX, this.trauma + s)

    // 감쇠율은 "이 요청이 자기 몫을 d 안에 태우는" 속도. 더 긴 여운을 원하는
    // 쪽을 따른다 — 폭발 직후의 잔타가 폭발의 여운을 잘라내면 안 된다.
    const decay = Math.max(s / d, SHAKE_MIN_DECAY)
    this.traumaDecay = this.traumaDecay > 0 ? Math.min(this.traumaDecay, decay) : decay
    // 진동수는 마지막 요청이 정한다. 가장 최근의 타격이 흔들림의 성격을 갖는다.
    this.frequency = THREE.MathUtils.clamp(frequency, 4, 40)
  }

  /**
   * 카메라 위치에 더할 오프셋(월드 좌표).
   *
   * 내부 필드를 그대로 돌려준다 — 매 프레임 Vector3를 새로 만들지 않기 위해서다.
   * 호출부는 읽기만 해야 한다.
   */
  get offset(): THREE.Vector3 {
    return this.offsetVec
  }

  /** 카메라 로컬 Z축(시선축) 회전량(라디안). */
  get roll(): number {
    return this.rollValue
  }

  /**
   * 흔들림 세기 배수(0..1). 모바일 품질 강등과 접근성 설정의 손잡이다.
   * 히트스톱과 숫자는 건드리지 않는다 — 멀미의 원인은 흔들림이다.
   */
  setShakeScale(scale: number): void {
    this.qualityShakeScale = THREE.MathUtils.clamp(scale, 0, 1)
    this.applyShakeScale()
  }

  private applyShakeScale(): void {
    this.shakeScale = this.qualityShakeScale * (this.reducedMotion.matches ? 0.08 : 1)
  }

  // -------------------------------------------------------------------------
  // 데미지 숫자
  // -------------------------------------------------------------------------

  /**
   * 월드 좌표 위에 숫자를 띄운다. 스크린 투영은 하지 않는다 —
   * 3D 빌보드라 카메라가 움직여도 숫자가 대상에 붙어 있다.
   *
   * 0 이하와 NaN은 그리지 않는다. "0 피해"는 정보가 아니라 소음이다.
   */
  popNumber(
    worldX: number,
    worldZ: number,
    value: number,
    style: DamageStyle,
    emphasis = 1,
  ): void {
    const rounded = Math.round(value)
    if (!(rounded > 0)) return

    const def = NUMBER_STYLES[style]
    const capped = Math.min(rounded, NUMBER_MAX_VALUE)
    const pop = this.acquireNumber()

    let n = 0
    if (style === 'heal' || style === 'xp') pop.glyphs[n++] = GLYPH_PLUS

    // 자릿수를 먼저 세고 뒤에서부터 채운다. 문자열을 거치지 않아 할당이 0이다.
    let digits = 1
    let scale10 = 10
    while (capped >= scale10 && digits < NUMBER_MAX_DIGITS) {
      digits++
      scale10 *= 10
    }
    let rest = capped
    for (let d = digits - 1; d >= 0; d--) {
      pop.glyphs[n + d] = rest % 10
      rest = Math.floor(rest / 10)
    }
    n += digits

    if (style === 'crit' || style === 'capped') {
      pop.glyphs[n++] = GLYPH_BANG
    }

    this.driftAngle += 2.399963 // 황금각(rad)
    pop.active = true
    pop.x = worldX
    pop.z = worldZ
    pop.count = n
    pop.style = def
    // 큰 피해가 숫자 내용만 달라지고 실루엣은 같았던 평준화를 푼다.
    // 상한은 군중전에서 숫자가 적 모델을 가리지 않는 1.28배다.
    pop.emphasis = THREE.MathUtils.clamp(emphasis, 0.88, 1.28)
    pop.t = 0
    pop.drift = Math.cos(this.driftAngle) * def.drift
  }

  /**
   * 빈 슬롯을 준다. 없으면 가장 오래된 것을 재사용한다.
   *
   * 한 프레임에 시뮬 8틱이 몰릴 수 있어서(MAX_TICKS_PER_FRAME) 상한 초과는
   * 실제로 일어난다. 그때 새 숫자를 버리면 방금 준 피해가 안 보이는,
   * 정확히 반대의 결과가 나온다. 사라질 때가 된 쪽을 밀어낸다.
   */
  private acquireNumber(): NumberPop {
    let oldest = this.numbers[0]!
    for (let i = 0; i < this.numbers.length; i++) {
      const p = this.numbers[i]!
      if (!p.active) return p
      if (p.t > oldest.t) oldest = p
    }
    return oldest
  }

  // -------------------------------------------------------------------------
  // 적 피격 플래시
  // -------------------------------------------------------------------------

  /**
   * 적 슬롯 index를 durationSec 동안 플래시 상태로 표시한다.
   *
   * 적 풀은 swap-remove라 슬롯 인덱스가 사망마다 바뀐다. 그래서 이 컨테이너는
   * "지금 프레임의 인덱스"로만 유효하다. 수명을 0.2초로 자르는 것이 그 대비다 —
   * 잘못 옮겨붙어도 한두 프레임 안에 사라진다.
   */
  flashEnemy(index: number, durationSec: number): void {
    if (index < 0 || index >= MAX_ENEMIES) return
    const d = THREE.MathUtils.clamp(durationSec, FLASH_MIN_DURATION, FLASH_MAX_DURATION)
    const end = this.now + d
    // 더 오래 남은 플래시가 있으면 덮지 않는다. 연타로 오히려 짧아지면 안 된다.
    if (end <= this.flashEnd[index]!) return
    this.flashEnd[index] = end
    this.flashSpan[index] = d
  }

  /**
   * 적 슬롯 index의 플래시 세기(0..1). 흰색 lerp 계수로 바로 쓸 수 있다.
   * 순회 없이 조회만 하므로 적이 600마리여도 비용이 없다.
   */
  flashAmount(index: number, now: number): number {
    if (index < 0 || index >= MAX_ENEMIES) return 0
    const remain = this.flashEnd[index]! - now
    if (remain <= 0) return 0
    const span = this.flashSpan[index]!
    if (span <= 0) return 0
    return remain < span ? remain / span : 1
  }

  // -------------------------------------------------------------------------
  // 프레임 갱신
  // -------------------------------------------------------------------------

  /**
   * @param now 벽시계 초. flashAmount에 넘기는 값과 같은 시계여야 한다.
   * @param dt  벽시계 경과 초. **히트스톱으로 스케일하지 않은 값**을 넘긴다.
   *            여기서 다시 느려지면 흔들림과 숫자가 같이 멈춰서
   *            타격감이 아니라 프레임 드랍으로 보인다.
   */
  update(now: number, dt: number): void {
    this.now = now
    this.updateHitstop(dt)
    this.updateShake(dt)
    this.updateNumbers(dt)
  }

  /**
   * 현재 프레임에 막 추가된 흔들림·숫자를 시간 경과 없이 즉시 샘플링한다.
   * update() 뒤 이벤트를 소비하는 렌더 순서에서 이전 프레임의 dt가 새 히트스톱
   * 수명을 깎지 않으면서도, 접촉 프레임의 시각 피드백은 늦지 않게 한다.
   */
  refreshPresentation(): void {
    this.updateShake(0)
    this.updateNumbers(0)
  }

  /** 새 런이 직전 판의 정지·흔들림·숫자·플래시를 물려받지 않게 한다. */
  reset(): void {
    this.hitstopRemain = 0
    this.hitstopStrength = 0
    this.hitstopSpent = 0
    this.timeScaleValue = 1
    this.trauma = 0
    this.traumaDecay = 0
    this.frequency = SHAKE_DEFAULT_FREQUENCY
    this.shakePhase = 0
    this.offsetVec.set(0, 0, 0)
    this.rollValue = 0
    this.driftAngle = 0
    for (const pop of this.numbers) pop.active = false
    this.mesh.count = 0
    this.flashEnd.fill(0)
    this.flashSpan.fill(0)
  }

  private updateHitstop(dt: number): void {
    this.hitstopSpent = Math.max(0, this.hitstopSpent - dt * HITSTOP_BUDGET_REFILL)

    if (this.hitstopRemain > 0) {
      this.hitstopRemain -= dt
      if (this.hitstopRemain <= 0) {
        this.hitstopRemain = 0
        this.hitstopStrength = 0
      }
    }

    this.timeScaleValue =
      this.hitstopRemain > 0 ? 1 - this.hitstopStrength * (1 - HITSTOP_FLOOR) : 1
  }

  private updateShake(dt: number): void {
    if (this.trauma <= 0) return

    this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt)
    if (this.trauma <= 0) {
      // 다 마르면 초기화한다. 다음 흔들림이 이전 요청의 감쇠율·위상을
      // 물려받으면 세기와 무관하게 성격이 달라진다.
      this.traumaDecay = 0
      this.shakePhase = 0
      this.offsetVec.set(0, 0, 0)
      this.rollValue = 0
      return
    }

    this.shakePhase += dt * this.frequency
    const p = this.shakePhase * TAU

    // 서로 나누어떨어지지 않는 두 주파수를 겹쳐 "돌아가는" 궤적을 만든다.
    // 프레임마다 난수를 뽑으면 60Hz 백색잡음이 되어 지저분하게 지글거린다.
    // 계수 합이 1이라 진폭이 정확히 1을 넘지 않는다.
    const nx = Math.sin(p) * 0.62 + Math.sin(p * 1.73 + 1.31) * 0.38
    const ny = Math.sin(p * 0.91 + 2.14) * 0.62 + Math.sin(p * 1.47 + 4.62) * 0.38
    const nr = Math.sin(p * 0.67 + 3.77)

    const amount = this.trauma * this.trauma * this.shakeScale
    const amp = amount * SHAKE_AMPLITUDE

    // 화면 오른쪽(월드 +X)과 화면 위쪽(SCREEN_UP) 두 축으로만 민다.
    this.offsetVec.set(nx * amp, ny * amp * SCREEN_UP_Y, ny * amp * SCREEN_UP_Z)
    this.rollValue = nr * amount * SHAKE_ROLL_MAX
  }

  private updateNumbers(dt: number): void {
    let n = 0

    for (let i = 0; i < this.numbers.length; i++) {
      const pop = this.numbers[i]!
      if (!pop.active) continue

      const def = pop.style
      pop.t += dt / def.life
      if (pop.t >= 1) {
        pop.active = false
        continue
      }

      const t = pop.t
      const inv = 1 - t
      // 위로 튀어 오르며 감속(ease-out cubic). 등속 상승은 UI 토스트처럼
      // 보이고 타격의 결과로 읽히지 않는다.
      const y = NUMBER_SPAWN_Y + def.rise * (1 - inv * inv * inv)
      const x = pop.x + pop.drift * t
      // 등장 순간 크게 튀었다가 빠르게 제자리로. exp(-11t)는 수명의 약 1/4
      // 지점에서 사실상 0이 된다 — 치명타는 이 한 순간에 눈을 잡는다.
      const punch = 1 + def.punch * Math.exp(-t * 11)
      // 끝에서 살짝 줄어들며 사라진다. 크기 그대로 투명해지면 "꺼진" 느낌이라
      // 시선이 마지막까지 붙잡힌다.
      const shrink = 1 - THREE.MathUtils.smoothstep(t, 0.7, 1) * 0.25
      const size = NUMBER_QUAD * def.scale * pop.emphasis * punch * shrink
      const alpha = def.alpha * (1 - THREE.MathUtils.smoothstep(t, 0.5, 1))

      const advance = size * GLYPH_ADVANCE
      const half = (pop.count - 1) * 0.5
      this.color.setHex(def.color)
      this.scl.set(size, size, 1)

      for (let g = 0; g < pop.count; g++) {
        if (n >= MAX_GLYPHS) break
        this.pos.set(x + (g - half) * advance, y, pop.z)
        this.m.compose(this.pos, this.qIdentity, this.scl)
        this.mesh.setMatrixAt(n, this.m)

        this.glyphData[n] = pop.glyphs[g]!
        const o = n * 4
        this.tintData[o] = this.color.r
        this.tintData[o + 1] = this.color.g
        this.tintData[o + 2] = this.color.b
        this.tintData[o + 3] = alpha
        n++
      }
    }

    this.mesh.count = n
    // count가 0이면 three가 드로우 자체를 건너뛴다. 갱신 플래그만 세워 둔다.
    this.mesh.instanceMatrix.needsUpdate = true
    this.glyphAttr.needsUpdate = true
    this.tintAttr.needsUpdate = true
  }

  dispose(): void {
    this.reducedMotion.removeEventListener('change', this.onMotionPreference)
    this.scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    const material = this.mesh.material
    if (Array.isArray(material)) {
      for (const m of material) m.dispose()
    } else {
      material.dispose()
    }
    this.atlas.dispose()
  }
}

/* ---------------------------------------------------------------------------
 * 통합 방법 — renderer.ts 를 사람이 직렬로 고칠 때 이 순서 그대로.
 * ---------------------------------------------------------------------------
 *
 * [1] 생성 — renderer.ts 생성자, `this.enemyRenderer = new EnemyRenderer(...)`
 *     바로 다음 줄.
 *
 *         import { ImpactFx } from './impact.ts'
 *         private readonly impact: ImpactFx
 *         ...
 *         this.impact = new ImpactFx(this.scene)
 *
 * [2] 매 프레임 갱신 — render() 안, `this.enemyRenderer.update(world, alpha, dt)`
 *     바로 다음 줄. now/dt 는 renderer.ts:284-287 이 이미 만들어 둔
 *     벽시계 값을 **그대로** 넘긴다(dt 는 0.1초로 클램프돼 있다).
 *
 *         this.impact.update(now, dt)
 *
 *     히트스톱으로 스케일한 dt 를 넘기면 안 된다. 시뮬이 멈춘 동안에도
 *     흔들림과 숫자는 계속 움직여야 그 정지가 "타격"으로 읽힌다.
 *
 * [3] 카메라 흔들림 — `this.positionCamera()` (renderer.ts:327) **다음 줄**.
 *
 *         this.positionCamera()
 *         this.camera.position.add(this.impact.offset)
 *         this.camera.rotateZ(this.impact.roll)
 *
 *     반드시 positionCamera() 뒤여야 한다. positionCamera()는 안에서
 *     lookAt()으로 회전을 다시 세우므로, 앞에서 position 을 밀면 lookAt 이
 *     카메라를 돌려 되받아쳐서 흔들림이 거의 상쇄된다.
 *     positionCamera()는 resize()에서도 불리는데 거기서는 더하지 않는다 —
 *     리사이즈한 그 한 프레임만 흔들림이 빠지고 다음 render 에서 복구된다.
 *     offset 은 내부 필드를 그대로 돌려주므로 호출부에서 변형하지 마라.
 *
 * [4] 히트스톱 배선 — Renderer 에 게터 하나를 뚫고, main.ts:156 에서 곱한다.
 *
 *         // renderer.ts
 *         get simTimeScale(): number { return this.impact.timeScale }
 *
 *         // main.ts:156
 *         accumulator +=
 *           Math.min(rawDt, DT * MAX_TICKS_PER_FRAME) * renderer.simTimeScale
 *
 *     시뮬 자체는 고정 DT 그대로 돈다. 누적기에 들어가는 양만 줄어서
 *     "틱이 덜 도는" 형태로 시간이 늦춰진다 — 결정론은 손대지 않는다.
 *     lastTime 은 계속 갱신되므로 히트스톱이 끝난 뒤 시간이 튀지도 않는다.
 *     (tools/sim-check.ts 는 stepWorld 를 직접 돌리므로 영향 없음.)
 *
 * [5] 이벤트 → 이펙트 배선 — render() 안, drainEvents(main.ts:189) 보다
 *     앞이면 어디든 된다. 이벤트를 **읽기만** 하고 배열을 비우지 마라.
 *     audio.update(main.ts:187)가 같은 배열을 뒤에서 다시 읽는다.
 *
 *     시뮬에 HitEvent 가 없어서(damage.ts 는 피해량·위치를 안 남긴다) 지금
 *     정확한 피격 지점에 숫자를 띄울 방법은 없다. 아래가 기성 신호만으로
 *     할 수 있는 최대치이고, sim 에 HitEvent 를 넣는 순간 popNumber 를
 *     그 좌표·피해량으로 바꾸면 된다.
 *
 *         // 사망 — 큰 놈이 죽을 때만 흔든다. 잡몹마다 흔들면 신호가 죽는다.
 *         for (const d of world.deaths) {
 *           if (d.type === 2) this.impact.shake(0.22, 0.26)          // 브루트
 *           else if (d.type === TYPE_BOSS) {                          // 보스
 *             this.impact.shake(0.9, 1.1, 12)
 *             this.impact.requestHitstop(0.9, 0.12)
 *           }
 *         }
 *
 *         // 폭발 링(zones.ts 가 push 하는 kind 2/3). 반경이 곧 규모다.
 *         for (const r of world.rings) {
 *           if (r.kind !== 2 && r.kind !== 3) continue
 *           this.impact.shake(Math.min(0.45, r.radius * 0.05), 0.3)
 *           this.impact.requestHitstop(0.45, 0.06)
 *         }
 *
 *         // 궁극기 시전.
 *         for (const c of world.casts) {
 *           if (c.slot === 'r') this.impact.shake(0.5, 0.5, 15)
 *         }
 *
 *         // 플레이어 체력 변화 — 피격 이벤트가 없으니 프레임 간 diff 로 잡는다.
 *         // world.player 는 단일 객체라 인덱스 셔플 문제가 없어 안전하다.
 *         const hp = world.player.hp
 *         if (hp < this.lastPlayerHp) {
 *           const dmg = this.lastPlayerHp - hp
 *           this.impact.popNumber(p.pos.x, p.pos.y, dmg, 'normal')
 *           this.impact.shake(Math.min(0.5, dmg * 0.02), 0.28)
 *         } else if (hp > this.lastPlayerHp) {
 *           this.impact.popNumber(p.pos.x, p.pos.y, hp - this.lastPlayerHp, 'heal')
 *         }
 *         this.lastPlayerHp = hp
 *
 *         // XP — progression.totalXp 는 단조 증가라 diff 가 안전하다.
 *         const xp = world.progression.totalXp
 *         if (xp > this.lastTotalXp) {
 *           this.impact.popNumber(p.pos.x, p.pos.y, xp - this.lastTotalXp, 'xp')
 *         }
 *         this.lastTotalXp = xp
 *
 * [6] 적 피격 플래시 — enemies.ts 의 drawEnemies() 에서 sim 플래시와 합친다.
 *     sim 의 pool.flash 는 swap-remove 때 같이 옮겨져서 항상 정확하다.
 *     이쪽은 렌더 전용 추가 채널이므로 **둘 중 큰 값**을 쓴다.
 *
 *         const f = Math.max(pool.flash[i]! / 0.08, impact.flashAmount(i, now))
 *         if (f > 0) this.color.lerp(this.white, Math.min(1, f))
 *
 *     EnemyRenderer 는 지금 now 를 안 받으므로 update() 시그니처에
 *     now 를 하나 더 넘기거나, ImpactFx 를 생성자에 주입해야 한다.
 *     (이번 라운드에서 enemies.ts 는 다른 에이전트가 잡고 있다.)
 *
 * [7] 품질 손잡이 — renderer.ts:336 updateRenderQuality() 안에서
 *     좁은 화면·터치 기기면 흔들림을 줄인다. 그리는 것이 없어 성능 문제는
 *     아니지만, 작은 화면에서 같은 진폭은 훨씬 크게 느껴진다.
 *
 *         this.impact.setShakeScale(constrained ? 0.6 : 1)
 *
 *     생성자에서 prefers-reduced-motion 이 켜져 있으면 이미 0.3 이 들어가
 *     있으므로, 접근성 설정을 존중하려면 이 호출은 그때 건너뛰는 편이 낫다.
 *
 * [8] 정리 — renderer.ts dispose() 안, this.enemyRenderer.dispose() 옆.
 *
 *         this.impact.dispose()
 *
 * 드로우콜: +1 (글리프 전부가 InstancedMesh 하나다). 상한 224 인스턴스.
 * 프레임당 할당: 0.
 * --------------------------------------------------------------------------- */
