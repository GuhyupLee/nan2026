# -*- coding: utf-8 -*-
"""r=33~48 외곽 지형 — 흙·자갈, 바위 노두, 마른 계류와 성벽 잔해.

화면에 들어오지 않는 원경은 만들지 않는다. 288×72 환형 격자를 실제 가시
범위에 집중하고, r=42부터만 낙차를 시작해 r=48 경계의 모든 지면 정점을
정확히 -6m로 모은다. 바깥쪽 수평 원판이나 숨은 원경 메시가 없다.
"""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402
from mathutils import Euler, Vector  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=1800)

TAU = math.tau
R_INNER = 33.0
R_CLIFF = 42.0
R_OUTER = 48.0
ANGULAR_SEGMENTS = 288
RADIAL_SEGMENTS = 72


def ground_material(name: str, roughness: float, uv_scale: float) -> bpy.types.Material:
    stem = name.split("/")[-1]
    return mw.material(
        mw.MaterialSpec(
            name=name,
            base_color=(1.0, 1.0, 1.0, 1.0),
            roughness=roughness,
            base_color_map=f"env/tex/ground/{stem}_basecolor.webp",
            normal_map=f"env/tex/ground/{stem}_normal.webp",
            orm_map=f"env/tex/ground/{stem}_orm.webp",
            uv_scale=uv_scale,
            shader="stone",
            arc_response=1.0,
        )
    )


soil = ground_material("mw/ground/soil-gravel", 0.92, 0.34)
worn = ground_material("mw/ground/worn-stone", 0.86, 0.50)
sand = ground_material("mw/ground/sand-drift", 0.96, 0.45)


# ---------------------------------------------------------------------------
# 변위장과 마른 계류
# ---------------------------------------------------------------------------


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    t = max(0.0, min(1.0, (value - edge0) / max(1.0e-9, edge1 - edge0)))
    return t * t * (3.0 - 2.0 * t)


noise_rng = mw.rng("terrain-low-frequency")
NOISE_PHASES = [float(value) for value in noise_rng.uniform(0.0, TAU, 5)]
NOISE_ANGLES = [float(value) for value in noise_rng.uniform(0.0, TAU, 5)]
NOISE_FREQS = [float(value) for value in noise_rng.uniform(0.055, 0.145, 5)]


def low_noise(x: float, y: float) -> float:
    total = 0.0
    for phase, angle, frequency in zip(NOISE_PHASES, NOISE_ANGLES, NOISE_FREQS):
        axis = x * math.cos(angle) + y * math.sin(angle)
        total += math.sin(axis * frequency * TAU + phase)
    return total / len(NOISE_PHASES)


def angle_delta(a: float, b: float) -> float:
    return abs((a - b + math.pi) % TAU - math.pi)


def stream_distance(radius: float, angle: float) -> float:
    """서남쪽에서 갈라져 동쪽으로 휘는 두 갈래 마른 계류의 횡거리."""
    run = radius - R_INNER
    primary = math.radians(-27.0) + 0.030 * run + 0.075 * math.sin(run * 0.72)
    distance = radius * angle_delta(angle, primary)

    # r=37.2 이후에만 나타나는 짧은 지류. 합류부를 넓혀 인공적인 한 줄을 피한다.
    if radius > 37.2:
        branch = math.radians(-6.0) - 0.052 * (radius - 37.2) + 0.055 * math.sin(run * 0.9)
        distance = min(distance, radius * angle_delta(angle, branch))
    return distance


def terrain_height(radius: float, angle: float) -> float:
    x, y = math.sin(angle) * radius, math.cos(angle) * radius
    inner_fade = smoothstep(R_INNER, 34.35, radius)
    cliff = smoothstep(R_CLIFF, R_OUTER, radius)
    visible = 1.0 - cliff

    # 3개 크기의 변위를 겹친다. 격자 정점이 전부 같은 z를 갖는 환형 띠는 없다.
    macro = low_noise(x, y) * 0.34
    meso = math.sin(angle * 7.0 + radius * 0.61) * 0.085
    gravel_roll = math.sin(x * 1.13 + y * 0.37) * math.sin(y * 0.92 - x * 0.28) * 0.035
    relief = (macro + meso + gravel_roll) * inner_fade * visible

    distance = stream_distance(radius, angle)
    stream = math.exp(-((distance / 0.72) ** 2))
    stream_fade = smoothstep(34.0, 35.2, radius) * (1.0 - smoothstep(44.2, 46.0, radius))
    bed = stream * (0.13 + 0.08 * (0.5 + 0.5 * math.sin(radius * 1.17))) * stream_fade

    # r=48에서는 relief와 bed가 모두 0이므로 원주 전체가 정확히 -6m다.
    return relief - bed - 6.0 * cliff


