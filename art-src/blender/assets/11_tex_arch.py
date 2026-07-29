# -*- coding: utf-8 -*-
"""건축용 PBR 텍스처 세트.

지오메트리는 만들지 않는다. 성벽·기와·단청처럼 멀리서 먼저 읽혀야 하는
구조는 거리장과 저주파 마스크로 직접 그리고, 돌 입자나 페인트 가루 같은
마이크로 디테일은 공유 ``mw/ground/stone-detail``에 맡긴다. 베이스맵에
픽셀 노이즈를 넣지 않아 WebP 예산과 형태 가독성을 함께 지킨다.
"""

import os
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import numpy as np  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=1100)

SUB = "arch"
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
    """같은 하이트에서 노멀과 AO를 뽑아 세 PBR 맵을 저장한다."""
    normal = mw.height_to_normal(height, normal_strength)
    occlusion = mw.ambient_occlusion(height, radius=ao_radius, strength=ao_strength)
    orm = mw.pack_orm(occlusion, roughness, metalness)
    return {
        "baseColor": mw.save_texture(f"{name}_basecolor", albedo, srgb=True, subdir=SUB),
        "normal": mw.save_texture(f"{name}_normal", normal, srgb=False, subdir=SUB),
        "orm": mw.save_texture(f"{name}_orm", orm, srgb=False, subdir=SUB),
    }


def grid(size: int) -> tuple[np.ndarray, np.ndarray]:
    """픽셀 중심의 0..1 UV 격자."""
    axis = (np.arange(size, dtype=np.float64) + 0.5) / size
    return np.meshgrid(axis, axis, indexing="xy")


def torus_delta(value: np.ndarray, center: float) -> np.ndarray:
    """타일 경계를 가로질러도 이어지는 부호 있는 최단 거리."""
    return (value - center + 0.5) % 1.0 - 0.5


def ellipse_distance(
    gx: np.ndarray,
    gy: np.ndarray,
    cx: float,
    cy: float,
    sx: float,
    sy: float,
) -> np.ndarray:
    """타일링 타원 거리장. 흙손 자국과 옹이처럼 명시적인 곡선을 그린다."""
    dx = torus_delta(gx, cx) / sx
    dy = torus_delta(gy, cy) / sy
    return np.sqrt(dx * dx + dy * dy)


# ---------------------------------------------------------------------------
# 1. masonry — 불규칙한 장방형 화강암 성벽
# ---------------------------------------------------------------------------

gx, gy = grid(BIG)

# 행 높이 자체를 달리한다. 같은 높이의 벽돌 격자에 단순 오프셋만 준 패턴은
# 부감 카메라에서 자로 그은 격자로 보이므로, 일곱 층의 높이 합만 1로 맞춘다.
row_heights = np.array([0.126, 0.158, 0.131, 0.171, 0.139, 0.151, 0.124])
row_edges = np.concatenate(([0.0], np.cumsum(row_heights)))
layout_rng = mw.rng("masonry-layout")

# 저주파 좌표 워프가 모르타르 모서리를 갉는다. 1024 픽셀에서 12주기라 입자
# 노이즈가 아니라 닳은 돌덩이의 큰 요철로 남는다.
edge_warp_x = (mw.fbm(BIG, 9, octaves=3, seed=1101) - 0.5) * 0.012
edge_warp_y = (mw.fbm(BIG, 12, octaves=3, seed=1102) - 0.5) * 0.010
xw = (gx + edge_warp_x) % 1.0
yw = (gy + edge_warp_y) % 1.0
edge_chip = mw.remap(mw.fbm(BIG, 16, octaves=3, seed=1103), -1.0, 1.0)
face = mw.warp(mw.fbm(BIG, 8, octaves=3, seed=1104), 0.018, 7, 1105)

masonry_h = np.full((BIG, BIG), 0.10)
block_tone = np.zeros((BIG, BIG))
block_core = np.zeros((BIG, BIG))

