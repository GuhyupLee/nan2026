# -*- coding: utf-8 -*-
"""명월단 문루 — 관통 홍예문과 곡선 팔작지붕.

성벽 조각과 마찬가지로 메시가 이미 r=34에 휘어 있다. 원점 둘레로 회전하면
네 방위에 같은 문루를 놓을 수 있고, +Y가 성 바깥이다.

카메라에서 실제로 오래 보이는 높이는 0~4m다. 그래서 삼각형과 부재 밀도는
석축 블록, 홍예석, 문짝, 난간 하부에 집중한다. 지붕은 기와를 낱장으로 만들지
않고 네 장의 저밀도 폐합 면과 곡선 처마·마루만 실제 지오메트리로 만든다.
"""

import bmesh
import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=2100)

RADIUS = 34.0
HALF_WIDTH = 3.60
BASE_INNER = -0.80
BASE_OUTER = 0.80
BASE_TOP = 3.40
ARCH_HALF = 1.80
ARCH_SPRING = 2.00
ARCH_RISE = 1.10
ROOF_EAVE = 5.76
ROOF_RIDGE = 8.30
ROOF_HALF = 3.50  # sweep 단면까지 포함해 석축의 7.2m 폭 안에 둔다.


# ---------------------------------------------------------------------------
# 기존 머티리얼만 사용
# ---------------------------------------------------------------------------


def arch_material(
    name: str,
    *,
    roughness: float,
    metallic: float,
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
            metallic=metallic,
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
    metallic=0.0,
    uv_scale=0.35,
    shader="stone",
    arc_response=1.0,
)
timber = arch_material(
    "mw/arch/timber",
    roughness=0.82,
    metallic=0.0,
    uv_scale=0.45,
    shader="default",
    arc_response=0.90,
)
painted = arch_material(
    "mw/arch/painted-wood",
    roughness=0.58,
    metallic=0.0,
    uv_scale=0.60,
    shader="default",
    arc_response=0.35,
)
roof_tile = arch_material(
    "mw/arch/roof-tile",
    roughness=0.74,
    metallic=0.0,
    uv_scale=1.20,
    shader="stone",
    arc_response=1.0,
)
bronze = arch_material(
    "mw/arch/bronze",
    roughness=0.52,
    metallic=1.0,
    uv_scale=0.85,
    shader="default",
    arc_response=0.55,
)


# ---------------------------------------------------------------------------
# 좌표와 공통 메시 도구
# ---------------------------------------------------------------------------


def ring_point(x: float, radial_offset: float, z: float) -> Vector:
    """월드 x 폭을 보존하면서 r=34 원호에 얹는다."""
    radius = RADIUS + radial_offset
    if abs(x) >= radius:
        raise ValueError("ring_point: 폭이 반경보다 크다")
    return Vector((x, math.sqrt(radius * radius - x * x), z))


def arch_height(x: float) -> float:
    t = max(0.0, 1.0 - (x / ARCH_HALF) ** 2)
    return ARCH_SPRING + ARCH_RISE * math.sqrt(t)


def circle_section(radius: float, segments: int = 8) -> list[tuple[float, float]]:
    return [
        (
            math.cos(math.tau * index / segments) * radius,
            math.sin(math.tau * index / segments) * radius,
        )
        for index in range(segments)
    ]


def cap_sweep(obj: bpy.types.Object) -> None:
    """mw.sweep의 열린 경로 양끝을 막아 차폐 페이드에서도 속이 안 보이게 한다."""
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
    uv_scale: float = 1.0,
) -> bpy.types.Object:
    obj = mw.box(name, size, center)
    obj.rotation_euler = Euler(rotation, "XYZ")
    return finish_part(
        obj,
        material,
        bevel_width=bevel_width,
        uv_scale=uv_scale,
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
        uv_scale=1.0,
        apply_transform=False,
    )


