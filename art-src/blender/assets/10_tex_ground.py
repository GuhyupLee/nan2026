# -*- coding: utf-8 -*-
"""지면 PBR 텍스처 세트.

플레이어가 전체 화면의 60%를 이 텍스처로 본다. 여기서 지면이 "타일링된
노이즈"로 읽히면 나머지를 아무리 잘 만들어도 웹게임으로 보인다.

## 주파수 분리 — 이 파일의 핵심 결정

처음에는 2048 한 장에 매크로부터 마이크로까지 전부 넣었다. 결과는 배포
18.9MB로 예산의 네 배였다. 원인은 해상도가 아니라 **픽셀 단위 고주파**다.
WebP든 뭐든 인접 픽셀이 무상관이면 압축할 게 없어서, 노멀맵 한 장이 2.8MB로
나온다.

그래서 층을 나눴다.

- **베이스맵**(이 파일의 세트들)은 매크로·메소만 담는다. 부드러워서 잘 눌린다.
- **마이크로**는 `stone-detail` 한 장이 전담하고, three.js가 훨씬 높은 타일
  주파수로 겹쳐 뿌린다.

용량이 5분의 1로 줄고 근접 디테일은 오히려 **좋아진다** — 디테일 맵은 UV
스케일이 독립이라 카메라가 가까워져도 해상도가 버틴다. 한 장에 다 넣으면
그 지점에서 텍셀이 뭉개진다.

## 채도 억제

5분 아크 색 전환이 three.js에서 위에 얹힌다. 텍스처가 이미 색을 갖고 있으면
두 색이 싸워 탁해진다. 베이스컬러는 거의 무채색으로 만든다.
"""

import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import numpy as np  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=1010)

SUB = "ground"

# 해상도는 화면 점유율로 정했다. 광장 판석 두 종은 화면의 절반을 덮으므로
# 1024, 아레나 밖 지형과 이끼는 원거리이거나 마스크로만 쓰여 512면 충분하다.
BIG = 1024
SMALL = 512


def emit(
    name: str,
    height: np.ndarray,
    albedo: np.ndarray,
    roughness: np.ndarray,
    *,
    metalness=0.0,
    normal_strength: float = 1.0,
    ao_radius: int = 6,
    ao_strength: float = 1.0,
) -> dict[str, str]:
    """하이트맵 하나에서 세 장을 만들어 저장한다.

    노멀·AO를 같은 하이트에서 뽑아야 명암이 어긋나지 않는다. 따로 만들면
    조명이 돌 때 요철이 미끄러지듯 어긋나는 게 보인다.
    """
    normal = mw.height_to_normal(height, normal_strength)
    occlusion = mw.ambient_occlusion(height, radius=ao_radius, strength=ao_strength)
    orm = mw.pack_orm(occlusion, roughness, metalness)
    return {
        "baseColor": mw.save_texture(f"{name}_basecolor", albedo, srgb=True, subdir=SUB),
        "normal": mw.save_texture(f"{name}_normal", normal, srgb=False, subdir=SUB),
        "orm": mw.save_texture(f"{name}_orm", orm, srgb=False, subdir=SUB),
    }


# ---------------------------------------------------------------------------
# 1. granite-slab — 광장 판석의 주 표면 (월드 2m에 한 번 반복)
# ---------------------------------------------------------------------------

# 결정립. f2f1이 입계(粒界)를 밝게 내므로 그대로 홈으로 쓴다.
grain_edge, grain_id = mw.voronoi(BIG, 44, seed=311, metric="f2f1")
grain = mw.sstep(grain_edge, 0.03, 0.20)

# 결정마다 다른 밝기. 화강암을 화강암으로 보이게 하는 유일한 신호다.
crystal_tone = (grain_id - 0.5) * 0.5

# 매크로 얼룩 — 채석 블록 단위 색차. 워프해서 층리처럼 흐르게 만든다.
macro = mw.remap(mw.warp(mw.fbm(BIG, 3, octaves=4, seed=312), 0.045, 4, 313), 0.0, 1.0)

