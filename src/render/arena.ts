import * as THREE from 'three'

/**
 * 정적 아레나 환경.
 *
 * 바닥 셰이더 1콜 + 병합된 건축 지오메트리 1콜만 사용한다. 텍스처, 난수,
 * 난수를 쓰지 않아 모바일에서도 비용이 고정되고 리플레이도 결정적이다.
 * 5분 아크는 기존 머티리얼의 색 유니폼만 갱신하므로 드로우콜은 그대로다.
 */

export interface ArenaArc {
  /** 1분 이후 차가운 청색이 빠지는 첫 환경 전환. */
  dusk: number
  /** 보스 등장 전까지 월식의 자홍색이 스며드는 정도. */
  eclipse: number
  /** 보스 등장 뒤 전장이 적대색으로 잠기는 정도. */
  boss: number
  /** 보스 2페이즈의 최종 환경 강도. */
  phaseTwo: number
  /** 등장 직후에만 남는 짧은 환경 피크. */
  arrival: number
}

export interface ArenaVisual {
  readonly group: THREE.Group
  applyArc(arc: Readonly<ArenaArc>): void
  dispose(): void
}

function smooth01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * 시뮬레이션 시각만 읽어 렌더용 환경 단계를 만든다.
 *
 * 별도 타이머나 난수를 만들지 않아 일시정지·리플레이에서도 같은 프레임은 같은
 * 색을 낸다. reduced-motion에서는 빠른 등장 피크만 줄이고, 시간 경과를 알리는
 * 정적인 색 변화는 보존한다.
 */
export function sampleArenaArc(
  time: number,
  bossSpawned: boolean,
  bossSpawnedAt: number,
  phaseTwoAt: number,
  reducedMotion: boolean,
  out: ArenaArc,
): ArenaArc {
  const safeTime = Number.isFinite(time) ? Math.max(0, time) : 0
  out.dusk = smooth01((safeTime - 55) / 95)
  out.eclipse = smooth01((safeTime - 145) / 65)

  const safeSpawnedAt = Number.isFinite(bossSpawnedAt)
    ? bossSpawnedAt
    : safeTime
  const sinceBoss = safeTime - safeSpawnedAt
  out.boss = bossSpawned ? smooth01(sinceBoss / 1.35) : 0
  out.arrival =
    bossSpawned && sinceBoss >= 0
      ? (1 - smooth01(sinceBoss / 1.6)) * (reducedMotion ? 0.3 : 1)
      : 0

  const sincePhaseTwo = phaseTwoAt >= 0 ? safeTime - phaseTwoAt : -1
  out.phaseTwo =
    sincePhaseTwo >= 0 ? smooth01(sincePhaseTwo / 1.2) : 0
  return out
}

const FLOOR_VERTEX_SHADER = /* glsl */ `
  varying vec3 vWorld;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorld = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`