# 층마다 블록 수·길이·시작점이 모두 다르다. 길이는 난수로 만들되 mw.rng에서
# 파생하므로 재실행 바이트가 변하지 않는다.
block_counts = (5, 4, 6, 5, 4, 6, 5)
for row, count in enumerate(block_counts):
    raw_widths = layout_rng.uniform(0.72, 1.34, count)
    widths = raw_widths / raw_widths.sum()
    boundaries = np.concatenate(([0.0], np.cumsum(widths)))
    shift = float(layout_rng.uniform(0.0, 1.0))

    row_mask = (yw >= row_edges[row]) & (yw < row_edges[row + 1])
    local_x = (xw - shift) % 1.0

    # 각 블록의 세로 모서리까지 토러스 최단 거리.
    x_distance = np.full((BIG, BIG), 1.0)
    for boundary in boundaries[:-1]:
        x_distance = np.minimum(x_distance, np.abs(torus_delta(local_x, float(boundary))))
    y_distance = np.minimum(yw - row_edges[row], row_edges[row + 1] - yw)
    mortar_distance = np.minimum(x_distance, y_distance)

    # 불규칙 임계값이 모서리를 깨물고, 두 단계 smoothstep이 깊은 홈과 둥근
    # 모서리를 분리한다.
    core = mw.sstep(mortar_distance + edge_chip * 0.0038, 0.006, 0.020)
    core = np.where(row_mask, core, 0.0)
    block_core = np.maximum(block_core, core)

    block_index = np.searchsorted(boundaries[1:], local_x, side="right")
    tones = layout_rng.uniform(-0.13, 0.14, count)
    row_tone = tones[np.minimum(block_index, count - 1)]
    block_tone = np.where(row_mask, row_tone, block_tone)

masonry_h = np.clip(
    masonry_h
    + block_core * (0.66 + block_tone * 0.23)
    + block_core * (face - 0.5) * 0.16,
    0.0,
    1.0,
)

# 타일의 y=0/1 이음부를 한 덩어리의 '아래층'으로 삼으면 타일링을 깨지 않고
# 아랫단에만 습기와 이끼가 모인다.
lower_course = np.exp(-((np.minimum(yw, 1.0 - yw) / 0.19) ** 2))
moss_patch = (
    lower_course
    * mw.sstep(mw.warp(mw.fbm(BIG, 5, octaves=4, seed=1106), 0.045, 4, 1107), 0.48, 0.72)
)
water_run = lower_course * mw.sstep(
    0.5 + 0.5 * np.sin((gx * 7.0 + mw.fbm(BIG, 3, octaves=2, seed=1108) * 0.45) * np.pi * 2.0),
    0.76,
    0.96,
)

masonry_mono = np.clip(0.20 + masonry_h * 0.52 + block_tone * 0.24 + face * 0.08, 0.0, 1.0)
masonry_albedo = mw.tint(
    masonry_mono,
    (0.105, 0.108, 0.112),
    (0.420, 0.416, 0.410),
)
# 모르타르는 깊고 차갑게, 아래 이끼는 낮은 채도의 녹갈색으로 남긴다.
masonry_albedo *= (0.63 + block_core * 0.37)[..., None]
masonry_albedo = masonry_albedo * (1.0 - moss_patch[..., None] * 0.34)
masonry_albedo += moss_patch[..., None] * np.array([0.038, 0.050, 0.035])
masonry_albedo -= water_run[..., None] * np.array([0.045, 0.043, 0.040])

masonry_rough = np.clip(
    0.79 + (1.0 - block_core) * 0.16 + moss_patch * 0.10 - water_run * 0.22 + (face - 0.5) * 0.08,
    0.48,
    0.99,
)
MASONRY = emit(
    "masonry",
    masonry_h,
    np.clip(masonry_albedo, 0.0, 1.0),
    masonry_rough,
    normal_strength=2.4,
    ao_radius=7,
    ao_strength=1.35,
)
del masonry_h, masonry_albedo, masonry_rough, block_tone, block_core
del edge_warp_x, edge_warp_y, edge_chip, face, xw, yw, moss_patch, water_run


# ---------------------------------------------------------------------------
# 2. roof-tile — 반원통 수키와, 오목한 암키와, 겹침 단차
# ---------------------------------------------------------------------------

# 아홉 줄의 정수 주기로 타일 경계가 이어진다. 저주파 좌표 편차는 손으로 놓은
# 기와의 미세한 비뚤어짐만 만들고 반원통 실루엣은 보존한다.
tile_shift = (mw.fbm(BIG, 3, octaves=3, seed=1121) - 0.5) * 0.055
x_phase = (gx * 9.0 + tile_shift) % 1.0
ridge_distance = np.minimum(x_phase, 1.0 - x_phase)
valley_distance = np.abs(x_phase - 0.5)
ridge = np.sqrt(np.clip(1.0 - (ridge_distance / 0.235) ** 2, 0.0, 1.0))
valley = np.sqrt(np.clip(1.0 - (valley_distance / 0.37) ** 2, 0.0, 1.0))

