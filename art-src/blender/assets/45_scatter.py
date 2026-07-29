# -*- coding: utf-8 -*-
"""근거리 지면 산포 키트.

부감 카메라에서 화면 대부분을 차지하는 것은 지평선이나 성벽이 아니라 플레이어
주변 6~11m의 바닥이다. 이 파일은 그 범위에 수천 번 인스턴싱할 작은 실루엣을
만든다. 변형 하나가 three.js의 InstancedMesh 하나가 되므로 오브젝트를 합치지
않는다.

식생도 알파 카드를 쓰지 않는다. 각 잎은 폭과 중앙 골이 있는 굽은 띠이고,
``Col.R``에 뿌리 0 → 끝 1 바람 가중치를 FLOAT_COLOR로 굽는다.
"""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=4500)

TAU = math.tau


# ---------------------------------------------------------------------------
# 공유 머티리얼
#
# 10_tex_ground.py와 11_tex_arch.py가 등록한 이름과 맵을 그대로 쓴다. 같은 이름을
# 유지해야 three.js가 이 소품과 기존 지면/건축을 같은 재질군으로 묶을 수 있다.
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

worn_stone = mw.material(
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

moss_lichen = mw.material(
    mw.MaterialSpec(
        name="mw/ground/moss-lichen",
        base_color=(1.0, 1.0, 1.0, 1.0),
        roughness=0.94,
        base_color_map="env/tex/ground/moss-lichen_basecolor.webp",
        normal_map="env/tex/ground/moss-lichen_normal.webp",
        orm_map="env/tex/ground/moss-lichen_orm.webp",
        uv_scale=0.7,
        shader="stone",
        arc_response=1.0,
    )
)

roof_tile = mw.material(
    mw.MaterialSpec(
        name="mw/arch/roof-tile",
        base_color=(1.0, 1.0, 1.0, 1.0),
        roughness=0.74,
        base_color_map="env/tex/arch/roof-tile_basecolor.webp",
        normal_map="env/tex/arch/roof-tile_normal.webp",
        orm_map="env/tex/arch/roof-tile_orm.webp",
        uv_scale=1.2,
        shader="stone",
        arc_response=1.0,
    )
)

blade = mw.material(
    mw.MaterialSpec(
        name="mw/nature/blade",
        base_color=(0.16, 0.19, 0.11, 1.0),
        roughness=0.88,
        double_sided=True,
        shader="foliage",
        arc_response=1.0,
    )
)


def force_vertex_color_export(mat: bpy.types.Material) -> None:
    """Blender 5.2가 ``Col``을 COLOR_0으로 내보내도록 노드에서 참조한다.

    런타임은 매니페스트의 재질로 교체하므로 이 연결은 미리보기 색보다 데이터
    보존이 목적이다. 사용하지 않은 활성 컬러 속성을 익스포터가 생략하는 경로를
    막는다.
    """
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    color_node = nodes.get("mw-Col-export") or nodes.new("ShaderNodeVertexColor")
    color_node.name = "mw-Col-export"
    color_node.layer_name = "Col"
    links.new(color_node.outputs["Color"], bsdf.inputs["Base Color"])


# ---------------------------------------------------------------------------
# 공통 메시 마감
# ---------------------------------------------------------------------------


def triangle_count(obj: bpy.types.Object) -> int:
    return sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons)


def wind_bounds(obj: bpy.types.Object) -> tuple[float, float]:
    values = [float((obj.matrix_world @ vertex.co).z) for vertex in obj.data.vertices]
    return min(values), max(values)