def wedge_block(
    name: str,
    x0: float,
    x1: float,
    z0: float,
    z1: float,
    *,
    radial0: tuple[float, float] = (BASE_INNER, BASE_OUTER),
    radial1: tuple[float, float] | None = None,
) -> bpy.types.Object:
    """큰 화강암 블록 한 장. 위쪽은 반경 중심으로 2% 물린다."""
    if radial1 is None:
        inward = z1 * 0.02
        radial1 = (radial0[0] - inward, radial0[1] - inward)
    points = [
        ring_point(x0, radial0[0], z0),
        ring_point(x1, radial0[0], z0),
        ring_point(x1, radial0[1], z0),
        ring_point(x0, radial0[1], z0),
        ring_point(x0, radial1[0], z1),
        ring_point(x1, radial1[0], z1),
        ring_point(x1, radial1[1], z1),
        ring_point(x0, radial1[1], z1),
    ]
    faces = [
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    obj = mw.new_mesh(name, [tuple(point) for point in points], faces)
    return finish_part(
        obj,
        masonry,
        bevel_width=0.018,
        uv_scale=1.0,
        apply_transform=False,
    )


def profile_prism(
    name: str,
    profile: list[tuple[float, float]],
    radial0: float,
    radial1: float,
    material: bpy.types.Material,
    *,
    bevel_width: float,
) -> bpy.types.Object:
    """x/z 윤곽을 r=34 곡면의 두 반경 사이로 압출한 폐합 메시."""
    verts = [
        tuple(ring_point(x, radial, z))
        for radial in (radial0, radial1)
        for x, z in profile
    ]
    count = len(profile)
    faces: list[tuple[int, ...]] = [
        tuple(reversed(range(count))),
        tuple(range(count, count * 2)),
    ]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    obj = mw.new_mesh(name, verts, faces)
    return finish_part(
        obj,
        material,
        bevel_width=bevel_width,
        uv_scale=1.0,
        apply_transform=False,
    )


def solid_grid_panel(
    name: str,
    rows: list[list[Vector]],
    material: bpy.types.Material,
    *,
    thickness: float,
    bevel_width: float,
) -> bpy.types.Object:
    """같은 열 수를 가진 곡면 그리드를 수직 두께가 있는 지붕판으로 만든다."""
    row_count = len(rows)
    column_count = len(rows[0])
    top = [point for row in rows for point in row]
    bottom = [Vector((point.x, point.y, point.z - thickness)) for point in top]
    verts = [tuple(point) for point in top + bottom]
    layer = row_count * column_count
    faces: list[tuple[int, ...]] = []

    for row in range(row_count - 1):
        for column in range(column_count - 1):
            a = row * column_count + column
            b = a + 1
            d = (row + 1) * column_count + column
            c = d + 1
            faces.append((a, b, c, d))
            faces.append((layer + d, layer + c, layer + b, layer + a))

    boundary: list[int] = []
    boundary.extend(range(column_count))
    boundary.extend(
        row * column_count + column_count - 1
        for row in range(1, row_count)
    )
    boundary.extend(
        range((row_count - 1) * column_count + column_count - 2, (row_count - 1) * column_count - 1, -1)
    )
    boundary.extend(
        row * column_count
        for row in range(row_count - 2, 0, -1)
    )
    for index, current in enumerate(boundary):
        nxt = boundary[(index + 1) % len(boundary)]
        faces.append((current, nxt, layer + nxt, layer + current))

    obj = mw.new_mesh(name, verts, faces)
    return finish_part(
        obj,
        material,
        bevel_width=bevel_width,
        uv_scale=1.0,
        apply_transform=False,
    )


def solid_polygon_panel(
    name: str,
    outline: list[Vector],
    material: bpy.types.Material,
    *,
    thickness: float,
    bevel_width: float,
) -> bpy.types.Object:
    top = outline
    bottom = [Vector((point.x, point.y, point.z - thickness)) for point in outline]
    count = len(outline)
    verts = [tuple(point) for point in top + bottom]
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
        material,
        bevel_width=bevel_width,
        uv_scale=1.0,
        apply_transform=False,
    )


# ---------------------------------------------------------------------------
# 0~3.4m 석축: 실제로 빈 홍예 통로
# ---------------------------------------------------------------------------


stone_parts: list[bpy.types.Object] = []

# 좌우 석축은 다섯 단, 줄눈은 한 단씩 반 칸 어긋난다. 개별 블록의 위치·높이
# 편차는 4mm 이내라 통로 폭과 총높이를 해치지 않으면서 좌우 대칭을 깨뜨린다.
course_height = (BASE_TOP - 0.14) / 5.0
for course in range(5):
    z0 = 0.14 + course * course_height
    z1 = 0.14 + (course + 1) * course_height
    for side in (-1, 1):
        edge0, edge1 = ((-HALF_WIDTH, -2.08) if side < 0 else (2.08, HALF_WIDTH))
        split = 2 if course % 2 == 0 else 3
        width = (edge1 - edge0) / split
        for block in range(split):
            generator = mw.rng(f"base-{course}-{side}-{block}")
            x0 = edge0 + block * width + 0.012
            x1 = edge0 + (block + 1) * width - 0.012
            local_z0 = z0 + float(generator.uniform(-0.0035, 0.0035))
            local_z1 = z1 + float(generator.uniform(-0.0035, 0.0035))
            stone_parts.append(
                wedge_block(
                    f"gatehouse-base-{course}-{side}-{block}",
                    x0,
                    x1,
                    local_z0 + 0.010,
                    local_z1 - 0.010,
                )
            )