# 여섯 장이 위에서 아래로 포개진다. 행 시작의 높은 턱 뒤로 완만히 낮아지는
# 톱니 높이가 겹침 단차이며, 단순한 사인 주름과 구분되는 핵심이다.
y_phase = (gy * 6.0) % 1.0
overlap = 1.0 - mw.sstep(y_phase, 0.045, 0.42)
roof_face = mw.fbm(BIG, 11, octaves=3, seed=1122)
roof_h = np.clip(
    0.43 + ridge * 0.36 - valley * 0.16 + overlap * 0.20 + (roof_face - 0.5) * 0.055,
    0.0,
    1.0,
)

# 일부 셀의 아래 모서리만 파서 깨진 기와를 만든다. 전체 셀을 검게 지우면
# 빠진 구멍처럼 보이므로 삼각형 조각과 얕은 파임을 함께 쓴다.
tile_col = np.floor(gx * 9.0).astype(np.int16)
tile_row = np.floor(gy * 6.0).astype(np.int16)
cell_x = (gx * 9.0) % 1.0
cell_y = (gy * 6.0) % 1.0
broken_select = (
    ((tile_col == 1) & (tile_row == 4))
    | ((tile_col == 5) & (tile_row == 1))
    | ((tile_col == 7) & (tile_row == 3))
)
broken_corner = mw.sstep(cell_x + cell_y, 1.25, 1.62) * broken_select
roof_h = np.clip(roof_h - broken_corner * 0.34, 0.0, 1.0)

roof_moss = (
    mw.sstep(valley, 0.25, 0.36)
    * mw.sstep(overlap, 0.50, 0.88)
    * mw.sstep(mw.fbm(BIG, 5, octaves=3, seed=1123), 0.48, 0.70)
)
rain_streak = mw.sstep(
    0.5 + 0.5 * np.sin((gx * 8.0 + mw.fbm(BIG, 2, octaves=2, seed=1124) * 0.40) * np.pi * 2.0),
    0.80,
    0.97,
) * (0.35 + 0.65 * y_phase)

roof_albedo = mw.tint(
    np.clip(0.28 + roof_h * 0.42 + (roof_face - 0.5) * 0.12, 0.0, 1.0),
    (0.070, 0.082, 0.092),
    (0.280, 0.306, 0.322),
)
roof_albedo -= rain_streak[..., None] * np.array([0.034, 0.038, 0.040])
roof_albedo -= broken_corner[..., None] * np.array([0.052, 0.050, 0.046])
roof_albedo = roof_albedo * (1.0 - roof_moss[..., None] * 0.24)
roof_albedo += roof_moss[..., None] * np.array([0.027, 0.040, 0.028])

roof_rough = np.clip(
    0.72 + roof_moss * 0.18 + broken_corner * 0.15 - rain_streak * 0.18 + (roof_face - 0.5) * 0.08,
    0.43,
    0.96,
)
ROOF_TILE = emit(
    "roof-tile",
    roof_h,
    np.clip(roof_albedo, 0.0, 1.0),
    roof_rough,
    normal_strength=2.15,
    ao_radius=6,
    ao_strength=1.15,
)
del roof_h, roof_albedo, roof_rough, ridge, valley, overlap, roof_face
del tile_shift, tile_col, tile_row, cell_x, cell_y, broken_select, broken_corner
del roof_moss, rain_streak, x_phase, y_phase, ridge_distance, valley_distance


# ---------------------------------------------------------------------------
# 3. painted-wood — 거리장으로 그린 단청 머리초
# ---------------------------------------------------------------------------

# 지정 팔레트. 색이 정체성인 세트라 회색 tint를 거치지 않고 실제 단청 색을
# 놓되, 아래의 노화 마스크에서만 밝기를 억제한다.
NAEROK = np.array([0x4A, 0x5F, 0x4E], dtype=np.float64) / 255.0
JANGDAN = np.array([0x9C, 0x3B, 0x2E], dtype=np.float64) / 255.0
SAMCHEONG = np.array([0x35, 0x56, 0x6E], dtype=np.float64) / 255.0
WHITE = np.array([0xD8, 0xD2, 0xC4], dtype=np.float64) / 255.0
YELLOW = np.array([0xB8, 0x91, 0x3F], dtype=np.float64) / 255.0

painted_albedo = np.broadcast_to(NAEROK, (BIG, BIG, 3)).copy()

