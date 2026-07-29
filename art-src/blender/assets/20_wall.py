# -*- coding: utf-8 -*-
"""15도 곡면 성벽 — 온전함, 풍화, 붕괴 세 변형.

three.js는 이 조각을 원점 둘레로 회전만 한다. 따라서 메시 자체가 r=34를
중심으로 휘어 있고, 안팎 면과 관통 총안도 완성된 상태로 내보낸다.

블록은 텍스처 무늬가 아니라 닫힌 개별 입체다. 네 단의 줄눈 위상을 어긋나게
하고 블록마다 위치와 회전을 아주 조금 흔들어, 24조각을 이어도 규칙적인
방사 격자로 읽히지 않게 했다.
"""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=2000)

ARC_HALF = math.radians(7.5)
BODY_INNER = 33.2
BODY_OUTER = 34.8
BODY_TOP = 2.60
WALL_TOP = 3.39  # 회전 흔들림까지 포함해 실제 정점이 3.4m를 넘지 않게 1cm 여유.


# ---------------------------------------------------------------------------
# 기존 머티리얼
# ---------------------------------------------------------------------------


def stone_material(
    name: str,
    family: str,
    roughness: float,
    uv_scale: float,
) -> bpy.types.Material:
    stem = name.split("/")[-1]
    return mw.material(
        mw.MaterialSpec(
            name=name,
            base_color=(1.0, 1.0, 1.0, 1.0),
            roughness=roughness,
            base_color_map=f"env/tex/{family}/{stem}_basecolor.webp",
            normal_map=f"env/tex/{family}/{stem}_normal.webp",
            orm_map=f"env/tex/{family}/{stem}_orm.webp",
            uv_scale=uv_scale,
            shader="stone",
            arc_response=1.0,
        )
    )


masonry = stone_material("mw/arch/masonry", "arch", 0.82, 0.35)
granite = stone_material("mw/ground/granite-slab", "ground", 0.78, 0.50)
worn = stone_material("mw/ground/worn-stone", "ground", 0.86, 0.50)
moss = stone_material("mw/ground/moss-lichen", "ground", 0.94, 0.70)


