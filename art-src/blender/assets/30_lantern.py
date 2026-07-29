# -*- coding: utf-8 -*-
"""한국 석등 — 관통 화창과 앙곡이 있는 2.05m 팔각 석등."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=3000)

TAU = math.tau


# ---------------------------------------------------------------------------
# 공유 머티리얼
# ---------------------------------------------------------------------------


def stone_material(name: str, roughness: float, uv_scale: float):
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
            shader="stone",
            arc_response=1.0,
        )
    )


granite = stone_material("mw/ground/granite-slab", 0.78, 0.5)
worn = stone_material("mw/ground/worn-stone", 0.86, 0.5)
moss = stone_material("mw/ground/moss-lichen", 0.94, 0.7)
flame = mw.material(
    mw.MaterialSpec(
        name="mw/light/flame",
        base_color=(1.0, 0.72, 0.38, 1.0),
        roughness=0.24,
        emission=(1.0, 0.62, 0.28),
        emission_strength=6.0,
        shader="emissive",
        arc_response=0.15,
    )
)


# ---------------------------------------------------------------------------
# 조형 유틸리티
# ---------------------------------------------------------------------------


def apply_boolean(target, cutter, operation: str) -> None:
    """Exact 불리언을 즉시 적용하고 커터를 지운다."""
    mw.activate(target)
    modifier = target.modifiers.new(f"mw-{operation.lower()}", "BOOLEAN")
    modifier.operation = operation
    modifier.solver = "EXACT"
    modifier.object = cutter
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def arch_cutter(name: str, angle: float):
    """한 화창의 D자 단면을 팔각 면의 법선 방향으로 관통시킨다."""
    radius_mid = 0.245
    depth = 0.16
    half_width = 0.071
    z_bottom = 1.435
    z_spring = 1.615

    outline = [(-half_width, z_bottom), (half_width, z_bottom), (half_width, z_spring)]
    for index in range(1, 8):
        theta = math.pi * index / 8.0
        outline.append(
            (
                half_width * math.cos(theta),
                z_spring + half_width * math.sin(theta),
            )
        )
    outline.append((-half_width, z_spring))

    normal = (math.cos(angle), math.sin(angle))
    tangent = (-math.sin(angle), math.cos(angle))
    verts = []
    for d in (-depth * 0.5, depth * 0.5):
        for u, z in outline:
            radial = radius_mid + d
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


def lotus_petal(name: str, *, inverted: bool):
    """+Y를 향한 연꽃잎 원형. 아래에서 회전 복제해 팔엽을 만든다."""
    if inverted:
        points = [
            (-0.050, 0.105, 0.338),
            (0.050, 0.105, 0.338),
            (-0.074, 0.225, 0.275),
            (0.074, 0.225, 0.275),
            (0.000, 0.306, 0.177),
            (0.000, 0.205, 0.318),
        ]
    else:
        points = [
            (-0.058, 0.250, 1.244),
            (0.058, 0.250, 1.244),
            (-0.070, 0.195, 1.315),
            (0.070, 0.195, 1.315),
            (0.000, 0.122, 1.393),
            (0.000, 0.188, 1.357),
        ]
    faces = [(0, 1, 5), (1, 3, 5), (3, 4, 5), (4, 2, 5), (2, 0, 5)]
    petal = mw.new_mesh(name, points, faces, smooth=True)
    mw.solidify(petal, 0.010, offset=-0.5)
    mw.bevel(petal, 0.008, 2, angle_deg=28.0)
    return petal


def eight_petals(prefix: str, *, inverted: bool):
    prototype = lotus_petal(f"{prefix}-0", inverted=inverted)
    petals = [prototype]
    for index in range(1, 8):
        copy = prototype.copy()
        copy.data = prototype.data.copy()
        copy.name = f"{prefix}-{index}"
        copy.rotation_euler.z = TAU * index / 8.0
        bpy.context.scene.collection.objects.link(copy)
        petals.append(copy)
    return petals


# ---------------------------------------------------------------------------
# 아래에서 위로 2.05m. 각 구간의 z 경계는 요청 치수와 정확히 일치한다.
# ---------------------------------------------------------------------------

parts = []

# 지대석 0.00–0.14. 한 덩어리의 완전한 모서리 대신 1.2cm 베벨로 오래 닳은
# 하이라이트를 만든다.
base = mw.box("lantern-ground-stone", (0.62, 0.62, 0.14), pivot_bottom=True)
mw.bevel(base, 0.012, 2)
parts.append(base)

# 하대석 0.14–0.36. 회전체가 몸체 질량을 만들고, 그 위에 실제 팔엽 복련을
# 얹는다. 꽃잎을 노멀에만 그리면 부감에서 윤곽이 전혀 읽히지 않는다.
lower_core = mw.lathe(
    "lantern-lower-lotus-core",
    [
        (0.00, 0.140),
        (0.285, 0.140),
        (0.310, 0.170),
        (0.275, 0.225),
        (0.230, 0.315),
        (0.165, 0.360),
        (0.00, 0.360),
    ],
    16,
)
parts.append(lower_core)
parts.extend(eight_petals("lantern-down-petal", inverted=True))

# 간주석 0.36–1.22. 위 반지름은 정확히 3% 작다.
pillar = mw.prism(
    "lantern-octagonal-shaft",
    8,
    0.118,
    0.118 * 0.97,
    0.86,
    location=(0.0, 0.0, 0.36),
    rotation=-math.pi / 8.0,
)
mw.bevel(pillar, 0.010, 2)
parts.append(pillar)

# 상대석 1.22–1.40과 앙련 팔엽.
upper_core = mw.lathe(
    "lantern-upper-lotus-core",
    [
        (0.00, 1.220),
        (0.205, 1.220),
        (0.270, 1.250),
        (0.250, 1.310),
        (0.175, 1.385),
        (0.00, 1.400),
    ],
    16,
)
parts.append(upper_core)
parts.extend(eight_petals("lantern-up-petal", inverted=False))

# 화사석 1.40–1.74. 먼저 팔각 통을 실제로 비우고, 네 교대 면에 D자 커터를
# 뚫는다. 창 뒤에 숨은 면이 없으므로 어느 각도에서도 발광이 관통한다.
chamber = mw.prism(
    "lantern-fire-chamber",
    8,
    0.265,
    0.255,
    0.34,
    location=(0.0, 0.0, 1.40),
    rotation=-math.pi / 8.0,
)
inner = mw.prism(
    "lantern-chamber-void",
    8,
    0.218,
    0.210,
    0.37,
    location=(0.0, 0.0, 1.385),
    rotation=-math.pi / 8.0,
)
apply_boolean(chamber, inner, "DIFFERENCE")
for window_index, angle in enumerate((0.0, math.pi * 0.5, math.pi, math.pi * 1.5)):
    apply_boolean(chamber, arch_cutter(f"lantern-window-{window_index}", angle), "DIFFERENCE")
mw.bevel(chamber, 0.008, 2, angle_deg=30.0)
parts.append(chamber)

# 옥개석 1.74–1.96. 단면은 중심에서 완만히 내려오다 처마 끝 3cm에서 다시
# 들린다. 팔각뿔 한 장으로는 만들 수 없는 안허리곡·앙곡의 실루엣이다.
roof = mw.lathe(
    "lantern-upturned-roof",
    [
        (0.00, 1.955),
        (0.100, 1.945),
        (0.220, 1.875),
        (0.365, 1.775),
        (0.425, 1.755),
        (0.452, 1.790),
        (0.405, 1.742),
        (0.270, 1.760),
        (0.115, 1.820),
        (0.00, 1.825),
    ],
    8,
)
mw.bevel(roof, 0.009, 2, angle_deg=34.0)
parts.append(roof)

# 보주 1.96–2.05.
bpy.ops.mesh.primitive_ico_sphere_add(
    subdivisions=2,
    radius=0.045,
    location=(0.0, 0.0, 2.005),
)
finial = bpy.context.object
finial.name = "lantern-finial-jewel"
parts.append(finial)


# ---------------------------------------------------------------------------
# 합치기, 표면 데이터, 발광 코어
# ---------------------------------------------------------------------------

lantern = mw.join("stone-lantern", parts)
mw.apply_transform(lantern)
mw.assign_by_index(
    lantern,
    (granite, worn, moss),
    lambda center, normal: (
        2
        if center.z < 0.20 and normal.z < 0.45
        else (1 if normal.z < -0.20 or 1.39 < center.z < 1.75 else 0)
    ),
)
# 불리언 화창과 2세그먼트 베벨이 만든 평면 내부 분할만 걷어 낸다. 0.47은
# 발광 구를 포함해 2,600 tris 아래에 두면서 팔각 실루엣을 유지하는 계측값이다.
mw.decimate(lantern, 0.47)
mw.shade_auto_smooth(lantern, 36.0)
mw.uv_box(lantern, 1.0)

# 0.16m 구는 화사석 중심에 둔다. 이름 접미사는 런타임 PointLight 승격 계약이다.
bpy.ops.mesh.primitive_ico_sphere_add(
    subdivisions=2,
    radius=0.080,
    location=(0.0, 0.0, 1.575),
)
glow = bpy.context.object
glow.name = "stone-lantern-glow"
mw.assign(glow, flame)
mw.shade_auto_smooth(glow, 40.0)
mw.uv_smart(glow)

mw.export_glb(
    "stone-lantern",
    [lantern, glow],
    max_triangles=2_600,
    notes="2.05m Korean stone lantern; four boolean-cut arched windows and separate emissive core",
)
mw.finish()
