# -*- coding: utf-8 -*-
"""성벽 밖 화강암 노두 5종 — 절단면, 평행 절리 홈, 북면 이끼."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bmesh  # noqa: E402
import bpy  # noqa: E402
import numpy as np  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=4300)

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


def force_vertex_color_export(mat: bpy.types.Material) -> None:
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    color_node = nodes.get("mw-Col-export") or nodes.new("ShaderNodeVertexColor")
    color_node.name = "mw-Col-export"
    color_node.layer_name = "Col"
    links.new(color_node.outputs["Color"], bsdf.inputs["Base Color"])


def strip_images_for_color_export(mat: bpy.types.Material) -> None:
    for node in list(mat.node_tree.nodes):
        if node.bl_idname == "ShaderNodeTexImage":
            mat.node_tree.nodes.remove(node)


def active_color(obj: bpy.types.Object) -> None:
    color = obj.data.color_attributes.get("Col")
    if color is not None:
        obj.data.color_attributes.active_color = color
        obj.data.color_attributes.active = color


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


def clean_degenerate(obj: bpy.types.Object) -> None:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if bm.edges:
        bmesh.ops.dissolve_degenerate(bm, dist=1.0e-5, edges=list(bm.edges))
        bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1.0e-5)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def make_boulder(
    name: str,
    target_size: tuple[float, float, float],
    *,
    cut_count: int,
    joint_count: int,
    decimate_ratio: float,
) -> tuple[bpy.types.Object, tuple[float, ...]]:
    """고밀도 구를 평면 투영으로 절단하고 남은 곡면만 다중 주파수 변위한다."""
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=4, radius=1.0)
    obj = bpy.context.object
    obj.name = name
    obj.data.name = name
    gen = mw.rng(name)

    # 방향성 파형은 백색 정점 노이즈의 가시 같은 표면을 피하면서 큰 화강암
    # 덩어리와 작은 풍화 요철을 동시에 만든다.
    noise_dirs = []
    for _ in range(4):
        direction = gen.normal(0.0, 1.0, 3)
        direction /= max(1.0e-9, float(np.linalg.norm(direction)))
        noise_dirs.append(direction)
    frequencies = gen.uniform(1.1, 4.2, 4)
    phases = gen.uniform(0.0, math.tau, 4)
    amplitudes = (0.085, 0.055, 0.028, 0.014)

    # 첫 절단은 +Y(북쪽), 둘째는 비스듬한 상면이다. 나머지는 개체마다 달라
    # 같은 구를 스케일만 바꾼 것으로 보이지 않게 한다.
    cuts: list[tuple[np.ndarray, float]] = [
        (np.array((0.00, 1.00, 0.14), dtype=np.float64), 0.62),
        (np.array((0.22, -0.08, 1.00), dtype=np.float64), 0.70),
    ]
    for _ in range(max(0, cut_count - 2)):
        normal = gen.normal(0.0, 1.0, 3)
        normal[2] *= 0.78
        normal /= max(1.0e-9, float(np.linalg.norm(normal)))
        cuts.append((normal, float(gen.uniform(0.56, 0.76))))
    cuts = [
        (normal / max(1.0e-9, float(np.linalg.norm(normal))), offset)
        for normal, offset in cuts
    ]

    normalized_points: list[np.ndarray] = []
    for vertex in obj.data.vertices:
        unit = np.asarray(vertex.co, dtype=np.float64)
        unit /= max(1.0e-9, float(np.linalg.norm(unit)))
        radius = 1.0
        for direction, frequency, phase, amplitude in zip(
            noise_dirs, frequencies, phases, amplitudes
        ):
            radius += math.sin(float(np.dot(unit, direction)) * frequency * math.pi + phase) * amplitude
        point = unit * radius
        for plane_normal, plane_offset in cuts:
            excess = float(np.dot(point, plane_normal)) - plane_offset
            if excess > 0.0:
                point -= plane_normal * excess
        # 실제 접지 절단면. 이후 모든 연산에서도 이 높이 아래로 내려가지 않는다.
        point[2] = max(point[2], -0.72)
        normalized_points.append(point)

    points = np.stack(normalized_points)
    # 절단으로 한쪽 질량이 줄었어도 바닥 footprint 중심이 원점에 오게 한다.
    x_mid = (float(points[:, 0].min()) + float(points[:, 0].max())) * 0.5
    y_mid = (float(points[:, 1].min()) + float(points[:, 1].max())) * 0.5
    points[:, 0] -= x_mid
    points[:, 1] -= y_mid

    # 최종 요구 크기에 정확히 맞춘다. 선형 스케일은 앞서 만든 절단면의 평면성을
    # 보존한다.
    for axis, target in enumerate(target_size):
        lo, hi = float(points[:, axis].min()), float(points[:, axis].max())
        if axis == 2:
            points[:, axis] = (points[:, axis] - lo) / max(1.0e-9, hi - lo) * target
        else:
            points[:, axis] *= target / max(1.0e-9, hi - lo)

    # 화강암 절리는 서로 평행해야 한다. x가 조금 섞인 높이 좌표를 사용해 완전한
    # 수평 띠를 피하고, 좁은 대역의 x/y 반지름을 줄여 실제 얕은 홈을 판다.
    height = target_size[2]
    joint_levels = tuple(
        float(value)
        for value in np.linspace(height * 0.30, height * 0.72, joint_count)
        + gen.uniform(-height * 0.025, height * 0.025, joint_count)
    )
    joint_width = max(0.026, height * 0.026)
    joint_depth = max(0.010, min(target_size[0], target_size[1]) * 0.020)
    for point in points:
        coordinate = point[2] + point[0] * 0.18
        distance = min(abs(coordinate - level) for level in joint_levels)
        if distance < joint_width:
            groove = (1.0 - distance / joint_width) ** 2
            radial = math.hypot(float(point[0]), float(point[1]))
            if radial > 1.0e-8:
                shrink = max(0.0, radial - joint_depth * groove) / radial
                point[0] *= shrink
                point[1] *= shrink

    for vertex, point in zip(obj.data.vertices, points):
        vertex.co = tuple(float(value) for value in point)
    obj.data.update()
    clean_degenerate(obj)

    # 5,120 tris의 고른 구망에서 실루엣·절단 경계·홈을 남기고 평면 내부 분할을
    # 걷어 낸다. 개체별 비율은 아래 실측 후 모두 2,500 이하가 되도록 잡았다.
    mw.decimate(obj, decimate_ratio)
    mw.assign(obj, worn)
    mw.bevel(
        obj,
        max(0.008, min(target_size) * 0.010),
        2,
        angle_deg=48.0,
    )

    # 데시메이트와 바닥 모서리 베벨 뒤에도 접지면과 높이 계약을 정확히 복구한다.
    z_values = [float(vertex.co.z) for vertex in obj.data.vertices]
    z_min, z_max = min(z_values), max(z_values)
    z_scale = target_size[2] / max(1.0e-9, z_max - z_min)
    for vertex in obj.data.vertices:
        vertex.co.z = (vertex.co.z - z_min) * z_scale
    obj.data.update()

    mw.shade_auto_smooth(obj, 34.0)
    mw.uv_box(obj, 1.0)

    def moss_mask(world, normal):
        coordinate = world.z + world.x * 0.18
        distance = min(abs(coordinate - level) for level in joint_levels)
        groove = max(0.0, 1.0 - distance / (joint_width * 1.55)) ** 1.5
        # +Y가 북쪽. 빗물이 머무는 바닥 근처와 절리 홈도 함께 올린다.
        north = max(0.0, normal.y) ** 1.35
        ground_damp = max(0.0, 1.0 - world.z / max(0.18, height * 0.30))
        moss = min(1.0, 0.04 + north * 0.67 + groove * 0.58 + ground_damp * 0.20)
        return (0.0, moss, 0.0)

    mw.set_vertex_colors(obj, moss_mask)
    active_color(obj)
    obj["mwMossChannel"] = "G"
    obj["mwNorthAxis"] = "+Y"
    obj["mwJointCount"] = joint_count
    return obj, joint_levels


boulder_specs = (
    ("boulder-a", (1.24, 1.02, 0.80), 4, 2, 0.28),
    ("boulder-b", (1.82, 1.26, 1.18), 5, 2, 0.27),
    ("boulder-c", (1.52, 1.62, 1.56), 5, 3, 0.26),
    ("boulder-d", (2.68, 1.86, 2.05), 6, 3, 0.25),
    ("boulder-e", (2.22, 2.04, 2.60), 7, 3, 0.24),
)

boulders: list[bpy.types.Object] = []
for spec in boulder_specs:
    boulder, _joint_levels = make_boulder(
        spec[0],
        spec[1],
        cut_count=spec[2],
        joint_count=spec[3],
        decimate_ratio=spec[4],
    )
    boulders.append(boulder)

force_vertex_color_export(worn)
strip_images_for_color_export(worn)

# 각 GLB에 메시 하나만 넣는다. 런타임은 종류별 GLB를 각각 InstancedMesh의
# 원본으로 삼으므로 오브젝트를 kit 하나로 합치지 않는다.
for obj in boulders:
    size = dimensions(obj)
    tris = triangle_count(obj)
    z_min = min(float(vertex.co.z) for vertex in obj.data.vertices)
    moss_min, moss_max = color_bounds(obj, 1)
    assert abs(z_min) < 1.0e-5
    assert obj.data.color_attributes.get("Col") is not None
    assert moss_max >= 0.72
    print(
        f"[43_rocks] {obj.name}: {tris:,} tris, "
        f"{size[0]:.3f} x {size[1]:.3f} x {size[2]:.3f} m, "
        f"moss G={moss_min:.2f}-{moss_max:.2f}"
    )
    mw.export_glb(
        obj.name,
        [obj],
        max_triangles=2_500,
        notes=(
            "single instancing source; planar fracture cuts, geometric parallel joint grooves, "
            "flat ground contact; FLOAT_COLOR Col.G stores north-face/groove moss"
        ),
        extras={
            "instancingSource": True,
            "mossChannel": "G",
            "northAxis": "+Y",
            "jointCount": int(obj["mwJointCount"]),
        },
        embed_textures=True,
    )

mw.finish()
print("[43_rocks] boulder-a through boulder-e OK")