const FLOOR_FRAGMENT_SHADER = /* glsl */ `
  uniform float uRadius;
  uniform vec3 uBase;
  uniform vec3 uLane;
  uniform vec3 uMortar;
  uniform vec3 uAccent;
  uniform vec3 uFogColor;

  varying vec3 vWorld;

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }

  float band(float value, float center, float halfWidth) {
    float distanceToBand = abs(value - center) - halfWidth;
    float antialias = max(fwidth(value) * 1.35, 0.0005);
    return 1.0 - smoothstep(-antialias, antialias, distanceToBand);
  }

  void main() {
    vec2 p = vWorld.xz;
    float radius = length(p);
    float normalizedRadius = clamp(radius / uRadius, 0.0, 1.0);

    // 엇갈린 대형 석재 판. 고주파 노이즈 대신 셀별 명암만 달리해
    // 캐릭터와 피해 장판의 실루엣을 흐리지 않는다.
    vec2 slab = p / 3.75;
    float row = floor(slab.y);
    slab.x += mod(row, 2.0) * 0.5;
    vec2 slabCell = floor(slab);
    vec2 slabUv = fract(slab);
    vec2 edgeDistance = min(slabUv, 1.0 - slabUv);
    float seamDistance = min(edgeDistance.x, edgeDistance.y);
    float seamAa = max(fwidth(slab.x), fwidth(slab.y)) * 1.4;
    float seam = 1.0 - smoothstep(0.012, 0.012 + seamAa, seamDistance);

    float tileTone = hash21(slabCell) - 0.5;
    float broadWear = sin(p.x * 0.21 + p.y * 0.07) * sin(p.y * 0.17 - p.x * 0.05);
    vec3 color = uBase * (0.96 + tileTone * 0.085 + broadWear * 0.035);

    // 네 방향 문루로 이어지는 넓은 진입로. 전투 범위선보다 훨씬 낮은
    // 대비로만 남겨 무의식적인 방향 감각을 제공한다.
    float axisDistance = min(abs(p.x), abs(p.y));
    float lane = 1.0 - smoothstep(3.45, 4.45, axisDistance);
    float laneEdge = band(axisDistance, 4.18, 0.075);
    color = mix(color, uLane, lane * 0.34);
    color = mix(color, uMortar, seam * mix(0.62, 0.35, lane));
    color += uAccent * laneEdge * 0.058;

    // 중앙 월식 문양은 실제 장애물이 아닌 바닥 상감이다.
    float centerField = 1.0 - smoothstep(4.75, 5.25, radius);
    float centerOuter = band(radius, 4.15, 0.09);
    float centerCross = (1.0 - smoothstep(0.12, 0.22, axisDistance))
                      * smoothstep(0.7, 1.25, radius)
                      * (1.0 - smoothstep(3.35, 3.8, radius));

    // 동심원 하나를 더 긋지 않고, 서로 어긋난 두 원의 차집합으로 초승을
    // 만든다. 완전 대칭을 깨야 중앙이 기술 테스트 패드가 아니라 월식
    // 상징으로 읽힌다.
    float moonOuterDistance = length(p - vec2(-0.18, 0.12));
    float moonCutDistance = length(p - vec2(0.55, 0.30));
    float moonAa = max(
      max(fwidth(moonOuterDistance), fwidth(moonCutDistance)) * 1.4,
      0.003
    );
    float moonOuter = 1.0 - smoothstep(2.18 - moonAa, 2.18 + moonAa, moonOuterDistance);
    float moonCut = 1.0 - smoothstep(1.96 - moonAa, 1.96 + moonAa, moonCutDistance);
    float crescent = moonOuter * (1.0 - moonCut);
    float crescentRim =
      band(moonOuterDistance, 2.18, 0.032) * (1.0 - moonCut)
      + band(moonCutDistance, 1.96, 0.024) * moonOuter;

    color = mix(color, uLane * 1.06, centerField * 0.22);
    color = mix(color, uMortar, crescent * 0.075);
    color += uAccent * (
      centerOuter * 0.18
      + centerCross * 0.078
      + crescent * 0.032
      + crescentRim * 0.052
    );

    // 10m·20m 기준은 디버그 그리드처럼 반복하지 않고 두 줄만 남긴다.
    float rangeGuides = max(band(radius, 10.0, 0.035), band(radius, 20.0, 0.04));
    color += uAccent * rangeGuides * 0.055;

    // 경계의 한계는 읽히되 스킬 이펙트처럼 빛나지 않게 한다.
    float boundaryInlay = band(radius, uRadius - 0.58, 0.085);
    color += uAccent * boundaryInlay * 0.25;
    color *= mix(1.0, 0.66, smoothstep(0.68, 1.0, normalizedRadius));

    float fog = smoothstep(28.0, 62.0, distance(cameraPosition, vWorld));
    color = mix(color, uFogColor, fog * 0.62);

    gl_FragColor = vec4(color, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`