# ---------------------------------------------------------------------------
# 고밀도 환형 지면
# ---------------------------------------------------------------------------


terrain_verts: list[tuple[float, float, float]] = []
terrain_faces: list[tuple[int, ...]] = []
for radial_index in range(RADIAL_SEGMENTS + 1):
    radius = R_INNER + (R_OUTER - R_INNER) * radial_index / RADIAL_SEGMENTS
    for angle_index in range(ANGULAR_SEGMENTS + 1):
        angle = -math.pi + TAU * angle_index / ANGULAR_SEGMENTS
        terrain_verts.append(
            (
                math.sin(angle) * radius,
                math.cos(angle) * radius,
                terrain_height(radius, angle),
            )
        )

stride = ANGULAR_SEGMENTS + 1
for radial_index in range(RADIAL_SEGMENTS):
    for angle_index in range(ANGULAR_SEGMENTS):
        a = radial_index * stride + angle_index
        b = a + 1
        c = a + stride + 1
        d = a + stride
        terrain_faces.append((a, b, c, d))

terrain = mw.new_mesh("outer-terrain-ground", terrain_verts, terrain_faces)


# ---------------------------------------------------------------------------
# 큰 바위 노두 — 가시 범위 안쪽에만 집중
# ---------------------------------------------------------------------------


OUTCROPS = (
    (35.2, -70.0, 1.20, 1.45, 0.82),
    (36.0, -18.0, 0.82, 1.10, 0.64),
    (36.8, 28.0, 1.45, 1.85, 1.32),
    (37.6, 83.0, 1.10, 1.36, 0.92),
    (38.3, 142.0, 1.62, 2.10, 1.72),
    (39.1, -139.0, 1.22, 1.55, 1.18),
    (40.0, -92.0, 1.80, 2.25, 2.18),
    (40.7, -4.0, 1.34, 1.78, 1.48),
    (41.4, 61.0, 1.66, 2.00, 1.84),
    (42.6, 118.0, 1.42, 1.70, 1.36),
)


def build_outcrops() -> bpy.types.Object:
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    sides = 10
    ring_scales = (0.72, 1.00, 0.90, 0.60, 0.27)
    ring_heights = (-0.07, 0.10, 0.43, 0.72, 0.91)

    for outcrop_index, (radius, angle_deg, sx, sy, height) in enumerate(OUTCROPS):
        generator = mw.rng(f"outcrop-{outcrop_index}")
        angle = math.radians(angle_deg)
        center_x = math.sin(angle) * radius
        center_y = math.cos(angle) * radius
        base_z = terrain_height(radius, angle)
        rotation = float(generator.uniform(-math.pi, math.pi))
        modulation = generator.uniform(0.84, 1.16, sides)
        rings: list[list[int]] = []
        for ring_index, (ring_scale, height_fraction) in enumerate(zip(ring_scales, ring_heights)):
            ring = []
            twist = float(generator.uniform(-0.10, 0.10)) * ring_index
            for side_index in range(sides):
                phi = TAU * side_index / sides + rotation + twist
                radial_scale = float(modulation[side_index]) * ring_scale
                x = center_x + math.cos(phi) * sx * radial_scale
                y = center_y + math.sin(phi) * sy * radial_scale
                z_jag = float(generator.uniform(-0.025, 0.025)) * height
                z = base_z + height * height_fraction + z_jag
                verts.append((x, y, z))
                ring.append(len(verts) - 1)
            rings.append(ring)

        for ring_index in range(len(rings) - 1):
            current, nxt = rings[ring_index], rings[ring_index + 1]
            for side_index in range(sides):
                other = (side_index + 1) % sides
                faces.append(
                    (current[side_index], current[other], nxt[other], nxt[side_index])
                )
        faces.append(tuple(reversed(rings[0])))

        top = len(verts)
        verts.append(
            (
                center_x + float(generator.uniform(-0.10, 0.10)) * sx,
                center_y + float(generator.uniform(-0.10, 0.10)) * sy,
                base_z + height,
            )
        )
        for side_index in range(sides):
            other = (side_index + 1) % sides
            faces.append((rings[-1][side_index], rings[-1][other], top))

    rocks = mw.new_mesh("outer-terrain-outcrops", verts, faces)
    mw.bevel(rocks, 0.022, 2, angle_deg=46.0)
    mw.shade_auto_smooth(rocks, 42.0)
    return rocks