# 문설주는 통로 가장자리의 길고 굵은 돌로 따로 읽힌다.
for side in (-1, 1):
    x0, x1 = ((-2.07, -1.82) if side < 0 else (1.82, 2.07))
    stone_parts.append(
        wedge_block(
            f"gatehouse-jamb-{side}",
            x0,
            x1,
            0.15,
            2.08,
        )
    )

# 홍예 위 폐합 띠. 앞·뒤 면, 평평한 상면, 곡선 홍예 안쪽 면을 모두 가지므로
# 차폐 디더가 잘라도 얇은 껍데기처럼 보이지 않는다.
arch_samples = 17
bottom = [
    (-ARCH_HALF + (ARCH_HALF * 2.0) * index / (arch_samples - 1), 0.0)
    for index in range(arch_samples)
]
bottom = [(x, arch_height(x)) for x, _ in bottom]
arch_profile = bottom + [(ARCH_HALF, BASE_TOP), (-ARCH_HALF, BASE_TOP)]
stone_parts.append(
    profile_prism(
        "gatehouse-arch-header",
        arch_profile,
        BASE_INNER - BASE_TOP * 0.02,
        BASE_OUTER - BASE_TOP * 0.02,
        masonry,
        bevel_width=0.018,
    )
)

# 홍예석 13매. 타원의 접선 방향으로 나뉜 쐐기꼴 돌이 벽 두께를 관통하고,
# 중앙 이마돌은 바깥쪽으로 더 솟아 그림자에서 즉시 읽힌다.
voussoir_count = 13
for index in range(voussoir_count):
    t0 = math.pi * index / voussoir_count
    t1 = math.pi * (index + 1) / voussoir_count
    is_key = index == voussoir_count // 2
    if is_key:
        t0 -= 0.018
        t1 += 0.018
    outer_rx = ARCH_HALF + (0.30 if not is_key else 0.36)
    outer_rz = ARCH_RISE + (0.28 if not is_key else 0.42)
    profile = [
        (ARCH_HALF * math.cos(t0), ARCH_SPRING + ARCH_RISE * math.sin(t0)),
        (ARCH_HALF * math.cos(t1), ARCH_SPRING + ARCH_RISE * math.sin(t1)),
        (outer_rx * math.cos(t1), ARCH_SPRING + outer_rz * math.sin(t1)),
        (outer_rx * math.cos(t0), ARCH_SPRING + outer_rz * math.sin(t0)),
    ]
    stone_parts.append(
        profile_prism(
            "gatehouse-keystone" if is_key else f"gatehouse-voussoir-{index:02d}",
            profile,
            -0.73,
            0.83,
            masonry,
            bevel_width=0.014,
        )
    )

# 문지방석은 보행면만 14cm 올라오며 통로 자체는 계속 앞뒤로 열린다.
threshold_points = [
    ring_point(-1.78, -0.82, 0.0),
    ring_point(1.78, -0.82, 0.0),
    ring_point(1.78, 0.82, 0.0),
    ring_point(-1.78, 0.82, 0.0),
    ring_point(-1.78, -0.82, 0.14),
    ring_point(1.78, -0.82, 0.14),
    ring_point(1.78, 0.82, 0.14),
    ring_point(-1.78, 0.82, 0.14),
]
threshold = mw.new_mesh(
    "gatehouse-threshold",
    [tuple(point) for point in threshold_points],
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
        threshold,
        masonry,
        bevel_width=0.020,
        uv_scale=1.0,
        apply_transform=False,
    )
)

# 문설주 안쪽의 빗장 구멍. 청동 안판을 16cm 뒤에 두고 네 면의 석재 소매를
# 돌출시켜, 평면 검은 사각형이 아니라 깊이가 있는 실제 홈으로 읽히게 한다.
socket_parts: list[bpy.types.Object] = []
for side in (-1, 1):
    for index, z in enumerate((0.34, 1.62)):
        x_open = side * 1.805
        x_back = side * 1.965
        y = ring_point(x_open, 0.05, z).y
        profile = [
            (0.0, -0.12, -0.12),
            (0.0, 0.12, -0.12),
            (0.0, 0.12, 0.12),
            (0.0, -0.12, 0.12),
        ]
        direction = 1.0 if side < 0 else -1.0
        verts = []
        for depth in (0.0, 0.16):
            for _, dy, dz in profile:
                verts.append((x_open + direction * depth, y + dy, z + dz))
        faces = [
            (0, 1, 5, 4),
            (1, 2, 6, 5),
            (2, 3, 7, 6),
            (3, 0, 4, 7),
            (4, 5, 6, 7),
        ]
        sleeve = mw.new_mesh(f"gatehouse-socket-{side}-{index}", verts, faces)
        socket_parts.append(
            finish_part(
                sleeve,
                masonry,
                bevel_width=0.012,
                uv_scale=1.0,
                apply_transform=False,
            )
        )
        back = box_part(
            f"gatehouse-socket-back-{side}-{index}",
            (0.018, 0.19, 0.19),
            (x_back, y, z),
            bronze,
            bevel_width=0.006,
            uv_scale=1.0,
        )
        socket_parts.append(back)