def finish_prop(
    obj: bpy.types.Object,
    mat: bpy.types.Material,
    bevel_width: float,
    *,
    wind: bool = False,
) -> bpy.types.Object:
    """모든 변형에 같은 상용 품질의 모서리·스무딩·UV 계약을 적용한다."""
    mw.assign(obj, mat)
    mw.bevel(obj, bevel_width, 2)
    mw.shade_auto_smooth(obj, 34)
    mw.uv_box(obj, 1.0)

    if wind:
        z_min, z_max = wind_bounds(obj)
        span = max(1.0e-6, z_max - z_min)

        # FLOAT_COLOR를 보장하는 공용 함수만 사용한다. R은 셰이더 입력 데이터고
        # G/B는 이 키트에서 비워 두어 런타임 색 변주에 충돌하지 않게 한다.
        mw.set_vertex_colors(
            obj,
            lambda world, _normal, lo=z_min, size=span: (
                max(0.0, min(1.0, (world.z - lo) / size)) ** 0.9,
                0.0,
                0.0,
            ),
        )
        color = obj.data.color_attributes.get("Col")
        if color is not None:
            obj.data.color_attributes.active_color = color
            obj.data.color_attributes.active = color
    return obj


# ---------------------------------------------------------------------------
# 자갈과 잔해
# ---------------------------------------------------------------------------


def irregular_stone(
    name: str,
    size: tuple[float, float, float],
    *,
    salt: str,
    subdivisions: int,
    decimate_ratio: float,
    cut_count: int,
    buried: float,
    mat: bpy.types.Material,
    bevel_width: float,
) -> bpy.types.Object:
    """변형한 구를 평면으로 잘라 풍화면과 파단면을 동시에 만든다.

    정점별 백색 잡음만 쓰면 표면이 가시처럼 돋는다. 대신 방향성 사인 세 겹으로
    큰 덩어리를 먼저 찌그러뜨린 뒤 작은 정점 편차를 얹는다. 파단면은 임계 밖
    정점을 같은 평면으로 투영해 실제 평면 노멀을 만든다.
    """
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0)
    obj = bpy.context.active_object
    obj.name = name
    obj.data.name = name

    gen = mw.rng(salt)
    directions = []
    for _ in range(3):
        direction = gen.normal(0.0, 1.0, 3)
        direction /= max(1.0e-9, float(np.linalg.norm(direction)))
        directions.append(direction)
    phases = gen.uniform(0.0, TAU, 3)
    frequencies = gen.uniform(1.15, 2.75, 3)
    amplitudes = gen.uniform(0.045, 0.105, 3)

    cuts: list[tuple[np.ndarray, float]] = []
    for _ in range(cut_count):
        normal = gen.normal(0.0, 1.0, 3)
        # 윗면과 옆면이 섞이되 바닥 접지면과 같은 방향만 반복되지 않게 한다.
        normal[2] = abs(normal[2]) * 0.75 + gen.uniform(-0.25, 0.35)
        normal /= max(1.0e-9, float(np.linalg.norm(normal)))
        cuts.append((normal, float(gen.uniform(0.48, 0.76))))

    points: list[np.ndarray] = []
    for vertex in obj.data.vertices:
        base = np.array(vertex.co, dtype=np.float64)
        unit = base / max(1.0e-9, float(np.linalg.norm(base)))
        radius = 1.0
        for direction, phase, frequency, amplitude in zip(
            directions, phases, frequencies, amplitudes
        ):
            radius += math.sin(float(np.dot(unit, direction)) * frequency * math.pi + phase) * amplitude
        radius += float(gen.uniform(-0.035, 0.035))
        point = unit * radius

        for plane_normal, plane_offset in cuts:
            excess = float(np.dot(point, plane_normal)) - plane_offset
            if excess > 0.0:
                point -= plane_normal * excess

        # 아래쪽도 하나의 얕은 절단면으로 만들어 지면에 안정적으로 붙인다.
        point[2] = max(point[2], -0.72)
        points.append(point * (np.asarray(size, dtype=np.float64) * 0.5))

    min_z = min(float(point[2]) for point in points)
    target_min = -abs(float(buried))
    for vertex, point in zip(obj.data.vertices, points):
        point[2] += target_min - min_z
        vertex.co = tuple(float(value) for value in point)
    obj.data.update()

    # 실루엣을 결정하는 큰 변형과 평면은 남기고 균일한 삼각망만 걷어 낸다.
    mw.decimate(obj, decimate_ratio)
    return finish_prop(obj, mat, bevel_width)