rocks = build_outcrops()


# ---------------------------------------------------------------------------
# 성벽에서 떨어진 석재 더미
# ---------------------------------------------------------------------------


RUBBLE_CENTERS_POLAR = (
    (35.25, math.radians(-53.0)),
    (35.55, math.radians(34.0)),
    (36.05, math.radians(128.0)),
)
RUBBLE_CENTERS = [
    (math.sin(angle) * radius, math.cos(angle) * radius)
    for radius, angle in RUBBLE_CENTERS_POLAR
]


def append_rotated_box(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    center: tuple[float, float, float],
    size: tuple[float, float, float],
    rotation: tuple[float, float, float],
) -> None:
    pivot = Vector(center)
    half = Vector((size[0] * 0.5, size[1] * 0.5, size[2] * 0.5))
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
        points.append(
            pivot + rotation_matrix @ Vector((half.x * x, half.y * y, half.z * z))
        )
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


def build_rubble() -> bpy.types.Object:
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    for pile_index, (center_x, center_y) in enumerate(RUBBLE_CENTERS):
        generator = mw.rng(f"rubble-pile-{pile_index}")
        for stone_index in range(11):
            tangent_offset = float(generator.normal(0.0, 0.46))
            radial_offset = float(generator.normal(0.0, 0.34))
            center_radius = math.hypot(center_x, center_y)
            radial_x, radial_y = center_x / center_radius, center_y / center_radius
            tangent_x, tangent_y = radial_y, -radial_x
            x = center_x + radial_x * radial_offset + tangent_x * tangent_offset
            y = center_y + radial_y * radial_offset + tangent_y * tangent_offset
            radius = math.hypot(x, y)
            angle = math.atan2(x, y)
            base_z = terrain_height(radius, angle)
            sx = float(generator.uniform(0.22, 0.62))
            sy = float(generator.uniform(0.20, 0.54))
            sz = float(generator.uniform(0.12, 0.34))
            pile_lift = max(0.0, 0.34 - math.hypot(tangent_offset, radial_offset) * 0.22)
            append_rotated_box(
                verts,
                faces,
                center=(x, y, base_z + sz * 0.42 + pile_lift),
                size=(sx, sy, sz),
                rotation=(
                    float(generator.uniform(-0.28, 0.28)),
                    float(generator.uniform(-0.28, 0.28)),
                    float(generator.uniform(-math.pi, math.pi)),
                ),
            )
    rubble = mw.new_mesh("outer-terrain-wall-rubble", verts, faces)
    mw.bevel(rubble, 0.012, 2, angle_deg=36.0)
    mw.shade_auto_smooth(rubble, 38.0)
    return rubble


rubble = build_rubble()


# ---------------------------------------------------------------------------
# 단일 메시, 재질 분배, 정점 마스크와 검증
# ---------------------------------------------------------------------------


outer_terrain = mw.join("outer-terrain", (terrain, rocks, rubble))


def near_rubble(x: float, y: float) -> float:
    distance = min(math.hypot(x - cx, y - cy) for cx, cy in RUBBLE_CENTERS)
    return 1.0 - smoothstep(0.55, 1.55, distance)


def material_index(center: Vector, normal: Vector) -> int:
    radius = math.hypot(center.x, center.y)
    angle = math.atan2(center.x, center.y)
    base_z = terrain_height(radius, angle)
    raised_stone = center.z - base_z > 0.11
    if raised_stone or normal.z < 0.48:
        return 1
    if stream_distance(radius, angle) < 0.72 or near_rubble(center.x, center.y) > 0.12:
        return 2
    return 0