# 위아래 테두리가 긴 띠의 외곽을 먼저 고정한다. 타일 y 경계 양쪽에 같은
# 장단색을 두어 반복 이음매도 하나의 굵은 적색 선으로 읽힌다.
edge_y = np.minimum(gy, 1.0 - gy)
painted_albedo[edge_y < 0.050] = JANGDAN
painted_albedo[(edge_y >= 0.050) & (edge_y < 0.068)] = WHITE
painted_albedo[(edge_y >= 0.068) & (edge_y < 0.112)] = YELLOW
painted_albedo[(edge_y >= 0.112) & (edge_y < 0.128)] = WHITE

# 좌우 경계 중심에서 안쪽으로 열린 반타원 거리장. u=min(x,1-x)를 쓰므로
# 두 끝은 정확히 대칭이고 타일 경계에서도 같은 값을 가진다.
u_end = np.minimum(gx, 1.0 - gx)
arch_r = np.sqrt((u_end / 0.405) ** 2 + ((gy - 0.5) / 0.455) ** 2)
arch_area = (arch_r < 1.0) & (edge_y > 0.132)

# 바깥에서 안쪽으로 녹 → 청 → 백 → 적, 갈수록 띠 폭을 좁힌다.
green_arch = arch_area & (arch_r >= 0.72)
blue_arch = arch_area & (arch_r >= 0.49) & (arch_r < 0.72)
white_arch = arch_area & (arch_r >= 0.34) & (arch_r < 0.49)
red_arch = arch_area & (arch_r >= 0.155) & (arch_r < 0.34)
yellow_seed = arch_area & (arch_r < 0.155)
# 바깥 녹색 아치는 중앙 뇌록보다 조금 밝고 푸르게 잡아 흰 실선 사이의
# 첫 겹이 분명히 보이게 한다.
painted_albedo[green_arch] = NAEROK * np.array([0.78, 1.12, 0.82])
painted_albedo[blue_arch] = SAMCHEONG
painted_albedo[white_arch] = WHITE
painted_albedo[red_arch] = JANGDAN
painted_albedo[yellow_seed] = YELLOW

# 각 색 아치 사이의 실선은 거리장의 등거리선이다. 블러 노이즈가 아니라
# 고정 폭 distance field라 축소해도 끊기지 않고 머리초 구획으로 읽힌다.
separator = np.zeros((BIG, BIG))
for radius in (0.155, 0.34, 0.49, 0.72, 0.985):
    separator = np.maximum(separator, 1.0 - mw.sstep(np.abs(arch_r - radius), 0.007, 0.014))
separator *= arch_area
painted_albedo = painted_albedo * (1.0 - separator[..., None]) + WHITE * separator[..., None]

# 중앙 뇌록 바탕에는 황색 마름모 하나만 두어 좌우 머리초 사이의 축을 잡는다.
# 마름모도 L1 거리장으로 그려 얼룩처럼 번지지 않는다.
diamond_d = np.abs(torus_delta(gx, 0.5)) / 0.065 + np.abs(gy - 0.5) / 0.105
diamond = 1.0 - mw.sstep(diamond_d, 0.82, 1.0)
diamond_line = (
    mw.sstep(diamond_d, 0.56, 0.66) * (1.0 - mw.sstep(diamond_d, 0.74, 0.84))
)
painted_albedo = painted_albedo * (1.0 - diamond[..., None]) + JANGDAN * diamond[..., None]
painted_albedo = painted_albedo * (1.0 - diamond_line[..., None]) + YELLOW * diamond_line[..., None]

# 벗겨짐은 저주파 덩어리를 x 방향으로 늘여 목재 섬유를 따라 긴 조각으로
# 떨어지게 한다. 5주기 마스크는 큰 검은 얼룩처럼 보여 9주기로 조각을 줄였고,
# 임계 전이를 좁혀 페인트가 들뜬 경계가 흐려지지 않게 했다.
peel_field = mw.warp(mw.fbm(BIG, 9, octaves=3, seed=1141), 0.026, 7, 1142)
peel_field = (
    peel_field
    + np.roll(peel_field, 9, axis=1)
    + np.roll(peel_field, -9, axis=1)
    + np.roll(peel_field, 19, axis=1)
    + np.roll(peel_field, -19, axis=1)
) / 5.0