type Point = readonly [x: number, y: number, z: number]

interface GeometryBuilder {
  positions: number[]
  normals: number[]
  colors: number[]
}

const COLOR_CACHE = new Map<number, THREE.Color>()

function linearColor(hex: number): THREE.Color {
  let color = COLOR_CACHE.get(hex)
  if (!color) {
    color = new THREE.Color(hex)
    COLOR_CACHE.set(hex, color)
  }
  return color
}

function addTriangle(
  builder: GeometryBuilder,
  a: Point,
  b: Point,
  c: Point,
  hex: number,
): void {
  const abx = b[0] - a[0]
  const aby = b[1] - a[1]
  const abz = b[2] - a[2]
  const acx = c[0] - a[0]
  const acy = c[1] - a[1]
  const acz = c[2] - a[2]
  let nx = aby * acz - abz * acy
  let ny = abz * acx - abx * acz
  let nz = abx * acy - aby * acx
  const inverseLength = 1 / Math.max(1e-6, Math.hypot(nx, ny, nz))
  nx *= inverseLength
  ny *= inverseLength
  nz *= inverseLength

  builder.positions.push(...a, ...b, ...c)
  builder.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz)
  const color = linearColor(hex)
  for (let i = 0; i < 3; i++) builder.colors.push(color.r, color.g, color.b)
}

function addQuad(
  builder: GeometryBuilder,
  a: Point,
  b: Point,
  c: Point,
  d: Point,
  hex: number,
): void {
  addTriangle(builder, a, b, c, hex)
  addTriangle(builder, a, c, d, hex)
}

function ringPoint(radius: number, y: number, angle: number): Point {
  return [Math.cos(angle) * radius, y, Math.sin(angle) * radius]
}

function addRingStrip(
  builder: GeometryBuilder,
  innerRadius: number,
  innerY: number,
  outerRadius: number,
  outerY: number,
  segments: number,
  hex: number,
): void {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2
    const a1 = ((i + 1) / segments) * Math.PI * 2
    addQuad(
      builder,
      ringPoint(innerRadius, innerY, a0),
      ringPoint(innerRadius, innerY, a1),
      ringPoint(outerRadius, outerY, a1),
      ringPoint(outerRadius, outerY, a0),
      hex,
    )
  }
}

function addRingWall(
  builder: GeometryBuilder,
  radius: number,
  bottom: number,
  top: number,
  segments: number,
  hex: number,
): void {
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2
    const a1 = ((i + 1) / segments) * Math.PI * 2
    addQuad(
      builder,
      ringPoint(radius, bottom, a0),
      ringPoint(radius, top, a0),
      ringPoint(radius, top, a1),
      ringPoint(radius, bottom, a1),
      hex,
    )
  }
}

function orientedPoint(
  centerRadius: number,
  angle: number,
  tangentOffset: number,
  radialOffset: number,
  y: number,
): Point {
  const radialX = Math.cos(angle)
  const radialZ = Math.sin(angle)
  const tangentX = -radialZ
  const tangentZ = radialX
  return [
    radialX * centerRadius + tangentX * tangentOffset + radialX * radialOffset,
    y,
    radialZ * centerRadius + tangentZ * tangentOffset + radialZ * radialOffset,
  ]
}