pebble_specs = (
    ("pebble-a", (0.070, 0.052, 0.038), 0, 0.006, granite),
    ("pebble-b", (0.110, 0.082, 0.052), 1, 0.008, worn_stone),
    ("pebble-c", (0.155, 0.105, 0.070), 1, 0.010, granite),
    # 넓고 낮은 d와 세로로 각진 e가 같은 산포에서도 실루엣 반복을 끊는다.
    ("pebble-d", (0.220, 0.135, 0.046), 2, 0.009, worn_stone),
    ("pebble-e", (0.125, 0.092, 0.105), 2, 0.012, granite),
)

scatter_objects: list[bpy.types.Object] = []
for pebble_name, pebble_size, cuts, buried_depth, pebble_mat in pebble_specs:
    scatter_objects.append(
        irregular_stone(
            pebble_name,
            pebble_size,
            salt=pebble_name,
            subdivisions=2,
            decimate_ratio=0.78,
            cut_count=cuts,
            buried=buried_depth,
            mat=pebble_mat,
            bevel_width=0.004,
        )
    )


rubble_specs = (
    ("rubble-a", (0.220, 0.180, 0.135), 3, 0.42, granite),
    ("rubble-b", (0.330, 0.245, 0.190), 4, 0.36, worn_stone),
    ("rubble-c", (0.460, 0.315, 0.235), 4, 0.32, granite),
    ("rubble-d", (0.550, 0.385, 0.280), 5, 0.29, worn_stone),
)

for rubble_name, rubble_size, cuts, ratio, rubble_mat in rubble_specs:
    scatter_objects.append(
        irregular_stone(
            rubble_name,
            rubble_size,
            salt=rubble_name,
            subdivisions=3,
            decimate_ratio=ratio,
            cut_count=cuts,
            buried=0.0,
            mat=rubble_mat,
            bevel_width=0.008,
        )
    )


# ---------------------------------------------------------------------------
# 깨진 기와 조각
# ---------------------------------------------------------------------------


def tile_shard(
    name: str,
    length: float,
    width: float,
    camber: float,
    thickness: float,
    *,
    rows: int,
    columns: int,
) -> bpy.types.Object:
    """불규칙 외곽과 실제 두께를 가진 얇은 원통곡면 조각."""
    gen = mw.rng(name)
    row_widths = gen.uniform(0.76, 1.0, rows)
    row_widths[0] *= float(gen.uniform(0.66, 0.84))
    row_widths[-1] *= float(gen.uniform(0.62, 0.86))
    offsets = gen.uniform(-width * 0.10, width * 0.10, rows)
    offsets -= float(np.mean(offsets))
    row_lifts = gen.uniform(-thickness * 0.12, thickness * 0.12, rows)

    verts: list[tuple[float, float, float]] = []
    for layer in (0, 1):
        for row in range(rows):
            v = row / (rows - 1)
            y = (v - 0.5) * length
            local_width = width * float(row_widths[row])
            for column in range(columns):
                u = column / (columns - 1) * 2.0 - 1.0
                x = float(offsets[row]) + u * local_width * 0.5
                curve = camber * max(0.0, 1.0 - u * u)
                # 한쪽 끝이 미세하게 들려 완벽한 압출판으로 보이지 않게 한다.
                warp = math.sin(v * math.pi) * thickness * 0.16 + float(row_lifts[row])
                top_z = thickness + curve + warp
                z = top_z if layer == 0 else top_z - thickness
                verts.append((x, y, z))

    stride = rows * columns
    faces: list[tuple[int, ...]] = []
    for row in range(rows - 1):
        for column in range(columns - 1):
            a = row * columns + column
            b = a + 1
            d = (row + 1) * columns + column
            c = d + 1
            faces.append((a, b, c, d))
            faces.append((stride + d, stride + c, stride + b, stride + a))

    # 네 파단 가장자리의 실제 두께. 텍스처 카드와 달리 부감에서도 옆면이 잡힌다.
    for row in range(rows - 1):
        a = row * columns
        b = (row + 1) * columns
        faces.append((a, b, stride + b, stride + a))
        a = row * columns + columns - 1
        b = (row + 1) * columns + columns - 1
        faces.append((b, a, stride + a, stride + b))
    for column in range(columns - 1):
        a = column
        b = column + 1
        faces.append((b, a, stride + a, stride + b))
        a = (rows - 1) * columns + column
        b = a + 1
        faces.append((a, b, stride + b, stride + a))

    min_z = min(vertex[2] for vertex in verts)
    verts = [(x, y, z - min_z) for x, y, z in verts]
    obj = mw.new_mesh(name, verts, faces)
    return finish_prop(obj, roof_tile, 0.004)