# 메소 요철 — 정으로 다듬은 면의 파임. 등방성이 아니라 결이 있다.
tooling = mw.remap(mw.warp(mw.fbm(BIG, 14, octaves=3, seed=318), 0.020, 9, 319), 0.0, 1.0)

# 얕은 균열. 능선 노이즈를 좁게 임계해 실선으로 만든다.
veins = mw.sstep(mw.warp(mw.ridged(BIG, 6, octaves=4, seed=316), 0.03, 5, 317), 0.86, 0.99)

granite_h = np.clip(
    0.52 + grain * 0.26 + crystal_tone * 0.11 + (macro - 0.5) * 0.17 + (tooling - 0.5) * 0.20 - veins * 0.44,
    0.0,
    1.0,
)

granite_albedo = mw.tint(
    np.clip(granite_h * 0.88 + macro * 0.18 + crystal_tone * 0.10, 0.0, 1.0),
    (0.086, 0.088, 0.096),
    (0.418, 0.414, 0.424),
)
# 입계는 광물이 달라 색도 미묘하게 다르다. 밝기만 바꾸면 플라스틱이 된다.
granite_albedo += grain[..., None] * np.array([0.030, 0.026, 0.020]).reshape(1, 1, 3)
granite_albedo -= veins[..., None] * np.array([0.058, 0.055, 0.052]).reshape(1, 1, 3)

granite_rough = np.clip(
    0.74 + (1.0 - grain) * 0.10 - (macro - 0.5) * 0.14 + (tooling - 0.5) * 0.10 + veins * 0.16,
    0.38,
    0.98,
)

GRANITE = emit("granite-slab", granite_h, np.clip(granite_albedo, 0, 1), granite_rough,
               normal_strength=2.2, ao_radius=5)

# ---------------------------------------------------------------------------
# 2. worn-stone — 같은 돌의 마모 상태. 정점 컬러 R로 블렌드한다.
# ---------------------------------------------------------------------------

# 곰보. 앞선 시도에서 `sstep(f1, 0.34, 0.05)`을 쓰니 **고리 모양**이 나왔다 —
# 셀 거리장을 좁게 임계하면 등고선이 그대로 보인다. 거리장을 제곱해 접시로
# 만들고, 셀 ID로 절반만 남겨 불규칙하게 흩는다.
pit_field, pit_id = mw.voronoi(BIG, 26, seed=321, metric="f1", jitter=1.0)
pit_bowl = np.clip(1.0 - pit_field / 0.42, 0.0, 1.0) ** 2.0
pits = pit_bowl * mw.sstep(pit_id, 0.46, 0.62)
# 가장자리를 노이즈로 갉아 원형을 깬다.
pits *= mw.sstep(mw.fbm(BIG, 30, octaves=3, seed=326), 0.30, 0.62)

# 균열망. worn 쪽은 훨씬 깊고 넓다.
crack = mw.warp(mw.ridged(BIG, 4, octaves=5, seed=322), 0.05, 4, 323)
crack_mask = mw.sstep(crack, 0.80, 0.98)
crack_wide = mw.blur(crack_mask, 3, 1)

# 물이 고였다 마른 자국. 넓고 얕은 접시.
dish = mw.sstep(mw.warp(mw.fbm(BIG, 2, octaves=3, seed=324), 0.06, 3, 325), 0.55, 0.86)

worn_h = np.clip(
    granite_h * 0.70 + 0.20 - pits * 0.40 - crack_mask * 0.44 - dish * 0.10,
    0.0,
    1.0,
)

worn_albedo = mw.tint(
    np.clip(worn_h * 0.86 + macro * 0.12, 0.0, 1.0),
    (0.064, 0.065, 0.070),
    (0.356, 0.352, 0.356),
)
worn_albedo -= crack_wide[..., None] * np.array([0.050, 0.048, 0.046]).reshape(1, 1, 3)
worn_albedo -= dish[..., None] * np.array([0.024, 0.022, 0.019]).reshape(1, 1, 3)

worn_rough = np.clip(0.84 + pits * 0.11 + crack_mask * 0.09 - dish * 0.18, 0.44, 0.99)