function addOrientedBox(
  builder: GeometryBuilder,
  centerRadius: number,
  angle: number,
  tangentCenter: number,
  tangentHalf: number,
  radialHalf: number,
  bottom: number,
  top: number,
  hex: number,
): void {
  const b0 = orientedPoint(centerRadius, angle, tangentCenter - tangentHalf, -radialHalf, bottom)
  const b1 = orientedPoint(centerRadius, angle, tangentCenter + tangentHalf, -radialHalf, bottom)
  const b2 = orientedPoint(centerRadius, angle, tangentCenter + tangentHalf, radialHalf, bottom)
  const b3 = orientedPoint(centerRadius, angle, tangentCenter - tangentHalf, radialHalf, bottom)
  const t0: Point = [b0[0], top, b0[2]]
  const t1: Point = [b1[0], top, b1[2]]
  const t2: Point = [b2[0], top, b2[2]]
  const t3: Point = [b3[0], top, b3[2]]

  addQuad(builder, t0, t3, t2, t1, hex)
  addQuad(builder, b0, t0, t1, b1, hex)
  addQuad(builder, b1, t1, t2, b2, hex)
  addQuad(builder, b2, t2, t3, b3, hex)
  addQuad(builder, b3, t3, t0, b0, hex)
}

function addTaperedPillar(
  builder: GeometryBuilder,
  centerRadius: number,
  angle: number,
  tangentCenter: number,
  bottom: number,
  top: number,
  bottomRadius: number,
  topRadius: number,
  hex: number,
): void {
  const radialX = Math.cos(angle)
  const radialZ = Math.sin(angle)
  const tangentX = -radialZ
  const tangentZ = radialX
  const centerX = radialX * centerRadius + tangentX * tangentCenter
  const centerZ = radialZ * centerRadius + tangentZ * tangentCenter
  const sides = 6
  const baseRotation = angle + Math.PI / 6

  for (let i = 0; i < sides; i++) {
    const a0 = baseRotation + (i / sides) * Math.PI * 2
    const a1 = baseRotation + ((i + 1) / sides) * Math.PI * 2
    const b0: Point = [
      centerX + Math.cos(a0) * bottomRadius,
      bottom,
      centerZ + Math.sin(a0) * bottomRadius,
    ]
    const b1: Point = [
      centerX + Math.cos(a1) * bottomRadius,
      bottom,
      centerZ + Math.sin(a1) * bottomRadius,
    ]
    const t1: Point = [
      centerX + Math.cos(a1) * topRadius,
      top,
      centerZ + Math.sin(a1) * topRadius,
    ]
    const t0: Point = [
      centerX + Math.cos(a0) * topRadius,
      top,
      centerZ + Math.sin(a0) * topRadius,
    ]
    addQuad(builder, b0, t0, t1, b1, hex)
    addTriangle(builder, [centerX, top, centerZ], t0, t1, hex)
  }

  const apex: Point = [centerX, top + 0.62, centerZ]
  for (let i = 0; i < sides; i++) {
    const a0 = baseRotation + (i / sides) * Math.PI * 2
    const a1 = baseRotation + ((i + 1) / sides) * Math.PI * 2
    addTriangle(
      builder,
      [
        centerX + Math.cos(a0) * topRadius * 1.18,
        top,
        centerZ + Math.sin(a0) * topRadius * 1.18,
      ],
      apex,
      [
        centerX + Math.cos(a1) * topRadius * 1.18,
        top,
        centerZ + Math.sin(a1) * topRadius * 1.18,
      ],
      0x50616a,
    )
  }
}

function distanceToCardinal(angle: number): number {
  return Math.abs(Math.sin(angle * 2))
}