scatter_objects.extend(
    (
        tile_shard("shard-a", 0.145, 0.115, 0.016, 0.009, rows=4, columns=5),
        tile_shard("shard-b", 0.235, 0.155, 0.022, 0.011, rows=5, columns=5),
        tile_shard("shard-c", 0.345, 0.205, 0.030, 0.012, rows=6, columns=6),
    )
)


# ---------------------------------------------------------------------------
# 낮은 이끼 둔덕
# ---------------------------------------------------------------------------


def moss_clump(name: str, diameter: float, height: float, segments: int) -> bpy.types.Object:
    """중앙이 하나로 솟지 않는 비대칭 저상 둔덕."""
    gen = mw.rng(name)
    angles = [TAU * index / segments for index in range(segments)]
    radii = gen.uniform(0.84, 1.08, segments) * diameter * 0.5
    inner_radii = radii * gen.uniform(0.38, 0.52, segments)
    top_heights = height * gen.uniform(0.70, 1.0, segments)
    phase = float(gen.uniform(0.0, TAU))

    verts: list[tuple[float, float, float]] = [(0.0, 0.0, height * 0.92)]
    for angle, radius, top_z in zip(angles, inner_radii, top_heights):
        verts.append((math.cos(angle) * radius, math.sin(angle) * radius, float(top_z)))
    for index, (angle, radius) in enumerate(zip(angles, radii)):
        edge_z = 0.0035 + 0.002 * (math.sin(angle * 3.0 + phase) * 0.5 + 0.5)
        verts.append((math.cos(angle) * radius, math.sin(angle) * radius, edge_z))
    for angle, radius in zip(angles, radii):
        verts.append((math.cos(angle) * radius * 0.96, math.sin(angle) * radius * 0.96, 0.0))
    bottom_center = len(verts)
    verts.append((0.0, 0.0, 0.0))

    inner_start = 1
    edge_start = 1 + segments
    bottom_start = 1 + segments * 2
    faces: list[tuple[int, ...]] = []
    for index in range(segments):
        nxt = (index + 1) % segments
        faces.append((0, inner_start + index, inner_start + nxt))
        faces.append(
            (
                inner_start + index,
                edge_start + index,
                edge_start + nxt,
                inner_start + nxt,
            )
        )
        faces.append(
            (
                edge_start + index,
                bottom_start + index,
                bottom_start + nxt,
                edge_start + nxt,
            )
        )
        faces.append((bottom_center, bottom_start + nxt, bottom_start + index))

    obj = mw.new_mesh(name, verts, faces)
    return finish_prop(obj, moss_lichen, 0.004)


scatter_objects.extend(
    (
        moss_clump("mossclump-a", 0.31, 0.030, 12),
        moss_clump("mossclump-b", 0.48, 0.037, 15),
    )
)


