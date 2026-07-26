import * as THREE from 'three'

/**
 * 원형 아레나.
 *
 * 텍스처 파일을 쓰지 않는다. 극좌표 그리드를 프래그먼트 셰이더로 그려서
 * 용량 0, 해상도 무한으로 처리한다. (계획: 환경 에셋 0개)
 */

const vertexShader = /* glsl */ `
  varying vec3 vWorld;

  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uRadius;
  uniform vec3  uBase;
  uniform vec3  uLine;
  uniform vec3  uEdge;

  varying vec3 vWorld;

  // phase가 정수인 지점에 화면 기준 1px 두께의 선을 그린다.
  // fwidth로 나누어 거리와 무관하게 두께가 일정해진다(모아레 방지).
  float gridLine(float phase, float widthPx) {
    float w = fwidth(phase) * widthPx;
    float f = abs(fract(phase - 0.5) - 0.5);
    return 1.0 - smoothstep(0.0, max(w, 1e-6), f);
  }

  void main() {
    float r = length(vWorld.xz);
    float t = clamp(r / uRadius, 0.0, 1.0);

    // 5단위 간격 동심원
    float rings = gridLine(r / 5.0, 1.2);

    // 24개 방사형 스포크. 중심 근처에서는 밀도가 폭발하므로 페이드아웃한다.
    float ang = atan(vWorld.z, vWorld.x);
    float spokes = gridLine(ang * (24.0 / 6.28318530718), 1.2)
                 * smoothstep(0.04, 0.30, t);

    float lines = max(rings * 0.55, spokes * 0.32);

    vec3 col = mix(uBase, uLine, lines);

    // 바깥으로 갈수록 어둡게 — 중앙으로 시선을 모은다.
    col *= mix(1.0, 0.42, smoothstep(0.5, 1.0, t));

    // 경계 근처 발광
    col += uEdge * smoothstep(0.92, 1.0, t) * 0.85;

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`

export function createArena(radius: number): THREE.Group {
  const group = new THREE.Group()

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 160),
    new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uRadius: { value: radius },
        uBase: { value: new THREE.Color(0x0d1424) },
        uLine: { value: new THREE.Color(0x2a4a6b) },
        uEdge: { value: new THREE.Color(0x1d6f9e) },
      },
    }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  group.add(floor)

  // 경계 링 — 셰이더 발광 위에 또렷한 윤곽을 하나 더 얹는다.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(radius - 0.22, radius + 0.12, 160),
    new THREE.MeshBasicMaterial({
      color: 0x4dd0ff,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = 0.02
  group.add(ring)

  return group
}