# ---------------------------------------------------------------------------
# 3.4~5.8m 누각: 8기둥, 창방·평방, 공포 4조, 계자난간
# ---------------------------------------------------------------------------


wood_parts: list[bpy.types.Object] = []

# 기단 상면의 얕은 마루틀.
for radial in (-0.72, 0.72):
    path = [tuple(ring_point(x, radial, 3.50)) for x in (-2.80, -1.40, 0.0, 1.40, 2.80)]
    wood_parts.append(
        sweep_part(
            f"gatehouse-sill-{radial:+.2f}",
            [(-0.10, -0.09), (0.10, -0.09), (0.10, 0.09), (-0.10, 0.09)],
            path,
            painted,
            bevel_width=0.008,
        )
    )

# 네 칸 × 앞뒤 = 8개. 중간 반지름이 밑동보다 정확히 3% 굵은 배흘림이고,
# 기둥별 0.08~0.24도 기울기로 완전 좌우대칭을 피한다.
column_x = (-2.46, -0.82, 0.82, 2.46)
column_radial = (-0.66, 0.66)
for row, radial in enumerate(column_radial):
    for column, x in enumerate(column_x):
        generator = mw.rng(f"column-{row}-{column}")
        base = ring_point(x, radial, 3.54)
        obj = mw.lathe(
            f"gatehouse-column-{row}-{column}",
            [
                (0.190, 0.00),
                (0.196, 0.16),
                (0.196, 0.92),
                (0.193, 1.62),
                (0.184, 1.82),
            ],
            12,
            location=tuple(base),
            smooth=True,
            cap=True,
        )
        obj.rotation_euler = Euler(
            (
                math.radians(float(generator.uniform(-0.20, 0.20))),
                math.radians(float(generator.uniform(-0.24, 0.24))),
                0.0,
            ),
            "XYZ",
        )
        wood_parts.append(
            finish_part(
                obj,
                painted,
                bevel_width=0.008,
                uv_scale=0.75,
                cylinder_uv=True,
            )
        )

# 창방과 평방. 곡률은 5점 sweep으로 유지하고 높이 차로 두 겹의 그림자를 낸다.
for radial in column_radial:
    for z, half_y, half_z in ((5.22, 0.105, 0.115), (5.48, 0.125, 0.105)):
        path = [
            tuple(ring_point(x, radial, z))
            for x in (-2.78, -1.40, 0.0, 1.40, 2.78)
        ]
        wood_parts.append(
            sweep_part(
                f"gatehouse-beam-{radial:+.2f}-{z:.2f}",
                [
                    (-half_y, -half_z),
                    (half_y, -half_z),
                    (half_y, half_z),
                    (-half_y, half_z),
                ],
                path,
                painted,
                bevel_width=0.009,
            )
        )

for side in (-1, 1):
    x = side * 2.46
    for z in (5.22, 5.48):
        path = [
            tuple(ring_point(x, radial, z))
            for radial in (-0.74, 0.0, 0.74)
        ]
        wood_parts.append(
            sweep_part(
                f"gatehouse-side-beam-{side}-{z:.2f}",
                [(-0.10, -0.10), (0.10, -0.10), (0.10, 0.10), (-0.10, 0.10)],
                path,
                painted,
                bevel_width=0.009,
            )
        )

# 공포 4조: 주두 하나와 앞뒤/좌우 첨차 2단을 실제 교차 부재로 쌓는다.
for index, x in enumerate(column_x):
    center = ring_point(x, 0.68, 5.42)
    wood_parts.append(
        box_part(
            f"gatehouse-bracket-capital-{index}",
            (0.34, 0.34, 0.22),
            (center.x, center.y, center.z),
            painted,
            bevel_width=0.008,
        )
    )
    for tier, (z, span_x, span_y) in enumerate(
        ((5.58, 0.74, 0.28), (5.72, 0.98, 0.34))
    ):
        wood_parts.append(
            box_part(
                f"gatehouse-bracket-x-{index}-{tier}",
                (span_x, 0.16, 0.14),
                (center.x, center.y, z),
                painted,
                bevel_width=0.008,
            )
        )
        wood_parts.append(
            box_part(
                f"gatehouse-bracket-y-{index}-{tier}",
                (0.16, span_y, 0.14),
                (center.x, center.y, z - 0.025),
                painted,
                bevel_width=0.008,
            )
        )

