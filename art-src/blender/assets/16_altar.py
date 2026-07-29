# -*- coding: utf-8 -*-
"""명월단 월대 — 두 단의 얕은 보행 제단.

시뮬레이션은 z=0 평면을 걷기 때문에 형태를 실루엣 높이로 과장할 수 없다.
상단은 4.5cm, 발광 상감도 4.9cm에서 끝낸다. 대신 단 모서리 베벨, 실제로
0.018m 파인 방사 배수홈, 단 옆면의 연화문 돌출로 낮은 높이 안에서 빛을
여러 번 꺾는다.
"""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Vector  # noqa: E402
from mathutils.geometry import tessellate_polygon  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=1600)

TAU = math.tau
SEGMENTS = 192
OUTER_RADIUS = 4.60
INNER_RADIUS = 3.10
LOWER_HEIGHT = 0.030
UPPER_HEIGHT = 0.045
GROOVE_DEPTH = 0.018


# ---------------------------------------------------------------------------
# 공유 머티리얼
# ---------------------------------------------------------------------------

granite = mw.material(
    mw.MaterialSpec(
        name="mw/ground/granite-slab",
        base_color=(1.0, 1.0, 1.0, 1.0),
        roughness=0.78,
        base_color_map="env/tex/ground/granite-slab_basecolor.webp",
        normal_map="env/tex/ground/granite-slab_normal.webp",
        orm_map="env/tex/ground/granite-slab_orm.webp",
        uv_scale=0.5,
        shader="stone",
        arc_response=1.0,
    )
)

inlay_mat = mw.material(
    mw.MaterialSpec(
        name="mw/ground/inlay",
        base_color=(0.35, 0.62, 0.70, 1.0),
        roughness=0.34,
        emission=(0.35, 0.62, 0.70),
        emission_strength=1.8,
        shader="emissive",
        arc_response=0.35,
    )
)


