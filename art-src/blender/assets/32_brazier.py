# -*- coding: utf-8 -*-
"""삼족 무쇠 화로 — 휜 다리, 반구형 몸통, 숯과 발광 반구."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=3200)

TAU = math.tau


def shared_material(name: str, roughness: float, uv_scale: float, *, metallic=0.0, shader="stone"):
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


bronze = shared_material("mw/arch/bronze", 0.52, 0.85, metallic=1.0, shader="default")
worn = shared_material("mw/ground/worn-stone", 0.86, 0.5)
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
# 삼족. 바닥에서는 넓게 벌어지고 몸통 아래에서는 안으로 감긴 S자 경로다.
# 원형 6각 단면을 sweep해 직선 막대가 아니라 주조된 곡선 다리로 읽히게 한다.
# ---------------------------------------------------------------------------

parts = []
section = [
    (math.cos(TAU * index / 6.0) * 0.043, math.sin(TAU * index / 6.0) * 0.043)
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

    path = [
        point(0.365, 0.035),
        point(0.350, 0.070, -0.010),
        point(0.300, 0.180, -0.018),
        point(0.235, 0.310, 0.012),
        point(0.205, 0.405),
    ]
    leg = mw.sweep(
        f"brazier-curved-leg-{leg_index}",
        section,
        path,
        smooth=True,
        scale_fn=lambda t: 1.08 - 0.22 * t,
    )
    mw.shade_auto_smooth(leg, 38.0)
    parts.append(leg)

    # 발굽 모양 받침은 바닥 접촉 면적을 넓혀 0.92m 프롭의 실루엣을 잡는다.
    foot = mw.box(
        f"brazier-foot-{leg_index}",
        (0.13, 0.10, 0.045),
        location=(radial[0] * 0.365, radial[1] * 0.365, 0.0),
        pivot_bottom=True,
    )
    foot.rotation_euler.z = angle
    mw.bevel(foot, 0.010, 2)
    parts.append(foot)


# ---------------------------------------------------------------------------
# 반구형 몸통과 구연부. 회전 프로필을 바깥→구연→안쪽으로 되돌려 실제 두께가
# 있는 열린 그릇으로 만든다. 차폐 페이드로 잘려도 빈 껍데기가 보이지 않는다.
# ---------------------------------------------------------------------------

body = mw.lathe(
    "brazier-bowl",
    [
        (0.075, 0.355),
        (0.170, 0.385),
        (0.270, 0.475),
        (0.330, 0.610),
        (0.340, 0.735),
        (0.365, 0.785),
        (0.300, 0.805),
        (0.282, 0.740),
        (0.275, 0.620),
        (0.220, 0.505),
        (0.120, 0.410),
        (0.075, 0.385),
    ],
    16,
)
mw.shade_auto_smooth(body, 36.0)
parts.append(body)

# 두 줄의 얕은 문양 띠와 12개의 작은 유두문. 별도 지오메트리지만 몸통에서
# 8~12mm만 솟아 저부조로 남는다.
for profile_index, profile in enumerate(
    (
        [(0.332, 0.575), (0.350, 0.585), (0.350, 0.603), (0.335, 0.613)],
        [(0.337, 0.645), (0.352, 0.654), (0.352, 0.670), (0.338, 0.679)],
    )
):
    band = mw.lathe(f"brazier-pattern-band-{profile_index}", profile, 16)
    mw.bevel(band, 0.008, 2)
    parts.append(band)

for boss_index in range(12):
    angle = TAU * (boss_index + 0.5) / 12.0
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=1,
        radius=0.030,
        location=(math.cos(angle) * 0.340, math.sin(angle) * 0.340, 0.627),
    )
    boss = bpy.context.object
    boss.name = f"brazier-band-boss-{boss_index}"
    boss.scale = (0.65, 0.65, 0.42)
    mw.apply_transform(boss)
    parts.append(boss)

# 구연부는 몸통 입술보다 한 번 더 굵은 둥근 테두리다.
bpy.ops.mesh.primitive_torus_add(
    major_radius=0.332,
    minor_radius=0.036,
    major_segments=16,
    minor_segments=6,
    location=(0.0, 0.0, 0.796),
)
rim = bpy.context.object
rim.name = "brazier-heavy-rim"
mw.shade_auto_smooth(rim, 36.0)
parts.append(rim)

brazier = mw.join("brazier", parts)
mw.apply_transform(brazier)
mw.assign(brazier, bronze)
# 원형 띠의 같은 평면에 생긴 베벨 분할만 4% 정리해 2,000 tris 안전 여유를 둔다.
mw.decimate(brazier, 0.96)
mw.shade_auto_smooth(brazier, 38.0)
mw.uv_cylinder(brazier, u_scale=1.0, v_scale=1.0)


# ---------------------------------------------------------------------------
# 숯은 찌그러진 저해상도 돌 8개다. 결정 난수는 위치·스케일·회전에 별도 salt를
# 써서 다른 프롭의 수정이 이 무더기를 흔들지 못하게 한다.
# ---------------------------------------------------------------------------

coal_rng = mw.rng("charcoal-clump")
coals = []
for coal_index in range(8):
    angle = float(coal_rng.uniform(0.0, TAU))
    radius = float(coal_rng.uniform(0.02, 0.205))
    bpy.ops.mesh.primitive_ico_sphere_add(
        subdivisions=1,
        radius=1.0,
        location=(
            math.cos(angle) * radius,
            math.sin(angle) * radius,
            float(coal_rng.uniform(0.782, 0.825)),
        ),
    )
    coal = bpy.context.object
    coal.name = f"brazier-charcoal-{coal_index}"
    coal.scale = (
        float(coal_rng.uniform(0.050, 0.085)),
        float(coal_rng.uniform(0.035, 0.065)),
        float(coal_rng.uniform(0.025, 0.052)),
    )
    coal.rotation_euler = (
        float(coal_rng.uniform(-0.35, 0.35)),
        float(coal_rng.uniform(-0.35, 0.35)),
        angle,
    )
    mw.apply_transform(coal)
    coals.append(coal)

charcoal = mw.join("brazier-charcoal", coals)
mw.assign(charcoal, worn)
mw.shade_auto_smooth(charcoal, 38.0)
mw.uv_box(charcoal, 1.0)

# 지름 0.22m의 상반구. 바닥 원판까지 막아 숯 사이로 보일 때도 속이 빈 발광
# 껍데기가 되지 않는다. 최고점 0.92m로 총 높이를 맞춘다.
glow = mw.lathe(
    "brazier-glow",
    [
        (0.000, 0.920),
        (0.060, 0.902),
        (0.095, 0.867),
        (0.110, 0.810),
        (0.000, 0.810),
    ],
    12,
)
mw.assign(glow, flame)
mw.shade_auto_smooth(glow, 40.0)
mw.uv_cylinder(glow)

mw.export_glb(
    "brazier",
    [brazier, charcoal, glow],
    max_triangles=2_000,
    notes="0.92m three-legged cast brazier; curved sweep legs, charcoal mound, separate emissive hemisphere",
)
mw.finish()