function createArchitecture(radius: number): THREE.BufferGeometry {
  const builder: GeometryBuilder = { positions: [], normals: [], colors: [] }
  const segments = 128

  // 낮은 안쪽 턱 → 넓은 상단 → 어둠으로 내려가는 외벽. 플레이 가능한
  // 반경 안에는 높은 지오메트리를 두지 않는다.
  addRingStrip(builder, radius - 0.72, 0.012, radius - 0.24, 0.035, segments, 0x283843)
  addRingStrip(builder, radius - 0.24, 0.035, radius + 0.16, 0.17, segments, 0x344650)
  addRingStrip(builder, radius + 0.16, 0.17, radius + 0.78, 0.36, segments, 0x263641)
  addRingStrip(builder, radius + 0.78, 0.36, radius + 1.42, 0.08, segments, 0x18242d)
  addRingWall(builder, radius + 1.42, -1.45, 0.08, segments, 0x0b1119)
  addRingStrip(builder, radius + 1.42, -1.45, radius + 3.1, -1.45, segments, 0x070b11)

  // 낮은 크레넬은 경계의 실루엣을 끊어 주되 네 문루 앞은 비운다.
  const crenellations = 32
  for (let i = 0; i < crenellations; i++) {
    const angle = ((i + 0.5) / crenellations) * Math.PI * 2
    if (distanceToCardinal(angle) < 0.25) continue
    const height = 0.56 + (i % 3) * 0.045
    addOrientedBox(
      builder,
      radius + 0.96,
      angle,
      0,
      0.38,
      0.26,
      0.32,
      height,
      i % 2 === 0 ? 0x293943 : 0x22313b,
    )
  }

  // 네 방향의 쌍둥이 문루. 중앙 시야 통로를 2.4m 이상 비워 카메라가
  // 경계 가까운 플레이어와 적을 가리지 않는다.
  for (let direction = 0; direction < 4; direction++) {
    const angle = direction * Math.PI * 0.5
    for (const side of [-1, 1]) {
      addOrientedBox(
        builder,
        radius + 1.0,
        angle,
        side * 1.68,
        0.62,
        0.62,
        0.24,
        0.52,
        0x34464f,
      )
      addTaperedPillar(
        builder,
        radius + 1.02,
        angle,
        side * 1.68,
        0.5,
        2.42,
        0.48,
        0.31,
        0x263943,
      )
    }
    addOrientedBox(
      builder,
      radius + 1.05,
      angle,
      0,
      1.74,
      0.23,
      2.18,
      2.42,
      0x40515a,
    )
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(builder.positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(builder.normals, 3))
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(builder.colors, 3))
  geometry.computeBoundingSphere()
  geometry.name = 'arena-architecture-merged'
  return geometry
}

const FLOOR_PALETTE = {
  base: [
    new THREE.Color(0x151f29),
    new THREE.Color(0x151c28),
    new THREE.Color(0x171722),
    new THREE.Color(0x19131c),
    new THREE.Color(0x1d1018),
  ],
  lane: [
    new THREE.Color(0x1b2d36),
    new THREE.Color(0x202b38),
    new THREE.Color(0x282432),
    new THREE.Color(0x301d29),
    new THREE.Color(0x381721),
  ],
  mortar: [
    new THREE.Color(0x080e15),
    new THREE.Color(0x090d16),
    new THREE.Color(0x0d0912),
    new THREE.Color(0x10070d),
    new THREE.Color(0x140509),
  ],
  accent: [
    new THREE.Color(0x327f91),
    new THREE.Color(0x427b9b),
    new THREE.Color(0x76577f),
    new THREE.Color(0xa44769),
    new THREE.Color(0xd04468),
  ],
  fog: [
    new THREE.Color(0x05070d),
    new THREE.Color(0x060711),
    new THREE.Color(0x08060d),
    new THREE.Color(0x0b050a),
    new THREE.Color(0x100407),
  ],
  arrivalAccent: new THREE.Color(0xe66a8b),
} as const

function applyArcColor(
  target: THREE.Color,
  palette: readonly [
    THREE.Color,
    THREE.Color,
    THREE.Color,
    THREE.Color,
    THREE.Color,
  ],
  arc: Readonly<ArenaArc>,
): void {
  target
    .copy(palette[0])
    .lerp(palette[1], arc.dusk)
    .lerp(palette[2], arc.eclipse)
    .lerp(palette[3], arc.boss)
    .lerp(palette[4], arc.phaseTwo)
}