wood_shift = (mw.fbm(BIG, 3, octaves=2, seed=1143) - 0.5) * 0.55
wood_grain = 0.5 + 0.5 * np.sin((gy * 18.0 + wood_shift) * np.pi * 2.0)
wood_grain = 0.72 * wood_grain + 0.28 * mw.fbm(BIG, 9, octaves=2, seed=1144)
# 섬유 골이 박락 윤곽을 한 번 더 잘라 둥근 노이즈 반점을 긴 파편으로 바꾼다.
peel_score = peel_field * 0.82 + wood_grain * 0.18
peel = mw.sstep(peel_score, 0.675, 0.705)
exposed_wood = mw.tint(wood_grain, (0.165, 0.125, 0.090), (0.410, 0.315, 0.205))

# 오래된 안료는 색을 바꾸기보다 같은 팔레트 안에서 8% 정도만 바랜다.
aging = 0.88 + mw.blur(mw.fbm(BIG, 4, octaves=3, seed=1145), 9, 2) * 0.12
painted_albedo *= aging[..., None]
painted_albedo = painted_albedo * (1.0 - peel[..., None]) + exposed_wood * peel[..., None]

paint_boundaries = np.maximum(separator, diamond_line)
painted_h = np.clip(
    0.56
    + paint_boundaries * 0.055
    + (wood_grain - 0.5) * 0.045
    - peel * 0.145,
    0.0,
    1.0,
)
painted_rough = np.clip(0.55 * (1.0 - peel) + 0.88 * peel, 0.55, 0.88)

PAINTED_WOOD = emit(
    "painted-wood",
    painted_h,
    np.clip(painted_albedo, 0.0, 1.0),
    painted_rough,
    normal_strength=1.25,
    ao_radius=5,
    ao_strength=0.85,
)
del painted_h, painted_albedo, painted_rough, separator, diamond, diamond_line
del peel_field, peel_score, peel, wood_shift, wood_grain, exposed_wood, aging, paint_boundaries
del arch_r, arch_area, green_arch, blue_arch, white_arch, red_arch, yellow_seed


# ---------------------------------------------------------------------------
# 4. timber — 칠하지 않은 풍화 목재
# ---------------------------------------------------------------------------

gx, gy = grid(SMALL)

# 세로결은 x에서만 빠르게 변하고 y의 저주파 굴곡으로 휜다. 등방성 FBM을
# 그대로 쓰지 않아 돌이나 구름이 아니라 기둥을 따라 선 목섬유로 읽힌다.
grain_bend = (mw.fbm(SMALL, 3, octaves=3, seed=1161) - 0.5) * 0.72
grain_phase = gx * 17.0 + grain_bend
grain_primary = 0.5 + 0.5 * np.sin(grain_phase * np.pi * 2.0)
grain_secondary = 0.5 + 0.5 * np.sin((grain_phase * 0.47 + gy * 0.35) * np.pi * 2.0)
timber_grain = grain_primary * 0.68 + grain_secondary * 0.20 + mw.fbm(SMALL, 8, octaves=2, seed=1162) * 0.12

# 갈라짐은 세로결의 골 중 일부만 y 마스크로 이어 놓는다.
split_line = mw.sstep(1.0 - grain_primary, 0.88, 0.985)
split_extent = mw.sstep(mw.fbm(SMALL, 3, octaves=3, seed=1163), 0.43, 0.68)
splits = split_line * split_extent

# 옹이는 세 개의 타원 거리장과 동심파로 명시한다. 토러스 거리라 가장자리
# 옹이도 반대편에 자연스럽게 이어진다.
knots = np.zeros((SMALL, SMALL))
knot_rings = np.zeros((SMALL, SMALL))
for cx, cy, sx, sy in (
    (0.22, 0.27, 0.105, 0.075),
    (0.68, 0.61, 0.130, 0.090),
    (0.91, 0.84, 0.085, 0.060),
):
    radius = ellipse_distance(gx, gy, cx, cy, sx, sy)
    mask = 1.0 - mw.sstep(radius, 0.82, 1.10)
    ring = (0.5 + 0.5 * np.cos(radius * np.pi * 9.0)) * mask
    knots = np.maximum(knots, mask)
    knot_rings = np.maximum(knot_rings, ring)

timber_h = np.clip(
    0.46 + (timber_grain - 0.5) * 0.23 + knot_rings * 0.17 - splits * 0.34 - knots * 0.055,
    0.0,
    1.0,
)
timber_albedo = mw.tint(
    np.clip(0.28 + timber_grain * 0.42 + knot_rings * 0.12 - splits * 0.30, 0.0, 1.0),
    (0.105, 0.094, 0.083),
    (0.360, 0.326, 0.286),
)
timber_rough = np.clip(0.80 + splits * 0.16 + knots * 0.07 - knot_rings * 0.05, 0.66, 0.98)