# ---------------------------------------------------------------------------
# 수치와 메시 조립 도구
# ---------------------------------------------------------------------------


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    t = max(0.0, min(1.0, (value - edge0) / max(1.0e-9, edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


def polar(radius: float, angle: float, z: float) -> Vector:
    """+Y가 조각 정면이 되도록 한 극좌표."""
    return Vector((math.sin(angle) * radius, math.cos(angle) * radius, z))


def append_closed_wedge(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    *,
    angle0: float,
    angle1: float,
    inner0: float,
    outer0: float,
    inner1: float,
    outer1: float,
    z0: float,
    z1: float,
    salt: str | None = None,
) -> None:
    """닫힌 사다리꼴 블록 하나.

    `salt`가 있으면 스펙의 ±0.008m, ±0.3도 안에서 독립적으로 흔든다.
    반경 방향 흔들림은 몸체 기준면 안쪽에서만 일어나 기초 돌출보다 밖으로
    튀지 않는다.
    """
    points = [
        polar(inner0, angle0, z0),
        polar(outer0, angle0, z0),
        polar(outer0, angle1, z0),
        polar(inner0, angle1, z0),
        polar(inner1, angle0, z1),
        polar(outer1, angle0, z1),
        polar(outer1, angle1, z1),
        polar(inner1, angle1, z1),
    ]

    if salt is not None:
        generator = mw.rng(salt)
        radial_shift = float(generator.uniform(-0.006, 0.006))
        tangent_shift = float(generator.uniform(-0.008, 0.008))
        vertical_shift = float(generator.uniform(-0.004, 0.004))
        rotation = Euler(
            (
                math.radians(float(generator.uniform(-0.30, 0.30))),
                math.radians(float(generator.uniform(-0.30, 0.30))),
                math.radians(float(generator.uniform(-0.30, 0.30))),
            ),
            "XYZ",
        )
        rotation_matrix = rotation.to_matrix()
        mid_angle = (angle0 + angle1) * 0.5
        radial = Vector((math.sin(mid_angle), math.cos(mid_angle), 0.0))
        tangent = Vector((math.cos(mid_angle), -math.sin(mid_angle), 0.0))
        center = sum(points, Vector()) / len(points)
        offset = radial * radial_shift + tangent * tangent_shift + Vector((0.0, 0.0, vertical_shift))
        points = [center + rotation_matrix @ (point - center) + offset for point in points]

    base = len(verts)
    verts.extend(tuple(float(value) for value in point) for point in points)
    faces.extend(
        [
            (base + 0, base + 3, base + 2, base + 1),
            (base + 4, base + 5, base + 6, base + 7),
            (base + 0, base + 1, base + 5, base + 4),
            (base + 1, base + 2, base + 6, base + 5),
            (base + 2, base + 3, base + 7, base + 6),
            (base + 3, base + 0, base + 4, base + 7),
        ]
    )


def append_arc_band(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    *,
    angle0: float,
    angle1: float,
    inner0: float,
    outer0: float,
    inner1: float,
    outer1: float,
    z0: float,
    z1: float,
    segments: int,
) -> None:
    """여러 현으로 휜 닫힌 환형 띠.

    기초·미석·여장처럼 긴 부재를 한 사다리꼴로 막으면 중심이 r=34에서
    29cm 안쪽으로 들어간다. 15도를 10개 이상으로 나눠 실제 곡률을 지킨다.
    """
    base = len(verts)
    stride = segments + 1
    for radius0, radius1, z in (
        (inner0, inner1, z0),
        (outer0, outer1, z0),
        (inner1, inner1, z1),
        (outer1, outer1, z1),
    ):
        # 아래 두 링은 첫 반경, 위 두 링은 두 번째 반경을 쓰도록 명시적으로
        # 분기한다. 튜플 형태를 유지하면 기울어진 몸체에도 같은 도구를 쓴다.
        del radius1
        for index in range(stride):
            angle = angle0 + (angle1 - angle0) * index / segments
            verts.append(tuple(polar(radius0, angle, z)))

    bottom_inner = base
    bottom_outer = base + stride
    top_inner = base + stride * 2
    top_outer = base + stride * 3
    for index in range(segments):
        nxt = index + 1
        faces.extend(
            [
                (top_inner + index, top_outer + index, top_outer + nxt, top_inner + nxt),
                (bottom_outer + index, bottom_inner + index, bottom_inner + nxt, bottom_outer + nxt),
                (bottom_inner + index, top_inner + index, top_inner + nxt, bottom_inner + nxt),
                (bottom_outer + index, bottom_outer + nxt, top_outer + nxt, top_outer + index),
            ]
        )
    faces.extend(
        [
            (bottom_inner, bottom_outer, top_outer, top_inner),
            (
                bottom_inner + segments,
                top_inner + segments,
                top_outer + segments,
                bottom_outer + segments,
            ),
        ]
    )


def append_box(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    *,
    center: tuple[float, float, float],
    size: tuple[float, float, float],
    rotation: tuple[float, float, float],
) -> None:
    """붕괴형 안쪽에 흘러내린 닫힌 석재 한 덩이."""
    half = Vector((size[0] * 0.5, size[1] * 0.5, size[2] * 0.5))
    pivot = Vector(center)
    rotation_matrix = Euler(rotation, "XYZ").to_matrix()
    points = []
    for x, y, z in (
        (-1, -1, -1),
        (1, -1, -1),
        (1, 1, -1),
        (-1, 1, -1),
        (-1, -1, 1),
        (1, -1, 1),
        (1, 1, 1),
        (-1, 1, 1),
    ):
        local = Vector((half.x * x, half.y * y, half.z * z))
        points.append(pivot + rotation_matrix @ local)
    base = len(verts)
    verts.extend(tuple(point) for point in points)
    faces.extend(
        [
            (base + 0, base + 3, base + 2, base + 1),
            (base + 4, base + 5, base + 6, base + 7),
            (base + 0, base + 1, base + 5, base + 4),
            (base + 1, base + 2, base + 6, base + 5),
            (base + 2, base + 3, base + 7, base + 6),
            (base + 3, base + 0, base + 4, base + 7),
        ]
    )


def mesh_z_bounds(obj: bpy.types.Object) -> tuple[float, float]:
    values = [float((obj.matrix_world @ vertex.co).z) for vertex in obj.data.vertices]
    if not values:
        raise SystemExit(f"[20_wall] {obj.name}: 높이를 잴 정점이 없다")
    return min(values), max(values)


def triangle_count(obj: bpy.types.Object) -> int:
    return sum(max(0, len(polygon.vertices) - 2) for polygon in obj.data.polygons)


# ---------------------------------------------------------------------------
# 세 변형
# ---------------------------------------------------------------------------


COURSES = (
    (0.25, 0.79, 7, 0.00),
    (0.79, 1.33, 8, 0.50),
    (1.33, 1.88, 7, 0.22),
    (1.88, 2.43, 9, 0.64),
)


def body_radius(radius: float, z: float) -> float:
    """위로 갈수록 중심 쪽으로 3% 눕는 규형."""
    return radius - max(0.0, z - 0.25) * 0.03


def block_survives(variant: str, layer: int, block: int, count: int) -> bool:
    if variant == "intact":
        return True
    if variant == "worn":
        return (layer, block) not in {(1, 2), (2, 5), (3, 1), (3, 7)}

    # 중앙으로 갈수록 더 낮아지는 V자 파구. 하부 두 단은 버티고, 상단
    # 1/3은 넓게 빠져 성벽 안쪽으로 시선이 통한다.
    center = (block + 0.5) / count - 0.5
    if layer == 2 and abs(center) < 0.13:
        return False
    if layer == 3 and abs(center) < 0.34:
        return False
    return True


def append_body_blocks(
    variant: str,
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
) -> list[tuple[float, float]]:
    top_survivors: list[tuple[float, float]] = []
    for layer, (z0, z1, count, phase_fraction) in enumerate(COURSES):
        block_angle = ARC_HALF * 2.0 / count
        phase = (phase_fraction - 0.5) * block_angle * 0.26
        for block in range(count):
            if not block_survives(variant, layer, block, count):
                continue
            a0 = -ARC_HALF + block * block_angle + phase
            a1 = -ARC_HALF + (block + 1) * block_angle + phase
            # 끝 블록만 정확한 15도 경계 안으로 자른다.
            a0 = max(-ARC_HALF, a0)
            a1 = min(ARC_HALF, a1)
            if a1 - a0 < math.radians(0.25):
                continue
            angular_gap = 0.018 / 34.0
            a0 += angular_gap
            a1 -= angular_gap
            radial_jamb = 0.018
            vertical_gap = 0.012
            append_closed_wedge(
                verts,
                faces,
                angle0=a0,
                angle1=a1,
                inner0=body_radius(BODY_INNER + radial_jamb, z0),
                outer0=body_radius(BODY_OUTER - radial_jamb, z0),
                inner1=body_radius(BODY_INNER + radial_jamb, z1),
                outer1=body_radius(BODY_OUTER - radial_jamb, z1),
                z0=z0 + vertical_gap,
                z1=z1 - vertical_gap,
                salt=f"{variant}-block-{layer}-{block}",
            )
            if layer == len(COURSES) - 1:
                top_survivors.append((a0, a1))
    return top_survivors


def append_coping(
    variant: str,
    top_survivors: list[tuple[float, float]],
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
) -> None:
    ranges = [(-ARC_HALF, ARC_HALF)]
    if variant == "worn":
        ranges = [
            (-ARC_HALF, math.radians(1.0)),
            (math.radians(3.3), ARC_HALF),
        ]
    elif variant == "breached":
        ranges = top_survivors

    for a0, a1 in ranges:
        if a1 - a0 < math.radians(0.2):
            continue
        append_arc_band(
            verts,
            faces,
            angle0=a0,
            angle1=a1,
            inner0=33.02,
            outer0=34.84,
            inner1=33.02,
            outer1=34.84,
            z0=2.43,
            z1=BODY_TOP,
            segments=max(1, int(math.ceil(math.degrees(a1 - a0) / 1.4))),
        )


def append_battlement(
    variant: str,
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
) -> None:
    """아래턱·머릿돌·기둥 사이가 완전히 빈 일곱 개 관통 총안."""
    if variant == "breached":
        return

    inner = body_radius(BODY_INNER + 0.035, BODY_TOP)
    outer = body_radius(BODY_OUTER - 0.035, BODY_TOP)
    append_arc_band(
        verts,
        faces,
        angle0=-ARC_HALF,
        angle1=ARC_HALF,
        inner0=inner,
        outer0=outer,
        inner1=inner,
        outer1=outer,
        z0=BODY_TOP,
        z1=2.79,
        segments=12,
    )

    # 풍화형은 오른쪽 두 총안 위 머릿돌과 가운데 기둥이 무너져 여장
    # 실루엣이 2.79m까지 낮아진다.
    header_ranges = [(-ARC_HALF, ARC_HALF)]
    if variant == "worn":
        header_ranges = [
            (-ARC_HALF, math.radians(0.8)),
            (math.radians(5.3), ARC_HALF),
        ]
    for a0, a1 in header_ranges:
        append_arc_band(
            verts,
            faces,
            angle0=a0,
            angle1=a1,
            inner0=inner,
            outer0=outer,
            inner1=inner,
            outer1=outer,
            z0=3.24,
            z1=WALL_TOP,
            segments=max(1, int(math.ceil(math.degrees(a1 - a0) / 1.3))),
        )

    openings = 7
    cell = ARC_HALF * 2.0 / openings
    pier_half_angle = (0.58 / 34.0) * 0.5
    for pier in range(openings + 1):
        center = -ARC_HALF + pier * cell
        if variant == "worn" and pier in (4, 5, 6):
            continue
        a0 = max(-ARC_HALF, center - pier_half_angle)
        a1 = min(ARC_HALF, center + pier_half_angle)
        append_closed_wedge(
            verts,
            faces,
            angle0=a0,
            angle1=a1,
            inner0=inner,
            outer0=outer,
            inner1=inner,
            outer1=outer,
            z0=2.79,
            z1=3.24,
        )


def append_breach_rubble(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
) -> None:
    """파구에서 r=31.9~33.1 안쪽으로 흘러내린 열두 석재."""
    generator = mw.rng("breach-rubble")
    for index in range(12):
        radius = float(generator.uniform(31.92, 33.08))
        angle = float(generator.normal(0.0, math.radians(2.2)))
        x, y = math.sin(angle) * radius, math.cos(angle) * radius
        sx = float(generator.uniform(0.28, 0.65))
        sy = float(generator.uniform(0.24, 0.54))
        sz = float(generator.uniform(0.16, 0.34))
        layer = 0.10 + (33.1 - radius) * 0.20
        append_box(
            verts,
            faces,
            center=(x, y, layer + sz * 0.45),
            size=(sx, sy, sz),
            rotation=(
                float(generator.uniform(-0.32, 0.32)),
                float(generator.uniform(-0.30, 0.30)),
                float(generator.uniform(-math.pi, math.pi)),
            ),
        )


def wall_color_fn(variant: str):
    breach_strength = {"intact": 0.0, "worn": 0.55, "breached": 1.0}[variant]

    def color(world: Vector, normal: Vector) -> tuple[float, float, float]:
        radius = max(1.0e-6, math.hypot(world.x, world.y))
        angle = math.atan2(world.x, world.y)
        radial_normal = (world.x * normal.x + world.y * normal.y) / radius
        inward_shadow = max(0.0, -radial_normal)
        low = 1.0 - smoothstep(0.30, 1.65, world.z)
        mottling = 0.5 + 0.5 * math.sin(world.x * 1.7 + world.y * 0.43 + world.z * 3.1)

        wear = 0.18 + breach_strength * 0.48 + mottling * 0.12
        if world.z > 2.35:
            wear += 0.10 + breach_strength * 0.10
        moss_value = 0.04 + inward_shadow * (0.34 + breach_strength * 0.18) + low * 0.22

        crack = 0.04 + breach_strength * (
            1.0 - smoothstep(math.radians(0.7), math.radians(4.6), abs(angle))
        )
        if variant == "worn":
            crack = max(
                crack,
                1.0 - smoothstep(
                    math.radians(0.35),
                    math.radians(1.35),
                    abs(angle - math.radians(3.8)),
                ),
            )
        return (min(1.0, wear), min(1.0, moss_value), min(1.0, crack))

    return color


def build_wall(variant: str) -> bpy.types.Object:
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []

    # 0.25m 지대석. 몸체보다 안팎으로 0.10m씩 돌출되고, 12현으로 휘어 있다.
    append_arc_band(
        verts,
        faces,
        angle0=-ARC_HALF,
        angle1=ARC_HALF,
        inner0=33.10,
        outer0=34.90,
        inner1=33.10,
        outer1=34.90,
        z0=0.0,
        z1=0.25,
        segments=12,
    )
    top_survivors = append_body_blocks(variant, verts, faces)
    append_coping(variant, top_survivors, verts, faces)
    append_battlement(variant, verts, faces)
    if variant == "breached":
        append_breach_rubble(verts, faces)

    obj = mw.new_mesh(f"wall-{variant}", verts, faces)
    mw.bevel(obj, 0.012, 2, angle_deg=38.0)
    # 2세그먼트 베벨이 만든 평면 내부 삼각형을 줄인다. 0.66은 세 변형 중
    # 부재가 가장 많은 온전형을 4k 아래에 두면서 총안 테두리와 블록별
    # 줄눈 실루엣을 보존하는 계측값이다.
    mw.decimate(obj, 0.66)

    def material_index(center: Vector, normal: Vector) -> int:
        radius = math.hypot(center.x, center.y)
        radial_normal = (center.x * normal.x + center.y * normal.y) / max(radius, 1.0e-6)
        if radial_normal < -0.55 and center.z < 1.05:
            return 3
        if center.z < 0.27:
            return 1
        if variant == "breached" and (radius < 33.15 or center.z > 1.72):
            return 2
        if variant == "worn" and (
            center.z > 2.30
            or 0.5 + 0.5 * math.sin(center.x * 2.1 + center.z * 3.7) > 0.78
        ):
            return 2
        return 0

    mw.assign_by_index(obj, (masonry, granite, worn, moss), material_index)
    mw.shade_auto_smooth(obj, 38.0)
    mw.uv_box(obj, 1.0)
    mw.set_vertex_colors(obj, wall_color_fn(variant))
    color = obj.data.color_attributes.get("Col")
    if color is not None:
        obj.data.color_attributes.active_color = color
        obj.data.color_attributes.active = color
    return obj


walls = [(variant, build_wall(variant)) for variant in ("intact", "worn", "breached")]

for variant, wall in walls:
    z_min, z_max = mesh_z_bounds(wall)
    triangles = triangle_count(wall)
    print(
        f"[20_wall] wall-{variant}: {triangles:,} tris, "
        f"z-range {z_min:+.6f} .. {z_max:+.6f} m"
    )
    if z_max > 3.400001:
        raise SystemExit(
            f"[20_wall] wall-{variant} 높이 위반: {z_max:+.6f}m > +3.400000m"
        )
    mw.export_glb(
        f"wall-{variant}",
        [wall],
        max_triangles=4_000,
        notes=(
            "r=34 curved 15deg wall; real staggered masonry blocks, 3% batter, "
            "projecting footing/coping and through embrasures"
        ),
        extras={
            "zMin": round(z_min, 6),
            "zMax": round(z_max, 6),
            "arcDegrees": 15.0,
            "innerRadius": BODY_INNER,
            "outerRadius": BODY_OUTER,
            "vertexColor": "Col: R wear, G moss/damp shade, B breach/crack proximity",
        },
    )

mw.finish()
print("[20_wall] wall-intact + wall-worn + wall-breached OK")
