# -*- coding: utf-8 -*-
"""외곽 회랑 — 석연, 실제 3단 계단, 네 경사로와 소맷돌.

네 방위의 60도 호는 전투 시야와 이동축이라 석연과 계단을 끊고 완만한 경사
웨지로 채운다. 남은 대각 방향 네 30도 호에만 0.42m 석연과 실제 세 단을 둔다.
회랑 바닥은 광장보다 방사 폭이 작은 판석으로 다시 나누고, 높은 이끼 마스크를
구워 통행량 차이가 셰이더에서 바로 읽히게 한다.
"""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=1700)

TAU = math.tau
RIM_INNER = 30.0
RIM_OUTER = 30.4
STAIR_OUTER = 31.6
TERRACE_OUTER = 33.2
TERRACE_HEIGHT = 0.42
FLOOR_GROOVE = 0.014


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

worn = mw.material(
    mw.MaterialSpec(
        name="mw/ground/worn-stone",
        base_color=(1.0, 1.0, 1.0, 1.0),
        roughness=0.86,
        base_color_map="env/tex/ground/worn-stone_basecolor.webp",
        normal_map="env/tex/ground/worn-stone_normal.webp",
        orm_map="env/tex/ground/worn-stone_orm.webp",
        uv_scale=0.5,
        shader="stone",
        arc_response=1.0,
    )
)


