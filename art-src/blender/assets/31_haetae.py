# -*- coding: utf-8 -*-
"""해태 석상 — 앉은 비대칭 자세와 하이폴리 노멀 전사를 갖춘 1.45m 석상."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=3100)

TAU = math.tau


# ---------------------------------------------------------------------------
# 베이크 전에 사용할 공유 화강암. 결과 머티리얼은 아래에서 별도 이름으로 만든다.
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


def apply_boolean(target, cutter) -> None:
    mw.activate(target)
    modifier = target.modifiers.new("mw-ansang-recess", "BOOLEAN")
    modifier.operation = "DIFFERENCE"
    modifier.solver = "EXACT"
    modifier.object = cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def eye_recess_cutter(name: str, normal, tangent, width: float):
    """안상(眼象)의 길쭉한 눈꼴을 2.5cm만 파는 얕은 커터."""
    center_z = 0.135
    half_w = width * 0.5
    half_h = 0.065
    outline = []
    # 위 호는 조금 높고 아래 호는 낮아 전통 기단의 뾰족한 눈꼴이 된다.
    for index in range(9):
        theta = math.pi * index / 8.0
        outline.append((half_w * math.cos(theta), center_z + half_h * math.sin(theta)))
    for index in range(9):
        theta = math.pi + math.pi * index / 8.0
        outline.append((half_w * math.cos(theta), center_z + half_h * 0.58 * math.sin(theta)))

    surface = 0.300 if abs(normal[1]) > 0.5 else 0.450
    verts = []
    # 바깥에서 시작해 표면 안쪽 2.8cm까지만 들어간다. 관통 장식이 아니다.
    for depth in (-0.028, 0.035):
        radial = surface + depth
        for u, z in outline:
            verts.append(
                (
                    normal[0] * radial + tangent[0] * u,
                    normal[1] * radial + tangent[1] * u,
                    z,
                )
            )
    count = len(outline)
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    return mw.new_mesh(name, verts, faces)


def ellipsoid(name: str, location, scale, *, subdivisions=2, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdivisions, radius=1.0, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.rotation_euler = rotation
    mw.apply_transform(obj)
    return obj


def cone(name: str, location, radius: float, depth: float, *, rotation=(0.0, 0.0, 0.0), down=False):
    bpy.ops.mesh.primitive_cone_add(
        vertices=8,
        radius1=0.0 if down else radius,
        radius2=radius if down else 0.0,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    mw.apply_transform(obj)
    return obj


def triangular_wedge(name: str, center, mirror: float):
    """갈기 위로 솟은 귀. 얇은 평면이 아니라 뒤까지 막힌 쐐기다."""
    cx, cy, cz = center
    x0 = cx
    verts = [
        (x0 - 0.070 * mirror, cy - 0.030, cz - 0.075),
        (x0 + 0.040 * mirror, cy - 0.020, cz - 0.070),
        (x0 + 0.012 * mirror, cy + 0.005, cz + 0.075),
        (x0 - 0.070 * mirror, cy - 0.085, cz - 0.075),
        (x0 + 0.040 * mirror, cy - 0.075, cz - 0.070),
        (x0 + 0.012 * mirror, cy - 0.055, cz + 0.075),
    ]
    faces = [
        (0, 1, 2),
        (5, 4, 3),
        (0, 3, 4, 1),
        (1, 4, 5, 2),
        (2, 5, 3, 0),
    ]
    return mw.new_mesh(name, verts, faces)


def curl(name: str, center, radius: float, turns: float, phase: float, *, section_radius=0.017):
    """정면에서 읽히는 x-z 평면의 돌 갈기 소용돌이."""
    cx, cy, cz = center
    path = []
    steps = 11
    for index in range(steps):
        t = index / (steps - 1)
        angle = phase + turns * TAU * t
        r = radius * (1.0 - 0.64 * t)
        path.append((cx + math.cos(angle) * r, cy, cz + math.sin(angle) * r))
    section = [
        (
            math.cos(TAU * index / 6.0) * section_radius,
            math.sin(TAU * index / 6.0) * section_radius,
        )
        for index in range(6)
    ]
    return mw.sweep(
        name,
        section,
        path,
        up=(0.0, 1.0, 0.0),
        smooth=True,
        scale_fn=lambda t: 1.0 - 0.46 * t,
    )


# ---------------------------------------------------------------------------
# 대좌: 정확히 0.9 × 0.6 × 0.28m. 네 면의 안상은 실제 불리언 파임이다.
# ---------------------------------------------------------------------------

components = []
pedestal = mw.box("haetae-pedestal", (0.90, 0.60, 0.28), pivot_bottom=True)
for face_index, (normal, tangent, width) in enumerate(
    (
        ((0.0, 1.0), (1.0, 0.0), 0.31),
        ((0.0, -1.0), (-1.0, 0.0), 0.31),
        ((1.0, 0.0), (0.0, 1.0), 0.22),
        ((-1.0, 0.0), (0.0, -1.0), 0.22),
    )
):
    apply_boolean(
        pedestal,
        eye_recess_cutter(f"haetae-ansang-cutter-{face_index}", normal, tangent, width),
    )
mw.bevel(pedestal, 0.015, 2, angle_deg=34.0)
components.append(pedestal)


# ---------------------------------------------------------------------------
# 앉은 몸. +Y가 정면이다. 앞다리는 곧고 뒷다리는 접혀 있으며 오른발이 2cm
# 더 앞으로 나와 완벽한 좌우 대칭을 피한다.
# ---------------------------------------------------------------------------

components.extend(
    (
        ellipsoid("haetae-torso", (0.0, -0.055, 0.695), (0.285, 0.255, 0.405)),
        ellipsoid("haetae-broad-chest", (0.0, 0.145, 0.720), (0.255, 0.205, 0.330)),
        ellipsoid("haetae-neck", (0.0, 0.050, 0.950), (0.235, 0.205, 0.235)),
        ellipsoid("haetae-left-haunch", (-0.235, -0.145, 0.485), (0.215, 0.230, 0.205)),
        ellipsoid("haetae-right-haunch", (0.225, -0.165, 0.480), (0.205, 0.225, 0.198)),
        ellipsoid("haetae-left-folded-hock", (-0.275, 0.010, 0.365), (0.155, 0.205, 0.095)),
        ellipsoid("haetae-right-folded-hock", (0.270, -0.005, 0.360), (0.150, 0.198, 0.090)),
        ellipsoid("haetae-left-foreleg", (-0.145, 0.180, 0.520), (0.080, 0.088, 0.245)),
        ellipsoid("haetae-right-foreleg", (0.150, 0.200, 0.515), (0.083, 0.090, 0.238)),
        ellipsoid("haetae-left-paw", (-0.145, 0.245, 0.322), (0.105, 0.145, 0.052)),
        ellipsoid("haetae-right-paw", (0.150, 0.270, 0.320), (0.108, 0.150, 0.050)),
    )
)

# 발가락은 하단 2m 전부가 보이는 카메라에서 가장 가까운 조각이라 실제 작은
# 돌마디로 세운다. 양쪽 위치도 4mm씩 어긋나 있다.
for side_index, x_center in enumerate((-0.145, 0.150)):
    y_center = 0.326 if side_index == 0 else 0.353
    for toe_index, x_offset in enumerate((-0.055, 0.0, 0.055)):
        components.append(
            ellipsoid(
                f"haetae-toe-{side_index}-{toe_index}",
                (x_center + x_offset, y_center, 0.318 + toe_index * 0.002),
                (0.034, 0.055, 0.025),
                subdivisions=1,
            )
        )


# ---------------------------------------------------------------------------
# 큰 머리(전체 높이 약 30%). 머리와 얼굴 덩어리는 z축으로 3° 틀었다.
# 벌어진 입은 위턱과 아래턱 사이가 실제로 비어 있고, 어금니 네 개가 드러난다.
# ---------------------------------------------------------------------------

HEAD_TURN = math.radians(3.0)
components.extend(
    (
        ellipsoid(
            "haetae-large-head",
            (-0.006, 0.105, 1.155),
            (0.295, 0.255, 0.270),
            rotation=(0.0, 0.0, HEAD_TURN),
        ),
        ellipsoid(
            "haetae-upper-muzzle",
            (-0.012, 0.315, 1.105),
            (0.205, 0.178, 0.105),
            rotation=(0.0, 0.0, HEAD_TURN),
        ),
        ellipsoid(
            "haetae-lower-jaw",
            (-0.002, 0.325, 1.005),
            (0.182, 0.165, 0.065),
            rotation=(math.radians(-7.0), 0.0, HEAD_TURN),
        ),
        ellipsoid(
            "haetae-upturned-nose",
            (-0.018, 0.472, 1.130),
            (0.142, 0.078, 0.082),
            rotation=(math.radians(11.0), 0.0, HEAD_TURN),
        ),
    )
)

# 튀어나온 눈과 두꺼운 눈썹. 오른쪽 눈을 6mm 높여 석공의 비대칭을 남긴다.
for side, x, z in ((-1, -0.190, 1.235), (1, 0.184, 1.241)):
    components.append(ellipsoid(f"haetae-eye-{side}", (x, 0.302, z), (0.072, 0.058, 0.070)))
    components.append(
        ellipsoid(
            f"haetae-brow-{side}",
            (x, 0.277, z + 0.064),
            (0.102, 0.050, 0.038),
            rotation=(0.0, math.radians(side * 13.0), math.radians(side * 8.0)),
        )
    )

# 콧구멍은 들창코 아래에 붙은 두 오목한 테두리처럼 보이는 작은 고리다.
for side, x in ((-1, -0.067), (1, 0.040)):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.022,
        minor_radius=0.008,
        major_segments=8,
        minor_segments=4,
        location=(x, 0.535, 1.135),
        rotation=(math.pi * 0.5, 0.0, 0.0),
    )
    nostril = bpy.context.object
    nostril.name = f"haetae-nostril-{side}"
    components.append(nostril)

# 위 어금니 둘은 아래로, 아래 어금니 둘은 위로 향한다.
for tooth_index, x in enumerate((-0.108, 0.092)):
    components.append(
        cone(
            f"haetae-upper-fang-{tooth_index}",
            (x, 0.445, 1.055),
            0.026,
            0.090,
            down=True,
        )
    )
for tooth_index, x in enumerate((-0.080, 0.116)):
    components.append(
        cone(
            f"haetae-lower-fang-{tooth_index}",
            (x, 0.438, 1.042),
            0.022,
            0.072,
        )
    )

components.append(triangular_wedge("haetae-left-ear", (-0.205, 0.015, 1.315), -1.0))
components.append(triangular_wedge("haetae-right-ear", (0.200, -0.005, 1.309), 1.0))

# 해태의 한 뿔. 3° 고개 틀기와 같은 방향으로 약간 기울며 최고점이 1.45m다.
components.append(
    cone(
        "haetae-single-horn",
        (-0.008, 0.060, 1.382),
        0.040,
        0.136,
        rotation=(math.radians(-9.0), 0.0, HEAD_TURN),
    )
)


# ---------------------------------------------------------------------------
# 갈기와 꼬리. 소용돌이 덩어리는 노멀만으로 만들지 않고 sweep 실루엣과 둥근
# 돌혹을 겹친다. 꼬리는 뒤에서 왼쪽 옆구리를 감아 가슴 아래까지 올라간다.
# ---------------------------------------------------------------------------

mane_specs = (
    ((-0.245, 0.238, 1.260), 0.082, 0.78, 0.2),
    ((0.238, 0.230, 1.270), 0.080, 0.82, 1.1),
    ((-0.278, 0.165, 1.120), 0.075, 0.72, 2.0),
    ((0.270, 0.150, 1.125), 0.078, 0.76, 2.8),
    ((-0.225, 0.090, 1.020), 0.070, 0.70, 0.7),
    ((0.220, 0.075, 1.025), 0.068, 0.73, 1.7),
    ((0.000, 0.035, 1.325), 0.074, 0.82, 2.4),
)
for curl_index, (center, radius, turns, phase) in enumerate(mane_specs):
    components.append(curl(f"haetae-mane-curl-{curl_index}", center, radius, turns, phase))
    components.append(
        ellipsoid(
            f"haetae-mane-lump-{curl_index}",
            center,
            (radius * 0.82, 0.055, radius * 0.78),
            subdivisions=1,
        )
    )

tail_path = [
    (0.030, -0.305, 0.390),
    (-0.180, -0.310, 0.405),
    (-0.315, -0.210, 0.475),
    (-0.340, -0.020, 0.575),
    (-0.325, 0.095, 0.705),
    (-0.285, 0.105, 0.825),
    (-0.235, 0.060, 0.920),
]
tail_section = [
    (math.cos(TAU * index / 8.0) * 0.046, math.sin(TAU * index / 8.0) * 0.046)
    for index in range(8)
]
components.append(
    mw.sweep(
        "haetae-wrapping-tail",
        tail_section,
        tail_path,
        smooth=True,
        scale_fn=lambda t: 1.0 - 0.38 * t,
    )
)
components.append(curl("haetae-tail-tuft", (-0.225, 0.075, 0.940), 0.070, 0.82, 1.4))


# ---------------------------------------------------------------------------
# 하이폴리 → 로우폴리. 모든 덩어리를 먼저 합치고 Catmull-Clark로 부드럽게 만든
# 결과가 high다. 그 복사본을 데시메이트한 뒤 지정 함수로 정확히 베이크한다.
# ---------------------------------------------------------------------------

high = mw.join("haetae-high", components)
mw.apply_transform(high)
mw.assign(high, granite)
mw.subdivide(high, levels=1)
mw.shade_auto_smooth(high, 40.0)

low = high.copy()
low.data = high.data.copy()
low.name = "haetae"
low.data.name = "haetae"
bpy.context.scene.collection.objects.link(low)
mw.decimate(low, 0.42)
mw.shade_auto_smooth(low, 38.0)
mw.uv_smart(low, angle_deg=58.0, island_margin=0.008)

baked = mw.bake_high_to_low(low, high, "haetae")

haetae_material = mw.material(
    mw.MaterialSpec(
        name="mw/prop/haetae",
        base_color=(1.0, 1.0, 1.0, 1.0),
        roughness=0.80,
        base_color_map="env/tex/ground/granite-slab_basecolor.webp",
        normal_map=baked["normal"],
        orm_map="env/tex/ground/granite-slab_orm.webp",
        normal_strength=1.0,
        uv_scale=0.5,
        shader="stone",
        arc_response=1.0,
    )
)
mw.assign(low, haetae_material)
bpy.data.objects.remove(high, do_unlink=True)

# 원점은 첫 부품인 대좌의 바닥 중심을 그대로 유지한다. 수치 오류가 생기면
# 익스포트 전에 즉시 실패시켜 1.45m 계약을 조용히 넘기지 않는다.
world_z = [float((low.matrix_world @ vertex.co).z) for vertex in low.data.vertices]
if min(world_z) < -0.001 or max(world_z) > 1.451:
    raise SystemExit(
        f"[31_haetae] 높이 계약 위반: z={min(world_z):.4f}..{max(world_z):.4f}"
    )

mw.export_glb(
    "haetae",
    [low],
    max_triangles=9_000,
    notes="1.45m seated haetae with recessed ansang pedestal, asymmetric paws/head, and baked high-poly normal",
    extras={"normalBake": baked["normal"], "aoBake": baked.get("ao")},
)
mw.finish()