# ---------------------------------------------------------------------------
# 판석 틈의 마른 뿌리
# ---------------------------------------------------------------------------


def append_flat_tube(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    path: list[tuple[float, float]],
    radii: list[float],
    *,
    sides: int = 6,
) -> None:
    """XY 경로를 따라 수평 폭이 큰 타원 튜브를 붙인다."""
    start = len(verts)
    for index, ((x, y), radius) in enumerate(zip(path, radii)):
        if index == 0:
            dx, dy = path[1][0] - x, path[1][1] - y
        elif index == len(path) - 1:
            dx, dy = x - path[index - 1][0], y - path[index - 1][1]
        else:
            dx = path[index + 1][0] - path[index - 1][0]
            dy = path[index + 1][1] - path[index - 1][1]
        inv = 1.0 / max(1.0e-9, math.hypot(dx, dy))
        side_x, side_y = -dy * inv, dx * inv
        vertical_radius = radius * 0.38
        for side_index in range(sides):
            angle = TAU * side_index / sides
            horizontal = math.cos(angle) * radius
            z = (math.sin(angle) + 1.0) * vertical_radius
            verts.append((x + side_x * horizontal, y + side_y * horizontal, z))

    for ring in range(len(path) - 1):
        a0 = start + ring * sides
        a1 = a0 + sides
        for side_index in range(sides):
            nxt = (side_index + 1) % sides
            faces.append((a0 + side_index, a0 + nxt, a1 + nxt, a1 + side_index))
    faces.append(tuple(reversed(tuple(start + index for index in range(sides)))))
    end = start + (len(path) - 1) * sides
    faces.append(tuple(end + index for index in range(sides)))


def root_mesh(name: str, length: float, base_radius: float, branch_scale: float) -> bpy.types.Object:
    """완만한 주근과 두 갈래 세근을 한 독립 메시 변형으로 만든다."""
    gen = mw.rng(name)
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    count = 10
    phase = float(gen.uniform(0.0, TAU))
    main_path: list[tuple[float, float]] = []
    main_radii: list[float] = []
    for index in range(count):
        t = index / (count - 1)
        x = math.sin(t * math.pi * 1.35 + phase) * length * 0.055
        x += math.sin(t * math.pi * 3.2 + phase * 0.7) * length * 0.018
        y = (t - 0.5) * length
        main_path.append((x, y))
        main_radii.append(base_radius * (1.0 - 0.78 * t))
    append_flat_tube(verts, faces, main_path, main_radii)

    for branch_index, source_index in enumerate((3, 6)):
        anchor = np.asarray(main_path[source_index], dtype=np.float64)
        direction = -1.0 if branch_index == 0 else 1.0
        branch_length = length * branch_scale * float(gen.uniform(0.82, 1.12))
        branch_path: list[tuple[float, float]] = []
        branch_radii: list[float] = []
        for index in range(6):
            t = index / 5.0
            angle = direction * (0.82 + 0.22 * branch_index)
            offset = np.array((math.sin(angle), math.cos(angle))) * branch_length * t
            offset[0] += math.sin(t * math.pi) * direction * branch_length * 0.11
            point = anchor + offset
            branch_path.append((float(point[0]), float(point[1])))
            branch_radii.append(base_radius * 0.58 * (1.0 - 0.82 * t))
        append_flat_tube(verts, faces, branch_path, branch_radii)

    obj = mw.new_mesh(name, verts, faces)
    return finish_prop(obj, moss_lichen, 0.004)


scatter_objects.extend(
    (
        root_mesh("root-a", 0.52, 0.022, 0.34),
        root_mesh("root-b", 0.86, 0.028, 0.39),
    )
)


# ---------------------------------------------------------------------------
# 실제 잎날 지오메트리
# ---------------------------------------------------------------------------