TIMBER = emit(
    "timber",
    timber_h,
    np.clip(timber_albedo, 0.0, 1.0),
    timber_rough,
    normal_strength=1.75,
    ao_radius=5,
    ao_strength=1.05,
)
del timber_h, timber_albedo, timber_rough, grain_bend, grain_phase
del grain_primary, grain_secondary, timber_grain, split_line, split_extent, splits
del knots, knot_rings


# ---------------------------------------------------------------------------
# 5. plaster — 회벽, 흙손 자국, 잔금, 하부 물때
# ---------------------------------------------------------------------------

plaster_base = mw.warp(mw.fbm(SMALL, 7, octaves=3, seed=1171), 0.022, 5, 1172)

# 흙손이 지나간 넓은 반원 호. 개별 타원 거리장이라 FBM을 밝힌 것과 달리
# 실제 미장 방향이 보이며, 네 호 모두 타일 경계에서 이어진다.
trowel = np.zeros((SMALL, SMALL))
for cx, cy, radius, width, sx, sy in (
    (0.12, 0.24, 1.00, 0.12, 0.42, 0.24),
    (0.63, 0.39, 0.92, 0.10, 0.36, 0.20),
    (0.35, 0.77, 1.08, 0.13, 0.48, 0.26),
    (0.88, 0.89, 0.84, 0.10, 0.31, 0.18),
):
    radius_field = ellipse_distance(gx, gy, cx, cy, sx, sy)
    stroke = np.exp(-((radius_field - radius) / width) ** 2)
    trowel = np.maximum(trowel, stroke)

crack_field = mw.warp(mw.ridged(SMALL, 4, octaves=4, seed=1173), 0.035, 4, 1174)
hairline = mw.sstep(crack_field, 0.91, 0.985)
hairline *= mw.sstep(mw.fbm(SMALL, 3, octaves=2, seed=1175), 0.38, 0.62)

lower_edge = np.minimum(gy, 1.0 - gy)
plaster_damp = np.exp(-((lower_edge / 0.18) ** 2))
plaster_streak = plaster_damp * mw.sstep(
    0.5 + 0.5 * np.sin((gx * 6.0 + mw.fbm(SMALL, 2, octaves=2, seed=1176) * 0.55) * np.pi * 2.0),
    0.71,
    0.94,
)

plaster_h = np.clip(
    0.50 + (plaster_base - 0.5) * 0.18 + trowel * 0.085 - hairline * 0.32,
    0.0,
    1.0,
)
plaster_albedo = mw.tint(
    np.clip(0.45 + plaster_base * 0.32 + trowel * 0.08 - hairline * 0.18, 0.0, 1.0),
    (0.245, 0.238, 0.224),
    (0.690, 0.674, 0.642),
)
plaster_albedo -= plaster_streak[..., None] * np.array([0.105, 0.103, 0.096])
plaster_rough = np.clip(0.84 + hairline * 0.11 + trowel * 0.045 - plaster_streak * 0.13, 0.65, 0.98)

PLASTER = emit(
    "plaster",
    plaster_h,
    np.clip(plaster_albedo, 0.0, 1.0),
    plaster_rough,
    normal_strength=1.35,
    ao_radius=7,
    ao_strength=0.90,
)
del plaster_h, plaster_albedo, plaster_rough, plaster_base, trowel
del crack_field, hairline, plaster_damp, plaster_streak, lower_edge


# ---------------------------------------------------------------------------
# 6. bronze — 범종과 금속 장식, 오목부의 녹청
# ---------------------------------------------------------------------------

hammered = mw.warp(mw.fbm(SMALL, 9, octaves=3, seed=1181), 0.025, 7, 1182)
recess_field = mw.warp(mw.ridged(SMALL, 4, octaves=4, seed=1183), 0.040, 4, 1184)
recess = mw.sstep(recess_field, 0.77, 0.95)
bronze_h = np.clip(0.48 + (hammered - 0.5) * 0.20 - recess * 0.31, 0.0, 1.0)

# 녹청은 오목한 선과 저주파 습기 반점이 겹친 자리에서만 선명해진다.
patina_cloud = mw.sstep(
    mw.warp(mw.fbm(SMALL, 5, octaves=4, seed=1185), 0.060, 4, 1186),
    0.46,
    0.69,
)
patina = np.clip(recess * 0.72 + patina_cloud * mw.sstep(0.57 - bronze_h, 0.04, 0.24) * 0.72, 0.0, 1.0)

