# -*- coding: utf-8 -*-
"""명월단 각루 — r=34 대각선 네 곳의 단층 사모지붕 정자.

문루와 같은 부재 어휘를 줄여 쓴다. 3.4m 석축 위에 2.4m 누각, 그 위에
1.8m 사모지붕이 놓인다. 메시 자체가 +Y의 r=34에 휘어 있어 원점 둘레로
45/135/225/315도 회전하면 네 대각선 배치가 끝난다.
"""

import bmesh
import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=2200)

RADIUS = 34.0
BASE_HALF = 2.38
BASE_INNER = -1.42
BASE_OUTER = 1.42
BASE_TOP = 3.40
PAVILION_TOP = 5.80
ROOF_TOP = 7.60
EAVE_Z = 5.80


# ---------------------------------------------------------------------------
# 기존 arch 머티리얼
# ---------------------------------------------------------------------------


def arch_material(
    name: str,
    *,
    roughness: float,
    uv_scale: float,
    shader: str,
    arc_response: float,
) -> bpy.types.Material:
    stem = name.split("/")[-1]
    return mw.material(
        mw.MaterialSpec(
            name=name,
            base_color=(1.0, 1.0, 1.0, 1.0),
            roughness=roughness,
            base_color_map=f"env/tex/arch/{stem}_basecolor.webp",
            normal_map=f"env/tex/arch/{stem}_normal.webp",
            orm_map=f"env/tex/arch/{stem}_orm.webp",
            uv_scale=uv_scale,
            shader=shader,
            arc_response=arc_response,
        )
    )


masonry = arch_material(
    "mw/arch/masonry",
    roughness=0.82,
    uv_scale=0.35,
    shader="stone",
    arc_response=1.0,
)
painted = arch_material(
    "mw/arch/painted-wood",
    roughness=0.58,
    uv_scale=0.60,
    shader="default",
    arc_response=0.35,
)
roof_tile = arch_material(
    "mw/arch/roof-tile",
    roughness=0.74,
    uv_scale=1.20,
    shader="stone",
    arc_response=1.0,
)


# ---------------------------------------------------------------------------
# 메시 도구
# ---------------------------------------------------------------------------


def ring_point(x: float, radial_offset: float, z: float) -> Vector:
    radius = RADIUS + radial_offset
    return Vector((x, math.sqrt(radius * radius - x * x), z))


def circle_section(radius: float, segments: int = 8) -> list[tuple[float, float]]:
    return [
        (
            math.cos(math.tau * index / segments) * radius,
            math.sin(math.tau * index / segments) * radius,
        )
        for index in range(segments)
    ]


def cap_sweep(obj: bpy.types.Object) -> None:
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    boundary = [edge for edge in bm.edges if edge.is_boundary]
    if boundary:
        bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


def finish_part(
    obj: bpy.types.Object,
    material: bpy.types.Material,
    *,
    bevel_width: float,
    uv_scale: float = 1.0,
    cylinder_uv: bool = False,
    apply_transform: bool = True,
) -> bpy.types.Object:
    if apply_transform:
        mw.apply_transform(obj)
    mw.assign(obj, material)
    mw.bevel(obj, bevel_width, 2, angle_deg=38.0)
    mw.shade_auto_smooth(obj, 38.0)
    if cylinder_uv:
        mw.uv_cylinder(obj, u_scale=uv_scale, v_scale=uv_scale)
    else:
        mw.uv_box(obj, uv_scale)
    return obj


