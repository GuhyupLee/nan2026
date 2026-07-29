import * as THREE from 'three'

import type { ArenaArc } from '../arena.ts'

/**
 * 개기월식 하늘과 그로부터 생성하는 IBL.
 *
 * ## 왜 하늘이 조명의 출발점인가
 *
 * 이 게임의 PBR을 "웹게임"에서 "상용"으로 넘기는 단 하나의 변경이 이 파일이다.
 * 기존 조명은 HemisphereLight + DirectionalLight 둘뿐이었다. 그 조합에서
 * 금속은 반사할 게 없어 검게 죽고, 거친 돌은 방향 하나에서만 빛을 받아
 * 종이처럼 평평해진다. **PBR의 절반은 환경광 반사(IBL)인데 그게 통째로
 * 비어 있었다.**
 *
 * 그래서 하늘을 셰이더로 그리고, 그 하늘을 큐브맵으로 구워 `scene.environment`에
 * 넣는다. 그 순간 모든 표면이 하늘 색을 반사하기 시작한다. 청동 종에 달빛
 * 하이라이트가 앉고, 젖은 판석이 하늘을 되비치고, 그늘진 면이 검정이 아니라
 * 하늘의 반대쪽 색으로 채워진다. 텍스처를 한 장도 안 바꾸고 재질감이 바뀐다.
 *
 * ## 5분 아크
 *
 * 하늘·달·구름·별이 전부 같은 `ArenaArc`를 읽는다. 별도 시계를 두지 않으므로
 * 일시정지·리플레이에서도 같은 프레임은 같은 하늘이 나온다.
 *
 * ## 비용
 *
 * 돔은 드로우콜 1개다. IBL 재생성만 비싸므로(6면 렌더 + 프리필터) 아크가
 * 실제로 움직였을 때만, 그것도 최소 간격을 두고 돌린다. 5분 런에서 약 50회,
 * 회당 3~5ms다.
 */

/**
 * 달의 방향(=주광원 방향).
 *
 * 고도 약 33°. 기존 코드는 (14, 26, 10)으로 고도 55°였는데, 그 각도에서는
 * 그림자가 발밑에만 깔려 판석의 요철도 건축물의 실루엣도 살지 않는다.
 * 낮추면 그림자가 길어져 지면 모델링이 드러나고, 달 자체가 성벽 위에 걸려
 * 화면 안에 들어온다.
 *
 * 방위는 카메라 반대쪽(-Z, 화면 위쪽)에서 약간 왼쪽. 그래서 그림자가
 * 화면 오른쪽 아래로 떨어진다 — 캐릭터를 가리지 않는 방향이다.
 */
export const MOON_DIRECTION = new THREE.Vector3(-0.30, 0.55, -0.78).normalize()

const SKY_VERTEX = /* glsl */ `
  varying vec3 vDir;

  void main() {
    vDir = position;
    // 돔은 카메라를 따라다니므로 이동 성분을 버리고 회전만 쓴다. 그래야
    // 플레이어가 아레나를 가로질러도 하늘이 미끄러지지 않는다.
    vec4 viewPosition = viewMatrix * vec4(position + cameraPosition, 1.0);
    gl_Position = projectionMatrix * viewPosition;
  }
`