bronze_mono = np.clip(0.22 + bronze_h * 0.60 + hammered * 0.08, 0.0, 1.0)
bronze_albedo = mw.tint(
    bronze_mono,
    (0.105, 0.070, 0.050),
    (0.460, 0.315, 0.155),
)
patina_color = np.array([0.055, 0.305, 0.245])
bronze_albedo = bronze_albedo * (1.0 - patina[..., None] * 0.82) + patina_color * patina[..., None] * 0.82
bronze_rough = np.clip(0.35 + patina * 0.40 + (1.0 - hammered) * 0.10, 0.35, 0.75)

BRONZE = emit(
    "bronze",
    bronze_h,
    np.clip(bronze_albedo, 0.0, 1.0),
    bronze_rough,
    metalness=1.0,
    normal_strength=1.55,
    ao_radius=6,
    ao_strength=1.15,
)
del bronze_h, bronze_albedo, bronze_rough, bronze_mono
del hammered, recess_field, recess, patina_cloud, patina


# ---------------------------------------------------------------------------
# 7. cloth — 성긴 직조, 가장자리 마모, 얼룩
# ---------------------------------------------------------------------------

# 28×24 정수 주기의 날실·씨실. 규칙적인 직조는 WebP가 잘 압축하고, 위상
# 편차만 저주파라 화면에서 픽셀 잡음 없이 성긴 천으로 읽힌다.
weave_bend_x = (mw.fbm(SMALL, 3, octaves=2, seed=1191) - 0.5) * 0.11
weave_bend_y = (mw.fbm(SMALL, 4, octaves=2, seed=1192) - 0.5) * 0.10
warp_thread = 0.5 + 0.5 * np.sin((gx * 28.0 + weave_bend_x) * np.pi * 2.0)
weft_thread = 0.5 + 0.5 * np.sin((gy * 24.0 + weave_bend_y) * np.pi * 2.0)
over_under = (warp_thread - 0.5) * (weft_thread - 0.5)

cloth_edge = np.minimum(gx, 1.0 - gx)
fray_band = np.exp(-((cloth_edge / 0.055) ** 2))
missing_warp = fray_band * mw.sstep(
    0.5 + 0.5 * np.sin((gy * 13.0 + mw.fbm(SMALL, 2, octaves=2, seed=1193) * 0.45) * np.pi * 2.0),
    0.64,
    0.92,
)
cloth_stain = mw.sstep(
    mw.warp(mw.fbm(SMALL, 4, octaves=4, seed=1194), 0.055, 3, 1195),
    0.52,
    0.76,
)

cloth_h = np.clip(
    0.50
    + (warp_thread - 0.5) * 0.13
    + (weft_thread - 0.5) * 0.11
    + over_under * 0.10
    - missing_warp * 0.20,
    0.0,
    1.0,
)
cloth_albedo = mw.tint(
    np.clip(0.34 + cloth_h * 0.42 - cloth_stain * 0.18 - missing_warp * 0.12, 0.0, 1.0),
    (0.105, 0.096, 0.092),
    (0.355, 0.318, 0.302),
)
cloth_rough = np.clip(0.86 + missing_warp * 0.10 + cloth_stain * 0.05 - over_under * 0.06, 0.76, 0.98)

CLOTH = emit(
    "cloth",
    cloth_h,
    np.clip(cloth_albedo, 0.0, 1.0),
    cloth_rough,
    normal_strength=1.25,
    ao_radius=3,
    ao_strength=0.75,
)
del cloth_h, cloth_albedo, cloth_rough, weave_bend_x, weave_bend_y
del warp_thread, weft_thread, over_under, cloth_edge, fray_band, missing_warp, cloth_stain


# ---------------------------------------------------------------------------
# 8. bark — 적송의 붉은 판상 껍질과 거북등 균열
# ---------------------------------------------------------------------------

plate_edge, plate_id = mw.voronoi(SMALL, 11, seed=1201, metric="f2f1", jitter=0.88)
plate_edge = mw.warp(plate_edge, 0.030, 5, 1202)
plate_core = mw.sstep(plate_edge, 0.020, 0.165)
deep_crack = 1.0 - mw.sstep(plate_edge, 0.010, 0.075)
plate_relief = mw.fbm(SMALL, 7, octaves=3, seed=1203)