# ---------------------------------------------------------------------------
# 마스크와 공용 수치 함수
# ---------------------------------------------------------------------------


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    t = max(0.0, min(1.0, (value - edge0) / max(1.0e-9, edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


mask_rng = mw.rng("terrace-low-frequency")
MASK_PHASES = mask_rng.uniform(0.0, TAU, 3)
MASK_ANGLES = mask_rng.uniform(0.0, TAU, 3)
MASK_FREQS = mask_rng.uniform(0.10, 0.22, 3)


def low_noise(x: float, y: float) -> float:
    total = 0.0
    for phase, angle, frequency in zip(MASK_PHASES, MASK_ANGLES, MASK_FREQS):
        axis = x * math.cos(float(angle)) + y * math.sin(float(angle))
        total += math.sin(axis * float(frequency) * TAU + float(phase))
    return 0.5 + total / 6.0


def cardinal_delta(theta: float) -> float:
    """가장 가까운 네 방위 중심선과의 각도 차."""
    period = TAU / 4.0
    return abs((theta + period * 0.5) % period - period * 0.5)


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
        raise SystemExit("[17_terrace] z 범위를 계산할 정점이 없다")
    return min(values), max(values)


# ---------------------------------------------------------------------------
# 회랑 판석 레코드와 균열 근접도
# ---------------------------------------------------------------------------

# 광장의 1.1~1.9m 방사 폭보다 작은 0.8m 두 줄이다. 첫 시도의 2.55~3.0m
# 접선 길이는 총 36.5k가 되어, 방사 폭은 유지하고 3.0~3.4m로만 늘렸다.
# 면적은 여전히 광장 판석의 절반 수준이라 더 작고 촘촘하게 읽힌다.
floor_records: list[dict] = []
for ring_index, (radius_inner, radius_outer) in enumerate(((31.6, 32.4), (32.4, 33.2))):
    generator = mw.rng(f"floor-ring-{ring_index}")
    radius_mid = (radius_inner + radius_outer) * 0.5
    target_arc = float(generator.uniform(3.00, 3.40))
    count = int(round(TAU * radius_mid / target_arc))
    phase = float(generator.uniform(-0.45, 0.45)) * TAU / count
    for stone_index in range(count):
        angle0 = phase + TAU * stone_index / count
        angle1 = phase + TAU * (stone_index + 1) / count
        floor_records.append(
            {
                "ring": ring_index,
                "stone": stone_index,
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

break_rng = mw.rng("terrace-broken-selection")
broken_fraction = float(break_rng.uniform(0.095, 0.115))
broken_indices = break_rng.choice(
    len(floor_records),
    size=int(round(len(floor_records) * broken_fraction)),
    replace=False,
)
for index in sorted(int(value) for value in broken_indices):
    floor_records[index]["broken"] = True
broken_centers = np.asarray([record["center"] for record in floor_records if record["broken"]])
for record in floor_records:
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
    # 3.4m 이하 접선 길이와 0.8m 링 간격을 함께 덮어 같은 링 및 인접 링의
    # 직접 이웃 판 전체가 B=1이 되게 한다.
    record["crack_value"] = 1.0 if distance <= 3.65 else 1.0 - smoothstep(3.65, 5.4, distance)


def crack_mask(x: float, y: float) -> float:
    if len(broken_centers) == 0:
        return 0.0
    distance = float(np.sqrt(np.min(np.sum((broken_centers - np.array((x, y))) ** 2, axis=1))))
    if distance <= 3.10:
        return 1.0
    return 1.0 - smoothstep(3.10, 5.20, distance)


def terrace_mask(
    x: float,
    y: float,
    seam_distance: float,
    crack_floor: float = 0.0,
) -> tuple[float, float, float, float]:
    theta = math.atan2(y, x)
    delta = cardinal_delta(theta)
    route = 1.0 - smoothstep(math.radians(10.0), math.radians(30.0), delta)
    noise = low_noise(x, y)

    wear = 0.10 + 0.90 * route + (noise - 0.5) * 0.16 * (1.0 - route)
    if delta <= math.radians(10.0):
        wear = 1.0

    seam = 1.0 - smoothstep(0.025, 0.30, seam_distance)
    # 통행량이 낮은 회랑은 판 중앙도 0.48에서 시작한다. 이음매와 통행축 밖은
    # 0.8~1.0까지 올라가지만 네 경사로 중심은 같은 규칙대로 0이 된다.
    moss = 0.48 + seam * 0.38 + (noise - 0.5) * 0.18
    moss *= 1.0 - route
    if delta <= math.radians(10.0):
        moss = 0.0

    return (
        max(0.10, min(1.0, wear)),
        max(0.0, min(1.0, moss)),
        max(crack_floor, crack_mask(x, y)),
        1.0,
    )


# ---------------------------------------------------------------------------
# 석연과 세 단 계단
# ---------------------------------------------------------------------------

structure_verts: list[tuple[float, float, float]] = []
structure_faces: list[tuple[int, ...]] = []
structure_colors: list[tuple[float, float, float, float]] = []


def add_structure_vertex(radius: float, theta: float, z: float) -> int:
    x, y = math.cos(theta) * radius, math.sin(theta) * radius
    structure_verts.append((x, y, z))
    structure_colors.append(terrace_mask(x, y, 0.18))
    return len(structure_verts) - 1


def add_sector_block(
    radius_inner: float,
    radius_outer: float,
    theta0: float,
    theta1: float,
    z_top: float,
    arc_segments: int,
) -> None:
    """바닥까지 찬 닫힌 환형 섹터 블록."""
    base = len(structure_verts)
    for z in (0.0, z_top):
        for radius in (radius_inner, radius_outer):
            for index in range(arc_segments + 1):
                theta = theta0 + (theta1 - theta0) * index / arc_segments
                add_structure_vertex(radius, theta, z)

    stride = arc_segments + 1
    bottom_inner = base
    bottom_outer = base + stride
    top_inner = base + stride * 2
    top_outer = base + stride * 3
    for index in range(arc_segments):
        nxt = index + 1
        structure_faces.extend(
            [
                (top_inner + index, top_outer + index, top_outer + nxt, top_inner + nxt),
                (bottom_outer + index, bottom_inner + index, bottom_inner + nxt, bottom_outer + nxt),
                (bottom_outer + index, bottom_outer + nxt, top_outer + nxt, top_outer + index),
                (bottom_inner + index, top_inner + index, top_inner + nxt, bottom_inner + nxt),
            ]
        )
    structure_faces.extend(
        [
            (bottom_inner, bottom_outer, top_outer, top_inner),
            (
                bottom_inner + arc_segments,
                top_inner + arc_segments,
                top_outer + arc_segments,
                bottom_outer + arc_segments,
            ),
        ]
    )


# 경사로 네 개가 240도를 차지하고, 그 사이 대각 방향의 30도 호 네 곳에
# 석연과 세 단을 놓는다.
stair_arcs: list[tuple[float, float]] = []
for quadrant in range(4):
    theta0 = math.radians(30.0 + quadrant * 90.0)
    theta1 = math.radians(60.0 + quadrant * 90.0)
    stair_arcs.append((theta0, theta1))
    add_sector_block(RIM_INNER, RIM_OUTER, theta0, theta1, TERRACE_HEIGHT, 20)
    for step_index in range(3):
        radius0 = RIM_OUTER + step_index * 0.40
        radius1 = radius0 + 0.40
        add_sector_block(
            radius0,
            radius1,
            theta0,
            theta1,
            0.14 * (step_index + 1),
            20,
        )


# ---------------------------------------------------------------------------
# 네 방위 경사로
# ---------------------------------------------------------------------------


def add_ramp(theta0: float, theta1: float, angular_segments: int = 42, radial_segments: int = 4) -> None:
    """r=30에서 31.6까지 0→0.42m로 오르는 실제 곡면 웨지."""
    grid: list[list[int]] = []
    for radial_index in range(radial_segments + 1):
        t = radial_index / radial_segments
        radius = RIM_INNER + (STAIR_OUTER - RIM_INNER) * t
        height = TERRACE_HEIGHT * t
        grid.append(
            [
                add_structure_vertex(
                    radius,
                    theta0 + (theta1 - theta0) * angle_index / angular_segments,
                    height,
                )
                for angle_index in range(angular_segments + 1)
            ]
        )

    for radial_index in range(radial_segments):
        for angle_index in range(angular_segments):
            structure_faces.append(
                (
                    grid[radial_index][angle_index],
                    grid[radial_index + 1][angle_index],
                    grid[radial_index + 1][angle_index + 1],
                    grid[radial_index][angle_index + 1],
                )
            )

    # 양 옆면과 바깥 수직면. 아래쪽은 지면에 붙어 열려 있어도 보이지 않지만,
    # 카메라 차폐 때 옆에서 빈 종이처럼 보이지 않도록 세 면은 막는다.
    for side_index in (0, angular_segments):
        for radial_index in range(radial_segments):
            a = grid[radial_index][side_index]
            b = grid[radial_index + 1][side_index]
            pa = structure_verts[a]
            pb = structure_verts[b]
            bottom_a = len(structure_verts)
            structure_verts.append((pa[0], pa[1], 0.0))
            structure_colors.append(terrace_mask(pa[0], pa[1], 0.18))
            bottom_b = len(structure_verts)
            structure_verts.append((pb[0], pb[1], 0.0))
            structure_colors.append(terrace_mask(pb[0], pb[1], 0.18))
            if side_index == 0:
                structure_faces.append((bottom_a, bottom_b, b, a))
            else:
                structure_faces.append((bottom_a, a, b, bottom_b))

    outer = grid[-1]
    for angle_index in range(angular_segments):
        a, b = outer[angle_index], outer[angle_index + 1]
        pa, pb = structure_verts[a], structure_verts[b]
        bottom_a = len(structure_verts)
        structure_verts.append((pa[0], pa[1], 0.0))
        structure_colors.append(terrace_mask(pa[0], pa[1], 0.18))
        bottom_b = len(structure_verts)
        structure_verts.append((pb[0], pb[1], 0.0))
        structure_colors.append(terrace_mask(pb[0], pb[1], 0.18))
        structure_faces.append((bottom_a, a, b, bottom_b))


for direction_index in range(4):
    center = TAU * direction_index / 4.0
    add_ramp(center - math.radians(30.0), center + math.radians(30.0))

structure = mw.new_mesh("outer-terrace-structure", structure_verts, structure_faces)
set_corner_colors(structure, structure_colors)
mw.bevel(structure, 0.012, 2)


# ---------------------------------------------------------------------------
# 경사로 양쪽 소맷돌
# ---------------------------------------------------------------------------

rail_verts: list[tuple[float, float, float]] = []
rail_faces: list[tuple[int, ...]] = []
rail_colors: list[tuple[float, float, float, float]] = []


def add_sleeve_stone(theta: float) -> None:
    """경사를 따라 오르는 낮은 난간석.

    가운데가 0.34m로 약간 솟고 양 끝은 낮아지는 전통 소맷돌 실루엣이다.
    """
    radial = np.array((math.cos(theta), math.sin(theta)))
    tangent = np.array((-radial[1], radial[0]))
    stations = 7
    rings: list[list[int]] = []
    for station in range(stations):
        t = station / (stations - 1)
        radius = 30.12 + (31.55 - 30.12) * t
        floor_z = TERRACE_HEIGHT * ((radius - RIM_INNER) / (STAIR_OUTER - RIM_INNER))
        cap_height = 0.22 + 0.12 * math.sin(math.pi * t)
        center = radial * radius
        ring: list[int] = []
        for side, z in ((-0.10, floor_z), (0.10, floor_z), (0.09, floor_z + cap_height), (-0.09, floor_z + cap_height)):
            point = center + tangent * side
            rail_verts.append((float(point[0]), float(point[1]), z))
            rail_colors.append(terrace_mask(float(point[0]), float(point[1]), 0.12))
            ring.append(len(rail_verts) - 1)
        rings.append(ring)

    for station in range(stations - 1):
        current, nxt = rings[station], rings[station + 1]
        for side in range(4):
            other = (side + 1) % 4
            rail_faces.append((current[side], current[other], nxt[other], nxt[side]))
    rail_faces.append(tuple(reversed(rings[0])))
    rail_faces.append(tuple(rings[-1]))


for direction_index in range(4):
    center = TAU * direction_index / 4.0
    add_sleeve_stone(center - math.radians(30.0))
    add_sleeve_stone(center + math.radians(30.0))

rails = mw.new_mesh("outer-terrace-sleeve-stones", rail_verts, rail_faces)
set_corner_colors(rails, rail_colors)
mw.bevel(rails, 0.014, 2)


# ---------------------------------------------------------------------------
# 작은 회랑 판석
# ---------------------------------------------------------------------------

floor_verts: list[tuple[float, float, float]] = []
floor_faces: list[tuple[int, ...]] = []
floor_colors: list[tuple[float, float, float, float]] = []


def clamp_floor_radius(point: np.ndarray) -> np.ndarray:
    radius = float(np.linalg.norm(point))
    target = max(STAIR_OUTER, min(TERRACE_OUTER, radius))
    if abs(target - radius) < 1.0e-12:
        return point
    return point * (target / max(radius, 1.0e-12))


def append_floor_piece(
    polygon: list[np.ndarray],
    inset: float,
    z_offset: float,
    lowered_corner: int,
    crack_value: float,
) -> None:
    polygon = [clamp_floor_radius(point) for point in polygon]
    inner = inset_convex(polygon, inset)
    count = len(polygon)
    center = sum(inner, np.array((0.0, 0.0))) / count
    drops = [0.0] * count
    drops[lowered_corner % count] = 0.006
    center_drop = sum(drops) / count

    base = len(floor_verts)
    for points, height, groove in (
        (polygon, TERRACE_HEIGHT + z_offset - FLOOR_GROOVE, True),
        (inner, TERRACE_HEIGHT + z_offset - FLOOR_GROOVE, True),
        (inner, TERRACE_HEIGHT + z_offset, False),
    ):
        for index, point in enumerate(points):
            floor_verts.append((float(point[0]), float(point[1]), height - drops[index]))
            distance = 0.0 if groove else edge_distance(point, polygon)
            floor_colors.append(
                terrace_mask(float(point[0]), float(point[1]), distance, crack_value)
            )
    floor_verts.append(
        (
            float(center[0]),
            float(center[1]),
            TERRACE_HEIGHT + z_offset - center_drop,
        )
    )
    floor_colors.append(
        terrace_mask(
            float(center[0]),
            float(center[1]),
            edge_distance(center, polygon),
            crack_value,
        )
    )

    outer = base
    inner_bottom = base + count
    inner_top = base + count * 2
    center_index = base + count * 3
    for index in range(count):
        nxt = (index + 1) % count
        floor_faces.append((outer + index, outer + nxt, inner_bottom + nxt, inner_bottom + index))
        floor_faces.append(
            (inner_bottom + index, inner_bottom + nxt, inner_top + nxt, inner_top + index)
        )
        floor_faces.append((inner_top + index, inner_top + nxt, center_index))


def floor_piece_polygons(record: dict) -> list[list[np.ndarray]]:
    r0, r1 = float(record["r0"]), float(record["r1"])
    a0, a1 = float(record["a0"]), float(record["a1"])
    generator = mw.rng(f"floor-stone-{record['ring']}-{record['stone']}")
    rotation = math.radians(float(generator.uniform(-0.6, 0.6)))
    center = np.asarray(record["center"], dtype=float)

    if record["broken"]:
        piece_count = int(generator.integers(2, 4))
        if piece_count == 2:
            cuts = [0.0, float(generator.uniform(0.40, 0.60)), 1.0]
        else:
            cuts = [
                0.0,
                float(generator.uniform(0.27, 0.36)),
                float(generator.uniform(0.64, 0.74)),
                1.0,
            ]
        boundaries = [
            (float(generator.uniform(0.025, 0.05)), float(generator.uniform(-0.02, 0.02)))
            for _ in range(piece_count - 1)
        ]
    else:
        piece_count = 1
        cuts = [0.0, 1.0]
        boundaries = []

    polygons: list[list[np.ndarray]] = []
    for piece_index in range(piece_count):
        inner_start = a0 + (a1 - a0) * cuts[piece_index]
        outer_start = inner_start
        inner_end = a0 + (a1 - a0) * cuts[piece_index + 1]
        outer_end = inner_end
        if piece_index > 0:
            gap, jag = boundaries[piece_index - 1]
            inner_start += (gap * 0.5 + jag) / r0
            outer_start += (gap * 0.5 - jag) / r1
        if piece_index < piece_count - 1:
            gap, jag = boundaries[piece_index]
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


floor_piece_count = 0
for record in floor_records:
    for piece_index, polygon in enumerate(floor_piece_polygons(record)):
        generator = mw.rng(f"floor-piece-{record['ring']}-{record['stone']}-{piece_index}")
        append_floor_piece(
            polygon,
            inset=float(generator.uniform(0.030, 0.050)),
            z_offset=float(generator.uniform(-0.012, 0.012)),
            lowered_corner=int(generator.integers(0, len(polygon))),
            crack_value=float(record["crack_value"]),
        )
        floor_piece_count += 1

floor = mw.new_mesh("outer-terrace-floor", floor_verts, floor_faces)
set_corner_colors(floor, floor_colors)
mw.bevel(floor, 0.012, 2)


# ---------------------------------------------------------------------------
# 단일 메시, 폴리곤별 머티리얼과 검증
# ---------------------------------------------------------------------------

outer_terrace = mw.join("outer-terrace", [structure, rails, floor])


def material_index(center, normal) -> int:
    radius = math.hypot(float(center.x), float(center.y))
    # 회랑 판석은 r>=31.6에만 있다. 소맷돌 끝은 31.55에서 끝나므로 이 경계로
    # 화강암 구조와 worn-stone 바닥을 안정적으로 나눌 수 있다.
    return 1 if radius >= 31.605 else 0


mw.assign_by_index(outer_terrace, [granite, worn], material_index)
force_color_export(granite)
force_color_export(worn)
mw.shade_auto_smooth(outer_terrace, 38.0)
mw.uv_box(outer_terrace, 1.0)

z_min, z_max = mesh_z_bounds([outer_terrace])
print(
    f"[17_terrace] rim=4 sectors, stairs=4x3, ramps=4x60deg, "
    f"sleeve-stones=8, floor-stones={len(floor_records)}, "
    f"broken={len(broken_indices)}, pieces={floor_piece_count}"
)
print(f"[17_terrace] z-range: {z_min:+.6f} .. {z_max:+.6f} m")
if z_min < -0.001001 or z_max > 2.600001:
    raise SystemExit(
        f"[17_terrace] z 범위 위반: {z_min:+.6f} .. {z_max:+.6f}, "
        "허용 [-0.001, +2.6]"
    )

mw.export_glb(
    "outer-terrace",
    [outer_terrace],
    max_triangles=34_000,
    notes="0.42m 석연, 실제 3단, 4개 60도 경사로, 소맷돌, 작은 회랑 판석",
    extras={
        "zMin": round(z_min, 6),
        "zMax": round(z_max, 6),
        "brokenFraction": round(len(broken_indices) / len(floor_records), 6),
        "vertexColor": "Col: R route wear, G high terrace moss, B crack proximity",
    },
)
mw.finish()
print("[17_terrace] outer-terrace OK")