WORN = emit("worn-stone", worn_h, np.clip(worn_albedo, 0, 1), worn_rough,
            normal_strength=2.0, ao_radius=7, ao_strength=1.2)

# ---------------------------------------------------------------------------
# 3. moss-lichen — 이음매와 그늘의 유기물. 정점 컬러 G로 블렌드한다.
# ---------------------------------------------------------------------------

clump = mw.warp(mw.fbm(SMALL, 5, octaves=5, seed=331), 0.07, 4, 332)
puff, _ = mw.voronoi(SMALL, 40, seed=333, metric="f1", jitter=1.0)

moss_h = np.clip(0.40 + clump * 0.36 + (1.0 - puff) * 0.26, 0.0, 1.0)

# 이끼는 색이 있어야 하지만 여전히 억제한다. 아크가 자홍으로 갈 때 채도 높은
# 초록이 남아 있으면 그 부분만 시간이 안 흐르는 것처럼 보인다.
moss_albedo = mw.tint(
    np.clip(moss_h * 0.94 + clump * 0.12, 0.0, 1.0),
    (0.050, 0.060, 0.042),
    (0.228, 0.262, 0.174),
)
lichen = mw.sstep(mw.warp(mw.fbm(SMALL, 9, octaves=3, seed=335), 0.04, 6, 336), 0.62, 0.80)
moss_albedo += lichen[..., None] * np.array([0.072, 0.076, 0.060]).reshape(1, 1, 3)

MOSS = emit("moss-lichen", moss_h, np.clip(moss_albedo, 0, 1),
            np.clip(0.93 - lichen * 0.10, 0.62, 1.0),
            normal_strength=1.7, ao_radius=4, ao_strength=1.35)

# ---------------------------------------------------------------------------
# 4. soil-gravel — 아레나 바깥 지형 (월드 3m 반복)
# ---------------------------------------------------------------------------

pebble, pebble_id = mw.voronoi(SMALL, 18, seed=341, metric="f1", jitter=1.0)
# 자갈도 접시로 만들어야 돌처럼 보인다. 거리장 그대로는 뾰족한 원뿔이 된다.
pebble_h = np.clip(1.0 - pebble / 0.46, 0.0, 1.0) ** 0.6 * mw.sstep(pebble_id, 0.22, 0.46)
fine = mw.fbm(SMALL, 12, octaves=4, seed=342)
drift = mw.warp(mw.fbm(SMALL, 3, octaves=4, seed=343), 0.08, 3, 344)

soil_h = np.clip(0.40 + pebble_h * 0.36 + (fine - 0.5) * 0.24 + (drift - 0.5) * 0.20, 0.0, 1.0)

soil_albedo = mw.tint(
    np.clip(soil_h * 0.88 + drift * 0.14, 0.0, 1.0),
    (0.060, 0.054, 0.046),
    (0.322, 0.296, 0.256),
)
soil_albedo += pebble_h[..., None] * np.array([0.038, 0.036, 0.034]).reshape(1, 1, 3)

SOIL = emit("soil-gravel", soil_h, np.clip(soil_albedo, 0, 1),
            np.clip(0.90 - pebble_h * 0.16 + (fine - 0.5) * 0.10, 0.55, 1.0),
            normal_strength=1.8, ao_radius=5, ao_strength=1.1)

# ---------------------------------------------------------------------------
# 5. sand-drift — 판석 위에 쌓인 마른 먼지
# ---------------------------------------------------------------------------

# 물결. 앞선 시도는 워프한 사인파를 썼는데 규칙이 남아 **천 주름**으로 보였다.
# 사인의 위상을 저주파 FBM으로 직접 밀고, 진폭까지 다른 FBM으로 죽여
# 물결이 끊겼다 이어지게 만든다.
axis = np.linspace(0.0, 1.0, SMALL, endpoint=False)
gx, gy = np.meshgrid(axis, axis, indexing="xy")
flow = mw.fbm(SMALL, 3, octaves=4, seed=351)
phase = (gx * 14.0 + gy * 5.0) * np.pi * 2.0 + flow * 26.0
amp = mw.sstep(mw.fbm(SMALL, 4, octaves=3, seed=354), 0.34, 0.72)
ripple = (np.sin(phase) * 0.5 + 0.5) * amp