def append_creased_ribbon(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    centers: list[np.ndarray],
    widths: list[float],
    *,
    crease: float = 0.11,
) -> None:
    """폭 방향 3정점의 얕은 V단면 잎을 만든다.

    알파 카드의 교차 평면과 달리, 카메라가 위에서 보아도 좌우 면과 중앙 골이
    실제 실루엣/노멀을 만든다.
    """
    start = len(verts)
    for index, (center, width) in enumerate(zip(centers, widths)):
        if index == 0:
            tangent = centers[1] - center
        elif index == len(centers) - 1:
            tangent = center - centers[index - 1]
        else:
            tangent = centers[index + 1] - centers[index - 1]
        side = np.array((-tangent[1], tangent[0], 0.0), dtype=np.float64)
        side_length = float(np.linalg.norm(side))
        if side_length < 1.0e-9:
            side = np.array((1.0, 0.0, 0.0))
        else:
            side /= side_length
        left = center - side * width * 0.5
        middle = center + np.array((0.0, 0.0, width * crease))
        right = center + side * width * 0.5
        verts.extend(tuple(float(value) for value in point) for point in (left, middle, right))

    for row in range(len(centers) - 1):
        a = start + row * 3
        b = a + 3
        faces.append((a, b, b + 1, a + 1))
        faces.append((a + 1, b + 1, b + 2, a + 2))


def grass_tuft(
    name: str,
    blade_count: int,
    height_range: tuple[float, float],
    lean_range: tuple[float, float],
) -> bpy.types.Object:
    """높이·방향·곡률이 다른 6~10장의 잎으로 만든 풀포기."""
    gen = mw.rng(name)
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    for blade_index in range(blade_count):
        angle = TAU * blade_index / blade_count + float(gen.uniform(-0.34, 0.34))
        height = float(gen.uniform(*height_range))
        lean = float(gen.uniform(*lean_range))
        segments = int(gen.integers(4, 7))
        base_radius = float(gen.uniform(0.004, 0.018))
        side_curve = float(gen.uniform(-0.025, 0.025))
        blade_width = float(gen.uniform(0.010, 0.019))
        radial = np.array((math.cos(angle), math.sin(angle), 0.0))
        tangent = np.array((-math.sin(angle), math.cos(angle), 0.0))

        centers: list[np.ndarray] = []
        widths: list[float] = []
        for segment in range(segments + 1):
            t = segment / segments
            rise = height * (t - 0.20 * t * t) / 0.80
            center = radial * (base_radius + lean * t**1.55)
            center += tangent * (math.sin(t * math.pi) * side_curve)
            center[2] = rise
            centers.append(center)
            widths.append(blade_width * (1.0 - t) ** 0.72 + 0.00045)
        append_creased_ribbon(verts, faces, centers, widths)

    obj = mw.new_mesh(name, verts, faces)
    return finish_prop(obj, blade, 0.004, wind=True)


foliage_objects: list[bpy.types.Object] = [
    grass_tuft("grass-a", 7, (0.12, 0.18), (0.045, 0.080)),
    grass_tuft("grass-b", 9, (0.18, 0.27), (0.065, 0.115)),
    grass_tuft("grass-c", 10, (0.27, 0.38), (0.090, 0.160)),
]