# 큰 판 내부에 한 단계 작은 균열을 드물게 넣어 보로노이 셀 한 겹의 인공성을
# 없앤다. 폭이 넓어 512에서도 한 픽셀 노이즈가 되지 않는다.
secondary_field = mw.warp(mw.ridged(SMALL, 4, octaves=3, seed=1204), 0.032, 4, 1205)
secondary_crack = mw.sstep(secondary_field, 0.88, 0.98)
secondary_crack *= mw.sstep(plate_id, 0.38, 0.60) * plate_core

bark_h = np.clip(
    0.16 + plate_core * (0.58 + (plate_id - 0.5) * 0.16) + (plate_relief - 0.5) * 0.15
    - secondary_crack * 0.26,
    0.0,
    1.0,
)
bark_albedo = mw.tint(
    np.clip(0.22 + bark_h * 0.60 + (plate_id - 0.5) * 0.10, 0.0, 1.0),
    (0.110, 0.096, 0.090),
    (0.340, 0.295, 0.280),
)
bark_albedo -= deep_crack[..., None] * np.array([0.050, 0.046, 0.043])
bark_albedo += plate_core[..., None] * np.array([0.018, 0.006, 0.000])
bark_rough = np.clip(0.84 + deep_crack * 0.12 + secondary_crack * 0.08 - plate_core * 0.06, 0.74, 0.99)

BARK = emit(
    "bark",
    bark_h,
    np.clip(bark_albedo, 0.0, 1.0),
    bark_rough,
    normal_strength=2.0,
    ao_radius=6,
    ao_strength=1.30,
)
del bark_h, bark_albedo, bark_rough, plate_edge, plate_id
del plate_core, deep_crack, plate_relief, secondary_field, secondary_crack


# ---------------------------------------------------------------------------
# 머티리얼 등록
#
# uvScale은 월드 미터당 반복 수다. 아래 값은 각 무늬의 실제 크기를 기준으로
# 하나씩 정했다. 지오메트리의 mw.uv_box(scale=1)와 곱해져 그대로 적용된다.
# ---------------------------------------------------------------------------

MATERIALS = (
    # 0.35 → 한 장이 2.86m. 성벽에서 7층×4~6개 장대석이 실제 축조 크기로 보인다.
    ("masonry", MASONRY, 0.82, 0.0, 0.35, "stone", 1.0),
    # 1.2 → 0.83m마다 반복. 한 주기에 9줄이라 수키와 폭이 약 9cm가 된다.
    ("roof-tile", ROOF_TILE, 0.74, 0.0, 1.2, "stone", 1.0),
    # 0.6 → 1.67m 보 한 칸에 좌우 머리초와 중앙 뇌록부가 한 번 들어간다.
    ("painted-wood", PAINTED_WOOD, 0.58, 0.0, 0.6, "default", 0.35),
    # 0.45 → 2.22m 기둥 높이에 긴 세로결과 옹이 몇 개가 반복 없이 읽힌다.
    ("timber", TIMBER, 0.82, 0.0, 0.45, "default", 0.90),
    # 0.30 → 3.33m 회벽 면에 큰 흙손 호가 남아 벽이 얼룩 타일처럼 보이지 않는다.
    ("plaster", PLASTER, 0.86, 0.0, 0.30, "stone", 1.0),
    # 0.85 → 1.18m 범종·장식 단위마다 요철과 녹청 분포가 한 번씩 돈다.
    ("bronze", BRONZE, 0.52, 1.0, 0.85, "default", 0.55),
    # 0.8 → 보통 1.25m 깃발 폭에 직조와 해진 양 가장자리가 한 구도로 들어간다.
    ("cloth", CLOTH, 0.88, 0.0, 0.80, "cloth", 0.85),
    # 0.55 → 1.82m 줄기 구간에 큰 판상 껍질이 보여 작은 자갈 무늬가 되지 않는다.
    ("bark", BARK, 0.88, 0.0, 0.55, "stone", 0.95),
)

for name, maps, roughness, metallic, uv_scale, shader, arc_response in MATERIALS:
    material_name = "mw/nature/bark" if name == "bark" else f"mw/arch/{name}"
    mw.material(
        mw.MaterialSpec(
            name=material_name,
            base_color=(1.0, 1.0, 1.0, 1.0),
            roughness=roughness,
            metallic=metallic,
            base_color_map=maps["baseColor"],
            normal_map=maps["normal"],
            orm_map=maps["orm"],
            uv_scale=uv_scale,
            shader=shader,
            arc_response=arc_response,
        )
    )

mw.finish()
print("[11_tex_arch] 8 architecture PBR sets OK")