sand_h = np.clip(0.50 + ripple * 0.26 + (flow - 0.5) * 0.30, 0.0, 1.0)
sand_albedo = mw.tint(
    np.clip(sand_h * 0.92 + flow * 0.10, 0.0, 1.0),
    (0.120, 0.112, 0.100),
    (0.432, 0.412, 0.376),
)

SAND = emit("sand-drift", sand_h, np.clip(sand_albedo, 0, 1),
            np.full((SMALL, SMALL), 0.95),
            normal_strength=1.1, ao_radius=8, ao_strength=0.7)

# ---------------------------------------------------------------------------
# 6. stone-detail — 공유 마이크로 디테일
#
# 베이스맵에서 걷어낸 고주파를 전담한다. three.js가 이 한 장을 훨씬 촘촘한
# UV 스케일(월드 0.25m 반복)로 모든 석재 표면에 겹친다. 카메라가 가까워져도
# 텍셀이 뭉개지지 않는 건 이 장 덕분이다.
#
# 베이스컬러는 만들지 않는다. 마이크로는 색이 아니라 **기울기와 거칠기**로만
# 읽히고, 색까지 겹치면 표면이 지저분해진다.
# ---------------------------------------------------------------------------

micro = (
    mw.value_noise(SMALL, 220, seed=361) * 0.5
    + mw.value_noise(SMALL, 110, seed=362) * 0.3
    + mw.value_noise(SMALL, 55, seed=363) * 0.2
)
speck, speck_id = mw.voronoi(SMALL, 90, seed=364, metric="f2f1")
detail_h = np.clip(micro * 0.72 + mw.sstep(speck, 0.02, 0.14) * 0.28, 0.0, 1.0)

DETAIL_NORMAL = mw.save_texture(
    "stone-detail_normal", mw.height_to_normal(detail_h, 1.5), srgb=False, subdir=SUB
)
DETAIL_ORM = mw.save_texture(
    "stone-detail_orm",
    mw.pack_orm(
        mw.ambient_occlusion(detail_h, radius=3, strength=0.8),
        np.clip(0.5 + (detail_h - 0.5) * 0.7, 0.0, 1.0),
        0.0,
    ),
    srgb=False,
    subdir=SUB,
)

# ---------------------------------------------------------------------------
# 머티리얼 등록
#
# 지오메트리는 없다. three.js가 매니페스트에서 이름으로 텍스처를 찾는다.
# `uvScale`은 월드 미터당 반복 수다 — 지오메트리 쪽 `uv_box(scale)`가 1.0일
# 때 이 값이 그대로 타일 주파수가 된다.
# ---------------------------------------------------------------------------

for name, maps, rough, uv_scale in (
    ("granite-slab", GRANITE, 0.78, 0.5),
    ("worn-stone", WORN, 0.86, 0.5),
    ("moss-lichen", MOSS, 0.94, 0.7),
    ("soil-gravel", SOIL, 0.92, 0.34),
    ("sand-drift", SAND, 0.96, 0.45),
):
    mw.material(
        mw.MaterialSpec(
            name=f"mw/ground/{name}",
            base_color=(1.0, 1.0, 1.0, 1.0),
            roughness=rough,
            base_color_map=maps["baseColor"],
            normal_map=maps["normal"],
            orm_map=maps["orm"],
            uv_scale=uv_scale,
            shader="stone",
            arc_response=1.0,
        )
    )

# 디테일 맵은 머티리얼이 아니라 three.js 셰이더가 직접 참조한다. 매니페스트에
# 이름만 남기려고 베이스컬러 없는 항목을 하나 등록한다.
mw.material(
    mw.MaterialSpec(
        name="mw/ground/stone-detail",
        normal_map=DETAIL_NORMAL,
        orm_map=DETAIL_ORM,
        uv_scale=4.0,
        shader="detail",
        arc_response=0.0,
    )
)

mw.finish()
print("[10_tex_ground] 5 sets + shared detail OK")
