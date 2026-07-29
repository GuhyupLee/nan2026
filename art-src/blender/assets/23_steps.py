# -*- coding: utf-8 -*-
"""성벽 오름계단 — 14개 실제 돌단과 양쪽 소맷돌.

배치기는 이 에셋을 네 방위 사이의 대각선(45/135/225/315도)에 놓는다.
로컬 +Y가 오르는 방향이며, 바닥 중심 원점에서 2.6m 성벽 상면까지 닿는다.
"""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=2300)

WIDTH = 1.8
STEP_COUNT = 14
TOP = 2.6
RISE = TOP / STEP_COUNT
TREAD = 0.27
RUN = TREAD * STEP_COUNT


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


granite = ground_material("mw/ground/granite-slab", 0.78, 0.50)
worn = ground_material("mw/ground/worn-stone", 0.86, 0.50)
moss = ground_material("mw/ground/moss-lichen", 0.94, 0.70)


def append_box(
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
    center: tuple[float, float, float],
    size: tuple[float, float, float],
) -> None:
    cx, cy, cz = center
    hx, hy, hz = size[0] * 0.5, size[1] * 0.5, size[2] * 0.5
    base = len(verts)
    verts.extend(
        [
            (cx - hx, cy - hy, cz - hz),
            (cx + hx, cy - hy, cz - hz),
            (cx + hx, cy + hy, cz - hz),
            (cx - hx, cy + hy, cz - hz),
            (cx - hx, cy - hy, cz + hz),
            (cx + hx, cy - hy, cz + hz),
            (cx + hx, cy + hy, cz + hz),
            (cx - hx, cy + hy, cz + hz),
        ]
    )
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


step_verts: list[tuple[float, float, float]] = []
step_faces: list[tuple[int, ...]] = []
for index in range(STEP_COUNT):
    height = RISE * (index + 1)
    y = -RUN * 0.5 + TREAD * (index + 0.5)
    append_box(
        step_verts,
        step_faces,
        center=(0.0, y, height * 0.5),
        size=(WIDTH, TREAD - 0.010, height),
    )

steps = mw.new_mesh("wall-stair-blocks", step_verts, step_faces)
mw.bevel(steps, 0.012, 2, angle_deg=36.0)


def sleeve_stone(name: str, side: float) -> bpy.types.Object:
    """계단 경사를 따라 오르는 낮고 두꺼운 전통 소맷돌."""
    stations = 9
    rail_width = 0.20
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, ...]] = []
    rings: list[list[int]] = []
    for station in range(stations):
        t = station / (stations - 1)
        y = -RUN * 0.5 + RUN * t
        floor = TOP * t
        # 가운데가 5cm 더 솟아 직선 콘크리트 난간처럼 보이지 않게 한다.
        cap = 0.29 + 0.05 * math.sin(math.pi * t)
        x0 = side - rail_width * 0.5
        x1 = side + rail_width * 0.5
        ring = []
        for point in (
            (x0, y, floor - 0.015),
            (x1, y, floor - 0.015),
            (x1 - 0.012, y, floor + cap),
            (x0 + 0.012, y, floor + cap),
        ):
            verts.append(point)
            ring.append(len(verts) - 1)
        rings.append(ring)

    for station in range(stations - 1):
        current, nxt = rings[station], rings[station + 1]
        for edge in range(4):
            other = (edge + 1) % 4
            faces.append((current[edge], current[other], nxt[other], nxt[edge]))
    faces.append(tuple(reversed(rings[0])))
    faces.append(tuple(rings[-1]))
    rail = mw.new_mesh(name, verts, faces)
    mw.bevel(rail, 0.014, 2, angle_deg=34.0)
    return rail


left = sleeve_stone("wall-stair-left-sleeve", -(WIDTH * 0.5 + 0.10))
right = sleeve_stone("wall-stair-right-sleeve", WIDTH * 0.5 + 0.10)
wall_stair = mw.join("wall-stair", (steps, left, right))


def material_index(center: Vector, normal: Vector) -> int:
    if abs(center.x) > WIDTH * 0.5 and normal.z < 0.55:
        return 2
    if normal.z > 0.62 or center.z > TOP:
        return 1
    return 0


mw.assign_by_index(wall_stair, (granite, worn, moss), material_index)
mw.shade_auto_smooth(wall_stair, 36.0)
mw.uv_box(wall_stair, 1.0)


def stair_color(world: Vector, normal: Vector) -> tuple[float, float, float]:
    tread_phase = ((world.y + RUN * 0.5) / TREAD) % 1.0
    seam = 1.0 - min(1.0, min(tread_phase, 1.0 - tread_phase) / 0.18)
    traffic = 1.0 - min(1.0, abs(world.x) / (WIDTH * 0.5))
    rail_shadow = 1.0 if abs(world.x) > WIDTH * 0.5 else 0.0
    wear_value = 0.30 + traffic * max(0.0, normal.z) * 0.62
    moss_value = 0.05 + rail_shadow * (0.24 + 0.36 * max(0.0, 1.0 - normal.z))
    crack_value = 0.08 + seam * 0.62
    return (min(1.0, wear_value), min(1.0, moss_value), min(1.0, crack_value))


mw.set_vertex_colors(wall_stair, stair_color)
color = wall_stair.data.color_attributes.get("Col")
if color is not None:
    wall_stair.data.color_attributes.active_color = color
    wall_stair.data.color_attributes.active = color

z_values = [float((wall_stair.matrix_world @ vertex.co).z) for vertex in wall_stair.data.vertices]
z_min, z_max = min(z_values), max(z_values)
triangles = sum(max(0, len(poly.vertices) - 2) for poly in wall_stair.data.polygons)
print(
    f"[23_steps] wall-stair: steps={STEP_COUNT}, width={WIDTH:.2f}m, "
    f"rise={TOP:.2f}m, {triangles:,} tris, z-range {z_min:+.6f} .. {z_max:+.6f} m"
)

mw.export_glb(
    "wall-stair",
    [wall_stair],
    max_triangles=3_000,
    notes="1.8m wide wall stair; 14 real stone steps to z=2.6m with paired sleeve stones",
    extras={
        "zMin": round(z_min, 6),
        "zMax": round(z_max, 6),
        "stepCount": STEP_COUNT,
        "placementDegrees": [45, 135, 225, 315],
        "vertexColor": "Col: R tread wear, G sleeve moss, B riser seam proximity",
    },
)
mw.finish()
print("[23_steps] wall-stair OK")
