# -*- coding: utf-8 -*-
"""대형 잔해 키트 — 성벽 하부와 회랑용 개별 파손 프롭 7종."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=3500)

TAU = math.tau


def shared_material(name: str, roughness: float, uv_scale: float, *, shader="default"):
    family, stem = name.split("/")[-2:]
    return mw.material(
        mw.MaterialSpec(
            name=name,
            base_color=(1.0, 1.0, 1.0, 1.0),
            roughness=roughness,
            base_color_map=f"env/tex/{family}/{stem}_basecolor.webp",
            normal_map=f"env/tex/{family}/{stem}_normal.webp",
            orm_map=f"env/tex/{family}/{stem}_orm.webp",
            uv_scale=uv_scale,
            shader=shader,
            arc_response=1.0,
        )
    )


granite = shared_material("mw/ground/granite-slab", 0.78, 0.5, shader="stone")
worn = shared_material("mw/ground/worn-stone", 0.86, 0.5, shader="stone")
masonry = shared_material("mw/arch/masonry", 0.84, 0.65, shader="stone")
roof_tile = shared_material("mw/arch/roof-tile", 0.74, 1.2, shader="stone")
timber = shared_material("mw/arch/timber", 0.78, 0.72)
painted = shared_material("mw/arch/painted-wood", 0.72, 0.78)


def extruded_fragment(name: str, footprint, height: float):
    count = len(footprint)
    verts = [(x, y, 0.0) for x, y in footprint] + [(x, y, height) for x, y in footprint]
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    return mw.new_mesh(name, verts, faces)


def finish_stone(obj, *, bevel=0.012):
    mw.bevel(obj, bevel, 2)
    mw.apply_transform(obj)
    mw.assign_by_index(
        obj,
        (granite, worn, masonry),
        lambda center, normal: (
            2 if normal.z < -0.25 else (1 if normal.z < 0.35 or center.z < 0.045 else 0)
        ),
    )
    mw.shade_auto_smooth(obj, 36.0)
    mw.uv_box(obj, 1.0)
    return obj


# ---------------------------------------------------------------------------
# 깨진 판석 2종. 완전한 직사각형 대신 파단 모서리와 빠져나간 쐐기를 실루엣으로 둔다.
# ---------------------------------------------------------------------------

slab_a = extruded_fragment(
    "slab-broken-a",
    [
        (-0.52, -0.30),
        (0.37, -0.30),
        (0.52, -0.18),
        (0.43, -0.02),
        (0.51, 0.25),
        (0.18, 0.30),
        (0.05, 0.22),
        (-0.25, 0.30),
        (-0.52, 0.18),
    ],
    0.105,
)
finish_stone(slab_a, bevel=0.014)

slab_b = extruded_fragment(
    "slab-broken-b",
    [
        (-0.39, -0.27),
        (0.22, -0.27),
        (0.36, -0.14),
        (0.28, 0.02),
        (0.38, 0.19),
        (0.07, 0.25),
        (-0.08, 0.17),
        (-0.30, 0.26),
        (-0.43, 0.08),
    ],
    0.090,
)
finish_stone(slab_b, bevel=0.012)


# ---------------------------------------------------------------------------
# 부러진 기둥 토막. X축을 따라 눕고 양 끝 링의 위치와 반지름이 흔들려 파단면이 된다.
# ---------------------------------------------------------------------------


def column_drum(name: str, length: float, radius: float, salt: str):
    gen = mw.rng(salt)
    sides = 12
    ring_x = (-length * 0.50, -length * 0.40, length * 0.40, length * 0.50)
    verts = []
    for ring_index, x in enumerate(ring_x):
        for side_index in range(sides):
            angle = TAU * side_index / sides
            edge_jag = float(gen.uniform(-0.028, 0.028)) if ring_index in (0, 3) else 0.0
            local_radius = radius * (
                1.0
                + 0.025 * math.sin(angle * 3.0 + ring_index)
                + float(gen.uniform(-0.012, 0.012))
            )
            verts.append(
                (
                    x + edge_jag,
                    math.cos(angle) * local_radius,
                    radius + math.sin(angle) * local_radius,
                )
            )
    faces = []
    for ring_index in range(3):
        a0 = ring_index * sides
        a1 = a0 + sides
        for side_index in range(sides):
            nxt = (side_index + 1) % sides
            faces.append((a0 + side_index, a0 + nxt, a1 + nxt, a1 + side_index))
    faces.append(tuple(reversed(range(sides))))
    faces.append(tuple(3 * sides + index for index in range(sides)))
    drum = mw.new_mesh(name, verts, faces, smooth=True)

    collars = [drum]
    for sign in (-1.0, 1.0):
        bpy.ops.mesh.primitive_torus_add(
            major_radius=radius * 0.98,
            minor_radius=radius * 0.075,
            major_segments=12,
            minor_segments=5,
            location=(sign * length * 0.34, 0.0, radius),
            rotation=(0.0, math.pi * 0.5, 0.0),
        )
        collar = bpy.context.object
        collar.name = f"{name}-collar"
        collars.append(collar)
    result = mw.join(name, collars)
    return finish_stone(result, bevel=0.008)


drum_a = column_drum("column-drum-a", 0.72, 0.185, "column-drum-a")
drum_b = column_drum("column-drum-b", 0.55, 0.225, "column-drum-b")


# ---------------------------------------------------------------------------
# 썩은 보. 위·아래 모서리와 두 파단면을 각각 다르게 찢은 긴 팔각 프리즘이다.
# ---------------------------------------------------------------------------

beam_footprint = [
    (-0.62, -0.09),
    (-0.53, -0.13),
    (0.45, -0.12),
    (0.62, -0.04),
    (0.57, 0.08),
    (0.39, 0.12),
    (-0.50, 0.11),
    (-0.62, 0.05),
]
beam = extruded_fragment("beam-a", beam_footprint, 0.20)
mw.bevel(beam, 0.010, 2)
mw.apply_transform(beam)
mw.assign_by_index(
    beam,
    (timber, painted),
    lambda center, normal: 1 if abs(center.x) > 0.46 or normal.z < -0.2 else 0,
)
mw.shade_auto_smooth(beam, 34.0)
mw.uv_box(beam, 1.0)


# ---------------------------------------------------------------------------
# 기와 무더기. 12개 조각은 하나의 오브젝트지만 서로 겹친 실루엣과 실제 두께를 가진다.
# ---------------------------------------------------------------------------


def tile_piece(name: str, length: float, width: float, camber: float, thickness: float):
    columns = 4
    rows = 4
    verts = []
    for layer in (0, 1):
        for row in range(rows):
            v = row / (rows - 1)
            y = (v - 0.5) * length
            for column in range(columns):
                u = column / (columns - 1) * 2.0 - 1.0
                x = u * width * 0.5
                curve = camber * (1.0 - u * u)
                top = thickness + curve
                verts.append((x, y, top if layer == 0 else top - thickness))
    stride = rows * columns
    faces = []
    for row in range(rows - 1):
        for column in range(columns - 1):
            a = row * columns + column
            b = a + 1
            d = (row + 1) * columns + column
            c = d + 1
            faces.append((a, b, c, d))
            faces.append((stride + d, stride + c, stride + b, stride + a))
    for row in range(rows - 1):
        for column in (0, columns - 1):
            a = row * columns + column
            b = (row + 1) * columns + column
            faces.append((a, b, stride + b, stride + a))
    for row in (0, rows - 1):
        for column in range(columns - 1):
            a = row * columns + column
            b = a + 1
            faces.append((b, a, stride + a, stride + b))
    tile = mw.new_mesh(name, verts, faces)
    mw.bevel(tile, 0.003, 1)
    return tile


tile_rng = mw.rng("tile-pile-a")
tiles = []
for index in range(12):
    length = float(tile_rng.uniform(0.27, 0.39))
    width = float(tile_rng.uniform(0.16, 0.23))
    tile = tile_piece(
        f"tile-pile-piece-{index}",
        length,
        width,
        float(tile_rng.uniform(0.020, 0.034)),
        0.012,
    )
    layer = index // 5
    tile.location = (
        float(tile_rng.uniform(-0.34, 0.34)) * (1.0 - layer * 0.15),
        float(tile_rng.uniform(-0.27, 0.27)) * (1.0 - layer * 0.15),
        0.025 + layer * 0.075,
    )
    tile.rotation_euler = (
        float(tile_rng.uniform(-0.14, 0.14)),
        float(tile_rng.uniform(-0.14, 0.14)),
        float(tile_rng.uniform(0.0, TAU)),
    )
    mw.apply_transform(tile)
    tiles.append(tile)

tile_pile = mw.join("tile-pile-a", tiles)
mw.apply_transform(tile_pile)
minimum_z = min(float(vertex.co.z) for vertex in tile_pile.data.vertices)
for vertex in tile_pile.data.vertices:
    vertex.co.z -= minimum_z
tile_pile.data.update()
mw.assign_by_index(
    tile_pile,
    (roof_tile, worn),
    lambda _center, normal: 1 if normal.z < 0.05 else 0,
)
mw.shade_auto_smooth(tile_pile, 34.0)
mw.uv_box(tile_pile, 1.0)


# ---------------------------------------------------------------------------
# 깨진 계단석. 두 단이 한 조각으로 남고 오른쪽 앞부분이 크게 탈락했다.
# ---------------------------------------------------------------------------

step_lower = extruded_fragment(
    "step-fragment-lower",
    [
        (-0.52, -0.25),
        (0.31, -0.25),
        (0.49, -0.10),
        (0.39, 0.05),
        (0.50, 0.18),
        (0.20, 0.25),
        (-0.52, 0.25),
    ],
    0.16,
)
step_upper = extruded_fragment(
    "step-fragment-upper",
    [
        (-0.40, -0.12),
        (0.22, -0.12),
        (0.36, -0.01),
        (0.27, 0.14),
        (-0.40, 0.14),
    ],
    0.13,
)
step_upper.location.z = 0.16
step = mw.join("step-fragment-a", (step_lower, step_upper))
finish_stone(step, bevel=0.014)


debris_objects = [slab_a, slab_b, drum_a, drum_b, beam, tile_pile, step]
expected_names = [
    "slab-broken-a",
    "slab-broken-b",
    "column-drum-a",
    "column-drum-b",
    "beam-a",
    "tile-pile-a",
    "step-fragment-a",
]
assert [obj.name for obj in debris_objects] == expected_names
assert len({id(obj.data) for obj in debris_objects}) == len(debris_objects)

for obj in debris_objects:
    triangles = sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons)
    print(f"[35_rubble] {obj.name}: {triangles:,} tris")

mw.export_glb(
    "debris-kit",
    debris_objects,
    max_triangles=7_000,
    notes="7 independent wall-and-corridor debris props; broken slabs, two column drums, rotten beam, 12-piece tile pile and stair fragment; existing materials mixed per polygon",
)
mw.finish()

