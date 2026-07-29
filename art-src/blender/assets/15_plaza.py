# -*- coding: utf-8 -*-
"""명월단 판석 광장.

판석 경계는 노멀맵에 그리지 않는다. 낮춘 홈 바닥, 수직 홈 벽, 인셋 상면을
각각 실제 면으로 만들고 마지막에 1.2cm 베벨을 건다. 52도 부감에서는 이 얕은
단차가 판석마다 다른 스페큘러 선과 AO를 만드는 가장 값싼 방법이다.

정점 컬러 ``Col``은 장식이 아니라 지면 셰이더의 입력 데이터다.

- R: 중앙 월대와 네 진입축의 마모
- G: 이음매와 외곽의 습기
- B: 파손 판석과 이웃의 균열 근접도

상면에 중앙 정점을 하나 더 두는 이유도 G 때문이다. 모서리 정점뿐이면 판석
전체가 이끼 마스크로 채워져, 30m 광장이 다시 텍스처 한 장처럼 보인다.
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

mw.reset(seed=1500)

TAU = math.tau
MAX_RADIUS = 30.0
GROOVE_DEPTH = 0.012


# ---------------------------------------------------------------------------
# 공유 머티리얼
# ---------------------------------------------------------------------------

# 10_tex_ground.py가 만든 이름과 맵을 그대로 넘긴다. 이름이 같아야 매니페스트와
# three.js의 머티리얼 병합이 유지된다.
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
# 수치 유틸리티
# ---------------------------------------------------------------------------


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    t = max(0.0, min(1.0, (value - edge0) / max(1.0e-9, edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


noise_rng = mw.rng("vertex-mask-low-frequency")
NOISE_PHASES = noise_rng.uniform(0.0, TAU, 4)
NOISE_ANGLES = noise_rng.uniform(0.0, TAU, 4)
NOISE_FREQS = noise_rng.uniform(0.075, 0.19, 4)


def low_noise(x: float, y: float) -> float:
    """몇 미터 단위로만 변하는 결정적 노이즈.

    픽셀 노이즈가 아니라 마스크 경계를 찌그러뜨리는 용도다. 서로 다른 방향의
    사인 네 개를 섞어 원형 등고선이 생기지 않게 했다.
    """
    total = 0.0
    for phase, angle, freq in zip(NOISE_PHASES, NOISE_ANGLES, NOISE_FREQS):
        axis = x * math.cos(float(angle)) + y * math.sin(float(angle))
        total += math.sin(axis * float(freq) * TAU + float(phase))
    return 0.5 + total * 0.125


def point_segment_distance(point: np.ndarray, a: np.ndarray, b: np.ndarray) -> float:
    ab = b - a
    denom = float(np.dot(ab, ab))
    if denom < 1.0e-12:
        return float(np.linalg.norm(point - a))
    t = max(0.0, min(1.0, float(np.dot(point - a, ab)) / denom))
    return float(np.linalg.norm(point - (a + ab * t)))


def edge_distance(point: np.ndarray, polygon: list[np.ndarray]) -> float:
    return min(
        point_segment_distance(point, polygon[index], polygon[(index + 1) % len(polygon)])
        for index in range(len(polygon))
    )


def rotate_about(point: np.ndarray, center: np.ndarray, angle: float) -> np.ndarray:
    c, s = math.cos(angle), math.sin(angle)
    delta = point - center
    return center + np.array((delta[0] * c - delta[1] * s, delta[0] * s + delta[1] * c))


def inset_convex(polygon: list[np.ndarray], distance: float) -> list[np.ndarray]:
    """반시계 볼록 다각형을 실제 거리만큼 인셋한다."""
    result: list[np.ndarray] = []
    count = len(polygon)
    for index, point in enumerate(polygon):
        prev = polygon[(index - 1) % count]
        nxt = polygon[(index + 1) % count]
        edge_prev = point - prev
        edge_next = nxt - point
        edge_prev /= max(1.0e-12, float(np.linalg.norm(edge_prev)))
        edge_next /= max(1.0e-12, float(np.linalg.norm(edge_next)))
        inward_prev = np.array((-edge_prev[1], edge_prev[0]))
        inward_next = np.array((-edge_next[1], edge_next[0]))
        bisector = inward_prev + inward_next
        denom = float(np.dot(bisector, inward_next))
        if abs(denom) < 1.0e-6:
            result.append(point + inward_next * distance)
        else:
            result.append(point + bisector * (distance / denom))
    return result


def set_corner_colors(obj: bpy.types.Object, per_vertex: list[tuple[float, float, float, float]]) -> None:
    """glTF COLOR_0으로 나갈 ``Col`` 코너 컬러를 만든다."""
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
    """Blender 5.2가 ``Col``을 COLOR_0으로 내보내도록 노드에서 참조한다.

    실제 게임 머티리얼은 매니페스트를 보고 교체되므로 이 연결은 Blender
    미리보기용이다. 노드에서 쓰지 않은 활성 컬러를 5.2 익스포터가 버리는
    동작을 막는 것이 목적이다.
    """
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    color_node = nodes.get("mw-Col-export") or nodes.new("ShaderNodeVertexColor")
    color_node.name = "mw-Col-export"
    color_node.layer_name = "Col"
    links.new(color_node.outputs["Color"], bsdf.inputs["Base Color"])


def mesh_z_bounds(objects: list[bpy.types.Object], radial_limit: float | None = None) -> tuple[float, float]:
    values: list[float] = []
    for obj in objects:
        matrix = obj.matrix_world
        for vertex in obj.data.vertices:
            world = matrix @ vertex.co
            if radial_limit is None or math.hypot(world.x, world.y) <= radial_limit + 1.0e-6:
                values.append(float(world.z))
    if not values:
        raise SystemExit("[15_plaza] z 범위를 계산할 정점이 없다")
    return min(values), max(values)


# ---------------------------------------------------------------------------
# 링과 판석 레코드
# ---------------------------------------------------------------------------


def bounded_widths(count: int, total: float) -> list[float]:
    """합은 고정하면서 모든 링 두께를 1.1~1.9m 안에 둔다."""
    generator = mw.rng("ring-widths")
    widths = generator.uniform(1.1, 1.9, count)
    # 단순 정규화는 극값을 범위 밖으로 밀 수 있다. 남은 여유가 있는 링에만
    # 오차를 나누면 계약 범위와 정확한 외곽 반경을 동시에 만족한다.
    for _ in range(16):
        delta = total - float(widths.sum())
        if abs(delta) < 1.0e-10:
            break
        if delta > 0.0:
            available = np.where(widths < 1.9 - 1.0e-9)[0]
        else:
            available = np.where(widths > 1.1 + 1.0e-9)[0]
        if len(available) == 0:
            break
        share = delta / len(available)
        widths[available] = np.clip(widths[available] + share, 1.1, 1.9)
    return [float(value) for value in widths]


CORE_RADIUS = 1.40
ring_widths = bounded_widths(19, MAX_RADIUS - CORE_RADIUS)
ring_bounds: list[tuple[float, float]] = []
cursor = CORE_RADIUS
for width in ring_widths:
    ring_bounds.append((cursor, cursor + width))
    cursor += width
ring_bounds[-1] = (ring_bounds[-1][0], MAX_RADIUS)

# 한 판의 접선 길이는 3.0~3.75m다. 2m로 만든 첫 시도는 2세그먼트 베벨 뒤
# 14.4만 삼각형이 되어 예산을 넘었다. 방사 폭은 그대로라 쿼터뷰에서 판석
# 밀도는 유지되고, 긴 판은 파손 조각과 링 위상 차이가 다시 잘게 나눈다.
# 이어지므로 링마다 목표 길이와 시작 위상을 따로 뽑는다.
records: list[dict] = []
for ring_index, (radius_inner, radius_outer) in enumerate(ring_bounds):
    ring_rng = mw.rng(f"ring-{ring_index}")
    radius_mid = (radius_inner + radius_outer) * 0.5
    target_arc = float(ring_rng.uniform(3.00, 3.75))
    count = max(6, int(round(TAU * radius_mid / target_arc)))
    phase = float(ring_rng.uniform(-0.45, 0.45)) * TAU / count
    for stone_index in range(count):
        angle0 = phase + TAU * stone_index / count
        angle1 = phase + TAU * (stone_index + 1) / count
        records.append(
            {
                "ring": ring_index,
                "stone": stone_index,
                "count": count,
                "r0": radius_inner,
                "r1": radius_outer,
                "a0": angle0,
                "a1": angle1,
                "center": np.array(
                    (
                        math.cos((angle0 + angle1) * 0.5) * radius_mid,
                        math.sin((angle0 + angle1) * 0.5) * radius_mid,
                    )
                ),
                "broken": False,
            }
        )

# 중앙은 월대 아래에도 실제 지면이 남도록 12각 판석 한 장으로 막는다. 파손
# 선정을 여기서 제외해 초승 상감 아래에 불필요한 얇은 조각이 생기지 않게 한다.
core_record = {
    "ring": -1,
    "stone": 0,
    "count": 1,
    "r0": 0.0,
    "r1": CORE_RADIUS,
    "a0": 0.0,
    "a1": TAU,
    "center": np.array((0.0, 0.0)),
    "broken": False,
}

break_rng = mw.rng("broken-selection")
broken_fraction = float(break_rng.uniform(0.06, 0.09))
broken_indices = break_rng.choice(
    len(records), size=int(round(len(records) * broken_fraction)), replace=False
)
for index in sorted(int(value) for value in broken_indices):
    records[index]["broken"] = True

broken_centers = np.asarray([record["center"] for record in records if record["broken"]])
for record in records:
    distance = float(
        np.sqrt(
            np.min(
                np.sum(
                    (broken_centers - np.asarray(record["center"], dtype=float)) ** 2,
                    axis=1,
                )
            )
        )
    )
    # 가장 긴 판의 접선 길이가 3.75m다. 4.25m 안의 중심은 같은 링의 바로
    # 옆 판 또는 인접 링 판이므로, 그 판 전체를 B=1로 고정한다.
    record["crack_value"] = 1.0 if distance <= 4.25 else 1.0 - smoothstep(4.25, 6.0, distance)


def crack_mask(x: float, y: float) -> float:
    if len(broken_centers) == 0:
        return 0.0
    distance = float(np.sqrt(np.min(np.sum((broken_centers - np.array((x, y))) ** 2, axis=1))))
    if distance <= 2.55:
        return 1.0
    return 1.0 - smoothstep(2.55, 4.6, distance)


def vertex_mask(
    x: float,
    y: float,
    seam_distance: float,
    crack_floor: float = 0.0,
) -> tuple[float, float, float, float]:
    radius = math.hypot(x, y)
    axis_distance = min(abs(x), abs(y))
    noise = low_noise(x, y)

    center_wear = 1.0 - smoothstep(4.8, 18.5, radius)
    route_wear = 1.0 - smoothstep(1.35, 4.2, axis_distance)
    wear = 0.10 + 0.90 * max(center_wear, route_wear)
    wear += (noise - 0.5) * 0.18 * (1.0 - max(center_wear, route_wear))
    if radius <= 4.8 or axis_distance <= 1.35:
        wear = 1.0

    seam = 1.0 - smoothstep(0.035, 0.34, seam_distance)
    outer = smoothstep(23.0, 29.0, radius)
    route_clear = 1.0 - smoothstep(1.55, 3.8, axis_distance)
    moss = max(seam * 0.78, outer * 0.76)
    moss = max(0.0, min(1.0, moss + (noise - 0.5) * 0.18))
    moss *= 1.0 - route_clear
    if axis_distance <= 1.55:
        moss = 0.0

    return (
        max(0.10, min(1.0, wear)),
        max(0.0, min(1.0, moss)),
        max(crack_floor, crack_mask(x, y)),
        1.0,
    )


# ---------------------------------------------------------------------------
# 판석 메시
# ---------------------------------------------------------------------------

floor_verts: list[tuple[float, float, float]] = []
floor_faces: list[tuple[int, ...]] = []
floor_colors: list[tuple[float, float, float, float]] = []


def append_piece(
    polygon: list[np.ndarray],
    *,
    inset: float,
    z_offset: float,
    lowered_corner: int,
    crack_value: float,
) -> None:
    """판석 조각 하나를 홈 바닥·홈 벽·상면으로 추가한다."""
    inner = inset_convex(polygon, inset)
    count = len(polygon)
    center = sum(inner, np.array((0.0, 0.0))) / count

    # 한 모서리만 8mm 낮춘다. 중심 정점은 그 기울기를 평균해 상면이 접히는
    # 대신 매우 얕은 비틀림으로 읽히게 한다.
    corner_drop = [0.0] * count
    corner_drop[lowered_corner % count] = 0.008
    center_drop = sum(corner_drop) / count

    base = len(floor_verts)
    groups: list[tuple[list[np.ndarray], float, bool]] = [
        (polygon, z_offset - GROOVE_DEPTH, True),
        (inner, z_offset - GROOVE_DEPTH, True),
        (inner, z_offset, False),
    ]
    for group_index, (points, height, is_groove) in enumerate(groups):
        for point_index, point in enumerate(points):
            drop = corner_drop[point_index]
            radius = float(np.linalg.norm(point))
            if radius > MAX_RADIUS:
                point = point * (MAX_RADIUS / radius)
            floor_verts.append((float(point[0]), float(point[1]), height - drop))
            distance = 0.0 if is_groove else edge_distance(point, polygon)
            floor_colors.append(
                vertex_mask(float(point[0]), float(point[1]), distance, crack_value)
            )

    floor_verts.append((float(center[0]), float(center[1]), z_offset - center_drop))
    floor_colors.append(
        vertex_mask(
            float(center[0]),
            float(center[1]),
            edge_distance(center, polygon),
            crack_value,
        )
    )
    center_index = base + count * 3

    outer = base
    inner_bottom = base + count
    inner_top = base + count * 2
    for index in range(count):
        nxt = (index + 1) % count
        # 낮춘 인셋 링의 수평 바닥.
        floor_faces.append((outer + index, outer + nxt, inner_bottom + nxt, inner_bottom + index))
        # 수직 홈 벽. 이 90도 턱에 mw.bevel이 걸려 하이라이트가 흐른다.
        floor_faces.append(
            (inner_bottom + index, inner_bottom + nxt, inner_top + nxt, inner_top + index)
        )
        floor_faces.append((inner_top + index, inner_top + nxt, center_index))


def piece_polygons(record: dict) -> list[list[np.ndarray]]:
    """정상 판은 한 조각, 파손 판은 2~3개의 벌어진 조각으로 돌려준다."""
    r0, r1 = float(record["r0"]), float(record["r1"])
    a0, a1 = float(record["a0"]), float(record["a1"])
    stone_rng = mw.rng(f"stone-{record['ring']}-{record['stone']}")
    rotation = math.radians(float(stone_rng.uniform(-0.4, 0.4)))
    center = np.asarray(record["center"], dtype=float)

    if not record["broken"]:
        ranges = [(0.0, 1.0, None, None)]
    else:
        piece_count = int(stone_rng.integers(2, 4))
        if piece_count == 2:
            cuts = [0.0, float(stone_rng.uniform(0.40, 0.60)), 1.0]
        else:
            first = float(stone_rng.uniform(0.27, 0.37))
            second = float(stone_rng.uniform(0.63, 0.74))
            cuts = [0.0, first, second, 1.0]
        boundaries = []
        for _ in range(piece_count - 1):
            boundaries.append(
                (
                    float(stone_rng.uniform(0.02, 0.05)),
                    float(stone_rng.uniform(-0.025, 0.025)),
                )
            )
        ranges = []
        for piece_index in range(piece_count):
            left = boundaries[piece_index - 1] if piece_index > 0 else None
            right = boundaries[piece_index] if piece_index < piece_count - 1 else None
            ranges.append((cuts[piece_index], cuts[piece_index + 1], left, right))

    polygons: list[list[np.ndarray]] = []
    radius_mid = (r0 + r1) * 0.5
    for start_t, end_t, left_boundary, right_boundary in ranges:
        inner_start = a0 + (a1 - a0) * start_t
        outer_start = inner_start
        inner_end = a0 + (a1 - a0) * end_t
        outer_end = inner_end
        if left_boundary is not None:
            gap, jag = left_boundary
            inner_start += (gap * 0.5 + jag) / r0
            outer_start += (gap * 0.5 - jag) / r1
        if right_boundary is not None:
            gap, jag = right_boundary
            inner_end -= (gap * 0.5 - jag) / r0
            outer_end -= (gap * 0.5 + jag) / r1

        polygon = [
            np.array((math.cos(inner_start) * r0, math.sin(inner_start) * r0)),
            np.array((math.cos(outer_start) * r1, math.sin(outer_start) * r1)),
            np.array((math.cos(outer_end) * r1, math.sin(outer_end) * r1)),
            np.array((math.cos(inner_end) * r0, math.sin(inner_end) * r0)),
        ]
        polygons.append([rotate_about(point, center, rotation) for point in polygon])
    return polygons


# 중앙 다각형은 다른 링과 같은 3층 구조지만 파손하지 않는다.
core_rng = mw.rng("core-stone")
core_rotation = math.radians(float(core_rng.uniform(-0.4, 0.4)))
core_polygon = [
    np.array(
        (
            math.cos(core_rotation + TAU * index / 12) * CORE_RADIUS,
            math.sin(core_rotation + TAU * index / 12) * CORE_RADIUS,
        )
    )
    for index in range(12)
]
append_piece(
    core_polygon,
    inset=float(core_rng.uniform(0.035, 0.055)),
    z_offset=float(core_rng.uniform(-0.020, 0.015)),
    lowered_corner=int(core_rng.integers(0, 12)),
    crack_value=crack_mask(0.0, 0.0),
)

piece_total = 1
for record in records:
    stone_rng = mw.rng(f"surface-{record['ring']}-{record['stone']}")
    polygons = piece_polygons(record)
    for piece_index, polygon in enumerate(polygons):
        piece_rng = mw.rng(f"piece-{record['ring']}-{record['stone']}-{piece_index}")
        # 파손 조각도 독립적인 z와 낮춘 모서리를 가져 균열을 가로질러 빛이
        # 한 평면처럼 이어지지 않는다.
        append_piece(
            polygon,
            inset=float(stone_rng.uniform(0.035, 0.055)),
            z_offset=float(piece_rng.uniform(-0.020, 0.015)),
            lowered_corner=int(piece_rng.integers(0, len(polygon))),
            crack_value=float(record["crack_value"]),
        )
        piece_total += 1

# 판석 아래를 막는 기반층(基盤層).
#
# 판석은 각각 분리된 섬이라 이음매 홈과 파손 조각 사이가 **뚫려 있다.**
# 부감 카메라에서 그 틈으로 배경이 그대로 비쳐 바닥에 검은 쐐기가 생긴다
# (형광 배경으로 찍어 확인했다 — 그림자가 아니라 구멍이었다).
#
# 틈마다 벽을 세우는 대신 아래에 원판 하나를 깐다. 삼각형 128개면 끝나고,
# 원인이 이음매든 파손이든 링 경계든 전부 한 번에 막힌다.
SUBSTRATE_Z = -0.075
SUBSTRATE_SEGMENTS = 128
substrate_verts = [(0.0, 0.0, SUBSTRATE_Z)]
for i in range(SUBSTRATE_SEGMENTS):
    angle = math.tau * i / SUBSTRATE_SEGMENTS
    substrate_verts.append(
        (math.cos(angle) * (MAX_RADIUS + 0.4), math.sin(angle) * (MAX_RADIUS + 0.4), SUBSTRATE_Z)
    )
substrate_faces = [
    (0, 1 + i, 1 + (i + 1) % SUBSTRATE_SEGMENTS) for i in range(SUBSTRATE_SEGMENTS)
]
plaza_substrate = mw.new_mesh("plaza-substrate", substrate_verts, substrate_faces)
mw.assign(plaza_substrate, granite)
mw.uv_box(plaza_substrate, 1.0)
# 정점 컬러는 셰이더가 요구하므로 반드시 있어야 한다. 완전히 닳고 젖은
# 그늘로 채워 틈 사이로 보일 때 어두운 흙바닥처럼 읽히게 한다.
mw.set_vertex_colors(plaza_substrate, lambda world, normal: (1.0, 0.75, 0.4))

plaza_floor = mw.new_mesh("plaza-floor", floor_verts, floor_faces)
set_corner_colors(plaza_floor, floor_colors)
mw.assign(plaza_floor, granite)
force_color_export(granite)

# 홈 벽의 90도 턱과 상면 모서리에 1.2cm 곡면을 만든다. 판석을 한 메시의
# 분리된 섬으로 조립했으므로 모디파이어 한 번으로도 각 판에 똑같이 적용된다.
mw.bevel(plaza_floor, 0.012, 2)
mw.shade_auto_smooth(plaza_floor, 38.0)
mw.uv_box(plaza_floor, 1.0)


# ---------------------------------------------------------------------------
# 전투 가독성 상감
# ---------------------------------------------------------------------------

inlay_verts: list[tuple[float, float, float]] = []
inlay_faces: list[tuple[int, ...]] = []
INLAY_BOTTOM = -0.006
INLAY_TOP = 0.006


def polygon_area(points: list[np.ndarray]) -> float:
    return 0.5 * sum(
        points[i][0] * points[(i + 1) % len(points)][1]
        - points[(i + 1) % len(points)][0] * points[i][1]
        for i in range(len(points))
    )


def triangulate_polygon(points: list[np.ndarray]) -> list[tuple[int, int, int]]:
    """Blender의 고정 테셀레이터로 오목한 초승을 삼각분할한다."""
    if polygon_area(points) < 0.0:
        points.reverse()
    vectors = [Vector((float(point[0]), float(point[1]), 0.0)) for point in points]
    lookup = {
        (round(float(vector.x), 12), round(float(vector.y), 12)): index
        for index, vector in enumerate(vectors)
    }
    triangles = []
    for triangle in tessellate_polygon([vectors]):
        # Blender 5.2는 정점 인덱스를, 4.x는 Vector를 돌려준다.
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
        raise SystemExit("[15_plaza] 초승 상감 삼각분할 실패")
    return triangles


def add_polygon_plate(points: list[np.ndarray]) -> None:
    base = len(inlay_verts)
    triangles = triangulate_polygon(points)
    count = len(points)
    inlay_verts.extend((float(p[0]), float(p[1]), INLAY_BOTTOM) for p in points)
    inlay_verts.extend((float(p[0]), float(p[1]), INLAY_TOP) for p in points)
    for a, b, c in triangles:
        inlay_faces.append((base + count + a, base + count + b, base + count + c))
        inlay_faces.append((base + c, base + b, base + a))
    for index in range(count):
        nxt = (index + 1) % count
        inlay_faces.append((base + index, base + nxt, base + count + nxt, base + count + index))


def add_annulus(radius: float, width: float, segments: int) -> None:
    base = len(inlay_verts)
    inner = radius - width * 0.5
    outer = radius + width * 0.5
    for z in (INLAY_BOTTOM, INLAY_TOP):
        for ring_radius in (inner, outer):
            for index in range(segments):
                angle = TAU * index / segments
                inlay_verts.append((math.cos(angle) * ring_radius, math.sin(angle) * ring_radius, z))
    layer = segments * 2
    for index in range(segments):
        nxt = (index + 1) % segments
        bi, bo = base + index, base + segments + index
        ti, to = base + layer + index, base + layer + segments + index
        binxt, bonxt = base + nxt, base + segments + nxt
        tinxt, tonxt = base + layer + nxt, base + layer + segments + nxt
        inlay_faces.extend(
            [
                (ti, to, tonxt, tinxt),
                (bo, bi, binxt, bonxt),
                (bo, bonxt, tonxt, to),
                (bi, ti, tinxt, binxt),
            ]
        )


def add_strip(center0: np.ndarray, center1: np.ndarray, width: float) -> None:
    direction = center1 - center0
    direction /= float(np.linalg.norm(direction))
    side = np.array((-direction[1], direction[0])) * width * 0.5
    add_polygon_plate([center0 - side, center1 - side, center1 + side, center0 + side])


# 두 원의 차집합. 작은 원을 +X로 옮겨 오른쪽을 파내면 왼쪽을 향한 초승이
# 된다. 교점부터 실제 두 원호를 따라가므로 납작한 C자 장식이 아니다.
outer_radius = 2.20
inner_radius = 1.96
inner_offset = 0.65
intersection_x = (
    outer_radius * outer_radius
    - inner_radius * inner_radius
    + inner_offset * inner_offset
) / (2.0 * inner_offset)
outer_angle = math.acos(intersection_x / outer_radius)
inner_angle = math.acos((intersection_x - inner_offset) / inner_radius)

crescent: list[np.ndarray] = []
for angle in np.linspace(outer_angle, TAU - outer_angle, 65):
    crescent.append(np.array((math.cos(float(angle)) * outer_radius, math.sin(float(angle)) * outer_radius)))
# 교점은 바깥 원호의 끝점과 같으므로 작은 원호에서는 양 끝을 제외한다.
for angle in np.linspace(TAU - inner_angle, inner_angle, 57)[1:-1]:
    crescent.append(
        np.array(
            (
                inner_offset + math.cos(float(angle)) * inner_radius,
                math.sin(float(angle)) * inner_radius,
            )
        )
    )
add_polygon_plate(crescent)

# 5cm 선은 14m 높이 카메라에서도 한 픽셀 이상을 안정적으로 유지한다.
add_annulus(10.0, 0.050, 96)
add_annulus(20.0, 0.050, 160)

# 진입로 가장자리 선은 기준 링과 겹치는 부분을 20cm 비워 같은 높이의 면이
# 포개지지 않게 한다.
strip_intervals = ((4.8, 9.88), (10.12, 19.88), (20.12, 29.76))
for direction_index in range(4):
    angle = TAU * direction_index / 4
    radial = np.array((math.cos(angle), math.sin(angle)))
    tangent = np.array((-radial[1], radial[0]))
    for side_sign in (-1.0, 1.0):
        offset = tangent * (2.40 * side_sign)
        for start, end in strip_intervals:
            add_strip(radial * start + offset, radial * end + offset, 0.045)

plaza_inlay = mw.new_mesh("plaza-inlay", inlay_verts, inlay_faces)
mw.assign(plaza_inlay, inlay_mat)
mw.bevel(plaza_inlay, 0.002, 2)
mw.shade_auto_smooth(plaza_inlay, 35.0)
mw.uv_box(plaza_inlay, 1.0)


# ---------------------------------------------------------------------------
# 검증과 내보내기
# ---------------------------------------------------------------------------

z_min, z_max = mesh_z_bounds([plaza_floor, plaza_inlay], radial_limit=MAX_RADIUS)
print(
    f"[15_plaza] rings={len(ring_bounds) + 1}, stones={len(records) + 1}, "
    f"broken={len(broken_indices)} ({broken_fraction * 100.0:.2f}%), pieces={piece_total}"
)
print(f"[15_plaza] z-range r<=30: {z_min:+.6f} .. {z_max:+.6f} m")
if z_min < -0.050001 or z_max > 0.040001:
    raise SystemExit(
        f"[15_plaza] z 범위 위반: {z_min:+.6f} .. {z_max:+.6f}, "
        "허용 [-0.05, +0.04]"
    )

mw.export_glb(
    "plaza-floor",
    [plaza_floor, plaza_substrate, plaza_inlay],
    max_triangles=95_000,
    notes="동심 판석, 실제 이음매 홈/베벨, 파손 조각, RGB 지면 블렌드 마스크, 발광 상감",
    extras={
        "zMin": round(z_min, 6),
        "zMax": round(z_max, 6),
        "brokenFraction": round(len(broken_indices) / len(records), 6),
        "vertexColor": "Col: R wear, G moss/wetness, B crack proximity",
    },
)
mw.finish()
print("[15_plaza] plaza-floor + plaza-inlay OK")