mw.assign_by_index(outer_terrain, (soil, worn, sand), material_index)
mw.shade_auto_smooth(outer_terrain, 42.0)
mw.uv_box(outer_terrain, 1.0)


def terrain_color(world: Vector, normal: Vector) -> tuple[float, float, float]:
    radius = math.hypot(world.x, world.y)
    angle = math.atan2(world.x, world.y)
    stream = 1.0 - smoothstep(0.35, 1.35, stream_distance(radius, angle))
    shade = max(0.0, 1.0 - normal.z)
    north_shade = max(0.0, -normal.y) * shade
    rubble_dust = near_rubble(world.x, world.y)
    mottling = 0.5 + 0.5 * low_noise(world.x, world.y)

    wear_value = 0.32 + mottling * 0.24 + rubble_dust * 0.30
    moss_value = 0.05 + stream * 0.66 + shade * 0.30 + north_shade * 0.24
    cliff_crack = smoothstep(40.8, 44.3, radius) * (0.45 + mottling * 0.38)
    outcrop_base = 0.0
    for rock_radius, rock_angle_deg, _sx, _sy, _height in OUTCROPS:
        rock_angle = math.radians(rock_angle_deg)
        rx, ry = math.sin(rock_angle) * rock_radius, math.cos(rock_angle) * rock_radius
        outcrop_base = max(
            outcrop_base,
            1.0 - smoothstep(0.45, 1.45, math.hypot(world.x - rx, world.y - ry)),
        )
    crack_value = max(0.06, cliff_crack, outcrop_base * 0.72)
    return (
        min(1.0, wear_value),
        min(1.0, moss_value),
        min(1.0, crack_value),
    )


mw.set_vertex_colors(outer_terrain, terrain_color)
color = outer_terrain.data.color_attributes.get("Col")
if color is not None:
    outer_terrain.data.color_attributes.active_color = color
    outer_terrain.data.color_attributes.active = color

world_points = [outer_terrain.matrix_world @ vertex.co for vertex in outer_terrain.data.vertices]
z_min = min(float(point.z) for point in world_points)
z_max = max(float(point.z) for point in world_points)
r_min = min(math.hypot(float(point.x), float(point.y)) for point in world_points)
r_max = max(math.hypot(float(point.x), float(point.y)) for point in world_points)
triangles = sum(max(0, len(poly.vertices) - 2) for poly in outer_terrain.data.polygons)

outer_ring_z = [
    terrain_verts[RADIAL_SEGMENTS * stride + index][2]
    for index in range(ANGULAR_SEGMENTS + 1)
]
if max(abs(value + 6.0) for value in outer_ring_z) > 1.0e-8:
    raise SystemExit("[18_terrain] r=48 경계가 -6m에 모이지 않는다")
if r_min < R_INNER - 0.001 or r_max > R_OUTER + 0.001:
    raise SystemExit(
        f"[18_terrain] 반경 범위 위반: {r_min:.6f} .. {r_max:.6f}, "
        f"허용 {R_INNER:.1f} .. {R_OUTER:.1f}"
    )

print(
    f"[18_terrain] outer-terrain: grid={ANGULAR_SEGMENTS}x{RADIAL_SEGMENTS}, "
    f"outcrops={len(OUTCROPS)}, rubble={len(RUBBLE_CENTERS)}x11, "
    f"{triangles:,} tris"
)
print(
    f"[18_terrain] radius {r_min:.6f} .. {r_max:.6f} m, "
    f"z-range {z_min:+.6f} .. {z_max:+.6f} m, r=48 z=-6.000000 m"
)

mw.export_glb(
    "outer-terrain",
    [outer_terrain],
    max_triangles=60_000,
    notes=(
        "dense r=33..48 displaced soil ring; r=42 cliff onset to -6m; "
        "ten rock outcrops, forked dry stream and three fallen-wall rubble piles"
    ),
    extras={
        "zMin": round(z_min, 6),
        "zMax": round(z_max, 6),
        "radiusMin": round(r_min, 6),
        "radiusMax": round(r_max, 6),
        "outerEdgeZ": -6.0,
        "vertexColor": "Col: R wear, G shaded rock/stream damp, B cliff/outcrop cracks",
    },
)
mw.finish()
print("[18_terrain] outer-terrain OK")