def fern(name: str) -> bpy.types.Object:
    """방사형 5엽 고사리. 각 엽은 굽은 엽축과 5쌍의 소엽을 가진다."""
    gen = mw.rng(name)
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    frond_count = 5
    for frond_index in range(frond_count):
        angle = TAU * frond_index / frond_count + float(gen.uniform(-0.16, 0.16))
        height = float(gen.uniform(0.19, 0.27))
        reach = float(gen.uniform(0.12, 0.20))
        radial = np.array((math.cos(angle), math.sin(angle), 0.0))
        side = np.array((-math.sin(angle), math.cos(angle), 0.0))
        centers: list[np.ndarray] = []
        widths: list[float] = []
        for segment in range(7):
            t = segment / 6.0
            center = radial * (reach * t**1.25)
            center += side * math.sin(t * math.pi) * float(gen.uniform(-0.010, 0.010))
            center[2] = height * (t - 0.16 * t * t) / 0.84
            centers.append(center)
            widths.append(0.010 * (1.0 - t) + 0.0012)
        append_creased_ribbon(verts, faces, centers, widths, crease=0.08)

        # 소엽은 끝으로 갈수록 짧아져 깃꼴 윤곽을 만든다. 각 소엽도 두 구간으로
        # 휘므로 납작한 삼각형 반복으로 읽히지 않는다.
        for pair_index in range(1, 6):
            anchor = centers[pair_index]
            along = pair_index / 6.0
            leaflet_length = 0.050 * (1.0 - along * 0.62)
            leaflet_width = 0.014 * (1.0 - along * 0.50)
            for direction in (-1.0, 1.0):
                leaf_axis = side * direction * 0.92 + radial * 0.38
                leaf_axis /= max(1.0e-9, float(np.linalg.norm(leaf_axis)))
                leaf_centers = []
                for step in range(3):
                    u = step / 2.0
                    point = anchor + leaf_axis * leaflet_length * u
                    point = point.copy()
                    point[2] += math.sin(u * math.pi) * 0.006
                    leaf_centers.append(point)
                leaf_widths = [leaflet_width * 0.62, leaflet_width, 0.0004]
                append_creased_ribbon(
                    verts,
                    faces,
                    leaf_centers,
                    leaf_widths,
                    crease=0.07,
                )

    obj = mw.new_mesh(name, verts, faces)
    return finish_prop(obj, blade, 0.004, wind=True)


foliage_objects.append(fern("fern-a"))


def append_vertical_stem(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    *,
    height: float,
    radius: float,
    rings: int,
    sides: int,
) -> None:
    start = len(verts)
    for ring in range(rings):
        t = ring / (rings - 1)
        x = math.sin(t * math.pi) * 0.008
        y = math.sin(t * math.pi * 0.7) * 0.004
        local_radius = radius * (1.0 - 0.26 * t)
        for side_index in range(sides):
            angle = TAU * side_index / sides
            verts.append(
                (
                    x + math.cos(angle) * local_radius,
                    y + math.sin(angle) * local_radius,
                    height * t,
                )
            )
    for ring in range(rings - 1):
        a0 = start + ring * sides
        a1 = a0 + sides
        for side_index in range(sides):
            nxt = (side_index + 1) % sides
            faces.append((a0 + side_index, a0 + nxt, a1 + nxt, a1 + side_index))
    faces.append(tuple(reversed(tuple(start + index for index in range(sides)))))
    top = start + (rings - 1) * sides
    faces.append(tuple(top + index for index in range(sides)))


def append_seed_head(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    *,
    base_z: float,
) -> None:
    """갈대 이삭을 가는 8각 방추로 만든다."""
    profile = (
        (0.004, 0.000),
        (0.013, 0.014),
        (0.018, 0.040),
        (0.014, 0.070),
        (0.002, 0.092),
    )
    sides = 8
    start = len(verts)
    for side_index in range(sides):
        angle = TAU * side_index / sides
        for radius, dz in profile:
            verts.append(
                (
                    math.cos(angle) * radius + 0.008,
                    math.sin(angle) * radius + 0.003,
                    base_z + dz,
                )
            )
    stride = len(profile)
    for side_index in range(sides):
        nxt = (side_index + 1) % sides
        for profile_index in range(stride - 1):
            a = start + side_index * stride + profile_index
            b = start + nxt * stride + profile_index
            faces.append((a, b, b + 1, a + 1))
    faces.append(
        tuple(reversed(tuple(start + side_index * stride for side_index in range(sides))))
    )
    faces.append(tuple(start + side_index * stride + stride - 1 for side_index in range(sides)))