# ---------------------------------------------------------------------------
# 마스크와 메시 유틸리티
# ---------------------------------------------------------------------------


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    t = max(0.0, min(1.0, (value - edge0) / max(1.0e-9, edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def groove_factor(theta: float, radius: float) -> float:
    """8개 방사선에서의 실제 수평 거리로 V형 홈 폭을 정한다."""
    period = TAU / 8.0
    nearest = abs((theta + period * 0.5) % period - period * 0.5)
    distance = abs(radius * math.sin(nearest))
    angular_profile = 1.0 - smoothstep(0.020, 0.095, distance)
    # 여덟 홈이 중심 한 점에서 겹쳐 14cm 깊은 구멍이 되지 않도록 55cm
    # 안쪽에서는 사라지게 한다.
    radial_gate = smoothstep(0.52, 0.82, radius)
    return angular_profile * radial_gate


def altar_color(x: float, y: float) -> tuple[float, float, float, float]:
    radius = math.hypot(x, y)
    theta = math.atan2(y, x)
    wear = 0.18 + 0.82 * (1.0 - smoothstep(0.45, OUTER_RADIUS, radius))
    moss = groove_factor(theta, radius) ** 1.4
    return (max(0.0, min(1.0, wear)), max(0.0, min(1.0, moss)), 0.0, 1.0)


def set_corner_colors(obj: bpy.types.Object, per_vertex: list[tuple[float, float, float, float]]) -> None:
    mesh = obj.data
    colors = mesh.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="CORNER")
    for loop in mesh.loops:
        colors.data[loop.index].color = per_vertex[loop.vertex_index]
    try:
        mesh.color_attributes.active_color = colors
        mesh.color_attributes.active = colors
    except Exception:
        pass


def force_color_export(mat: bpy.types.Material) -> None:
    """Blender 5.2의 미사용 컬러 제거를 막아 COLOR_0을 보존한다."""
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    color_node = nodes.get("mw-Col-export") or nodes.new("ShaderNodeVertexColor")
    color_node.name = "mw-Col-export"
    color_node.layer_name = "Col"
    links.new(color_node.outputs["Color"], bsdf.inputs["Base Color"])


def mesh_z_bounds(objects: list[bpy.types.Object]) -> tuple[float, float]:
    values = [
        float((obj.matrix_world @ vertex.co).z)
        for obj in objects
        for vertex in obj.data.vertices
    ]
    if not values:
        raise SystemExit("[16_altar] z 범위를 계산할 정점이 없다")
    return min(values), max(values)


# ---------------------------------------------------------------------------
# 두 단과 8줄 배수홈
# ---------------------------------------------------------------------------

altar_verts: list[tuple[float, float, float]] = []
altar_faces: list[tuple[int, ...]] = []
altar_colors: list[tuple[float, float, float, float]] = []


def add_vertex(radius: float, theta: float, base_height: float, *, groove: bool) -> int:
    x, y = math.cos(theta) * radius, math.sin(theta) * radius
    height = base_height - (GROOVE_DEPTH * groove_factor(theta, radius) if groove else 0.0)
    altar_verts.append((x, y, height))
    altar_colors.append(altar_color(x, y))
    return len(altar_verts) - 1


def add_ring(radius: float, base_height: float, *, groove: bool) -> list[int]:
    return [
        add_vertex(radius, TAU * index / SEGMENTS, base_height, groove=groove)
        for index in range(SEGMENTS)
    ]


def connect_rings(inner: list[int], outer: list[int]) -> None:
    for index in range(SEGMENTS):
        nxt = (index + 1) % SEGMENTS
        altar_faces.append((inner[index], outer[index], outer[nxt], inner[nxt]))


# 2단 상면. 중심 정점과 네 개 반경 링으로 배수홈의 폭이 반경에 따라
# 자연스럽게 좁아지게 한다.
center_top = add_vertex(0.0, 0.0, UPPER_HEIGHT, groove=False)
upper_rings = [
    add_ring(radius, UPPER_HEIGHT, groove=True)
    for radius in (0.55, 1.25, 2.15, INNER_RADIUS)
]
for index in range(SEGMENTS):
    nxt = (index + 1) % SEGMENTS
    altar_faces.append((center_top, upper_rings[0][index], upper_rings[0][nxt]))
for inner, outer in zip(upper_rings[:-1], upper_rings[1:]):
    connect_rings(inner, outer)

# 1단 상면. r=3.1의 정점을 일부러 복제해 1.5cm 수직 단차를 실제 면으로 만든다.
lower_rings = [
    add_ring(radius, LOWER_HEIGHT, groove=True)
    for radius in (INNER_RADIUS, 3.82, OUTER_RADIUS)
]
for inner, outer in zip(lower_rings[:-1], lower_rings[1:]):
    connect_rings(inner, outer)

# 2단 옆면. 홈 중심에서는 위아래 링이 똑같이 1.8cm 낮아져 얇은 배수 슬롯이
# 단을 가로질러 이어진다.
for index in range(SEGMENTS):
    nxt = (index + 1) % SEGMENTS
    altar_faces.append(
        (
            lower_rings[0][index],
            lower_rings[0][nxt],
            upper_rings[-1][nxt],
            upper_rings[-1][index],
        )
    )

# 외곽 옆면과 바닥을 막아 차폐 페이드로 잘려도 속 빈 원판으로 보이지 않는다.
outer_bottom = add_ring(OUTER_RADIUS, 0.0, groove=False)
for index in range(SEGMENTS):
    nxt = (index + 1) % SEGMENTS
    altar_faces.append(
        (
            outer_bottom[index],
            outer_bottom[nxt],
            lower_rings[-1][nxt],
            lower_rings[-1][index],
        )
    )
bottom_center = add_vertex(0.0, 0.0, 0.0, groove=False)
for index in range(SEGMENTS):
    nxt = (index + 1) % SEGMENTS
    altar_faces.append((bottom_center, outer_bottom[nxt], outer_bottom[index]))

altar_base = mw.new_mesh("moon-altar-base", altar_verts, altar_faces)
set_corner_colors(altar_base, altar_colors)
mw.assign(altar_base, granite)
mw.bevel(altar_base, 0.008, 2)


# ---------------------------------------------------------------------------
# 단 옆면 연화문 저부조
# ---------------------------------------------------------------------------

relief_verts: list[tuple[float, float, float]] = []
relief_faces: list[tuple[int, ...]] = []
relief_colors: list[tuple[float, float, float, float]] = []


def add_lotus_band(
    radius: float,
    z0: float,
    z1: float,
    count: int,
    protrusion: float,
    phase: float,
) -> None:
    """아치형 꽃잎 패치를 원주에 반복한다.

    경계는 단 옆면에서 1mm만 떠 있고 중심 맥은 더 돌출된다. 최대 돌출은
    0.011m라 계약의 0.012m를 넘지 않는다.
    """
    cell = TAU / count
    half = cell * 0.43
    height = z1 - z0
    for petal_index in range(count):
        angle = phase + cell * petal_index
        boundary = [
            (angle - half, z0 + height * 0.12, 0.0010),
            (angle - half * 0.72, z0 + height * 0.60, protrusion * 0.52),
            (angle, z1 - height * 0.08, protrusion * 0.82),
            (angle + half * 0.72, z0 + height * 0.60, protrusion * 0.52),
            (angle + half, z0 + height * 0.12, 0.0010),
            (angle, z0 + height * 0.05, protrusion * 0.22),
        ]
        base = len(relief_verts)
        for theta, z, offset in boundary:
            rr = radius + offset
            x, y = math.cos(theta) * rr, math.sin(theta) * rr
            relief_verts.append((x, y, z))
            relief_colors.append(altar_color(x, y))

        center_radius = radius + protrusion
        center_z = z0 + height * 0.49
        center_index = len(relief_verts)
        cx, cy = math.cos(angle) * center_radius, math.sin(angle) * center_radius
        relief_verts.append((cx, cy, center_z))
        relief_colors.append(altar_color(cx, cy))
        for boundary_index in range(len(boundary)):
            nxt = (boundary_index + 1) % len(boundary)
            relief_faces.append((base + boundary_index, base + nxt, center_index))


lotus_rng = mw.rng("lotus-phases")
add_lotus_band(
    OUTER_RADIUS,
    0.0,
    LOWER_HEIGHT,
    64,
    0.011,
    float(lotus_rng.uniform(0.0, TAU / 64)),
)
add_lotus_band(
    INNER_RADIUS,
    LOWER_HEIGHT,
    UPPER_HEIGHT,
    40,
    0.008,
    float(lotus_rng.uniform(0.0, TAU / 40)),
)

lotus_relief = mw.new_mesh("moon-altar-lotus-relief", relief_verts, relief_faces, smooth=True)
set_corner_colors(lotus_relief, relief_colors)
mw.assign(lotus_relief, granite)

# 베벨된 단과 열린 저부조 패치를 합쳐 화강암 드로우콜을 하나로 유지한다.
moon_altar = mw.join("moon-altar", [altar_base, lotus_relief])
mw.assign(moon_altar, granite)
force_color_export(granite)
mw.shade_auto_smooth(moon_altar, 38.0)
mw.uv_box(moon_altar, 1.0)


# ---------------------------------------------------------------------------
# 중앙 초승 상감
# ---------------------------------------------------------------------------


def polygon_area(points: list[np.ndarray]) -> float:
    return 0.5 * sum(
        points[index][0] * points[(index + 1) % len(points)][1]
        - points[(index + 1) % len(points)][0] * points[index][1]
        for index in range(len(points))
    )


def triangulate_polygon(points: list[np.ndarray]) -> list[tuple[int, int, int]]:
    if polygon_area(points) < 0.0:
        points.reverse()
    vectors = [Vector((float(point[0]), float(point[1]), 0.0)) for point in points]
    lookup = {
        (round(float(vector.x), 12), round(float(vector.y), 12)): index
        for index, vector in enumerate(vectors)
    }
    triangles: list[tuple[int, int, int]] = []
    for triangle in tessellate_polygon([vectors]):
        if isinstance(triangle[0], int):
            triangles.append(tuple(int(vertex) for vertex in triangle))
        else:
            triangles.append(
                tuple(
                    lookup[(round(float(vertex.x), 12), round(float(vertex.y), 12))]
                    for vertex in triangle
                )
            )
    if len(triangles) != len(points) - 2:
        raise SystemExit("[16_altar] 초승 상감 삼각분할 실패")
    return triangles


def crescent_points(
    outer_radius: float,
    inner_radius: float,
    offset: float,
    outer_segments: int,
    inner_segments: int,
) -> list[np.ndarray]:
    x = (
        outer_radius * outer_radius
        - inner_radius * inner_radius
        + offset * offset
    ) / (2.0 * offset)
    outer_angle = math.acos(x / outer_radius)
    inner_angle = math.acos((x - offset) / inner_radius)
    points = [
        np.array((math.cos(float(angle)) * outer_radius, math.sin(float(angle)) * outer_radius))
        for angle in np.linspace(outer_angle, TAU - outer_angle, outer_segments)
    ]
    points.extend(
        np.array(
            (
                offset + math.cos(float(angle)) * inner_radius,
                math.sin(float(angle)) * inner_radius,
            )
        )
        for angle in np.linspace(TAU - inner_angle, inner_angle, inner_segments)[1:-1]
    )
    return points


inlay_points = crescent_points(1.34, 1.16, 0.42, 49, 43)
inlay_triangles = triangulate_polygon(inlay_points)
inlay_verts: list[tuple[float, float, float]] = []
inlay_faces: list[tuple[int, ...]] = []
INLAY_BOTTOM = 0.037
INLAY_TOP = 0.049
inlay_verts.extend((float(point[0]), float(point[1]), INLAY_BOTTOM) for point in inlay_points)
inlay_verts.extend((float(point[0]), float(point[1]), INLAY_TOP) for point in inlay_points)
point_count = len(inlay_points)
for a, b, c in inlay_triangles:
    inlay_faces.append((point_count + a, point_count + b, point_count + c))
    inlay_faces.append((c, b, a))
for index in range(point_count):
    nxt = (index + 1) % point_count
    inlay_faces.append((index, nxt, point_count + nxt, point_count + index))

altar_inlay = mw.new_mesh("moon-altar-inlay", inlay_verts, inlay_faces)
mw.assign(altar_inlay, inlay_mat)
mw.bevel(altar_inlay, 0.002, 2)
mw.shade_auto_smooth(altar_inlay, 35.0)
mw.uv_box(altar_inlay, 1.0)


# ---------------------------------------------------------------------------
# 검증과 내보내기
# ---------------------------------------------------------------------------

z_min, z_max = mesh_z_bounds([moon_altar, altar_inlay])
print(
    f"[16_altar] tiers=0.030/0.045m, lotus=64+40 petals, "
    f"drains=8 x {GROOVE_DEPTH:.3f}m"
)
print(f"[16_altar] z-range: {z_min:+.6f} .. {z_max:+.6f} m")
if z_min < -0.000001 or z_max > 0.050001:
    raise SystemExit(
        f"[16_altar] z 범위 위반: {z_min:+.6f} .. {z_max:+.6f}, "
        "허용 [0.00, +0.05]"
    )

mw.export_glb(
    "moon-altar",
    [moon_altar, altar_inlay],
    max_triangles=16_000,
    notes="4.5cm 보행 월대, 연화문 저부조, 실제 8방 배수홈, 발광 초승 상감",
    extras={
        "zMin": round(z_min, 6),
        "zMax": round(z_max, 6),
        "grooveDepth": GROOVE_DEPTH,
        "vertexColor": "Col: R center wear, G drain moss",
    },
)
mw.finish()
print("[16_altar] moon-altar + moon-altar-inlay OK")