# 계자난간: 판막음 대신 위·아래 띠와 관통 살대를 앞뒤에 세운다.
for radial in (-0.91, 0.91):
    for z, half_z in ((3.72, 0.045), (4.34, 0.055)):
        path = [
            tuple(ring_point(x, radial, z))
            for x in (-2.62, -1.31, 0.0, 1.31, 2.62)
        ]
        wood_parts.append(
            sweep_part(
                f"gatehouse-railing-rail-{radial:+.2f}-{z:.2f}",
                [(-0.055, -half_z), (0.055, -half_z), (0.055, half_z), (-0.055, half_z)],
                path,
                painted,
                bevel_width=0.006,
            )
        )
    for index, x in enumerate((-2.48, -2.05, -1.62, -1.19, -0.76, -0.33, 0.10, 0.53, 0.96, 1.39, 1.82, 2.25)):
        point = ring_point(x, radial, 4.02)
        wood_parts.append(
            box_part(
                f"gatehouse-railing-bar-{radial:+.2f}-{index}",
                (0.050, 0.055, 0.54),
                (point.x, point.y, point.z),
                painted,
                bevel_width=0.006,
            )
        )


# ---------------------------------------------------------------------------
# 팔작지붕: 면은 저밀도, 처마 곡선·앙곡·마루는 실제 sweep
# ---------------------------------------------------------------------------


roof_parts: list[bpy.types.Object] = []

# 앞뒤 사면. 처마선은 양끝 18cm 들리고, 면 중앙은 7cm 볼록해 앙곡이
# 평면 노멀만으로 사라지지 않는다.
roof_x = (-3.50, -2.33, -1.17, 0.0, 1.17, 2.33, 3.50)
for front in (-1, 1):
    rows: list[list[Vector]] = []
    for row in range(5):
        v = row / 4.0
        half_span = ROOF_HALF * (1.0 - v) + 1.72 * v
        radial = front * (1.92 * (1.0 - v) + 0.08 * v)
        row_points = []
        for unit in (-1.0, -2.0 / 3.0, -1.0 / 3.0, 0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0):
            x = half_span * unit
            end_lift = 0.18 * (abs(unit) ** 2.4) * (1.0 - v)
            z = ROOF_EAVE * (1.0 - v) + 8.20 * v
            z += end_lift + 0.07 * math.sin(math.pi * v)
            row_points.append(ring_point(x, radial, z))
        rows.append(row_points)
    roof_parts.append(
        solid_grid_panel(
            f"gatehouse-roof-{'front' if front > 0 else 'back'}",
            rows,
            roof_tile,
            thickness=0.105,
            bevel_width=0.012,
        )
    )

# 좌우 팔작 합각면. 용마루 끝에서 굽은 옆 처마로 내려오는 폐합 삼각판이다.
for side in (-1, 1):
    ridge = ring_point(side * 1.72, 0.0, 8.20)
    eave = [
        ring_point(
            side * ROOF_HALF,
            radial,
            ROOF_EAVE + 0.18 + 0.06 * (abs(radial) / 1.92) ** 2,
        )
        for radial in (-1.92, -1.28, -0.64, 0.0, 0.64, 1.28, 1.92)
    ]
    roof_parts.append(
        solid_polygon_panel(
            f"gatehouse-roof-hip-{side}",
            [ridge] + eave,
            roof_tile,
            thickness=0.105,
            bevel_width=0.012,
        )
    )

# 안허리곡: 네 처마선 모두 양끝이 실제 경로에서 올라간다.
eave_paths: list[list[tuple[float, float, float]]] = []
for front in (-1, 1):
    path = [
        tuple(
            ring_point(
                x,
                front * 1.94,
                ROOF_EAVE + 0.18 * (abs(x) / ROOF_HALF) ** 2.4,
            )
        )
        for x in roof_x
    ]
    eave_paths.append(path)
for side in (-1, 1):
    path = [
        tuple(
            ring_point(
                side * ROOF_HALF,
                radial,
                ROOF_EAVE + 0.18 + 0.07 * (abs(radial) / 1.94) ** 2,
            )
        )
        for radial in (-1.94, -1.29, -0.65, 0.0, 0.65, 1.29, 1.94)
    ]
    eave_paths.append(path)
for index, path in enumerate(eave_paths):
    roof_parts.append(
        sweep_part(
            f"gatehouse-curved-eave-{index}",
            [(-0.075, -0.065), (0.075, -0.065), (0.075, 0.065), (-0.075, 0.065)],
            path,
            roof_tile,
            bevel_width=0.012,
        )
    )

# 용마루.
ridge_path = [
    tuple(ring_point(x, 0.0, ROOF_RIDGE + 0.018 * (abs(x) / 1.72) ** 2))
    for x in (-1.72, -0.86, 0.0, 0.86, 1.72)
]
roof_parts.append(
    sweep_part(
        "gatehouse-ridge-main",
        circle_section(0.070, 8),
        ridge_path,
        roof_tile,
        bevel_width=0.012,
        smooth=True,
    )
)

