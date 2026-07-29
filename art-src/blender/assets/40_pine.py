# -*- coding: utf-8 -*-
"""한국 적송 두 종 — 굽은 줄기, 층진 가지, 실제 침엽 다발."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=4000)

TAU = math.tau


# ---------------------------------------------------------------------------
# 공유 머티리얼
#
# 껍질은 11_tex_arch.py가 만든 PBR 세트를 그대로 재사용한다. 침엽은 화면에서
# 수백 번 겹치는 작은 형상이므로 새 텍스처보다 중성 저채도 상수색이 안정적이다.
# ---------------------------------------------------------------------------

bark = mw.material(
    mw.MaterialSpec(
        name="mw/nature/bark",
        base_color=(1.0, 1.0, 1.0, 1.0),
        roughness=0.88,
        base_color_map="env/tex/arch/bark_basecolor.webp",
        normal_map="env/tex/arch/bark_normal.webp",
        orm_map="env/tex/arch/bark_orm.webp",
        uv_scale=0.55,
        shader="stone",
        arc_response=0.95,
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


# ---------------------------------------------------------------------------
# 메시 공통 처리
# ---------------------------------------------------------------------------


def fill_boundaries(obj: bpy.types.Object) -> None:
    """sweep의 양 끝 경계만 막는다."""
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
    """Blender 5.2가 바람 마스크를 COLOR_0으로 보존하게 한다."""
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    color_node = nodes.get("mw-Col-export") or nodes.new("ShaderNodeVertexColor")
    color_node.name = "mw-Col-export"
    color_node.layer_name = "Col"
    links.new(color_node.outputs["Color"], bsdf.inputs["Base Color"])


def strip_images_for_color_export(mat: bpy.types.Material) -> None:
    """AUTO 내보내기에서도 PBR 이미지는 GLB에 중복 삽입하지 않는다.

    맵 경로는 이미 매니페스트에 기록됐다. 이미지 노드를 지운 뒤 AUTO를 쓰면
    실제 FLOAT_COLOR는 COLOR_0으로 나가고 GLB에는 수 MB짜리 텍스처가 안 들어간다.
    """
    for node in list(mat.node_tree.nodes):
        if node.bl_idname == "ShaderNodeTexImage":
            mat.node_tree.nodes.remove(node)


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

    def scale_fn(t: float) -> float:
        return float(np.interp(t, knots, values))

    return scale_fn


def finish_wood(
    obj: bpy.types.Object,
    *,
    uv_cylinder: bool,
    wind_fn,
    bevel_width: float,
) -> bpy.types.Object:
    fill_boundaries(obj)
    mw.assign(obj, bark)
    mw.bevel(obj, bevel_width, 2, angle_deg=42.0)
    mw.shade_auto_smooth(obj, 34.0)
    if uv_cylinder:
        # 요청 계약: 줄기 UV는 반드시 원통 투영을 쓴다.
        mw.uv_cylinder(obj, u_scale=1.0, v_scale=0.55)
    else:
        mw.uv_box(obj, 1.0)
    mw.set_vertex_colors(obj, wind_fn)
    active_color(obj)
    return obj


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


# ---------------------------------------------------------------------------
# 침엽 다발
#
# 한 침엽은 납작한 카드가 아니라 삼각 기부와 한 점 끝을 잇는 작은 사면체다.
# 다발당 5개 × 4면 = 정확히 20삼각형이라 요청 범위(12~20)를 꽉 채운다.
# ---------------------------------------------------------------------------


def orthogonal_basis(direction: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    direction = direction / max(1.0e-9, float(np.linalg.norm(direction)))
    helper = np.array((0.0, 0.0, 1.0))
    if abs(float(np.dot(direction, helper))) > 0.88:
        helper = np.array((0.0, 1.0, 0.0))
    side = np.cross(direction, helper)
    side /= max(1.0e-9, float(np.linalg.norm(side)))
    up = np.cross(side, direction)
    up /= max(1.0e-9, float(np.linalg.norm(up)))
    return side, up


def append_needle_bundle(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    center: np.ndarray,
    outward: np.ndarray,
    *,
    gen: np.random.Generator,
) -> None:
    axis = outward / max(1.0e-9, float(np.linalg.norm(outward)))
    side, up = orthogonal_basis(axis)
    for needle_index in range(5):
        fan = (needle_index - 2) * 0.34 + float(gen.uniform(-0.10, 0.10))
        lift = float(gen.uniform(-0.22, 0.20))
        direction = axis + side * fan + up * lift
        direction /= max(1.0e-9, float(np.linalg.norm(direction)))
        local_side, local_up = orthogonal_basis(direction)
        length = float(gen.uniform(0.17, 0.25))
        width = float(gen.uniform(0.0060, 0.0095))
        base_center = center + side * float(gen.uniform(-0.020, 0.020))
        base_center += up * float(gen.uniform(-0.014, 0.014))
        start = len(verts)
        base_points = (
            base_center + local_side * width,
            base_center - local_side * width * 0.55 + local_up * width * 0.75,
            base_center - local_side * width * 0.55 - local_up * width * 0.75,
        )
        tip = base_center + direction * length
        verts.extend(tuple(float(value) for value in point) for point in (*base_points, tip))
        faces.extend(
            (
                (start, start + 2, start + 1),
                (start, start + 1, start + 3),
                (start + 1, start + 2, start + 3),
                (start + 2, start, start + 3),
            )
        )


def create_needles(
    asset_name: str,
    branch_paths: list[list[np.ndarray]],
) -> bpy.types.Object:
    gen = mw.rng(f"{asset_name}-needles")
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []

    for branch_index, path in enumerate(branch_paths):
        end_axis = path[-1] - path[-2]
        end_axis /= max(1.0e-9, float(np.linalg.norm(end_axis)))
        side, up = orthogonal_basis(end_axis)
        # 가지마다 4다발. tall 7가지=28, bent 6가지=24로 요청 20~40 안이다.
        for cluster_index, t in enumerate((0.54, 0.70, 0.85, 1.00)):
            center = path[-2] * (1.0 - t) + path[-1] * t
            ring_angle = TAU * cluster_index / 4.0 + branch_index * 0.61
            center = center + side * math.cos(ring_angle) * 0.035
            center = center + up * math.sin(ring_angle) * 0.028
            append_needle_bundle(verts, faces, center, end_axis, gen=gen)

    obj = mw.new_mesh(f"{asset_name}-needle-geometry", verts, faces, smooth=False)
    mw.assign(obj, needle)
    # 다발당 20삼각형이라는 명시 예산을 보존한다. 각 침엽은 판이 아니라 이미
    # 삼각 단면의 닫힌 쐐기라서 별도 베벨을 더하면 작은 형상만 13배로 불어난다.
    mw.shade_auto_smooth(obj, 34.0)
    mw.uv_smart(obj, angle_deg=58.0, island_margin=0.002)
    mw.set_vertex_colors(obj, lambda _world, _normal: (1.0, 0.0, 0.0))
    active_color(obj)
    return obj


# ---------------------------------------------------------------------------
# 적송 조립
# ---------------------------------------------------------------------------


def create_pine(
    name: str,
    height: float,
    trunk_path: tuple[tuple[float, float, float], ...],
    trunk_scales: tuple[float, ...],
    branch_specs: tuple[tuple[int, float, float, float], ...],
) -> bpy.types.Object:
    """굽이진 주간과 층별 길이가 다른 가지를 하나의 인스턴스 메시로 만든다."""
    trunk = mw.sweep(
        f"{name}-trunk",
        circle_section(10, 0.285 if height > 6.0 else 0.255),
        trunk_path,
        up=(0.0, 1.0, 0.0),
        smooth=True,
        scale_fn=piecewise_scale(trunk_scales),
    )
    trunk = finish_wood(
        trunk,
        uv_cylinder=True,
        wind_fn=lambda world, _normal, h=height: (
            0.42 * max(0.0, min(1.0, world.z / h)) ** 1.12,
            0.0,
            0.0,
        ),
        bevel_width=0.010,
    )

    wood_parts = [trunk]
    branch_paths: list[list[np.ndarray]] = []
    gen = mw.rng(f"{name}-branches")
    trunk_points = [np.asarray(point, dtype=np.float64) for point in trunk_path]

    for branch_index, (anchor_index, angle, length, droop) in enumerate(branch_specs):
        anchor = trunk_points[anchor_index]
        radial = np.array((math.cos(angle), math.sin(angle), 0.0))
        tangent = np.array((-math.sin(angle), math.cos(angle), 0.0))
        side_curve = float(gen.uniform(-0.09, 0.09)) * length
        path: list[np.ndarray] = []
        for point_index, t in enumerate((0.0, 0.22, 0.52, 0.80, 1.0)):
            point = anchor + radial * (length * t)
            point += tangent * math.sin(t * math.pi) * side_curve
            # 처음에는 거의 수평, 바깥 20%에서만 솔가지 특유의 처짐을 준다.
            point[2] += 0.055 * math.sin(t * math.pi)
            point[2] -= droop * max(0.0, (t - 0.58) / 0.42) ** 1.7
            if point_index == 0:
                point -= radial * 0.035
            path.append(point)

        base_radius = 0.070 if height > 6.0 else 0.064
        base_radius *= float(gen.uniform(0.88, 1.10))
        branch = mw.sweep(
            f"{name}-branch-{branch_index:02d}",
            circle_section(10, base_radius),
            [tuple(float(value) for value in point) for point in path],
            up=(0.0, 0.0, 1.0),
            smooth=True,
            scale_fn=piecewise_scale((1.0, 0.86, 0.66, 0.42, 0.16)),
        )
        span = max(1.0e-6, float(np.linalg.norm(path[-1] - path[0])))
        start = path[0].copy()
        branch = finish_wood(
            branch,
            uv_cylinder=False,
            wind_fn=lambda world, _normal, origin=start, size=span: (
                0.18
                + 0.82
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
                        / size,
                    ),
                )
                ** 0.82,
                0.0,
                0.0,
            ),
            bevel_width=0.006,
        )
        wood_parts.append(branch)
        branch_paths.append(path)

    wood = mw.join(f"{name}-wood", wood_parts)
    mw.apply_transform(wood)
    active_color(wood)
    needles = create_needles(name, branch_paths)
    pine = mw.join(name, (wood, needles))
    mw.apply_transform(pine)

    # 모디파이어의 수치 오차까지 흡수해 바닥 z=0, 요청 높이를 정확히 맞춘다.
    z_values = [float(vertex.co.z) for vertex in pine.data.vertices]
    z_min, z_max = min(z_values), max(z_values)
    scale_z = height / max(1.0e-9, z_max - z_min)
    for vertex in pine.data.vertices:
        vertex.co.z = (vertex.co.z - z_min) * scale_z
    pine.data.update()
    active_color(pine)
    pine["mwWind"] = "pine"
    pine["mwWindTipWeight"] = 1.0
    return pine


# tall은 2.1m와 4.1m 부근에서 반대 방향으로 꺾여 곧은 조경수 윤곽을 피한다.
pine_tall = create_pine(
    "pine-tall",
    7.5,
    (
        (0.00, 0.00, 0.00),
        (0.04, 0.02, 0.78),
        (0.14, 0.06, 1.55),
        (0.33, 0.01, 2.32),
        (0.21, -0.06, 3.20),
        (-0.03, -0.03, 4.12),
        (-0.18, 0.08, 5.05),
        (-0.05, 0.17, 6.24),
        (0.08, 0.20, 7.50),
    ),
    (1.00, 0.96, 0.88, 0.79, 0.68, 0.57, 0.44, 0.29, 0.11),
    (
        (2, 0.18, 1.34, 0.18),
        (3, 2.62, 1.72, 0.24),
        (3, 4.52, 1.08, 0.16),
        (4, 1.14, 1.58, 0.28),
        (5, 3.48, 1.26, 0.20),
        (5, 5.62, 0.92, 0.15),
        (6, 0.48, 0.82, 0.13),
    ),
)

# bent는 하부 3.5m 동안 x로 1m 넘게 휘어 성벽 너머에서도 종류가 구분된다.
pine_bent = create_pine(
    "pine-bent",
    5.2,
    (
        (0.00, 0.00, 0.00),
        (0.06, 0.00, 0.54),
        (0.31, 0.03, 1.08),
        (0.72, 0.01, 1.72),
        (1.08, -0.06, 2.42),
        (1.20, -0.14, 3.12),
        (1.02, -0.10, 3.86),
        (0.78, 0.03, 4.55),
        (0.70, 0.08, 5.20),
    ),
    (1.00, 0.93, 0.84, 0.73, 0.63, 0.51, 0.40, 0.27, 0.10),
    (
        (2, 2.92, 1.14, 0.18),
        (3, 0.26, 1.38, 0.25),
        (4, 4.18, 1.21, 0.22),
        (5, 1.72, 1.08, 0.18),
        (6, 3.72, 0.86, 0.15),
        (7, 5.52, 0.68, 0.12),
    ),
)

force_vertex_color_export(bark)
force_vertex_color_export(needle)
strip_images_for_color_export(bark)

for obj, expected_height, bundle_count in (
    (pine_tall, 7.5, 28),
    (pine_bent, 5.2, 24),
):
    size = dimensions(obj)
    tris = triangle_count(obj)
    wind_min, wind_max = color_bounds(obj, 0)
    assert abs(size[2] - expected_height) < 1.0e-5
    assert obj.data.color_attributes.get("Col") is not None
    assert wind_min <= 1.0e-5 and abs(wind_max - 1.0) < 1.0e-5
    print(
        f"[40_pine] {obj.name}: {tris:,} tris, "
        f"{size[0]:.3f} x {size[1]:.3f} x {size[2]:.3f} m, "
        f"{bundle_count} needle bundles, wind R={wind_min:.2f}-{wind_max:.2f}"
    )
    mw.export_glb(
        obj.name,
        [obj],
        max_triangles=7_000,
        notes=(
            f"Korean red pine; {bundle_count} geometric needle bundles at 20 tris each; "
            "FLOAT_COLOR Col.R stores root-to-tip wind weight"
        ),
        extras={"needleBundles": bundle_count, "windTipWeight": 1.0},
        embed_textures=True,
    )

mw.finish()
print("[40_pine] pine-tall + pine-bent OK")