def reed(name: str) -> bpy.types.Object:
    """곧은 마른 줄기, 기하 이삭, 바깥으로 눕는 세 잎."""
    gen = mw.rng(name)
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    stem_height = 0.352
    append_vertical_stem(verts, faces, height=stem_height, radius=0.006, rings=7, sides=6)
    append_seed_head(verts, faces, base_z=stem_height)

    for leaf_index, angle in enumerate((0.35, 2.55, 4.55)):
        radial = np.array((math.cos(angle), math.sin(angle), 0.0))
        side = np.array((-math.sin(angle), math.cos(angle), 0.0))
        height = (0.16, 0.22, 0.27)[leaf_index]
        reach = (0.085, 0.105, 0.125)[leaf_index]
        centers: list[np.ndarray] = []
        widths: list[float] = []
        for segment in range(6):
            t = segment / 5.0
            center = radial * (reach * t**1.35)
            center += side * math.sin(t * math.pi) * float(gen.uniform(-0.009, 0.009))
            center[2] = height * (t - 0.24 * t * t) / 0.76
            centers.append(center)
            widths.append(0.013 * (1.0 - t) ** 0.70 + 0.00045)
        append_creased_ribbon(verts, faces, centers, widths)

    obj = mw.new_mesh(name, verts, faces)
    return finish_prop(obj, blade, 0.004, wind=True)


foliage_objects.append(reed("reed-a"))

# Vertex Color 노드의 레이어 이름은 실제 ``Col`` 속성이 존재한 뒤 지정해야 한다.
# Blender 5.2는 존재하지 않는 레이어 이름을 노드에 미리 넣으면 빈 이름으로
# 되돌리고, 이후 활성 컬러를 별도 COLOR_1로 중복 내보낸다.
force_vertex_color_export(blade)


# ---------------------------------------------------------------------------
# 내보내기
# ---------------------------------------------------------------------------

expected_scatter = [
    *(f"pebble-{suffix}" for suffix in "abcde"),
    *(f"rubble-{suffix}" for suffix in "abcd"),
    *(f"shard-{suffix}" for suffix in "abc"),
    *(f"mossclump-{suffix}" for suffix in "ab"),
    *(f"root-{suffix}" for suffix in "ab"),
]
expected_foliage = [
    *(f"grass-{suffix}" for suffix in "abc"),
    "fern-a",
    "reed-a",
]

assert [obj.name for obj in scatter_objects] == expected_scatter
assert [obj.name for obj in foliage_objects] == expected_foliage
assert len({id(obj.data) for obj in scatter_objects + foliage_objects}) == 21

for group_name, objects in (("scatter-kit", scatter_objects), ("foliage-kit", foliage_objects)):
    print(f"[45_scatter] {group_name} objects:")
    for obj in objects:
        print(f"[45_scatter]   {obj.name}: {triangle_count(obj):,} tris")

mw.export_glb(
    "scatter-kit",
    scatter_objects,
    max_triangles=14_000,
    notes="16 independent ground-scatter variants; preserve object boundaries for InstancedMesh",
)
mw.export_glb(
    "foliage-kit",
    foliage_objects,
    max_triangles=3_000,
    notes="5 independent geometry-foliage variants; FLOAT_COLOR Col.R stores wind weight",
    # Blender 5.2의 glTF 익스포터는 image_format=NONE일 때 노드 트리의 정점
    # 컬러 참조도 건너뛰고 흰 COLOR_0 + 실제 Col을 COLOR_1로 내보낸다.
    # 이 머티리얼에는 이미지가 없으므로 AUTO로 바꿔도 포함되는 텍스처는 없고,
    # 실제 FLOAT_COLOR Col만 런타임이 기대하는 COLOR_0으로 보존된다.
    embed_textures=True,
)
mw.finish()
print("[45_scatter] scatter-kit + foliage-kit OK")