# 네 내림마루/추녀마루. 중간점이 직선 보간보다 8cm 높아 실제 앙곡을 만든다.
corner_specs: list[tuple[int, int]] = [
    (side, front)
    for side in (-1, 1)
    for front in (-1, 1)
]
for index, (side, front) in enumerate(corner_specs):
    path = []
    for step in range(5):
        t = step / 4.0
        x = side * (1.72 * (1.0 - t) + ROOF_HALF * t)
        radial = front * 1.94 * t
        z = 8.25 * (1.0 - t) + (ROOF_EAVE + 0.23) * t
        z += 0.08 * math.sin(math.pi * t)
        path.append(tuple(ring_point(x, radial, z)))
    roof_parts.append(
        sweep_part(
            f"gatehouse-hip-ridge-{index}",
            circle_section(0.052, 8),
            path,
            roof_tile,
            bevel_width=0.012,
            smooth=True,
        )
    )

    # 추녀는 지붕 아래, 사래는 끝 32cm를 한 번 더 뻗어 네 귀의 실루엣을 만든다.
    wood_path = [
        tuple(ring_point(side * 1.74, 0.0, 8.08)),
        tuple(ring_point(side * 2.66, front * 0.98, 6.98)),
        tuple(ring_point(side * 3.46, front * 1.91, ROOF_EAVE - 0.04)),
    ]
    wood_parts.append(
        sweep_part(
            f"gatehouse-chunyeo-{index}",
            [(-0.075, -0.065), (0.075, -0.065), (0.075, 0.065), (-0.075, 0.065)],
            wood_path,
            painted,
            bevel_width=0.009,
        )
    )
    sarae_path = [
        tuple(ring_point(side * 3.28, front * 1.72, ROOF_EAVE - 0.01)),
        tuple(ring_point(side * ROOF_HALF, front * 1.94, ROOF_EAVE + 0.15)),
    ]
    wood_parts.append(
        sweep_part(
            f"gatehouse-sarae-{index}",
            [(-0.060, -0.052), (0.060, -0.052), (0.060, 0.052), (-0.060, 0.052)],
            sarae_path,
            painted,
            bevel_width=0.008,
        )
    )

# 서까래는 +Y 처마 밑 한 줄만 만든다. 노멀맵이 맡는 기와 반복과 달리,
# 아래에서 보이는 12개의 둥근 끝만 실루엣/AO에 기여한다.
for index, x in enumerate(
    (-3.10, -2.54, -1.97, -1.41, -0.85, -0.28, 0.28, 0.85, 1.41, 1.97, 2.54, 3.10)
):
    path = [
        tuple(ring_point(x * 0.91, 0.68, 6.24)),
        tuple(ring_point(x, 1.88, ROOF_EAVE - 0.10 + 0.12 * (abs(x) / 3.10) ** 2)),
    ]
    wood_parts.append(
        sweep_part(
            f"gatehouse-rafter-front-{index:02d}",
            circle_section(0.043, 8),
            path,
            painted,
            bevel_width=0.006,
            smooth=True,
        )
    )


# ---------------------------------------------------------------------------
# 문짝 2짝: 원점은 각 경첩축, 로컬 Z가 glTF/three.js Y 회전축이 된다
# ---------------------------------------------------------------------------


def door_board(
    name: str,
    x0: float,
    x1: float,
    top0: float,
    top1: float,
) -> bpy.types.Object:
    y0, y1 = -0.060, 0.060
    verts = [
        (x0, y0, 0.0),
        (x1, y0, 0.0),
        (x1, y0, top1),
        (x0, y0, top0),
        (x0, y1, 0.0),
        (x1, y1, 0.0),
        (x1, y1, top1),
        (x0, y1, top0),
    ]
    faces = [
        (0, 3, 2, 1),
        (4, 5, 6, 7),
        (0, 1, 5, 4),
        (1, 2, 6, 5),
        (2, 3, 7, 6),
        (3, 0, 4, 7),
    ]
    obj = mw.new_mesh(name, verts, faces)
    return finish_part(
        obj,
        timber,
        bevel_width=0.008,
        uv_scale=1.0,
        apply_transform=False,
    )