export function createArena(radius: number): ArenaVisual {
  const group = new THREE.Group()
  group.name = 'arena'

  const floorGeometry = new THREE.CircleGeometry(radius, 128)
  floorGeometry.name = 'arena-floor'
  const floorMaterial = new THREE.ShaderMaterial({
    name: 'arena-floor-procedural',
    vertexShader: FLOOR_VERTEX_SHADER,
    fragmentShader: FLOOR_FRAGMENT_SHADER,
    uniforms: {
      uRadius: { value: radius },
      uBase: { value: FLOOR_PALETTE.base[0].clone() },
      uLane: { value: FLOOR_PALETTE.lane[0].clone() },
      uMortar: { value: FLOOR_PALETTE.mortar[0].clone() },
      uAccent: { value: FLOOR_PALETTE.accent[0].clone() },
      uFogColor: { value: FLOOR_PALETTE.fog[0].clone() },
    },
  })
  const floor = new THREE.Mesh(
    floorGeometry,
    floorMaterial,
  )
  floor.name = 'arena-floor'
  floor.rotation.x = -Math.PI / 2
  floor.renderOrder = -2
  floor.matrixAutoUpdate = false
  floor.updateMatrix()
  group.add(floor)

  const architectureGeometry = createArchitecture(radius)
  const architectureMaterial = new THREE.MeshStandardMaterial({
    name: 'arena-architecture-stone',
    vertexColors: true,
    color: 0xffffff,
    roughness: 0.82,
    metalness: 0.12,
    emissive: 0x050b10,
    emissiveIntensity: 0.24,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
  const architecture = new THREE.Mesh(
    architectureGeometry,
    architectureMaterial,
  )
  architecture.name = 'arena-boundary-and-landmarks'
  architecture.receiveShadow = true
  architecture.renderOrder = -1
  architecture.matrixAutoUpdate = false
  architecture.updateMatrix()
  group.add(architecture)

  // 성능 감사·브라우저 계측에서 정적 환경 예산을 바로 확인할 수 있다.
  group.userData.staticDrawCalls = 2
  group.userData.staticTriangles =
    floorGeometry.getAttribute('position').count - 2 +
    architecture.geometry.getAttribute('position').count / 3
  group.matrixAutoUpdate = false
  group.updateMatrix()
  return {
    group,
    applyArc(arc: Readonly<ArenaArc>): void {
      applyArcColor(
        floorMaterial.uniforms.uBase.value as THREE.Color,
        FLOOR_PALETTE.base,
        arc,
      )
      applyArcColor(
        floorMaterial.uniforms.uLane.value as THREE.Color,
        FLOOR_PALETTE.lane,
        arc,
      )
      applyArcColor(
        floorMaterial.uniforms.uMortar.value as THREE.Color,
        FLOOR_PALETTE.mortar,
        arc,
      )
      const accent = floorMaterial.uniforms.uAccent.value as THREE.Color
      applyArcColor(accent, FLOOR_PALETTE.accent, arc)
      accent.lerp(FLOOR_PALETTE.arrivalAccent, arc.arrival * 0.42)
      applyArcColor(
        floorMaterial.uniforms.uFogColor.value as THREE.Color,
        FLOOR_PALETTE.fog,
        arc,
      )

      architectureMaterial.emissive
        .copy(FLOOR_PALETTE.fog[0])
        .lerp(FLOOR_PALETTE.accent[2], arc.eclipse * 0.24)
        .lerp(FLOOR_PALETTE.accent[3], arc.boss * 0.32)
        .lerp(FLOOR_PALETTE.accent[4], arc.phaseTwo * 0.38)
        .lerp(FLOOR_PALETTE.arrivalAccent, arc.arrival * 0.18)
      architectureMaterial.emissiveIntensity =
        0.24 +
        arc.eclipse * 0.08 +
        arc.boss * 0.1 +
        arc.phaseTwo * 0.08 +
        arc.arrival * 0.12
    },
    dispose(): void {
      floorGeometry.dispose()
      floorMaterial.dispose()
      architectureGeometry.dispose()
      architectureMaterial.dispose()
    },
  }
}