def box_part(
    name: str,
    size: tuple[float, float, float],
    center: tuple[float, float, float],
    material: bpy.types.Material,
    *,
    bevel_width: float,
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    obj = mw.box(name, size, center)
    obj.rotation_euler = Euler(rotation, "XYZ")
    return finish_part(
        obj,
        material,
        bevel_width=bevel_width,
    )


def sweep_part(
    name: str,
    section: list[tuple[float, float]],
    path: list[tuple[float, float, float]],
    material: bpy.types.Material,
    *,
    bevel_width: float,
    up: tuple[float, float, float] = (0.0, 0.0, 1.0),
    smooth: bool = False,
) -> bpy.types.Object:
    obj = mw.sweep(
        name,
        section,
        path,
        closed_section=True,
        closed_path=False,
        up=up,
        smooth=smooth,
    )
    cap_sweep(obj)
    return finish_part(
        obj,
        material,
        bevel_width=bevel_width,
        apply_transform=False,
    )


def wedge_block(
    name: str,
    x0: float,
    x1: float,
    z0: float,
    z1: float,
) -> bpy.types.Object:
    """상부가 반경 중심으로 2% 물리는 폐합 석축 블록."""
    inward0 = z0 * 0.02
    inward1 = z1 * 0.02
    points = [
        ring_point(x0, BASE_INNER - inward0, z0),
        ring_point(x1, BASE_INNER - inward0, z0),
        ring_point(x1, BASE_OUTER - inward0, z0),
        ring_point(x0, BASE_OUTER - inward0, z0),
        ring_point(x0, BASE_INNER - inward1, z1),
        ring_point(x1, BASE_INNER - inward1, z1),
        ring_point(x1, BASE_OUTER - inward1, z1),
        ring_point(x0, BASE_OUTER - inward1, z1),
    ]
    obj = mw.new_mesh(
        name,
        [tuple(point) for point in points],
        [
            (0, 3, 2, 1),
            (4, 5, 6, 7),
            (0, 1, 5, 4),
            (1, 2, 6, 5),
            (2, 3, 7, 6),
            (3, 0, 4, 7),
        ],
    )
    return finish_part(
        obj,
        masonry,
        bevel_width=0.018,
        apply_transform=False,
    )


def solid_polygon_panel(
    name: str,
    outline: list[Vector],
    *,
    thickness: float,
) -> bpy.types.Object:
    bottom = [Vector((point.x, point.y, point.z - thickness)) for point in outline]
    count = len(outline)
    verts = [tuple(point) for point in outline + bottom]
    faces: list[tuple[int, ...]] = [
        tuple(range(count)),
        tuple(reversed(range(count, count * 2))),
    ]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    obj = mw.new_mesh(name, verts, faces)
    return finish_part(
        obj,
        roof_tile,
        bevel_width=0.012,
        apply_transform=False,
    )


# ---------------------------------------------------------------------------
# 3.4m 석축 기단 — 네 단의 큰 화강암 블록
# ---------------------------------------------------------------------------


stone_parts: list[bpy.types.Object] = []
course_height = BASE_TOP / 4.0
for course in range(4):
    z0 = course * course_height
    z1 = (course + 1) * course_height
    block_count = 4 if course % 2 == 0 else 5
    block_width = BASE_HALF * 2.0 / block_count
    phase = 0.0 if course % 2 == 0 else block_width * 0.16
    for block in range(block_count):
        generator = mw.rng(f"tower-base-{course}-{block}")
        x0 = max(
            -BASE_HALF,
            -BASE_HALF + block * block_width - phase,
        )
        x1 = min(
            BASE_HALF,
            -BASE_HALF + (block + 1) * block_width - phase,
        )
        if x1 - x0 < 0.25:
            continue
        stone_parts.append(
            wedge_block(
                f"corner-tower-base-{course}-{block}",
                x0 + 0.012,
                x1 - 0.012,
                z0 + 0.012 + float(generator.uniform(-0.003, 0.003)),
                z1 - 0.012 + float(generator.uniform(-0.003, 0.003)),
            )
        )

# 아래 지대석과 위 미석은 본체보다 각각 8cm, 10cm 돌출한다.
for name, half, radial0, radial1, z0, z1 in (
    ("corner-tower-footing", 2.46, -1.50, 1.50, 0.0, 0.18),
    ("corner-tower-coping", 2.48, -1.50, 1.50, 3.24, 3.40),
):
    points = [
        ring_point(-half, radial0, z0),
        ring_point(half, radial0, z0),
        ring_point(half, radial1, z0),
        ring_point(-half, radial1, z0),
        ring_point(-half, radial0 - z1 * 0.02, z1),
        ring_point(half, radial0 - z1 * 0.02, z1),
        ring_point(half, radial1 - z1 * 0.02, z1),
        ring_point(-half, radial1 - z1 * 0.02, z1),
    ]
    obj = mw.new_mesh(
        name,
        [tuple(point) for point in points],
        [
            (0, 3, 2, 1),
            (4, 5, 6, 7),
            (0, 1, 5, 4),
            (1, 2, 6, 5),
            (2, 3, 7, 6),
            (3, 0, 4, 7),
        ],
    )
    stone_parts.append(
        finish_part(
            obj,
            masonry,
            bevel_width=0.020,
            apply_transform=False,
        )
    )


# ---------------------------------------------------------------------------
# 2.4m 누각 — 4기둥, 창방·평방, 공포 4조, 사방 계자난간
# ---------------------------------------------------------------------------


wood_parts: list[bpy.types.Object] = []
column_positions = [
    (-1.56, -0.94),
    (1.56, -0.94),
    (-1.56, 0.94),
    (1.56, 0.94),
]
for index, (x, radial) in enumerate(column_positions):
    generator = mw.rng(f"tower-column-{index}")
    base = ring_point(x, radial, 3.48)
    column = mw.lathe(
        f"corner-tower-column-{index}",
        [
            (0.172, 0.00),
            (0.177, 0.14),
            (0.177, 0.88),
            (0.174, 1.54),
            (0.165, 1.76),
        ],
        12,
        location=tuple(base),
        smooth=True,
        cap=True,
    )
    column.rotation_euler = Euler(
        (
            math.radians(float(generator.uniform(-0.24, 0.24))),
            math.radians(float(generator.uniform(-0.24, 0.24))),
            0.0,
        ),
        "XYZ",
    )
    wood_parts.append(
        finish_part(
            column,
            painted,
            bevel_width=0.008,
            uv_scale=0.75,
            cylinder_uv=True,
        )
    )

# 앞뒤 창방·평방.
for radial in (-0.94, 0.94):
    for z, half_radial, half_z in ((5.18, 0.095, 0.105), (5.42, 0.115, 0.095)):
        path = [
            tuple(ring_point(x, radial, z))
            for x in (-1.72, -0.86, 0.0, 0.86, 1.72)
        ]
        wood_parts.append(
            sweep_part(
                f"corner-tower-beam-{radial:+.2f}-{z:.2f}",
                [
                    (-half_radial, -half_z),
                    (half_radial, -half_z),
                    (half_radial, half_z),
                    (-half_radial, half_z),
                ],
                path,
                painted,
                bevel_width=0.009,
            )
        )

# 좌우 창방·평방.
for side in (-1, 1):
    x = side * 1.56
    for z in (5.18, 5.42):
        path = [
            tuple(ring_point(x, radial, z))
            for radial in (-1.08, 0.0, 1.08)
        ]
        wood_parts.append(
            sweep_part(
                f"corner-tower-side-beam-{side}-{z:.2f}",
                [(-0.095, -0.095), (0.095, -0.095), (0.095, 0.095), (-0.095, 0.095)],
                path,
                painted,
                bevel_width=0.009,
            )
        )

# 네 기둥 머리마다 축소 공포 한 조: 주두 + 첨차 두 단.
for index, (x, radial) in enumerate(column_positions):
    point = ring_point(x, radial, 5.30)
    wood_parts.append(
        box_part(
            f"corner-tower-capital-{index}",
            (0.31, 0.31, 0.20),
            (point.x, point.y, point.z),
            painted,
            bevel_width=0.008,
        )
    )
    for tier, (z, span) in enumerate(((5.45, 0.62), (5.58, 0.82))):
        wood_parts.append(
            box_part(
                f"corner-tower-bracket-x-{index}-{tier}",
                (span, 0.15, 0.13),
                (point.x, point.y, z),
                painted,
                bevel_width=0.008,
            )
        )
        wood_parts.append(
            box_part(
                f"corner-tower-bracket-y-{index}-{tier}",
                (0.15, span, 0.13),
                (point.x, point.y, z - 0.022),
                painted,
                bevel_width=0.008,
            )
        )

# 앞뒤 난간의 관통 살대.
for radial in (-1.12, 1.12):
    for z in (3.68, 4.24):
        path = [
            tuple(ring_point(x, radial, z))
            for x in (-1.66, -0.83, 0.0, 0.83, 1.66)
        ]
        wood_parts.append(
            sweep_part(
                f"corner-tower-railing-x-{radial:+.2f}-{z:.2f}",
                [(-0.050, -0.045), (0.050, -0.045), (0.050, 0.045), (-0.050, 0.045)],
                path,
                painted,
                bevel_width=0.006,
            )
        )
    for index, x in enumerate((-1.48, -1.10, -0.72, -0.34, 0.04, 0.42, 0.80, 1.18, 1.48)):
        point = ring_point(x, radial, 3.96)
        wood_parts.append(
            box_part(
                f"corner-tower-baluster-x-{radial:+.2f}-{index}",
                (0.048, 0.052, 0.48),
                (point.x, point.y, point.z),
                painted,
                bevel_width=0.006,
            )
        )

# 좌우 난간도 판으로 막지 않고 살대를 관통시킨다.
for side in (-1, 1):
    x = side * 1.76
    for z in (3.68, 4.24):
        path = [
            tuple(ring_point(x, radial, z))
            for radial in (-1.03, 0.0, 1.03)
        ]
        wood_parts.append(
            sweep_part(
                f"corner-tower-railing-y-{side}-{z:.2f}",
                [(-0.050, -0.045), (0.050, -0.045), (0.050, 0.045), (-0.050, 0.045)],
                path,
                painted,
                bevel_width=0.006,
            )
        )
    for index, radial in enumerate((-0.82, -0.41, 0.0, 0.41, 0.82)):
        point = ring_point(x, radial, 3.96)
        wood_parts.append(
            box_part(
                f"corner-tower-baluster-y-{side}-{index}",
                (0.052, 0.048, 0.48),
                (point.x, point.y, point.z),
                painted,
                bevel_width=0.006,
            )
        )


# ---------------------------------------------------------------------------
# 1.8m 사모지붕 — 네 곡선 처마, 네 추녀마루, 네 추녀·사래
# ---------------------------------------------------------------------------


roof_parts: list[bpy.types.Object] = []
eave_half_x = 2.72
eave_half_y = 2.06
apex = ring_point(0.0, 0.0, 7.56)

# 앞뒤 삼각 사면.
for front in (-1, 1):
    eave = [
        ring_point(
            x,
            front * eave_half_y,
            EAVE_Z + 0.16 * (abs(x) / eave_half_x) ** 2.3,
        )
        for x in (-2.72, -1.81, -0.91, 0.0, 0.91, 1.81, 2.72)
    ]
    roof_parts.append(
        solid_polygon_panel(
            f"corner-tower-roof-{'front' if front > 0 else 'back'}",
            [apex] + eave,
            thickness=0.10,
        )
    )

# 좌우 삼각 사면.
for side in (-1, 1):
    eave = [
        ring_point(
            side * eave_half_x,
            radial,
            EAVE_Z + 0.16 + 0.06 * (abs(radial) / eave_half_y) ** 2.0,
        )
        for radial in (-2.06, -1.37, -0.69, 0.0, 0.69, 1.37, 2.06)
    ]
    roof_parts.append(
        solid_polygon_panel(
            f"corner-tower-roof-side-{side}",
            [apex] + eave,
            thickness=0.10,
        )
    )

# 안허리곡이 있는 네 처마선을 sweep으로 분명히 만든다.
eave_paths: list[list[tuple[float, float, float]]] = []
for front in (-1, 1):
    eave_paths.append(
        [
            tuple(
                ring_point(
                    x,
                    front * (eave_half_y + 0.02),
                    EAVE_Z + 0.16 * (abs(x) / eave_half_x) ** 2.3,
                )
            )
            for x in (-2.72, -1.81, -0.91, 0.0, 0.91, 1.81, 2.72)
        ]
    )
for side in (-1, 1):
    eave_paths.append(
        [
            tuple(
                ring_point(
                    side * eave_half_x,
                    radial,
                    EAVE_Z + 0.16 + 0.06 * (abs(radial) / eave_half_y) ** 2.0,
                )
            )
            for radial in (-2.08, -1.39, -0.69, 0.0, 0.69, 1.39, 2.08)
        ]
    )
for index, path in enumerate(eave_paths):
    roof_parts.append(
        sweep_part(
            f"corner-tower-curved-eave-{index}",
            [(-0.070, -0.060), (0.070, -0.060), (0.070, 0.060), (-0.070, 0.060)],
            path,
            roof_tile,
            bevel_width=0.012,
        )
    )

# 네 추녀마루. 중간이 직선보다 7cm 높아 앙곡이 실제 메시 실루엣에 남는다.
corner_specs = [(side, front) for side in (-1, 1) for front in (-1, 1)]
for index, (side, front) in enumerate(corner_specs):
    ridge_path = []
    for step in range(5):
        t = step / 4.0
        x = side * eave_half_x * t
        radial = front * eave_half_y * t
        z = 7.55 * (1.0 - t) + (EAVE_Z + 0.20) * t
        z += 0.07 * math.sin(math.pi * t)
        ridge_path.append(tuple(ring_point(x, radial, z)))
    roof_parts.append(
        sweep_part(
            f"corner-tower-hip-ridge-{index}",
            circle_section(0.052, 8),
            ridge_path,
            roof_tile,
            bevel_width=0.012,
            smooth=True,
        )
    )

    # 추녀와 사래를 네 귀에 한 쌍씩 둔다.
    wood_parts.append(
        sweep_part(
            f"corner-tower-chunyeo-{index}",
            [(-0.068, -0.058), (0.068, -0.058), (0.068, 0.058), (-0.068, 0.058)],
            [
                tuple(ring_point(0.0, 0.0, 7.34)),
                tuple(ring_point(side * 1.36, front * 1.03, 6.60)),
                tuple(ring_point(side * 2.68, front * 2.02, EAVE_Z - 0.04)),
            ],
            painted,
            bevel_width=0.009,
        )
    )
    wood_parts.append(
        sweep_part(
            f"corner-tower-sarae-{index}",
            [(-0.054, -0.048), (0.054, -0.048), (0.054, 0.048), (-0.054, 0.048)],
            [
                tuple(ring_point(side * 2.47, front * 1.83, EAVE_Z - 0.01)),
                tuple(ring_point(side * 2.72, front * 2.08, EAVE_Z + 0.14)),
            ],
            painted,
            bevel_width=0.008,
        )
    )

# +Y 처마 밑 서까래 한 줄만 실제 지오메트리로 남긴다.
for index, x in enumerate((-2.28, -1.71, -1.14, -0.57, 0.0, 0.57, 1.14, 1.71, 2.28)):
    wood_parts.append(
        sweep_part(
            f"corner-tower-rafter-front-{index}",
            circle_section(0.040, 8),
            [
                tuple(ring_point(x * 0.74, 0.76, 6.52)),
                tuple(
                    ring_point(
                        x,
                        2.00,
                        EAVE_Z - 0.08 + 0.11 * (abs(x) / 2.28) ** 2,
                    )
                ),
            ],
            painted,
            bevel_width=0.006,
            smooth=True,
        )
    )


# ---------------------------------------------------------------------------
# 결합과 자체 검증
# ---------------------------------------------------------------------------


stone_group = mw.join("corner-tower-stone", stone_parts)
mw.assign_by_index(stone_group, (masonry,), lambda _center, _normal: 0)
wood_group = mw.join("corner-tower-wood", wood_parts)
mw.assign_by_index(wood_group, (painted,), lambda _center, _normal: 0)
roof_group = mw.join("corner-tower-roof", roof_parts)
mw.assign_by_index(roof_group, (roof_tile,), lambda _center, _normal: 0)

corner_tower = mw.join(
    "corner-tower",
    [stone_group, wood_group, roof_group],
)
mw.shade_auto_smooth(corner_tower, 38.0)
mw.uv_box(corner_tower, 1.0)


def tower_color(world: Vector, normal: Vector) -> tuple[float, float, float]:
    radius = max(1.0e-6, math.hypot(world.x, world.y))
    radial_normal = (world.x * normal.x + world.y * normal.y) / radius
    low = max(0.0, 1.0 - world.z / 3.4)
    asymmetry = 0.5 + 0.5 * math.sin(world.x * 1.91 + world.y * 0.27 + world.z * 2.43)
    corner_weather = max(0.0, 1.0 - abs(world.x - 1.48) / 0.55)
    wear = 0.16 + low * 0.22 + asymmetry * 0.12 + corner_weather * 0.08
    damp = 0.04 + max(0.0, -radial_normal) * 0.22 + low * 0.15
    crack = 0.03 + corner_weather * 0.30
    return (wear, damp, crack)


mw.set_vertex_colors(corner_tower, tower_color)
color = corner_tower.data.color_attributes.get("Col")
if color is not None:
    corner_tower.data.color_attributes.active_color = color
    corner_tower.data.color_attributes.active = color

triangles = sum(
    max(0, len(polygon.vertices) - 2)
    for polygon in corner_tower.data.polygons
)
z_values = [
    float((corner_tower.matrix_world @ vertex.co).z)
    for vertex in corner_tower.data.vertices
]
z_min, z_max = min(z_values), max(z_values)
print(
    f"[22_tower] corner-tower: {triangles:,} tris, "
    f"z-range {z_min:+.6f} .. {z_max:+.6f} m"
)
if triangles > 18_000:
    raise SystemExit(f"[22_tower] 예산 초과: {triangles:,} > 18,000")
if z_min < -0.0001 or z_max > ROOF_TOP + 0.0001:
    raise SystemExit(
        f"[22_tower] 높이 위반: {z_min:+.6f} .. {z_max:+.6f}m"
    )

mw.export_glb(
    "corner-tower",
    [corner_tower],
    max_triangles=18_000,
    notes=(
        "r=34 curved diagonal corner pavilion; battered masonry base, four "
        "asymmetric entasis columns, four real two-tier brackets, open balustrades, "
        "and swept upturned pyramidal roof"
    ),
    extras={
        "zMin": round(z_min, 6),
        "zMax": round(z_max, 6),
        "radius": RADIUS,
        "facings": "+Y outward",
        "storeys": 1,
        "baseHeight": BASE_TOP,
        "pavilionHeight": PAVILION_TOP - BASE_TOP,
        "roofHeight": ROOF_TOP - PAVILION_TOP,
        "placementDegrees": [45, 135, 225, 315],
        "vertexColor": "Col: R wear, G moss/damp shade, B crack proximity",
    },
)
mw.finish()
print("[22_tower] corner-tower OK")