def build_door(side: int) -> bpy.types.Object:
    # side=-1은 왼쪽 경첩에서 +X로, side=+1은 오른쪽 경첩에서 -X로 닫힌다.
    direction = -float(side)
    hinge_x = side * 1.775
    leaf_width = 1.755
    pieces: list[bpy.types.Object] = []
    plank_count = 4
    for index in range(plank_count):
        a = index * leaf_width / plank_count + 0.010
        b = (index + 1) * leaf_width / plank_count - 0.010
        local_x0 = direction * a
        local_x1 = direction * b
        global_x0 = hinge_x + local_x0
        global_x1 = hinge_x + local_x1
        pieces.append(
            door_board(
                f"gatehouse-door-board-{side}-{index}",
                local_x0,
                local_x1,
                arch_height(global_x0) - 0.18,
                arch_height(global_x1) - 0.18,
            )
        )

    # 가로 띠쇠 3줄. 모두 문 앞(+local Y)에 있어 assign_by_index로 청동을
    # 한 번에 분리할 수 있다.
    for index, z in enumerate((0.58, 1.22, 1.82)):
        strap = mw.box(
            f"gatehouse-door-strap-{side}-{index}",
            (leaf_width - 0.10, 0.030, 0.095),
            (direction * leaf_width * 0.50, 0.075, z),
        )
        pieces.append(
            finish_part(
                strap,
                bronze,
                bevel_width=0.006,
                uv_scale=1.0,
            )
        )

    plate = mw.box(
        f"gatehouse-door-handle-plate-{side}",
        (0.22, 0.025, 0.28),
        (direction * 1.36, 0.080, 1.12),
    )
    pieces.append(
        finish_part(
            plate,
            bronze,
            bevel_width=0.006,
            uv_scale=1.0,
        )
    )
    ring_path = [
        (
            direction * 1.36 + math.cos(math.tau * index / 16) * 0.105,
            0.125,
            1.10 + math.sin(math.tau * index / 16) * 0.135,
        )
        for index in range(16)
    ]
    ring = mw.sweep(
        f"gatehouse-door-handle-ring-{side}",
        circle_section(0.018, 6),
        ring_path,
        closed_section=True,
        closed_path=True,
        up=(0.0, 1.0, 0.0),
        smooth=True,
    )
    pieces.append(
        finish_part(
            ring,
            bronze,
            bevel_width=0.006,
            uv_scale=1.0,
            apply_transform=False,
        )
    )

    door = mw.join(
        "gatehouse-door-l" if side < 0 else "gatehouse-door-r",
        pieces,
    )
    # 로컬 y=0.061보다 앞에 붙은 면은 띠쇠/문고리, 나머지는 세로 널판이다.
    mw.assign_by_index(
        door,
        (timber, bronze),
        lambda center, _normal: 1 if center.y > 0.061 else 0,
    )
    mw.shade_auto_smooth(door, 38.0)
    mw.uv_box(door, 1.0)

    hinge = ring_point(hinge_x, 0.44, 0.14)
    # 닫힌 두 문짝이 r=34 곡률을 따라 얕은 V를 이루도록 각 경첩의 접선을
    # 기본 회전으로 쓴다. 이후 three.js는 이 로컬 Z(glTF Y)만 더 돌리면 된다.
    tangent_angle = math.atan2(-hinge_x, math.sqrt((RADIUS + 0.44) ** 2 - hinge_x ** 2))
    door.location = tuple(hinge)
    door.rotation_euler = Euler((0.0, 0.0, tangent_angle), "XYZ")

    def door_color(world: Vector, normal: Vector) -> tuple[float, float, float]:
        edge_wear = min(1.0, abs(normal.y) * 0.22 + (1.0 - min(world.z / 3.0, 1.0)) * 0.20)
        weather = 0.5 + 0.5 * math.sin(world.x * 4.1 + world.z * 3.3 + side * 0.7)
        return (0.20 + edge_wear + weather * 0.08, 0.03 + weather * 0.03, 0.02)

    mw.set_vertex_colors(door, door_color)
    color = door.data.color_attributes.get("Col")
    if color is not None:
        door.data.color_attributes.active_color = color
        door.data.color_attributes.active = color
    return door


door_left = build_door(-1)
door_right = build_door(1)


# ---------------------------------------------------------------------------
# 결합, 정점 마스크, 실제 관통/예산/높이 자체 검증
# ---------------------------------------------------------------------------


gatehouse = mw.join(
    "gatehouse",
    stone_parts + socket_parts + wood_parts + roof_parts,
)

# join 뒤 중복 슬롯을 세 재질로 정리한다. 청동 소켓 안판은 z<2m이고 앞/뒤
# 법선이 큰 작은 면으로만 남으므로 네 번째 슬롯으로 분리한다.
mw.assign_by_index(
    gatehouse,
    (masonry, painted, roof_tile, bronze),
    lambda center, normal: (
        3
        if center.z < 1.90 and abs(normal.x) > 0.82 and abs(center.x) > 1.90
        else 2
        if center.z >= 5.67 and normal.z > -0.92
        else 1
        if center.z >= 3.39
        else 0
    ),
)
mw.shade_auto_smooth(gatehouse, 38.0)
mw.uv_box(gatehouse, 1.0)