const SKY_FRAGMENT = /* glsl */ `
  precision highp float;

  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uGround;
  uniform vec3 uMoonDir;
  uniform vec3 uMoonColor;
  uniform vec3 uCoronaColor;
  uniform vec3 uCloudLit;
  uniform vec3 uCloudDark;
  uniform float uEclipse;
  uniform float uBoss;
  uniform float uPhaseTwo;
  uniform float uStarFade;
  uniform float uTime;

  varying vec3 vDir;

  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }

  float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i);
    float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z
    );
  }

  float fbm(vec3 p) {
    float total = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      total += valueNoise(p) * amplitude;
      p *= 2.03;
      amplitude *= 0.5;
    }
    return total;
  }

  void main() {
    vec3 dir = normalize(vDir);
    float height = dir.y;

    // --- 기본 그라디언트 -----------------------------------------------
    // 지평선 근처를 지수로 눌러야 하늘이 "위로 열린" 느낌이 난다. 선형
    // 보간은 어느 각도에서 봐도 같은 속도로 변해서 돔처럼 보인다.
    float horizonBlend = pow(clamp(1.0 - abs(height), 0.0, 1.0), 3.2);
    vec3 color = mix(uZenith, uHorizon, horizonBlend);
    // 지평선 아래는 지면 반사광. IBL에서 아래쪽 반구를 채우는 값이라
    // 화면에는 거의 안 보여도 재질에는 크게 영향을 준다.
    color = mix(color, uGround, smoothstep(0.02, -0.18, height));

    float moonDot = dot(dir, uMoonDir);

  #ifndef MW_SKY_IBL
    // --- 별 ------------------------------------------------------------
    // 셀 안에 점 하나. 밝기를 제곱으로 눌러 대부분은 아주 어둡고 몇 개만
    // 도드라지게 한다. 균일한 밝기의 점밭은 즉시 "노이즈 텍스처"로 읽힌다.
    //
    // IBL 경로에서는 통째로 건너뛴다. 프리필터가 어차피 뭉개서 기여가 0인데,
    // 큐브 6면 × 픽셀마다 해시를 도는 비용만 남는다.
    vec3 starCell = dir * 190.0;
    vec3 cellId = floor(starCell);
    float star = hash13(cellId);
    float brightness = pow(star, 42.0) * 3.4;
    if (brightness > 0.002) {
      vec3 offset = vec3(hash13(cellId + 1.7), hash13(cellId + 3.1), hash13(cellId + 5.3));
      float d = length(fract(starCell) - offset);
      float twinkle = 0.72 + 0.28 * sin(uTime * (1.4 + star * 3.0) + star * 40.0);
      float spark = smoothstep(0.085, 0.0, d) * brightness * twinkle;
      // 지평선 대기소광 + 달 주변 산란으로 별이 지워지는 것까지 재현해야
      // 하늘이 층으로 읽힌다.
      spark *= smoothstep(-0.02, 0.30, height);
      spark *= 1.0 - smoothstep(0.965, 0.999, moonDot);
      // 별빛은 약간 푸르되 완전히 희지 않게. 색온도 차이가 깊이를 만든다.
      color += spark * uStarFade * mix(vec3(0.72, 0.80, 1.0), vec3(1.0, 0.94, 0.86), star);
    }
  #endif

    // --- 달 -------------------------------------------------------------
    // 각반경 약 1.4°. 실제 달(0.52°)보다 크게 잡았다 — 실제 크기로 그리면
    // 부감 카메라 화면에서 점으로 보여 월식이라는 사건이 전달되지 않는다.
    float angle = acos(clamp(moonDot, -1.0, 1.0));
    const float MOON_RADIUS = 0.0244;
    float disc = 1.0 - smoothstep(MOON_RADIUS * 0.96, MOON_RADIUS * 1.04, angle);

    if (disc > 0.0 || angle < 0.6) {
      // 바다(海) 무늬. 달 표면에 접선 좌표를 만들어 노이즈를 얹는다.
      vec3 tangent = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
      vec3 bitangent = cross(uMoonDir, tangent);
      vec2 lunar = vec2(dot(dir, tangent), dot(dir, bitangent)) / MOON_RADIUS;
      float maria = fbm(vec3(lunar * 1.6, 0.0));
      float craters = 1.0 - smoothstep(0.35, 0.62, fbm(vec3(lunar * 5.2, 3.0)));

      // 가장자리 어두워짐(limb darkening). 이게 없으면 달이 종이 원반이 된다.
      float limb = sqrt(max(0.0, 1.0 - pow(angle / MOON_RADIUS, 2.0)));
      float surface = (0.62 + maria * 0.44 - craters * 0.12) * mix(0.55, 1.0, limb);

      // 본影(umbra)이 달을 가로질러 지나간다. 개기 때는 대기 산란으로
      // 붉게 남는 "블러드문"이 되어야 한다 — 완전히 사라지면 사건이 아니라
      // 버그로 보인다.
      float shadowSweep = uEclipse * 2.35 - 1.0;
      float shadowMask = smoothstep(-0.35, 0.55, (lunar.x * 0.5) - shadowSweep);
      vec3 eclipsed = mix(
        uMoonColor * surface,
        vec3(0.42, 0.085, 0.062) * (surface * 0.85 + 0.25),
        clamp(shadowMask * uEclipse * 1.15, 0.0, 1.0)
      );
      color = mix(color, eclipsed, disc);

      // 코로나 — 개기 때만 나타나는 얇은 고리와 넓은 헤일로.
      float halo = pow(clamp(1.0 - angle / 0.55, 0.0, 1.0), 3.4);
      float ring = smoothstep(MOON_RADIUS * 1.16, MOON_RADIUS * 1.02, angle)
                 * smoothstep(MOON_RADIUS * 0.99, MOON_RADIUS * 1.03, angle);
      float coronaAmount = mix(0.42, 1.0, uEclipse);
      color += uCoronaColor * (halo * 0.30 * coronaAmount + ring * 1.9 * uEclipse);
    }

    // --- 구름 ------------------------------------------------------------
    // 얇고 길게 늘인 층운. 수직으로 눌러야 하늘에 붙어 있는 것처럼 보인다.
    // 구형 좌표를 그대로 쓰면 천정에서 뭉치므로 방향 벡터를 직접 스케일한다.
    float above = smoothstep(0.02, 0.34, height);
    if (above > 0.0) {
      vec3 cloudCoord = dir / max(0.10, height);
      cloudCoord.xz *= 0.62;
      cloudCoord.xz += uTime * vec2(0.0090, 0.0042);
      float sheet = fbm(cloudCoord * 1.25);
      float density = smoothstep(0.50, 0.86, sheet);
      // 두 번째 층을 다른 속도로 흘려야 구름이 판이 아니라 부피로 읽힌다.
      // IBL에서는 한 층이면 충분하다 — 프리필터를 통과하면 두 층의 차이가
      // 남지 않는데 FBM 5옥타브를 한 번 더 도는 비용만 든다.
      #ifndef MW_SKY_IBL
      float upper = smoothstep(0.56, 0.92, fbm(cloudCoord * 2.7 + vec3(11.0, 0.0, 5.0) - uTime * 0.006));
      density = clamp(density + upper * 0.42, 0.0, 1.0);
      #endif

      // 달 쪽 가장자리만 밝게. 뒤에서 빛을 받는 구름의 은테두리다.
      float rim = pow(clamp(moonDot * 0.5 + 0.5, 0.0, 1.0), 5.0);
      vec3 cloud = mix(uCloudDark, uCloudLit, rim);
      cloud += uCoronaColor * rim * 0.34 * uEclipse;
      color = mix(color, cloud, density * above * 0.80);
    }

    // --- 보스 단계의 하늘 균열 --------------------------------------------
    // 2페이즈에서만 나타난다. 능선형 노이즈를 좁게 임계해 실금으로 만들고,
    // 발광시켜 블룸이 잡게 한다.
    if (uPhaseTwo > 0.001) {
      vec3 fractureCoord = dir * 3.4;
      float ridge = 1.0 - abs(fbm(fractureCoord) * 2.0 - 1.0);
      float crack = smoothstep(0.86, 0.995, ridge) * smoothstep(-0.05, 0.25, height);
      color += vec3(1.0, 0.26, 0.30) * crack * uPhaseTwo * 1.7;
    }

    // 보스 단계에서 지평선이 아래에서부터 붉게 달아오른다.
    color += vec3(0.30, 0.045, 0.070) * uBoss * pow(clamp(1.0 - abs(height) * 2.6, 0.0, 1.0), 2.0);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

/** 아크 5단계에 대응하는 하늘 색. 인덱스 0=시작, 4=보스 2페이즈. */
const SKY_PALETTE = {
  zenith: [0x0a1526, 0x0b1327, 0x120e26, 0x1a0a1c, 0x210711],
  horizon: [0x2b4a72, 0x30416b, 0x412f5e, 0x5a1f3f, 0x6b1526],
  ground: [0x070a12, 0x080a13, 0x0a070f, 0x0d050a, 0x110407],
  moon: [0xf2f6ff, 0xe8ecff, 0xe4d8f0, 0xf0c2cf, 0xf5b2bd],
  corona: [0x4f7fb0, 0x5878b4, 0x8a63b0, 0xc4507e, 0xe0405f],
  cloudLit: [0x35506f, 0x374763, 0x452f55, 0x5c1f38, 0x6d1524],
  cloudDark: [0x0c1422, 0x0d1220, 0x120c1c, 0x160713, 0x1a050d],
} as const

type Palette5 = readonly [number, number, number, number, number]

function sampleArcColor(target: THREE.Color, palette: Palette5, arc: Readonly<ArenaArc>): void {
  target
    .setHex(palette[0])
    .lerp(new THREE.Color(palette[1]), arc.dusk)
    .lerp(new THREE.Color(palette[2]), arc.eclipse)
    .lerp(new THREE.Color(palette[3]), arc.boss)
    .lerp(new THREE.Color(palette[4]), arc.phaseTwo)
}

export interface SkyOptions {
  /** IBL 재생성 최소 간격(초). 낮출수록 색 전환이 매끄럽고 비싸진다. */
  iblIntervalSec?: number
  /** IBL 큐브 해상도. 128이면 거친 반사에 충분하고 32면 부족하다. */
  iblSize?: number
}

export class Sky {
  readonly mesh: THREE.Mesh
  /** 하늘이 실제로 내는 주광 색. 렌더러가 DirectionalLight에 그대로 쓴다. */
  readonly keyLightColor = new THREE.Color(0xffffff)
  /** 지면 반사광. HemisphereLight의 아래쪽 색이다. */
  readonly bounceColor = new THREE.Color(0x0a0e18)

  private readonly scene: THREE.Scene
  private readonly material: THREE.ShaderMaterial
  private readonly iblMaterial: THREE.ShaderMaterial
  private readonly pmrem: THREE.PMREMGenerator
  private readonly iblScene: THREE.Scene
  private environmentTarget: THREE.WebGLRenderTarget | null = null
  private readonly iblInterval: number
  private iblCooldown = 0
  /** 마지막으로 IBL을 구운 시점의 아크. 실제로 움직였을 때만 다시 굽는다. */
  private bakedArc = { dusk: -1, eclipse: -1, boss: -1, phaseTwo: -1 }
  private time = 0

  constructor(gl: THREE.WebGLRenderer, scene: THREE.Scene, options: SkyOptions = {}) {
    this.scene = scene
    // 재생성 간격을 0.28초에서 크게 늘렸다. 아크는 5분에 걸쳐 변하므로
    // 1.2초 단위 갱신은 눈에 띄지 않지만, 재생성 자체가 프레임을 16ms까지
    // 밀어 올리는 스파이크였다. 측정에서 90프레임 중 10프레임이 8ms를
    // 넘었는데 그 전부가 이 작업이었다.
    this.iblInterval = options.iblIntervalSec ?? 1.2

    this.material = new THREE.ShaderMaterial({
      name: 'eclipse-sky',
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      // 안개는 하늘에 적용하면 안 된다. 하늘이 곧 안개색의 출처다.
      fog: false,
      uniforms: {
        uZenith: { value: new THREE.Color(SKY_PALETTE.zenith[0]) },
        uHorizon: { value: new THREE.Color(SKY_PALETTE.horizon[0]) },
        uGround: { value: new THREE.Color(SKY_PALETTE.ground[0]) },
        uMoonDir: { value: MOON_DIRECTION.clone() },
        uMoonColor: { value: new THREE.Color(SKY_PALETTE.moon[0]) },
        uCoronaColor: { value: new THREE.Color(SKY_PALETTE.corona[0]) },
        uCloudLit: { value: new THREE.Color(SKY_PALETTE.cloudLit[0]) },
        uCloudDark: { value: new THREE.Color(SKY_PALETTE.cloudDark[0]) },
        uEclipse: { value: 0 },
        uBoss: { value: 0 },
        uPhaseTwo: { value: 0 },
        uStarFade: { value: 1 },
        uTime: { value: 0 },
      },
    })

    // 반지름은 카메라 far(240)보다 확실히 작아야 한다. 돔이 카메라를 따라다니므로
    // 절대 크기는 시각적으로 무의미하고, 잘리지만 않으면 된다.
    const geometry = new THREE.SphereGeometry(180, 48, 32)
    this.mesh = new THREE.Mesh(geometry, this.material)
    this.mesh.name = 'eclipse-sky'
    this.mesh.renderOrder = -1000
    this.mesh.frustumCulled = false
    scene.add(this.mesh)

    // IBL용 씬은 **단순화된 머티리얼**을 쓰는 별도 돔이다.
    //
    // 본 씬을 그대로 구우면 캐릭터·이펙트까지 환경광에 섞여 프레임마다 색이
    // 튄다. 그래서 하늘만 담은 씬을 따로 둔다.
    //
    // 화면용 머티리얼을 공유했더니 IBL 재생성이 프레임을 16ms까지 밀어
    // 올렸다. 큐브 6면을 각각 그리는데 픽셀마다 별 해시와 5옥타브 구름
    // FBM을 돌기 때문이다. **환경광에 별과 구름의 고주파는 아무 기여도
    // 하지 않는다** — 프리필터가 어차피 뭉갠다. 저주파 성분만 남긴
    // 별도 머티리얼을 쓰면 결과는 사실상 같고 비용은 몇 분의 일이 된다.
    this.iblMaterial = this.material.clone()
    this.iblMaterial.name = 'eclipse-sky-ibl'
    // 공유 유니폼 객체를 그대로 물려 화면용과 항상 같은 색을 낸다.
    this.iblMaterial.uniforms = this.material.uniforms
    this.iblMaterial.defines = { MW_SKY_IBL: '' }
    this.iblMaterial.needsUpdate = true

    this.iblScene = new THREE.Scene()
    const iblDome = new THREE.Mesh(new THREE.SphereGeometry(100, 16, 12), this.iblMaterial)
    iblDome.frustumCulled = false
    this.iblScene.add(iblDome)

    this.pmrem = new THREE.PMREMGenerator(gl)
    this.pmrem.compileEquirectangularShader()
  }

  /**
   * 아크에 맞춰 하늘 색을 갱신하고, 필요하면 IBL을 다시 굽는다.
   *
   * @param dt 렌더 프레임 간격(초). 구름 흐름과 별 반짝임에만 쓴다.
   */
  update(arc: Readonly<ArenaArc>, dt: number): void {
    this.time += dt
    const uniforms = this.material.uniforms
    uniforms.uTime.value = this.time

    sampleArcColor(uniforms.uZenith.value as THREE.Color, SKY_PALETTE.zenith, arc)
    sampleArcColor(uniforms.uHorizon.value as THREE.Color, SKY_PALETTE.horizon, arc)
    sampleArcColor(uniforms.uGround.value as THREE.Color, SKY_PALETTE.ground, arc)
    sampleArcColor(uniforms.uMoonColor.value as THREE.Color, SKY_PALETTE.moon, arc)
    sampleArcColor(uniforms.uCoronaColor.value as THREE.Color, SKY_PALETTE.corona, arc)
    sampleArcColor(uniforms.uCloudLit.value as THREE.Color, SKY_PALETTE.cloudLit, arc)
    sampleArcColor(uniforms.uCloudDark.value as THREE.Color, SKY_PALETTE.cloudDark, arc)

    uniforms.uEclipse.value = arc.eclipse
    uniforms.uBoss.value = arc.boss
    uniforms.uPhaseTwo.value = arc.phaseTwo
    // 월식이 진행되면 달빛이 약해져 별이 오히려 잘 보인다. 실제 현상이고,
    // 화면에서는 "어두워졌다"가 아니라 "하늘이 깊어졌다"로 읽힌다.
    uniforms.uStarFade.value = 0.55 + arc.eclipse * 0.45

    // 주광·반사광 색을 하늘에서 뽑아 렌더러에 넘긴다. 조명과 배경이 각자
    // 다른 팔레트를 갖고 있으면 아무리 맞춰도 어긋난 순간이 생긴다.
    this.keyLightColor
      .copy(uniforms.uMoonColor.value as THREE.Color)
      .lerp(new THREE.Color(0x8c2436), arc.eclipse * 0.42)
    this.bounceColor.copy(uniforms.uGround.value as THREE.Color)

    this.iblCooldown -= dt
    const moved =
      Math.abs(arc.dusk - this.bakedArc.dusk) +
      Math.abs(arc.eclipse - this.bakedArc.eclipse) +
      Math.abs(arc.boss - this.bakedArc.boss) +
      Math.abs(arc.phaseTwo - this.bakedArc.phaseTwo)
    if (this.environmentTarget === null || (moved > 0.06 && this.iblCooldown <= 0)) {
      this.bakeEnvironment(arc)
    }
  }

  /** 하늘을 큐브맵으로 구워 `scene.environment`에 넣는다. */
  private bakeEnvironment(arc: Readonly<ArenaArc>): void {
    const previous = this.environmentTarget
    // fromScene은 호출마다 새 렌더 타겟을 만든다. 이전 것을 반드시 버려야
    // 5분 런에서 50개가 쌓여 VRAM을 먹지 않는다.
    this.environmentTarget = this.pmrem.fromScene(this.iblScene, 0.02)
    this.scene.environment = this.environmentTarget.texture
    previous?.dispose()

    this.bakedArc.dusk = arc.dusk
    this.bakedArc.eclipse = arc.eclipse
    this.bakedArc.boss = arc.boss
    this.bakedArc.phaseTwo = arc.phaseTwo
    this.iblCooldown = this.iblInterval
  }

  /** 환경광 세기. 저사양에서 IBL을 끄지 않고 줄이는 데 쓴다. */
  setEnvironmentIntensity(value: number): void {
    this.scene.environmentIntensity = THREE.MathUtils.clamp(value, 0, 3)
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.iblMaterial.dispose()
    this.environmentTarget?.dispose()
    this.environmentTarget = null
    this.scene.environment = null
    this.pmrem.dispose()
  }
}
