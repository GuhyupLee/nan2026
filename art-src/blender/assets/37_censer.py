# -*- coding: utf-8 -*-
"""삼족 향로와 배례석 — 연화 저부조를 포함한 근거리 청동·화강암 프롭."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=3700)

TAU = math.tau


def shared_material(
    name: str,
    roughness: float,
    uv_scale: float,
    *,
    metallic: float = 0.0,
    shader: str = "default",
):
    family, stem = name.split("/")[-2:]
    return mw.material(
        mw.MaterialSpec(
            name=name,
            base_color=(1.0, 1.0, 1.0, 1.0),
            roughness=roughness,
            metallic=metallic,
            base_color_map=f"env/tex/{family}/{stem}_basecolor.webp",
            normal_map=f"env/tex/{family}/{stem}_normal.webp",
            orm_map=f"env/tex/{family}/{stem}_orm.webp",
            uv_scale=uv_scale,
            shader=shader,
            arc_response=0.55 if metallic else 1.0,
        )
    )


bronze = shared_material("mw/arch/bronze", 0.52, 0.85, metallic=1.0)
granite = shared_material("mw/ground/granite-slab", 0.78, 0.5, shader="stone")
worn = shared_material("mw/ground/worn-stone", 0.86, 0.5, shader="stone")


# ---------------------------------------------------------------------------
# 향로: 0.55m. 세 발은 바깥으로 벌어진 곡선, 몸체는 속이 막히지 않은 회전 프로필이다.
# ---------------------------------------------------------------------------

censer_parts = []
leg_section = [
    (math.cos(TAU * index / 6.0) * 0.027, math.sin(TAU * index / 6.0) * 0.027)
    for index in range(6)
]
for leg_index in range(3):
    angle = math.pi * 0.5 + TAU * leg_index / 3.0
    radial = (math.cos(angle), math.sin(angle))
    tangent = (-math.sin(angle), math.cos(angle))

    def point(radius, z, side=0.0):
        return (
            radial[0] * radius + tangent[0] * side,
            radial[1] * radius + tangent[1] * side,
            z,
        )

    leg = mw.sweep(
        f"censer-leg-{leg_index}",
        leg_section,
        [
            point(0.205, 0.025),
            point(0.195, 0.060, -0.008),
            point(0.160, 0.135, -0.010),
            point(0.125, 0.220, 0.006),
        ],
        smooth=True,
        scale_fn=lambda t: 1.08 - 0.18 * t,
    )
    mw.bevel(leg, 0.004, 1, angle_deg=28.0)
    censer_parts.append(leg)

body = mw.lathe(
    "censer-body",
    [
        (0.065, 0.205),
        (0.145, 0.225),
        (0.220, 0.300),
        (0.245, 0.375),
        (0.248, 0.420),
        (0.262, 0.440),
        (0.220, 0.455),
        (0.205, 0.415),
        (0.202, 0.340),
        (0.145, 0.260),
        (0.065, 0.225),
    ],
    18,
)
mw.shade_auto_smooth(body, 36.0)
censer_parts.append(body)

for z, radius in ((0.305, 0.225), (0.392, 0.247)):
    band = mw.lathe(
        "censer-cast-band",
        [(radius - 0.010, z - 0.012), (radius + 0.009, z), (radius - 0.008, z + 0.012)],
        18,
    )
    censer_parts.append(band)

bpy.ops.mesh.primitive_torus_add(
    major_radius=0.239,
    minor_radius=0.023,
    major_segments=18,
    minor_segments=6,
    location=(0.0, 0.0, 0.444),
)
rim = bpy.context.object
rim.name = "censer-rim"
censer_parts.append(rim)

# 좌우 귀 손잡이.
for sign in (-1.0, 1.0):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.082,
        minor_radius=0.019,
        major_segments=12,
        minor_segments=5,
        location=(sign * 0.275, 0.0, 0.405),
        rotation=(math.pi * 0.5, 0.0, 0.0),
    )
    handle = bpy.context.object
    handle.name = "censer-ear-handle"
    censer_parts.append(handle)

# 낮은 뚜껑과 꼭지로 정확히 0.55m를 잡는다.
lid = mw.lathe(
    "censer-lid",
    [(0.0, 0.438), (0.205, 0.438), (0.220, 0.460), (0.105, 0.500), (0.0, 0.505)],
    18,
)
censer_parts.append(lid)
knob = mw.lathe(
    "censer-lid-knob",
    [(0.0, 0.495), (0.045, 0.505), (0.052, 0.532), (0.028, 0.550), (0.0, 0.550)],
    12,
)
censer_parts.append(knob)

censer = mw.join("censer", censer_parts)
mw.apply_transform(censer)
mw.assign(censer, bronze)
mw.shade_auto_smooth(censer, 36.0)
mw.uv_cylinder(censer)
censer.location = (0.0, 0.46, 0.0)


# ---------------------------------------------------------------------------
# 배례석. 깨진 모서리와 12엽 얕은 연화문을 실제 상면 지오메트리로 만든다.
# ---------------------------------------------------------------------------

slab_footprint = [
    (-0.60, -0.40),
    (0.49, -0.40),
    (0.60, -0.29),
    (0.60, 0.40),
    (-0.53, 0.40),
    (-0.60, 0.33),
]
slab_verts = [(x, y, 0.0) for x, y in slab_footprint] + [(x, y, 0.22) for x, y in slab_footprint]
count = len(slab_footprint)
slab_faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
for index in range(count):
    nxt = (index + 1) % count
    slab_faces.append((index, nxt, count + nxt, count + index))
slab = mw.new_mesh("offering-stone-slab", slab_verts, slab_faces)
mw.bevel(slab, 0.018, 2)

relief_parts = [slab]
for petal_index in range(12):
    angle = TAU * petal_index / 12.0
    radial = (math.cos(angle), math.sin(angle))
    tangent = (-math.sin(angle), math.cos(angle))
    center = (radial[0] * 0.145, radial[1] * 0.145)
    half_width = 0.048
    inner_radius = 0.050
    outer_radius = 0.265
    points = [
        (
            radial[0] * inner_radius + tangent[0] * half_width,
            radial[1] * inner_radius + tangent[1] * half_width,
            0.222,
        ),
        (
            radial[0] * inner_radius - tangent[0] * half_width,
            radial[1] * inner_radius - tangent[1] * half_width,
            0.222,
        ),
        (
            radial[0] * outer_radius - tangent[0] * 0.020,
            radial[1] * outer_radius - tangent[1] * 0.020,
            0.224,
        ),
        (radial[0] * (outer_radius + 0.040), radial[1] * (outer_radius + 0.040), 0.226),
        (
            radial[0] * outer_radius + tangent[0] * 0.020,
            radial[1] * outer_radius + tangent[1] * 0.020,
            0.224,
        ),
        (center[0], center[1], 0.234),
    ]
    petal = mw.new_mesh(
        f"offering-stone-lotus-petal-{petal_index}",
        points,
        [(0, 1, 5), (1, 2, 5), (2, 3, 5), (3, 4, 5), (4, 0, 5)],
        smooth=True,
    )
    mw.solidify(petal, 0.006, offset=-1.0)
    mw.bevel(petal, 0.003, 1, angle_deg=25.0)
    relief_parts.append(petal)

offering_stone = mw.join("offering-stone", relief_parts)
mw.apply_transform(offering_stone)
mw.assign_by_index(
    offering_stone,
    (granite, worn),
    lambda center, normal: 1 if normal.z < 0.15 or center.x > 0.48 else 0,
)
mw.shade_auto_smooth(offering_stone, 38.0)
mw.uv_box(offering_stone, 1.0)
offering_stone.location = (0.0, -0.45, 0.0)

censer_z = [float(vertex.co.z) for vertex in censer.data.vertices]
if min(censer_z) < -0.001 or max(censer_z) > 0.551:
    raise SystemExit(f"[37_censer] 향로 높이 계약 위반: {min(censer_z):.4f}..{max(censer_z):.4f}")

mw.export_glb(
    "censer",
    [censer, offering_stone],
    max_triangles=2_400,
    notes="0.55m three-legged bronze censer and separate 1.2x0.8x0.22m beveled offering-stone with shallow 12-petal lotus relief",
)
mw.finish()