def gate_color(world: Vector, normal: Vector) -> tuple[float, float, float]:
    radius = max(1.0e-6, math.hypot(world.x, world.y))
    radial_normal = (world.x * normal.x + world.y * normal.y) / radius
    low = max(0.0, 1.0 - world.z / 3.4)
    asymmetry = 0.5 + 0.5 * math.sin(world.x * 1.73 + world.y * 0.31 + world.z * 2.7)
    wear = 0.14 + low * 0.24 + asymmetry * 0.13
    damp = 0.04 + max(0.0, -radial_normal) * 0.22 + low * 0.16
    crack = 0.03 + max(0.0, 1.0 - abs(world.x + 2.42) / 0.32) * 0.34
    return (wear, damp, crack)


mw.set_vertex_colors(gatehouse, gate_color)
color = gatehouse.data.color_attributes.get("Col")
if color is not None:
    gatehouse.data.color_attributes.active_color = color
    gatehouse.data.color_attributes.active = color


def triangle_count(objects: list[bpy.types.Object]) -> int:
    return sum(
        max(0, len(polygon.vertices) - 2)
        for obj in objects
        for polygon in obj.data.polygons
    )


def z_bounds(objects: list[bpy.types.Object]) -> tuple[float, float]:
    values = [
        float((obj.matrix_world @ vertex.co).z)
        for obj in objects
        for vertex in obj.data.vertices
    ]
    return min(values), max(values)


def x_bounds(objects: list[bpy.types.Object]) -> tuple[float, float]:
    values = [
        float((obj.matrix_world @ vertex.co).x)
        for obj in objects
        for vertex in obj.data.vertices
    ]
    return min(values), max(values)


# 문짝은 가동 부재이므로 제외하고, 낮은 눈높이 9개 광선을 성 안쪽에서
# 바깥쪽으로 쏜다. 하나라도 석축에 맞으면 홍예가 실제 관통하지 않은 것이다.
for sample_x in (-1.36, 0.0, 1.36):
    for sample_z in (0.36, 1.08, 1.78):
        hit, _location, _normal, _face = gatehouse.ray_cast(
            Vector((sample_x, RADIUS - 2.0, sample_z)),
            Vector((0.0, 1.0, 0.0)),
            distance=4.0,
        )
        if hit:
            raise SystemExit(
                f"[21_gatehouse] 홍예 관통 실패: x={sample_x:.2f}, z={sample_z:.2f}"
            )

export_objects = [gatehouse, door_left, door_right]
triangles = triangle_count(export_objects)
z_min, z_max = z_bounds(export_objects)
x_min, x_max = x_bounds(export_objects)
print(
    f"[21_gatehouse] gatehouse: {triangles:,} tris, "
    f"x-range {x_min:+.6f} .. {x_max:+.6f} m, "
    f"z-range {z_min:+.6f} .. {z_max:+.6f} m"
)
print("[21_gatehouse] arch passage: 9/9 low sight rays clear (doors excluded)")
if triangles > 26_000:
    raise SystemExit(f"[21_gatehouse] 예산 초과: {triangles:,} > 26,000")
if z_min < -0.0001 or z_max > 8.4001:
    raise SystemExit(
        f"[21_gatehouse] 높이 위반: {z_min:+.6f} .. {z_max:+.6f}m"
    )
if x_max - x_min > 7.201:
    raise SystemExit(
        f"[21_gatehouse] 폭 위반: {x_max - x_min:.6f}m > 7.200m"
    )

mw.export_glb(
    "gatehouse",
    export_objects,
    max_triangles=26_000,
    notes=(
        "r=34 curved gatehouse; through elliptical arch, 13 radial voussoirs and "
        "oversized keystone; hinge-pivoted double timber doors; eight entasis "
        "columns, four real bracket sets, open balusters, swept curved hip-and-gable roof"
    ),
    extras={
        "zMin": round(z_min, 6),
        "zMax": round(z_max, 6),
        "width": round(x_max - x_min, 6),
        "radius": RADIUS,
        "facings": "+Y outward",
        "arch": {
            "width": ARCH_HALF * 2.0,
            "spring": ARCH_SPRING,
            "apex": ARCH_SPRING + ARCH_RISE,
            "throughSightRays": 9,
        },
        "doors": {
            "objects": ["gatehouse-door-l", "gatehouse-door-r"],
            "thickness": 0.12,
            "pivot": "hinge axis; Blender Z / glTF Y rotation",
        },
        "placementDegrees": [0, 90, 180, 270],
        "vertexColor": "Col: R wear, G moss/damp shade, B crack proximity",
    },
)
mw.finish()
print("[21_gatehouse] gatehouse OK")
