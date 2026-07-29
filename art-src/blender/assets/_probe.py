# -*- coding: utf-8 -*-
"""파이프라인 자체 검증용 프로브.

에셋이 아니라 `mw` 라이브러리 계약을 확인하는 스크립트다. 실패하면 다른 에셋
스크립트를 쓰기 전에 라이브러리를 고쳐야 한다.
"""

import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import numpy as np  # noqa: E402
import mw  # noqa: E402

mw.reset(seed=1)

# 1) 절차 텍스처 — 이음매 없는 석재
SIZE = 256
stone_h = mw.fbm(SIZE, 8, octaves=5, seed=11)
cell, cell_id = mw.voronoi(SIZE, 6, seed=12, metric="f2f1")
height = np.clip(stone_h * 0.55 + np.clip(cell * 2.2, 0, 1) * 0.45, 0, 1)
albedo = np.stack([height * 0.42 + 0.18, height * 0.44 + 0.20, height * 0.48 + 0.24], axis=-1)
normal = mw.height_to_normal(height, 1.6)
occlusion = mw.ambient_occlusion(height, radius=5, strength=1.0)
orm = mw.pack_orm(occlusion, np.clip(0.92 - height * 0.25, 0, 1), 0.0)

base_path = mw.save_texture("probe_basecolor", albedo, srgb=True, subdir="probe")
normal_path = mw.save_texture("probe_normal", normal, srgb=False, subdir="probe")
orm_path = mw.save_texture("probe_orm", orm, srgb=False, subdir="probe")

# 2) 지오메트리 — lathe / sweep / prism / bevel
pillar = mw.lathe(
    "probe-pillar",
    [(0.0, 0.0), (0.42, 0.0), (0.40, 0.18), (0.34, 0.22), (0.32, 1.6), (0.40, 1.72), (0.0, 1.78)],
    24,
)
mw.shade_auto_smooth(pillar, 38)

rail = mw.sweep(
    "probe-rail",
    [(-0.09, 0.0), (0.09, 0.0), (0.09, 0.14), (0.0, 0.20), (-0.09, 0.14)],
    [(-1.5 + i * 0.5, 0.0, 1.85) for i in range(8)],
)

cap = mw.box("probe-cap", (1.1, 1.1, 0.16), (0.0, 0.0, 1.78), pivot_bottom=True)
mw.bevel(cap, 0.02, 2)

merged = mw.join("probe", [pillar, rail, cap])
mw.uv_box(merged, 0.55)

mat = mw.material(
    mw.MaterialSpec(
        name="probe-stone",
        base_color_map=base_path,
        normal_map=normal_path,
        orm_map=orm_path,
        roughness=0.85,
    )
)
mw.assign(merged, mat)

mw.export_glb("probe", [merged], subdir="probe", max_triangles=8000, notes="pipeline probe")
mw.finish()
print("[probe] OK")
