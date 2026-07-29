# -*- coding: utf-8 -*-
"""대나무 군락 — 굽은 마디 기둥 9대와 피침형 실제 잎."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=4100)

TAU = math.tau

culm_mat = mw.material(
    mw.MaterialSpec(
        name="mw/nature/culm",
        base_color=(0.22, 0.26, 0.14, 1.0),
        roughness=0.62,
        shader="default",
        arc_response=1.0,
    )
)

needle = mw.material(
    mw.MaterialSpec(
        name="mw/nature/needle",
        base_color=(0.09, 0.13, 0.07, 1.0),
        roughness=0.85,
        double_sided=True,
        shader="foliage",
        arc_response=1.0,
    )
)


def fill_boundaries(obj: bpy.types.Object) -> None:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    boundary = [edge for edge in bm.edges if edge.is_boundary]
    if boundary:
        bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def active_color(obj: bpy.types.Object) -> None:
    color = obj.data.color_attributes.get("Col")
    if color is not None:
        obj.data.color_attributes.active_color = color
        obj.data.color_attributes.active = color


def force_vertex_color_export(mat: bpy.types.Material) -> None:
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    color_node = nodes.get("mw-Col-export") or nodes.new("ShaderNodeVertexColor")
    color_node.name = "mw-Col-export"
    color_node.layer_name = "Col"
    links.new(color_node.outputs["Color"], bsdf.inputs["Base Color"])


def circle_section(sides: int, radius: float) -> list[tuple[float, float]]:
    return [
        (
            math.cos(TAU * index / sides) * radius,
            math.sin(TAU * index / sides) * radius,
        )
        for index in range(sides)
    ]


def piecewise_scale(values: tuple[float, ...]):
    knots = np.linspace(0.0, 1.0, len(values))
    return lambda t: float(np.interp(t, knots, values))


def triangle_count(obj: bpy.types.Object) -> int:
    return sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons)


def dimensions(obj: bpy.types.Object) -> tuple[float, float, float]:
    coords = [vertex.co for vertex in obj.data.vertices]
    return tuple(
        max(float(co[axis]) for co in coords) - min(float(co[axis]) for co in coords)
        for axis in range(3)
    )


def color_bounds(obj: bpy.types.Object, channel: int) -> tuple[float, float]:
    color = obj.data.color_attributes["Col"]
    values = [float(item.color[channel]) for item in color.data]
    return min(values), max(values)


def oriented_ring(
    name: str,
    center: np.ndarray,
    tangent: np.ndarray,
    radius: float,
    thickness: float,
    sides: int = 8,
) -> bpy.types.Object:
    """마디 둘레의 돌출 띠. 축 메시와 겹쳐 열린 양 끝은 보이지 않는다."""
    tangent = tangent / max(1.0e-9, float(np.linalg.norm(tangent)))
    helper = np.array((0.0, 0.0, 1.0))
    if abs(float(np.dot(tangent, helper))) > 0.90:
        helper = np.array((0.0, 1.0, 0.0))
    side = np.cross(tangent, helper)
    side /= max(1.0e-9, float(np.linalg.norm(side)))
    up = np.cross(side, tangent)
    up /= max(1.0e-9, float(np.linalg.norm(up)))

    verts: list[tuple[float, float, float]] = []
    for axial in (-thickness * 0.5, thickness * 0.5):
        for index in range(sides):
            angle = TAU * index / sides
            point = center + tangent * axial
            point += side * math.cos(angle) * radius
            point += up * math.sin(angle) * radius
            verts.append(tuple(float(value) for value in point))
    faces = []
    for index in range(sides):
        nxt = (index + 1) % sides
        faces.append((index, nxt, sides + nxt, sides + index))
    return mw.new_mesh(name, verts, faces, smooth=True)


def append_lanceolate_leaf(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    anchor: np.ndarray,
    direction: np.ndarray,
    side: np.ndarray,
    reach: float,
    width: float,
) -> None:
    """폭 방향 3정점의 V골을 가진 4구간 피침형 잎."""
    start = len(verts)
    direction = direction / max(1.0e-9, float(np.linalg.norm(direction)))
    side = side / max(1.0e-9, float(np.linalg.norm(side)))
    ridge = np.cross(side, direction)
    ridge /= max(1.0e-9, float(np.linalg.norm(ridge)))
    widths = (0.0010, width * 0.72, width, width * 0.56, 0.00045)
    for row, local_width in enumerate(widths):
        t = row / (len(widths) - 1)
        center = anchor + direction * (reach * t)
        center = center + ridge * (math.sin(t * math.pi) * reach * 0.055)
        center = center - np.array((0.0, 0.0, 1.0)) * (t * t * reach * 0.10)
        left = center - side * local_width * 0.5
        middle = center + ridge * local_width * 0.10
        right = center + side * local_width * 0.5
        verts.extend(tuple(float(value) for value in point) for point in (left, middle, right))
    for row in range(len(widths) - 1):
        a = start + row * 3
        b = a + 3
        faces.append((a, b, b + 1, a + 1))
        faces.append((a + 1, b + 1, b + 2, a + 2))


def leaf_bundle(
    name: str,
    anchor: np.ndarray,
    stem_tangent: np.ndarray,
    *,
    gen: np.random.Generator,
    base_weight: float,
) -> bpy.types.Object:
    """서로 다른 방위의 가는 피침형 잎 세 장."""
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    reach = float(gen.uniform(0.30, 0.42))
    stem_tangent = stem_tangent / max(1.0e-9, float(np.linalg.norm(stem_tangent)))
    for leaf_index in range(3):
        angle = TAU * leaf_index / 3.0 + float(gen.uniform(-0.20, 0.20))
        radial = np.array((math.cos(angle), math.sin(angle), 0.0))
        direction = radial * 0.86 + stem_tangent * float(gen.uniform(0.16, 0.31))
        direction /= max(1.0e-9, float(np.linalg.norm(direction)))
        side = np.cross(direction, stem_tangent)
        if float(np.linalg.norm(side)) < 1.0e-8:
            side = np.array((-radial[1], radial[0], 0.0))
        append_lanceolate_leaf(
            verts,
            faces,
            anchor,
            direction,
            side,
            reach,
            float(gen.uniform(0.026, 0.040)),
        )

    obj = mw.new_mesh(name, verts, faces, smooth=False)
    mw.assign(obj, needle)
    mw.bevel(obj, 0.0006, 2, angle_deg=50.0)
    mw.shade_auto_smooth(obj, 34.0)
    mw.uv_smart(obj, angle_deg=58.0, island_margin=0.002)
    max_distance = max(
        float(np.linalg.norm(np.asarray(vertex.co, dtype=np.float64) - anchor))
        for vertex in obj.data.vertices
    )
    mw.set_vertex_colors(
        obj,
        lambda world, _normal, origin=anchor.copy(), span=max_distance, base=base_weight: (
            base
            + (1.0 - base)
            * max(
                0.0,
                min(
                    1.0,
                    float(
                        np.linalg.norm(
                            np.array((world.x, world.y, world.z), dtype=np.float64)
                            - origin
                        )
                    )
                    / max(1.0e-9, span),
                ),
            )
            ** 0.70,
            0.0,
            0.0,
        ),
    )
    active_color(obj)
    return obj


# ---------------------------------------------------------------------------
# 9대 배치. 중앙 한 대와 두 겹의 불규칙 고리로 바닥 중심을 분명히 한다.
# ---------------------------------------------------------------------------

gen = mw.rng("culm-layout")
base_positions = [np.array((0.0, 0.0), dtype=np.float64)]
for index in range(8):
    angle = TAU * index / 8.0 + float(gen.uniform(-0.16, 0.16))
    radius = float(gen.uniform(0.15, 0.34))
    base_positions.append(np.array((math.cos(angle), math.sin(angle))) * radius)
mean_base = np.mean(np.stack(base_positions), axis=0)
base_positions = [position - mean_base for position in base_positions]

heights = [5.40, 3.20]
heights.extend(float(value) for value in gen.uniform(3.45, 5.18, 7))
diameters = [0.090, 0.050]
diameters.extend(float(value) for value in gen.uniform(0.056, 0.086, 7))

culm_parts: list[bpy.types.Object] = []
leaf_parts: list[bpy.types.Object] = []

for culm_index, (base_xy, height, diameter) in enumerate(
    zip(base_positions, heights, diameters)
):
    culm_gen = mw.rng(f"culm-{culm_index}")
    bend_angle = float(culm_gen.uniform(0.0, TAU))
    bend_dir = np.array((math.cos(bend_angle), math.sin(bend_angle)))
    cross_dir = np.array((-bend_dir[1], bend_dir[0]))
    lean = float(culm_gen.uniform(0.025, 0.075))
    crown_bend = float(culm_gen.uniform(0.28, 0.54))

    path: list[np.ndarray] = []
    for node_index in range(9):
        t = node_index / 8.0
        xy = base_xy + bend_dir * (lean * height * t)
        xy = xy + bend_dir * (crown_bend * max(0.0, (t - 0.52) / 0.48) ** 2)
        # 각 마디에서 좌우로 작게 꺾되 전역 난수 상태에 기대지 않는다.
        kink = float(culm_gen.uniform(-0.020, 0.020)) * math.sin(t * math.pi)
        xy = xy + cross_dir * kink
        path.append(np.array((xy[0], xy[1], height * t), dtype=np.float64))

    shaft = mw.sweep(
        f"bamboo-culm-{culm_index:02d}",
        circle_section(8, diameter * 0.5),
        [tuple(float(value) for value in point) for point in path],
        up=(0.0, 1.0, 0.0),
        smooth=True,
        scale_fn=piecewise_scale((1.00, 0.995, 0.985, 0.97, 0.95, 0.91, 0.87, 0.82, 0.76)),
    )
    fill_boundaries(shaft)
    mw.assign(shaft, culm_mat)
    # 팔각 측면의 45°는 스무딩으로 원통을 만들고, 90°인 절단 끝만 베벨한다.
    mw.bevel(shaft, 0.0030, 2, angle_deg=50.0)
    mw.shade_auto_smooth(shaft, 34.0)
    mw.uv_cylinder(shaft, u_scale=1.0, v_scale=0.75)
    mw.set_vertex_colors(
        shaft,
        lambda world, _normal, h=height: (
            max(0.0, min(1.0, world.z / h)) ** 0.72,
            0.0,
            0.0,
        ),
    )
    active_color(shaft)
    culm_parts.append(shaft)

    for node_index in range(1, 8):
        tangent = path[node_index + 1] - path[node_index - 1]
        local_radius = diameter * 0.5 * (1.0 - 0.24 * node_index / 8.0)
        ring = oriented_ring(
            f"bamboo-node-{culm_index:02d}-{node_index:02d}",
            path[node_index],
            tangent,
            local_radius * 1.15,
            max(0.014, diameter * 0.28),
        )
        mw.assign(ring, culm_mat)
        mw.bevel(ring, 0.0018, 2, angle_deg=50.0)
        mw.shade_auto_smooth(ring, 34.0)
        mw.uv_box(ring, 1.0)
        node_weight = (node_index / 8.0) ** 0.72
        mw.set_vertex_colors(
            ring,
            lambda _world, _normal, value=node_weight: (value, 0.0, 0.0),
        )
        active_color(ring)
        culm_parts.append(ring)

    for bundle_index, node_index in enumerate((6, 7)):
        tangent = path[min(8, node_index + 1)] - path[node_index - 1]
        base_weight = (node_index / 8.0) ** 0.72
        leaf_parts.append(
            leaf_bundle(
                f"bamboo-leaves-{culm_index:02d}-{bundle_index:02d}",
                path[node_index],
                tangent,
                gen=culm_gen,
                base_weight=base_weight,
            )
        )

culms = mw.join("bamboo-clump-culms", culm_parts)
mw.apply_transform(culms)
active_color(culms)
leaves = mw.join("bamboo-clump-leaves", leaf_parts)
mw.apply_transform(leaves)
active_color(leaves)
bamboo = mw.join("bamboo-clump", (culms, leaves))
mw.apply_transform(bamboo)

# 바닥 절단면 베벨이 만드는 부동소수점 미세 이동을 제거한다. 가장 높은 줄기는
# 요청 상한 5.4m를 그대로 유지하고 군락 원점은 지면 중심 z=0이 된다.
z_values = [float(vertex.co.z) for vertex in bamboo.data.vertices]
z_min, z_max = min(z_values), max(z_values)
z_scale = 5.4 / max(1.0e-9, z_max - z_min)
for vertex in bamboo.data.vertices:
    vertex.co.z = (vertex.co.z - z_min) * z_scale
bamboo.data.update()
active_color(bamboo)
bamboo["mwWind"] = "bamboo"
bamboo["mwWindTipWeight"] = 1.0
bamboo["mwWindAmplitude"] = 1.0

force_vertex_color_export(culm_mat)
force_vertex_color_export(needle)

size = dimensions(bamboo)
tris = triangle_count(bamboo)
wind_min, wind_max = color_bounds(bamboo, 0)
assert abs(min(float(vertex.co.z) for vertex in bamboo.data.vertices)) < 1.0e-5
assert size[2] <= 5.4001
assert bamboo.data.color_attributes.get("Col") is not None
assert wind_min <= 1.0e-5 and abs(wind_max - 1.0) < 1.0e-5
print(
    f"[41_bamboo] bamboo-clump: {tris:,} tris, "
    f"{size[0]:.3f} x {size[1]:.3f} x {size[2]:.3f} m, "
    f"9 culms ({min(heights):.2f}-{max(heights):.2f} m), "
    f"wind R={wind_min:.2f}-{wind_max:.2f}"
)

mw.export_glb(
    "bamboo-clump",
    [bamboo],
    max_triangles=4_000,
    notes=(
        "9 individually kinked culms with protruding node rings and geometric lanceolate "
        "leaves; FLOAT_COLOR Col.R reaches 1.0 at leaf/culm tips"
    ),
    extras={
        "culmCount": 9,
        "heightRange": [min(heights), max(heights)],
        "diameterRange": [min(diameters), max(diameters)],
        "windTipWeight": 1.0,
        "windClass": "bamboo",
    },
    embed_textures=True,
)
mw.finish()
print("[41_bamboo] bamboo-clump OK")
