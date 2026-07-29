# -*- coding: utf-8 -*-
"""깃발 — 실제 정지 주름과 바람 가중치가 있는 3.6m 목제 장대 프롭."""

import math
import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=3400)

TAU = math.tau


def shared_material(name: str, roughness: float, uv_scale: float, *, shader="default", double_sided=False):
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
            double_sided=double_sided,
            arc_response=1.0,
        )
    )


timber = shared_material("mw/arch/timber", 0.78, 0.72)
cloth = shared_material("mw/arch/cloth", 0.84, 1.0, shader="cloth", double_sided=True)


# 장대, 짧은 가로대, 매듭 받침을 하나의 인스턴싱 가능한 오브젝트로 합친다.
pole_parts = []
pole = mw.prism(
    "banner-pole",
    12,
    0.044,
    0.034,
    3.54,
    location=(0.0, 0.0, 0.0),
    rotation=math.pi / 12.0,
)
mw.bevel(pole, 0.005, 1, angle_deg=28.0)
pole_parts.append(pole)

crossbar = mw.prism(
    "banner-crossbar",
    10,
    0.027,
    0.027,
    1.02,
    location=(0.0, 0.0, 3.27),
    rotation=math.pi / 10.0,
)
crossbar.rotation_euler.y = math.pi * 0.5
mw.apply_transform(crossbar)
mw.bevel(crossbar, 0.004, 1)
pole_parts.append(crossbar)

finial = mw.lathe(
    "banner-finial",
    [(0.0, 3.54), (0.070, 3.54), (0.060, 3.59), (0.0, 3.60)],
    12,
)
mw.bevel(finial, 0.004, 1)
pole_parts.append(finial)

for z in (3.22, 2.82, 2.34, 1.52, 1.08):
    tie = mw.lathe(
        "banner-tie-collar",
        [(0.043, z - 0.012), (0.052, z), (0.043, z + 0.012)],
        10,
    )
    pole_parts.append(tie)

banner = mw.join("banner", pole_parts)
mw.apply_transform(banner)
mw.assign(banner, timber)
mw.shade_auto_smooth(banner, 34.0)
mw.uv_cylinder(banner)


# 12×20 셀. 왼쪽은 장대에 묶이고 오른쪽이 자유단이다.
columns = 12
rows = 20
width = 0.90
length = 2.20
x0 = 0.052
z_top = 3.24
verts = []
for row in range(rows + 1):
    v = row / rows  # 0=위, 1=아래
    for column in range(columns + 1):
        u = column / columns  # 0=장대, 1=자유단
        x = x0 + width * u
        z = z_top - length * v
        # 아래 가장자리의 삼각 톱니. 고정 쪽의 첫 점은 매듭선에 남긴다.
        if row == rows and column > 0:
            z += 0.075 if column % 2 == 1 else 0.0

        # 서로 다른 방향의 사인 두 겹. 고정변에서는 정확히 0이고 자유단 쪽에서
        # 약 3.5cm까지 자라 평면 천의 정면 반사를 깨뜨린다.
        pin_falloff = u**0.82
        y = pin_falloff * (
            0.024 * math.sin(TAU * (1.45 * u + 0.34 * v))
            + 0.011 * math.sin(TAU * (0.55 * u - 2.10 * v) + 0.7)
        )
        verts.append((x, y, z))

faces = []
stride = columns + 1
for row in range(rows):
    for column in range(columns):
        a = row * stride + column
        b = a + 1
        d = (row + 1) * stride + column
        c = d + 1
        faces.append((a, b, c, d))

banner_cloth = mw.new_mesh("banner-cloth", verts, faces, smooth=True)
mw.assign(banner_cloth, cloth)
mw.shade_auto_smooth(banner_cloth, 50.0)

# 격자와 같은 좌표계의 UV라 정지 주름을 넣어도 텍스처가 늘어나지 않는다.
uv = banner_cloth.data.uv_layers.new(name="UVMap")
for polygon in banner_cloth.data.polygons:
    for loop_index in polygon.loop_indices:
        vertex_index = banner_cloth.data.loops[loop_index].vertex_index
        row = vertex_index // stride
        column = vertex_index % stride
        uv.data[loop_index].uv = (column / columns, 1.0 - row / rows)

# R = 바람 가중치. 고정변은 높이와 무관하게 0, 자유단은 아래로 갈수록 1에 도달한다.
mw.set_vertex_colors(
    banner_cloth,
    lambda world, _normal: (
        max(0.0, min(1.0, (world.x - x0) / width))
        * (
            0.42
            + 0.58
            * max(0.0, min(1.0, (z_top - world.z) / length))
        ),
        0.0,
        0.0,
    ),
)
color = banner_cloth.data.color_attributes.get("Col")
if color is not None:
    banner_cloth.data.color_attributes.active_color = color
    banner_cloth.data.color_attributes.active = color
wind_values = [float(item.color[0]) for item in color.data] if color is not None else []
if (
    color is None
    or color.data_type != "FLOAT_COLOR"
    or min(wind_values, default=1.0) > 1.0e-6
    or max(wind_values, default=0.0) < 0.999
):
    raise SystemExit("[34_banner] FLOAT_COLOR Col.R 바람 가중치 범위가 0..1이 아니다")

# glTF 익스포터가 데이터 마스크를 사용하지 않은 속성으로 제거하지 않도록 명시적으로 참조한다.
nodes = cloth.node_tree.nodes
links = cloth.node_tree.links
bsdf = nodes.get("Principled BSDF")
color_node = nodes.new("ShaderNodeVertexColor")
color_node.name = "mw-Col-export"
color_node.layer_name = "Col"
links.new(color_node.outputs["Color"], bsdf.inputs["Base Color"])

mw.export_glb(
    "banner",
    [banner, banner_cloth],
    max_triangles=1_400,
    notes="3.6m timber banner; separate 12x20 cloth grid with two static sine wrinkles, ragged sawtooth hem and FLOAT_COLOR Col.R wind weight",
)
mw.finish()
