# -*- coding: utf-8 -*-
"""오층 석탑 — 하단 2m에 기단 부조와 삼단 층급받침을 집중한 3.6m 석탑."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=3600)


def shared_stone(name: str, roughness: float):
    family, stem = name.split("/")[-2:]
    return mw.material(
        mw.MaterialSpec(
            name=name,
            base_color=(1.0, 1.0, 1.0, 1.0),
            roughness=roughness,
            base_color_map=f"env/tex/{family}/{stem}_basecolor.webp",
            normal_map=f"env/tex/{family}/{stem}_normal.webp",
            orm_map=f"env/tex/{family}/{stem}_orm.webp",
            uv_scale=0.5,
            shader="stone",
            arc_response=1.0,
        )
    )


granite = shared_stone("mw/ground/granite-slab", 0.78)
worn = shared_stone("mw/ground/worn-stone", 0.86)


def chipped_box(name: str, width: float, depth: float, z0: float, height: float, chip=0.0):
    """앞 오른쪽 모서리를 실제 평면으로 잘라 낸 오래된 직육면체."""
    hx, hy = width * 0.5, depth * 0.5
    if chip > 0.0:
        footprint = [
            (-hx, -hy),
            (hx, -hy),
            (hx, hy - chip),
            (hx - chip * 0.72, hy),
            (-hx, hy),
        ]
    else:
        footprint = [(-hx, -hy), (hx, -hy), (hx, hy), (-hx, hy)]

    verts = [(x, y, z0) for x, y in footprint] + [(x, y, z0 + height) for x, y in footprint]
    count = len(footprint)
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    for index in range(count):
        nxt = (index + 1) % count
        faces.append((index, nxt, count + nxt, count + index))
    return mw.new_mesh(name, verts, faces)


def square_ring(half: float):
    """모서리와 변 중앙을 번갈아 갖는 8점 사각 링."""
    return [
        (-half, -half),
        (0.0, -half),
        (half, -half),
        (half, 0.0),
        (half, half),
        (0.0, half),
        (-half, half),
        (-half, 0.0),
    ]


def upturned_roof(name: str, z0: float, half: float, height: float, broken_corner=None):
    """처마 중앙은 낮고 네 귀는 들린 석탑 옥개석."""
    outer = square_ring(half)
    middle = square_ring(half * 0.73)
    inner = square_ring(half * 0.42)
    underside = square_ring(half * 0.57)

    # 오래된 탑의 깨진 귀. 외곽과 하면을 함께 안으로 밀어 빈 삼각형이 아니라
    # 실제 절단면이 남게 한다.
    if broken_corner is not None:
        index = int(broken_corner) % 8
        x, y = outer[index]
        outer[index] = (x * 0.80, y * 0.80)

    verts = []
    # 외곽 상면: 변 중앙보다 모서리가 3.5cm 높아 앙곡이 실루엣으로 읽힌다.
    for index, (x, y) in enumerate(outer):
        corner = index % 2 == 0
        lift = (0.25 if corner else 0.08) * height
        if broken_corner is not None and index == int(broken_corner) % 8:
            lift = 0.02 * height
        verts.append((x, y, z0 + lift))
    for x, y in middle:
        verts.append((x, y, z0 + height * 0.62))
    for x, y in inner:
        verts.append((x, y, z0 + height * 0.92))
    center_top = len(verts)
    verts.append((0.0, 0.0, z0 + height))

    outer_bottom = len(verts)
    for index, (x, y) in enumerate(outer):
        corner = index % 2 == 0
        lift = (0.10 if corner else 0.0) * height
        if broken_corner is not None and index == int(broken_corner) % 8:
            lift = 0.0
        verts.append((x, y, z0 + lift))
    inner_bottom = len(verts)
    for x, y in underside:
        verts.append((x, y, z0))

    faces = []
    for ring_a, ring_b in ((0, 8), (8, 16)):
        for index in range(8):
            nxt = (index + 1) % 8
            faces.append((ring_a + index, ring_a + nxt, ring_b + nxt, ring_b + index))
    for index in range(8):
        nxt = (index + 1) % 8
        faces.append((16 + index, 16 + nxt, center_top))
        faces.append((index, outer_bottom + index, outer_bottom + nxt, nxt))
        faces.append(
            (
                outer_bottom + index,
                inner_bottom + index,
                inner_bottom + nxt,
                outer_bottom + nxt,
            )
        )
    faces.append(tuple(reversed(range(inner_bottom, inner_bottom + 8))))
    return mw.new_mesh(name, verts, faces)


def bevel_part(obj, width=0.010):
    # 석탑은 같은 모서리가 수백 번 반복된다. 1세그먼트 챔퍼면 이 크기의
    # 프롭에서 하이라이트 폭은 그대로 읽히고, 동률 엣지가 많은 최종 Decimate를
    # 쓰지 않아도 예산과 바이트 결정성을 함께 지킬 수 있다.
    mw.bevel(obj, width, 1, angle_deg=34.0)
    return obj


# ---------------------------------------------------------------------------
# 이층 기단 0–1.00m. 하층 최대 폭 1.5m, 상층 면석 폭 1.15m다.
# 앞 오른쪽 기단 모서리 하나는 11cm가 떨어져 나가 완전한 새 탑을 피한다.
# ---------------------------------------------------------------------------

parts = [
    bevel_part(chipped_box("pagoda-lower-plinth", 1.50, 1.50, 0.00, 0.15, chip=0.11), 0.015),
    bevel_part(chipped_box("pagoda-lower-face-stone", 1.34, 1.34, 0.15, 0.25), 0.012),
    bevel_part(chipped_box("pagoda-lower-cap", 1.42, 1.42, 0.40, 0.10), 0.012),
    bevel_part(chipped_box("pagoda-upper-plinth", 1.22, 1.22, 0.50, 0.10), 0.010),
    bevel_part(chipped_box("pagoda-upper-face-stone", 1.15, 1.15, 0.60, 0.28), 0.010),
    bevel_part(chipped_box("pagoda-upper-cap", 1.24, 1.24, 0.88, 0.12), 0.012),
]


def add_face_pillars(prefix: str, half: float, z0: float, height: float, width: float):
    """각 면의 우주 2개와 탱주 1개를 1.8cm 돋을새김한다."""
    protrusion = 0.018
    inset = width * 0.52
    for face in ("front", "back", "right", "left"):
        for pillar_index, offset in enumerate((-inset, 0.0, inset)):
            if face in ("front", "back"):
                y = half + protrusion * 0.5
                if face == "back":
                    y = -y
                obj = mw.box(
                    f"{prefix}-{face}-pillar-{pillar_index}",
                    (width, protrusion, height),
                    location=(offset, y, z0),
                    pivot_bottom=True,
                )
            else:
                x = half + protrusion * 0.5
                if face == "left":
                    x = -x
                obj = mw.box(
                    f"{prefix}-{face}-pillar-{pillar_index}",
                    (protrusion, width, height),
                    location=(x, offset, z0),
                    pivot_bottom=True,
                )
            bevel_part(obj, 0.008)
            parts.append(obj)


# 하단 1m는 화면에 항상 들어오므로 두 기단 모두 실제 부조를 둔다.
add_face_pillars("pagoda-lower-relief", 0.670, 0.170, 0.215, 0.085)
add_face_pillars("pagoda-upper-relief", 0.575, 0.625, 0.235, 0.070)


# ---------------------------------------------------------------------------
# 탑신·옥개석 5쌍. 폭과 높이를 매 층 정확히 0.82배 줄인다. 각 옥개 아래에는
# 얇은 장식선이 아니라 실제 네모 받침 3단이 있다.
# ---------------------------------------------------------------------------

z_cursor = 1.00
for floor_index in range(5):
    scale = 0.82 ** floor_index
    body_width = 0.64 * scale
    body_height = 0.240 * scale
    support_height = 0.022 * scale
    roof_half = 0.550 * scale
    roof_height = 0.190 * scale

    body = chipped_box(
        f"pagoda-body-{floor_index + 1}",
        body_width,
        body_width,
        z_cursor,
        body_height,
        chip=0.035 * scale if floor_index == 1 else 0.0,
    )
    bevel_part(body, 0.009)
    parts.append(body)
    z_cursor += body_height

    for support_index in range(3):
        support_half = body_width * 0.5 + (0.035 + support_index * 0.030) * scale
        support = chipped_box(
            f"pagoda-roof-support-{floor_index + 1}-{support_index + 1}",
            support_half * 2.0,
            support_half * 2.0,
            z_cursor,
            support_height,
        )
        bevel_part(support, 0.008)
        parts.append(support)
        z_cursor += support_height

    # 첫 층 앞 오른쪽 귀와 셋째 층 앞 왼쪽 귀가 깨졌다. 하단 첫 귀는 카메라에서
    # 가장 잘 보이는 1.5m 부근이라 파손 실루엣을 여기에 우선 배치했다.
    broken = 4 if floor_index == 0 else (6 if floor_index == 2 else None)
    roof = upturned_roof(
        f"pagoda-roof-{floor_index + 1}",
        z_cursor,
        roof_half,
        roof_height,
        broken_corner=broken,
    )
    bevel_part(roof, 0.008)
    parts.append(roof)
    z_cursor += roof_height


# ---------------------------------------------------------------------------
# 상륜부는 상부 가시성이 낮아 실루엣만 남긴다. 마지막 보륜 위 팔각 찰주와
# 10cm 보첨으로 정확히 3.60m를 맞춘다.
# ---------------------------------------------------------------------------

finial_base = mw.lathe(
    "pagoda-finial-base",
    [
        (0.00, z_cursor),
        (0.125, z_cursor),
        (0.145, z_cursor + 0.045),
        (0.105, z_cursor + 0.100),
        (0.00, z_cursor + 0.120),
    ],
    12,
)
parts.append(finial_base)

bpy.ops.mesh.primitive_uv_sphere_add(
    segments=12,
    ring_count=6,
    radius=0.080,
    location=(0.0, 0.0, z_cursor + 0.200),
)
finial_orb = bpy.context.object
finial_orb.name = "pagoda-finial-lotus-orb"
parts.append(finial_orb)

for ring_index in range(4):
    ring_z = z_cursor + 0.285 + ring_index * 0.052
    ring = mw.lathe(
        f"pagoda-finial-ring-{ring_index}",
        [
            (0.030, ring_z),
            (0.095 - ring_index * 0.010, ring_z + 0.017),
            (0.030, ring_z + 0.034),
        ],
        12,
    )
    parts.append(ring)

pole_start = z_cursor + 0.460
pole_height = 3.500 - pole_start
pole = mw.prism(
    "pagoda-finial-pole",
    8,
    0.027,
    0.020,
    pole_height,
    location=(0.0, 0.0, pole_start),
    rotation=math.pi / 8.0,
)
mw.bevel(pole, 0.008, 1)
parts.append(pole)

bpy.ops.mesh.primitive_cone_add(
    vertices=8,
    radius1=0.050,
    radius2=0.0,
    depth=0.100,
    location=(0.0, 0.0, 3.550),
)
tip = bpy.context.object
tip.name = "pagoda-finial-tip"
parts.append(tip)


# ---------------------------------------------------------------------------
# 하나의 인스턴싱 가능한 메시로 합치고, 하면·기단 바깥 마모부에 worn-stone을
# 폴리곤 단위로 섞는다. 별도 텍스처나 고유 회색 머티리얼은 만들지 않는다.
# ---------------------------------------------------------------------------

pagoda = mw.join("stone-pagoda", parts)
mw.apply_transform(pagoda)
mw.assign_by_index(
    pagoda,
    (granite, worn),
    lambda center, normal: (
        1
        if normal.z < -0.18
        or (center.z < 0.52 and math.hypot(center.x, center.y) > 0.53)
        or (1.00 < center.z < 1.78 and normal.z < 0.20)
        else 0
    ),
)
mw.shade_auto_smooth(pagoda, 38.0)
mw.uv_box(pagoda, 1.0)

z_values = [float((pagoda.matrix_world @ vertex.co).z) for vertex in pagoda.data.vertices]
if min(z_values) < -0.001 or max(z_values) > 3.601:
    raise SystemExit(
        f"[36_pagoda] 높이 계약 위반: z={min(z_values):.4f}..{max(z_values):.4f}"
    )

mw.export_glb(
    "stone-pagoda",
    [pagoda],
    max_triangles=5_000,
    notes="3.6m five-story stone pagoda; two relief bases, three roof supports per floor, upturned and chipped eaves",
)
mw.finish()
