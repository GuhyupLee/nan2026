# -*- coding: utf-8 -*-
"""종각과 범종 — 화면에 남는 하부 구조와 실제 주조 장식을 갖춘 4.2m 프롭."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=3300)

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


granite = shared_material("mw/ground/granite-slab", 0.78, 0.5, shader="stone")
timber = shared_material("mw/arch/timber", 0.78, 0.72)
painted = shared_material("mw/arch/painted-wood", 0.72, 0.78)
roof_tile = shared_material("mw/arch/roof-tile", 0.74, 1.2, shader="stone")
bronze = shared_material("mw/arch/bronze", 0.52, 0.85, metallic=1.0)


def square_ring(half: float, edge_z: float, corner_z: float):
    points = (
        (-half, -half),
        (0.0, -half),
        (half, -half),
        (half, 0.0),
        (half, half),
        (0.0, half),
        (-half, half),
        (-half, 0.0),
    )
    return [(x, y, corner_z if index % 2 == 0 else edge_z) for index, (x, y) in enumerate(points)]


def pavilion_roof():
    """처마 끝이 들린 두꺼운 사모지붕. 상부는 실루엣에 필요한 링만 둔다."""
    outer_top = square_ring(1.58, 2.90, 3.055)
    middle_top = square_ring(0.96, 3.38, 3.43)
    upper_top = square_ring(0.18, 3.92, 3.92)
    outer_bottom = square_ring(1.58, 2.78, 2.89)
    inner_bottom = square_ring(0.34, 3.50, 3.50)
    verts = outer_top + middle_top + upper_top + outer_bottom + inner_bottom
    top_center = len(verts)
    verts.append((0.0, 0.0, 3.97))

    faces = []
    for start_a, start_b in ((0, 8), (8, 16)):
        for index in range(8):
            nxt = (index + 1) % 8
            faces.append((start_a + index, start_a + nxt, start_b + nxt, start_b + index))
    for index in range(8):
        nxt = (index + 1) % 8
        faces.append((16 + index, 16 + nxt, top_center))
        faces.append((index, 24 + index, 24 + nxt, nxt))
        faces.append((24 + index, 32 + index, 32 + nxt, 24 + nxt))
    faces.append(tuple(reversed(range(32, 40))))
    roof = mw.new_mesh("pavilion-samo-roof", verts, faces)
    mw.bevel(roof, 0.018, 1, angle_deg=31.0)
    return roof


# ---------------------------------------------------------------------------
# 종각. 카메라에서 자주 잘리는 3m 위는 지붕 실루엣만, 그 아래는 구조 결구를 둔다.
# ---------------------------------------------------------------------------

pavilion_parts = []
column_xy = ((-1.05, -1.05), (1.05, -1.05), (1.05, 1.05), (-1.05, 1.05))

for index, (x, y) in enumerate(column_xy):
    foundation = mw.box(
        f"pavilion-foundation-{index}",
        (0.46, 0.46, 0.18),
        location=(x, y, 0.0),
        pivot_bottom=True,
    )
    mw.bevel(foundation, 0.018, 2)
    pavilion_parts.append(foundation)

    column = mw.prism(
        f"pavilion-column-{index}",
        12,
        0.155,
        0.145,
        2.47,
        location=(x, y, 0.18),
        rotation=math.pi / 12.0,
    )
    mw.bevel(column, 0.008, 1, angle_deg=28.0)
    pavilion_parts.append(column)

    # 주두와 간략 공포. 부감에서 겹쳐 보이는 세 단의 길이를 달리한다.
    for tier, (size, z) in enumerate(((0.34, 2.52), (0.48, 2.61), (0.60, 2.70))):
        bracket = mw.box(
            f"pavilion-bracket-{index}-{tier}",
            (size, 0.16 if tier != 1 else 0.22, 0.10),
            location=(x, y, z),
        )
        bracket.rotation_euler.z = (math.pi * 0.5) if tier == 1 else 0.0
        mw.bevel(bracket, 0.010, 1)
        pavilion_parts.append(bracket)

# 창방·평방은 하단 3m의 큰 음영선을 만든다.
for axis, fixed in (("x", -1.05), ("x", 1.05), ("y", -1.05), ("y", 1.05)):
    if axis == "x":
        size = (2.42, 0.16, 0.18)
        location = (0.0, fixed, 2.46)
    else:
        size = (0.16, 2.42, 0.18)
        location = (fixed, 0.0, 2.46)
    beam = mw.box(f"pavilion-changbang-{axis}-{fixed:+.2f}", size, location=location)
    mw.bevel(beam, 0.012, 1)
    pavilion_parts.append(beam)

# 종을 매다는 중심 보. 지붕 아래에서 보이는 면이라 실제 두께와 받침을 둔다.
hanger_beam = mw.box("pavilion-bell-beam", (0.22, 2.46, 0.24), location=(0.0, 0.0, 2.64))
mw.bevel(hanger_beam, 0.014, 1)
pavilion_parts.append(hanger_beam)
for y in (-0.50, 0.50):
    brace = mw.box("pavilion-hanger-brace", (0.42, 0.18, 0.13), location=(0.0, y, 2.48))
    mw.bevel(brace, 0.010, 1)
    pavilion_parts.append(brace)

pavilion_parts.append(pavilion_roof())
finial = mw.prism(
    "pavilion-roof-finial",
    4,
    0.12,
    0.025,
    0.23,
    location=(0.0, 0.0, 3.97),
    rotation=math.pi / 4.0,
)
mw.bevel(finial, 0.008, 1)
pavilion_parts.append(finial)

pavilion = mw.join("bell-pavilion", pavilion_parts)
mw.apply_transform(pavilion)
mw.assign_by_index(
    pavilion,
    (granite, timber, painted, roof_tile),
    lambda center, _normal: (
        0
        if center.z < 0.21
        else (3 if center.z > 2.77 else (2 if center.z > 2.43 else 1))
    ),
)
mw.shade_auto_smooth(pavilion, 36.0)
mw.uv_box(pavilion, 1.0)


# ---------------------------------------------------------------------------
# 범종. 메시 좌표의 (0,0,0)이 매다는 핀 축이며 오브젝트 위치만 종각 보로 옮긴다.
# ---------------------------------------------------------------------------

bell_parts = []
bell_body = mw.lathe(
    "bell-body",
    [
        (0.070, -0.075),
        (0.185, -0.115),
        (0.285, -0.200),
        (0.330, -0.390),
        (0.355, -0.700),
        (0.405, -0.970),
        (0.420, -1.040),
        (0.365, -1.100),
        (0.330, -1.055),
        (0.350, -0.985),
        (0.300, -0.700),
        (0.275, -0.405),
        (0.235, -0.225),
        (0.070, -0.120),
    ],
    24,
)
bell_parts.append(bell_body)

# 상대·하대의 이중 띠. 안쪽 면까지 이어지는 회전 프로필이라 차폐 때도 두께가 남는다.
for name, z, radius in (
    ("bell-upper-band-a", -0.225, 0.300),
    ("bell-upper-band-b", -0.278, 0.315),
    ("bell-lower-band-a", -0.885, 0.390),
    ("bell-lower-band-b", -0.948, 0.405),
):
    band = mw.lathe(
        name,
        [(radius - 0.012, z - 0.018), (radius + 0.012, z), (radius - 0.010, z + 0.018)],
        24,
    )
    mw.bevel(band, 0.004, 1, angle_deg=25.0)
    bell_parts.append(band)

# 유곽 네 벌과 유두 9개씩. 모든 유두는 실제 저해상도 구형 지오메트리다.
for panel_index in range(4):
    angle = TAU * panel_index / 4.0
    normal = (math.cos(angle), math.sin(angle))
    tangent = (-math.sin(angle), math.cos(angle))
    radius = 0.326

    def panel_box(name, tangential, z, width, height):
        location = (
            normal[0] * radius + tangent[0] * tangential,
            normal[1] * radius + tangent[1] * tangential,
            z,
        )
        part = mw.box(name, (width, 0.024, height), location=location)
        part.rotation_euler.z = angle - math.pi * 0.5
        mw.bevel(part, 0.004, 1)
        return part

    for edge_index, offset in enumerate((-0.122, 0.122)):
        bell_parts.append(
            panel_box(f"bell-nipple-panel-{panel_index}-side-{edge_index}", offset, -0.430, 0.022, 0.285)
        )
    for edge_index, z in enumerate((-0.562, -0.298)):
        bell_parts.append(
            panel_box(f"bell-nipple-panel-{panel_index}-rail-{edge_index}", 0.0, z, 0.266, 0.022)
        )

    for row in range(3):
        for column in range(3):
            tangential = (column - 1) * 0.073
            z = -0.430 + (row - 1) * 0.072
            bpy.ops.mesh.primitive_ico_sphere_add(
                subdivisions=1,
                radius=0.021,
                location=(
                    normal[0] * (radius + 0.020) + tangent[0] * tangential,
                    normal[1] * (radius + 0.020) + tangent[1] * tangential,
                    z,
                ),
            )
            nipple = bpy.context.object
            nipple.name = f"bell-nipple-{panel_index}-{row}-{column}"
            nipple.scale = (0.78, 0.78, 0.72)
            mw.apply_transform(nipple)
            bell_parts.append(nipple)

# 앞뒤 당좌. 원판과 중앙 돌기를 겹쳐 연화형 충격판으로 읽히게 한다.
for pad_index, sign in enumerate((-1.0, 1.0)):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=16,
        radius=0.115,
        depth=0.028,
        location=(0.0, sign * 0.365, -0.690),
        rotation=(math.pi * 0.5, 0.0, 0.0),
    )
    pad = bpy.context.object
    pad.name = f"bell-striking-pad-{pad_index}"
    mw.bevel(pad, 0.006, 1)
    bell_parts.append(pad)

    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=1,
        radius=0.046,
        location=(0.0, sign * 0.386, -0.690),
    )
    boss = bpy.context.object
    boss.name = f"bell-striking-pad-boss-{pad_index}"
    boss.scale = (1.0, 0.56, 1.0)
    mw.apply_transform(boss)
    bell_parts.append(boss)

# 용뉴 고리와 양쪽 받침, 그 옆의 음통.
bpy.ops.mesh.primitive_torus_add(
    major_radius=0.105,
    minor_radius=0.032,
    major_segments=16,
    minor_segments=6,
    location=(0.0, 0.0, 0.045),
    rotation=(math.pi * 0.5, 0.0, 0.0),
)
dragon_loop = bpy.context.object
dragon_loop.name = "bell-dragon-loop"
bell_parts.append(dragon_loop)
for x in (-0.092, 0.092):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.055, location=(x, 0.0, -0.060))
    mount = bpy.context.object
    mount.name = "bell-dragon-mount"
    mount.scale = (1.2, 0.8, 0.7)
    mw.apply_transform(mount)
    bell_parts.append(mount)

sound_tube = mw.prism(
    "bell-sound-tube",
    10,
    0.035,
    0.031,
    0.215,
    location=(0.155, 0.0, -0.065),
    rotation=math.pi / 10.0,
)
mw.bevel(sound_tube, 0.004, 1)
bell_parts.append(sound_tube)

bell = mw.join("bell", bell_parts)
mw.apply_transform(bell)
mw.assign(bell, bronze)
mw.shade_auto_smooth(bell, 34.0)
mw.uv_cylinder(bell, u_scale=1.0, v_scale=1.0)
# 원점은 로컬 (0,0,0), 즉 용뉴를 꿰는 축이다. 위치만 종각 안의 매달림 높이로 이동한다.
bell.location = (0.0, 0.0, 2.565)

bell_local_z = [float(vertex.co.z) for vertex in bell.data.vertices]
if min(bell_local_z) < -1.105 or max(bell_local_z) > 0.185:
    raise SystemExit(
        f"[33_bell] 종 원점/높이 계약 위반: local z={min(bell_local_z):.4f}..{max(bell_local_z):.4f}"
    )

pavilion_world_z = [float((pavilion.matrix_world @ vertex.co).z) for vertex in pavilion.data.vertices]
if min(pavilion_world_z) < -0.001 or max(pavilion_world_z) > 4.201:
    raise SystemExit(
        f"[33_bell] 종각 높이 계약 위반: z={min(pavilion_world_z):.4f}..{max(pavilion_world_z):.4f}"
    )

mw.export_glb(
    "bell-pavilion",
    [pavilion, bell],
    max_triangles=12_000,
    notes="4.2m four-column bell pavilion; 1.1m separate bell with 4 nipple panels, 36 nipples, 2 striking pads, dragon loop and sound tube; bell origin is suspension axis",
)
mw.finish()
