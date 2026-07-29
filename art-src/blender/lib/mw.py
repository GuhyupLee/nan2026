# -*- coding: utf-8 -*-
"""명월(明月) 환경 에셋 파이프라인 공용 라이브러리.

에셋 스크립트는 이 모듈만 임포트하면 된다. 목표는 두 가지다.

1. **결정성** — 같은 스크립트는 항상 같은 GLB를 낸다. 난수는 반드시 `rng()`로
   시드에서 파생시키고, `random`/`bpy.ops.object.randomize_transform`처럼 전역
   상태를 쓰는 경로는 쓰지 않는다.
2. **웹 예산** — 에셋은 결국 브라우저에서 로드된다. `export_glb()`가 삼각형 수와
   텍스처 용량을 매니페스트에 적어 두므로, 예산 초과는 빌드 시점에 잡힌다.

## 스크립트 뼈대

    import bpy, os, sys
    sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))
    import mw

    mw.reset(seed=1201)
    ...
    mw.export_glb("wall-segment", objects)

## 하이폴리 → 로우폴리

웹 게임처럼 보이지 않게 만드는 단 하나의 결정적 요소는 **노멀맵에 구워 넣은
고밀도 디테일**이다. 로우폴리에 평평한 색만 칠하면 삼각형을 아무리 늘려도
"three.js 데모"로 읽힌다. `bake_high_to_low()`가 그 전사를 담당한다.
"""

from __future__ import annotations

import json
import math
import os
import struct
import sys
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

# ---------------------------------------------------------------------------
# 경로
# ---------------------------------------------------------------------------

PROJECT_ROOT = os.environ.get("MW_PROJECT_ROOT") or os.getcwd()
ASSET_OUT_DIR = os.path.join(PROJECT_ROOT, "public", "env")
# 원본 텍스처는 public에 두지 않는다. 2048 PNG 15장이 83MB인데 그대로 배포하면
# 첫 로드가 끝나지 않는다. `tools/art/optimize-env-tex.mjs`가 여기서 읽어
# public/env/tex/*.webp로 줄인다. 매니페스트에는 **변환 후 경로**를 적는다.
TEXTURE_RAW_DIR = os.path.join(PROJECT_ROOT, "art-src", "blender", "tex-raw")
TEXTURE_OUT_REL = "env/tex"
MANIFEST_PATH = os.path.join(PROJECT_ROOT, "art-src", "blender", "manifest.json")
WORK_DIR = os.path.join(PROJECT_ROOT, "art-src", "blender", ".work")

TAU = math.tau


def _ensure_dirs() -> None:
    for path in (ASSET_OUT_DIR, TEXTURE_RAW_DIR, WORK_DIR, os.path.dirname(MANIFEST_PATH)):
        os.makedirs(path, exist_ok=True)


# ---------------------------------------------------------------------------
# 결정적 난수
# ---------------------------------------------------------------------------

_SEED = 0


def rng(salt: str = "") -> np.random.Generator:
    """스크립트 시드 + 문자열 salt에서 파생된 독립 난수 생성기.

    salt를 다르게 주면 서로 독립이고, 같은 salt는 항상 같은 수열을 낸다. 이
    덕분에 에셋 A의 디테일을 늘려도 에셋 B의 배치가 흔들리지 않는다.
    """
    digest = 0
    for index, ch in enumerate(salt):
        digest = (digest * 131 + ord(ch) + index) & 0xFFFFFFFF
    return np.random.default_rng((_SEED * 2654435761 + digest) & 0xFFFFFFFF)


# ---------------------------------------------------------------------------
# 씬
# ---------------------------------------------------------------------------


def reset(seed: int = 0, cycles_samples: int = 64) -> None:
    """공장 초기화 상태에서 시작해 씬을 완전히 비운다."""
    global _SEED
    _SEED = int(seed)
    _ensure_dirs()

    bpy.ops.wm.read_factory_settings(use_empty=True)

    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    scene.render.engine = "CYCLES"
    scene.cycles.samples = cycles_samples
    scene.cycles.use_denoising = True
    scene.cycles.bake_type = "COMBINED"
    # 알베도를 구울 때 필름 톤매핑이 섞이면 게임 안에서 두 번 톤매핑된다.
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"

    try:
        scene.cycles.device = "GPU"
        prefs = bpy.context.preferences.addons.get("cycles")
        if prefs is not None:
            cprefs = prefs.preferences
            for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
                try:
                    cprefs.compute_device_type = backend
                    cprefs.get_devices()
                    if any(d.type == backend for d in cprefs.devices):
                        for device in cprefs.devices:
                            device.use = device.type in (backend, "CPU")
                        break
                except Exception:
                    continue
    except Exception:
        # GPU 구성이 없으면 CPU로 굽는다. 품질은 같고 시간만 늘어난다.
        scene.cycles.device = "CPU"


def deselect_all() -> None:
    for obj in bpy.context.scene.objects:
        obj.select_set(False)
    bpy.context.view_layer.objects.active = None


def activate(obj: bpy.types.Object, *, solo: bool = True) -> bpy.types.Object:
    if solo:
        deselect_all()
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    return obj


# ---------------------------------------------------------------------------
# 메시 생성
# ---------------------------------------------------------------------------


def new_mesh(
    name: str,
    verts: Sequence[Sequence[float]],
    faces: Sequence[Sequence[int]],
    *,
    smooth: bool = False,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [], [tuple(f) for f in faces])
    mesh.validate(verbose=False)
    mesh.update()
    if smooth:
        for polygon in mesh.polygons:
            polygon.use_smooth = True
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def box(
    name: str,
    size: Sequence[float],
    location: Sequence[float] = (0.0, 0.0, 0.0),
    *,
    pivot_bottom: bool = False,
) -> bpy.types.Object:
    """축 정렬 박스. `pivot_bottom`이면 바닥면이 location.z에 놓인다."""
    sx, sy, sz = (float(size[0]) * 0.5, float(size[1]) * 0.5, float(size[2]) * 0.5)
    zlo, zhi = (0.0, sz * 2.0) if pivot_bottom else (-sz, sz)
    verts = [
        (-sx, -sy, zlo), (sx, -sy, zlo), (sx, sy, zlo), (-sx, sy, zlo),
        (-sx, -sy, zhi), (sx, -sy, zhi), (sx, sy, zhi), (-sx, sy, zhi),
    ]
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    obj = new_mesh(name, verts, faces)
    obj.location = tuple(float(v) for v in location)
    return obj


def prism(
    name: str,
    sides: int,
    radius_bottom: float,
    radius_top: float,
    height: float,
    location: Sequence[float] = (0.0, 0.0, 0.0),
    *,
    rotation: float = 0.0,
    cap_bottom: bool = True,
    cap_top: bool = True,
    smooth: bool = False,
) -> bpy.types.Object:
    """n각 기둥/원뿔대. 기둥, 처마 서까래, 석등 몸통에 두루 쓴다."""
    verts: list[tuple[float, float, float]] = []
    for i in range(sides):
        angle = rotation + TAU * i / sides
        verts.append((math.cos(angle) * radius_bottom, math.sin(angle) * radius_bottom, 0.0))
    for i in range(sides):
        angle = rotation + TAU * i / sides
        verts.append((math.cos(angle) * radius_top, math.sin(angle) * radius_top, height))

    faces: list[tuple[int, ...]] = []
    for i in range(sides):
        j = (i + 1) % sides
        faces.append((i, j, sides + j, sides + i))
    if cap_bottom and radius_bottom > 1e-6:
        faces.append(tuple(reversed(range(sides))))
    if cap_top and radius_top > 1e-6:
        faces.append(tuple(range(sides, sides * 2)))

    obj = new_mesh(name, verts, faces, smooth=smooth)
    obj.location = tuple(float(v) for v in location)
    return obj


def lathe(
    name: str,
    profile: Sequence[Sequence[float]],
    segments: int,
    *,
    location: Sequence[float] = (0.0, 0.0, 0.0),
    arc: float = TAU,
    smooth: bool = True,
    cap: bool = True,
) -> bpy.types.Object:
    """(radius, z) 프로필을 회전시킨다. 항아리·종·석등 갓·기와 마루에 쓴다."""
    points = [(float(r), float(z)) for r, z in profile]
    ring_count = segments if abs(arc - TAU) < 1e-6 else segments + 1
    verts: list[tuple[float, float, float]] = []
    for s in range(ring_count):
        angle = arc * s / segments
        cos_a, sin_a = math.cos(angle), math.sin(angle)
        for radius, z in points:
            verts.append((cos_a * radius, sin_a * radius, z))

    stride = len(points)
    faces: list[tuple[int, ...]] = []
    loop = abs(arc - TAU) < 1e-6
    span = segments if loop else segments
    for s in range(span):
        s0 = s * stride
        s1 = ((s + 1) % ring_count) * stride if loop else (s + 1) * stride
        for p in range(stride - 1):
            a, b = s0 + p, s0 + p + 1
            c, d = s1 + p + 1, s1 + p
            if abs(points[p][0]) < 1e-6:
                faces.append((a, c, d))
            elif abs(points[p + 1][0]) < 1e-6:
                faces.append((a, b, d))
            else:
                faces.append((a, b, c, d))

    obj = new_mesh(name, verts, faces, smooth=smooth)
    if cap:
        _fill_boundary(obj)
    obj.location = tuple(float(v) for v in location)
    return obj


def sweep(
    name: str,
    section: Sequence[Sequence[float]],
    path: Sequence[Sequence[float]],
    *,
    closed_section: bool = True,
    closed_path: bool = False,
    up: Sequence[float] = (0.0, 0.0, 1.0),
    smooth: bool = False,
    scale_fn: Callable[[float], float] | None = None,
) -> bpy.types.Object:
    """2D 단면을 3D 경로를 따라 밀어낸다. 성벽·처마·난간·다리 구조에 쓴다.

    프레임은 경로 접선과 `up`으로 만든다. 접선이 up과 평행해지는 구간(수직
    상승)은 이전 프레임을 재사용해 뒤집힘을 막는다.
    """
    pts = [Vector(tuple(float(c) for c in p)) for p in path]
    if len(pts) < 2:
        raise ValueError("sweep: 경로는 점 2개 이상이 필요하다")
    up_v = Vector(tuple(float(c) for c in up)).normalized()

    frames: list[tuple[Vector, Vector, Vector]] = []
    prev_normal: Vector | None = None
    count = len(pts)
    for i in range(count):
        if closed_path:
            tangent = (pts[(i + 1) % count] - pts[(i - 1) % count])
        elif i == 0:
            tangent = pts[1] - pts[0]
        elif i == count - 1:
            tangent = pts[-1] - pts[-2]
        else:
            tangent = pts[i + 1] - pts[i - 1]
        if tangent.length < 1e-9:
            tangent = Vector((1.0, 0.0, 0.0))
        tangent.normalize()
        side = tangent.cross(up_v)
        if side.length < 1e-6:
            side = prev_normal if prev_normal is not None else Vector((1.0, 0.0, 0.0))
        side = Vector(side).normalized()
        normal = side.cross(tangent).normalized()
        prev_normal = side
        frames.append((pts[i], side, normal))

    stride = len(section)
    verts: list[tuple[float, float, float]] = []
    for index, (origin, side, normal) in enumerate(frames):
        t = index / max(1, count - 1)
        k = scale_fn(t) if scale_fn else 1.0
        for u, v in section:
            p = origin + side * (float(u) * k) + normal * (float(v) * k)
            verts.append((p.x, p.y, p.z))

    faces: list[tuple[int, ...]] = []
    ring_span = count if closed_path else count - 1
    for i in range(ring_span):
        a0 = i * stride
        a1 = ((i + 1) % count) * stride
        edges = stride if closed_section else stride - 1
        for p in range(edges):
            q = (p + 1) % stride
            faces.append((a0 + p, a0 + q, a1 + q, a1 + p))

    obj = new_mesh(name, verts, faces, smooth=smooth)
    return obj


def _fill_boundary(obj: bpy.types.Object) -> None:
    """열린 경계 루프를 n각형으로 막는다."""
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    boundary = [e for e in bm.edges if e.is_boundary]
    if boundary:
        try:
            bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
        except Exception:
            pass
    bm.to_mesh(mesh)
    bm.free()
    mesh.update()


# ---------------------------------------------------------------------------
# 편집 연산
# ---------------------------------------------------------------------------


def join(name: str, objects: Sequence[bpy.types.Object]) -> bpy.types.Object:
    """여러 오브젝트를 하나로 합친다. 드로우콜 예산의 핵심이다."""
    alive = [o for o in objects if o.name in bpy.data.objects]
    if not alive:
        raise ValueError("join: 오브젝트가 없다")
    if len(alive) == 1:
        alive[0].name = name
        return alive[0]
    activate(alive[0])
    for obj in alive[1:]:
        obj.select_set(True)
    bpy.ops.object.join()
    result = bpy.context.view_layer.objects.active
    result.name = name
    result.data.name = name
    return result


def apply_transform(obj: bpy.types.Object, *, location=True, rotation=True, scale=True) -> None:
    activate(obj)
    bpy.ops.object.transform_apply(location=location, rotation=rotation, scale=scale)


def bevel(obj: bpy.types.Object, width: float, segments: int = 2, angle_deg: float = 42.0) -> None:
    """모서리 베벨.

    **이게 저가형과 상용의 경계선이다.** 완전히 날카로운 모서리는 실제 물체에
    존재하지 않아서, 스페큘러 하이라이트가 모서리를 따라 흐르지 않는다. 눈은
    그걸 즉시 "CG"로 읽는다. 0.5cm 베벨 하나가 재질감을 통째로 바꾼다.
    """
    modifier = obj.modifiers.new("mw-bevel", "BEVEL")
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    modifier.angle_limit = math.radians(angle_deg)
    modifier.harden_normals = segments > 1
    modifier.miter_outer = "MITER_ARC"
    obj.data.shade_smooth()
    _apply_modifier(obj, modifier.name)


def subdivide(obj: bpy.types.Object, levels: int = 1, *, simple: bool = False) -> None:
    modifier = obj.modifiers.new("mw-subsurf", "SUBSURF")
    modifier.levels = levels
    modifier.render_levels = levels
    modifier.subdivision_type = "SIMPLE" if simple else "CATMULL_CLARK"
    _apply_modifier(obj, modifier.name)


def solidify(obj: bpy.types.Object, thickness: float, *, offset: float = -1.0) -> None:
    modifier = obj.modifiers.new("mw-solidify", "SOLIDIFY")
    modifier.thickness = thickness
    modifier.offset = offset
    _apply_modifier(obj, modifier.name)


def displace(obj: bpy.types.Object, texture: bpy.types.Texture, strength: float, *, mid: float = 0.5) -> None:
    modifier = obj.modifiers.new("mw-displace", "DISPLACE")
    modifier.texture = texture
    modifier.strength = strength
    modifier.mid_level = mid
    modifier.texture_coords = "GLOBAL"
    _apply_modifier(obj, modifier.name)


def decimate(obj: bpy.types.Object, ratio: float) -> None:
    modifier = obj.modifiers.new("mw-decimate", "DECIMATE")
    modifier.ratio = max(0.005, min(1.0, ratio))
    _apply_modifier(obj, modifier.name)


def shade_auto_smooth(obj: bpy.types.Object, angle_deg: float = 42.0) -> None:
    """각도 기준 자동 스무딩.

    Blender 4.1에서 `use_auto_smooth`가 사라지고 모디파이어 노드 그룹으로
    바뀌었다. 버전에 따라 두 경로 모두 대응한다.
    """
    obj.data.shade_smooth()
    mesh = obj.data
    if hasattr(mesh, "use_auto_smooth"):
        mesh.use_auto_smooth = True
        mesh.auto_smooth_angle = math.radians(angle_deg)
        return
    try:
        activate(obj)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle_deg))
    except Exception:
        pass


def _apply_modifier(obj: bpy.types.Object, name: str) -> None:
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=name)


def noise_texture(name: str, scale: float = 1.0, depth: int = 4, seed_salt: str = "") -> bpy.types.Texture:
    """Displace 모디파이어용 절차 텍스처."""
    texture = bpy.data.textures.new(name, type="CLOUDS")
    texture.noise_scale = scale
    texture.noise_depth = depth
    texture.noise_basis = "BLENDER_ORIGINAL"
    return texture


def scatter_instances(
    name: str,
    source: bpy.types.Object,
    placements: Iterable[tuple[Sequence[float], float, float]],
) -> bpy.types.Object:
    """(위치, z회전, 스케일) 목록으로 소스를 복제해 하나로 합친다.

    GLB 하나에 여러 벌이 들어가면 브라우저에서 InstancedMesh로 다시 쪼개기가
    어렵다. 반대로 **바위·잔해처럼 개별 위치가 의미 없는 것**은 여기서 합쳐
    드로우콜을 줄이는 편이 낫다. 배치가 의미 있는 것(석등 같은)은 합치지 말고
    three.js 쪽 InstancedMesh로 넘긴다.
    """
    copies: list[bpy.types.Object] = []
    for location, rot_z, scale in placements:
        copy = source.copy()
        copy.data = source.data.copy()
        bpy.context.scene.collection.objects.link(copy)
        copy.location = tuple(float(v) for v in location)
        copy.rotation_euler = Euler((0.0, 0.0, float(rot_z)), "XYZ")
        copy.scale = (float(scale), float(scale), float(scale))
        copies.append(copy)
    merged = join(name, copies)
    apply_transform(merged)
    return merged


# ---------------------------------------------------------------------------
# UV
# ---------------------------------------------------------------------------


def set_vertex_colors(
    obj: bpy.types.Object,
    fn: Callable[[Vector, Vector], Sequence[float]],
    *,
    name: str = "Col",
) -> None:
    """정점마다 (월드 위치, 노멀) → (r, g, b) 마스크를 굽는다.

    ## 반드시 FLOAT_COLOR여야 하는 이유

    Blender의 색 속성은 `BYTE_COLOR`와 `FLOAT_COLOR` 두 가지다. 기본값인
    `BYTE_COLOR`는 **sRGB로 해석**되고, glTF 익스포터가 내보낼 때 선형으로
    변환한다. 마스크 0.5를 넣으면 셰이더에 0.214가 도착한다.

    마스크는 색이 아니라 **데이터**다. 감마가 끼면 이끼가 있어야 할 곳에
    이끼가 안 나고, 원인을 찾으려면 텍스처·셰이더·UV를 전부 뒤진 다음에야
    여기에 도달한다. `FLOAT_COLOR`는 선형 그대로 나가므로 그 실패가 없다.

    ## 채널 규약 (SPEC.md §4 Tier 1.5)

    - R = 마모도 (0 새것 → 1 닳음)
    - G = 이끼/습기
    - B = 균열 근접도
    """
    mesh = obj.data
    existing = mesh.color_attributes.get(name)
    if existing is not None:
        mesh.color_attributes.remove(existing)
    layer = mesh.color_attributes.new(name=name, type="FLOAT_COLOR", domain="POINT")

    matrix = obj.matrix_world
    normal_matrix = matrix.to_3x3().inverted_safe().transposed()
    values = []
    for vertex in mesh.vertices:
        world = matrix @ vertex.co
        normal = (normal_matrix @ vertex.normal).normalized()
        rgb = fn(world, normal)
        values.extend(
            (
                min(1.0, max(0.0, float(rgb[0]))),
                min(1.0, max(0.0, float(rgb[1]))),
                min(1.0, max(0.0, float(rgb[2]))),
                1.0,
            )
        )
    layer.data.foreach_set("color", values)
    mesh.update()


def uv_smart(obj: bpy.types.Object, *, angle_deg: float = 66.0, island_margin: float = 0.006) -> None:
    activate(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle_deg), island_margin=island_margin)
    bpy.ops.object.mode_set(mode="OBJECT")


def uv_box(obj: bpy.types.Object, scale: float = 1.0) -> None:
    """월드 공간 박스 투영.

    타일링 텍스처를 쓰는 건축물에는 스마트 UV보다 이쪽이 훨씬 낫다. 섬이
    생기지 않아 이음매가 없고, 인접한 벽 조각끼리 무늬가 이어진다.
    """
    mesh = obj.data
    # Blender 5.2의 bpy_prop_collection은 비어 있어도 bool(collection)이 True인
    # 경우가 있다. 길이를 직접 보지 않으면 active가 None인 채 아래에서 깨진다.
    if len(mesh.uv_layers) == 0:
        mesh.uv_layers.new(name="UVMap")
    active = mesh.uv_layers.active
    if active is None:
        mesh.uv_layers.active_index = 0
        active = mesh.uv_layers[0]
    uv_layer = active.data
    matrix = obj.matrix_world
    for polygon in mesh.polygons:
        normal = (matrix.to_3x3() @ polygon.normal).normalized()
        ax, ay, az = abs(normal.x), abs(normal.y), abs(normal.z)
        for loop_index in polygon.loop_indices:
            world = matrix @ mesh.vertices[mesh.loops[loop_index].vertex_index].co
            if az >= ax and az >= ay:
                u, v = world.x, world.y
            elif ax >= ay:
                u, v = world.y, world.z
            else:
                u, v = world.x, world.z
            uv_layer[loop_index].uv = (u * scale, v * scale)


def uv_cylinder(obj: bpy.types.Object, *, u_scale: float = 1.0, v_scale: float = 1.0) -> None:
    """Z축 원통 투영. 기둥·석등·종에 쓴다."""
    mesh = obj.data
    if len(mesh.uv_layers) == 0:
        mesh.uv_layers.new(name="UVMap")
    active = mesh.uv_layers.active
    if active is None:
        mesh.uv_layers.active_index = 0
        active = mesh.uv_layers[0]
    uv_layer = active.data
    for polygon in mesh.polygons:
        # 이음매에서 u가 1→0으로 되감기면 텍스처가 한 폴리곤에 통째로 압축된다.
        # 폴리곤 단위로 기준각을 잡아 상대 오프셋만 누적해 막는다.
        angles = []
        for loop_index in polygon.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            angles.append(math.atan2(co.y, co.x))
        base = angles[0]
        for loop_index, angle in zip(polygon.loop_indices, angles):
            delta = (angle - base + math.pi) % TAU - math.pi
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            u = (base + delta) / TAU
            uv_layer[loop_index].uv = (u * u_scale, co.z * v_scale)


# ---------------------------------------------------------------------------
# 절차 텍스처 (numpy, 완전 타일링)
# ---------------------------------------------------------------------------


def _periodic_hash(ix: np.ndarray, iy: np.ndarray, period: int, seed: int) -> np.ndarray:
    x = np.mod(ix, period).astype(np.int64)
    y = np.mod(iy, period).astype(np.int64)
    h = (x * 374761393 + y * 668265263 + seed * 2246822519) & 0xFFFFFFFF
    h = (h ^ (h >> 13)) * 1274126177 & 0xFFFFFFFF
    h = h ^ (h >> 16)
    return (h & 0xFFFFFF).astype(np.float64) / float(0xFFFFFF)


def value_noise(size: int, period: int, seed: int) -> np.ndarray:
    """주기 `period`의 이음매 없는 밸류 노이즈. 결과는 0..1."""
    axis = np.linspace(0.0, period, size, endpoint=False)
    gx, gy = np.meshgrid(axis, axis, indexing="xy")
    ix, iy = np.floor(gx).astype(np.int64), np.floor(gy).astype(np.int64)
    fx, fy = gx - ix, gy - iy
    ux = fx * fx * (3.0 - 2.0 * fx)
    uy = fy * fy * (3.0 - 2.0 * fy)
    n00 = _periodic_hash(ix, iy, period, seed)
    n10 = _periodic_hash(ix + 1, iy, period, seed)
    n01 = _periodic_hash(ix, iy + 1, period, seed)
    n11 = _periodic_hash(ix + 1, iy + 1, period, seed)
    return (n00 * (1 - ux) + n10 * ux) * (1 - uy) + (n01 * (1 - ux) + n11 * ux) * uy


def fbm(size: int, period: int, octaves: int = 5, seed: int = 0, gain: float = 0.5) -> np.ndarray:
    """이음매 없는 FBM. 각 옥타브의 주기가 정수배라 타일링이 유지된다."""
    total = np.zeros((size, size), dtype=np.float64)
    amplitude, norm, current = 1.0, 0.0, period
    for octave in range(octaves):
        total += value_noise(size, max(1, int(current)), seed + octave * 7919) * amplitude
        norm += amplitude
        amplitude *= gain
        current *= 2
    return total / max(1e-9, norm)


def voronoi(
    size: int,
    cells: int,
    seed: int,
    *,
    metric: str = "f1",
    jitter: float = 1.0,
) -> tuple[np.ndarray, np.ndarray]:
    """이음매 없는 보로노이. (거리장 0..1, 셀 ID 0..1) 쌍을 돌려준다.

    석재 블록, 기와, 자갈, 결정립, 갈라진 흙에 전부 쓴다. `metric="f2f1"`은
    셀 **경계**를 밝게 내므로 균열·이음매·모르타르에 그대로 쓸 수 있다.

    구현은 3×3 이웃만 본다. 전 특징점을 도는 순진한 방식은 2048² × cells²라
    셀 100개짜리 화강암 결정에서 몇 시간이 걸린다. 이웃 검사로 O(size²×9)가 된다.
    """
    axis = (np.arange(size) + 0.5) / size * cells
    gx, gy = np.meshgrid(axis, axis, indexing="xy")
    cx, cy = np.floor(gx).astype(np.int64), np.floor(gy).astype(np.int64)

    best = np.full((size, size), 1e9)
    second = np.full((size, size), 1e9)
    best_id = np.zeros((size, size))

    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            nx, ny = cx + dx, cy + dy
            jx = _periodic_hash(nx, ny, cells, seed)
            jy = _periodic_hash(nx, ny, cells, seed + 7717)
            ident = _periodic_hash(nx, ny, cells, seed + 15733)
            px = nx + 0.5 + (jx - 0.5) * jitter
            py = ny + 0.5 + (jy - 0.5) * jitter
            ddx, ddy = gx - px, gy - py
            dist = np.sqrt(ddx * ddx + ddy * ddy)
            closer = dist < best
            second = np.where(closer, best, np.minimum(second, dist))
            best_id = np.where(closer, ident, best_id)
            best = np.where(closer, dist, best)

    field = (second - best) if metric == "f2f1" else best
    return np.clip(field, 0.0, 1.0), best_id


def ridged(size: int, period: int, octaves: int = 5, seed: int = 0, gain: float = 0.5) -> np.ndarray:
    """능선형 FBM. 균열·나뭇결·바위 결에 쓴다. 0..1이며 1이 능선이다."""
    total = np.zeros((size, size), dtype=np.float64)
    amplitude, norm, current = 1.0, 0.0, period
    for octave in range(octaves):
        n = value_noise(size, max(1, int(current)), seed + octave * 6367)
        total += (1.0 - np.abs(n * 2.0 - 1.0)) * amplitude
        norm += amplitude
        amplitude *= gain
        current *= 2
    return total / max(1e-9, norm)


def warp(field: np.ndarray, amount: float, period: int = 4, seed: int = 0) -> np.ndarray:
    """도메인 워프. 절차 텍스처가 "노이즈"로 안 보이게 만드는 핵심 연산.

    FBM을 그대로 쓰면 아무리 겹쳐도 균질한 안개다. 좌표 자체를 다른 노이즈로
    밀면 흐름·결·응결이 생기고, 그때부터 자연물로 읽힌다.
    """
    size = field.shape[0]
    dx = (value_noise(size, period, seed + 101) - 0.5) * 2.0 * amount * size
    dy = (value_noise(size, period, seed + 202) - 0.5) * 2.0 * amount * size
    ay = np.arange(size)[:, None] + dy
    ax = np.arange(size)[None, :] + dx
    # 토러스 랩으로 이음매를 유지한다.
    x0 = np.floor(ax).astype(np.int64)
    y0 = np.floor(ay).astype(np.int64)
    fx, fy = ax - x0, ay - y0
    x0m, y0m = np.mod(x0, size), np.mod(y0, size)
    x1m, y1m = np.mod(x0 + 1, size), np.mod(y0 + 1, size)
    v00 = field[y0m, x0m]
    v10 = field[y0m, x1m]
    v01 = field[y1m, x0m]
    v11 = field[y1m, x1m]
    return (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy


def blur(field: np.ndarray, radius: int = 2, passes: int = 2) -> np.ndarray:
    """이음매를 유지하는 박스 블러(roll 기반이라 자동으로 랩된다)."""
    out = field.astype(np.float64)
    for _ in range(max(1, passes)):
        acc = np.zeros_like(out)
        for dy in (-radius, 0, radius):
            for dx in (-radius, 0, radius):
                acc += np.roll(np.roll(out, dy, axis=0), dx, axis=1)
        out = acc / 9.0
    return out


def remap(field: np.ndarray, lo: float = 0.0, hi: float = 1.0) -> np.ndarray:
    """실제 최소·최대를 lo..hi로 늘린다. 노이즈는 대개 0.3~0.7에 몰려 있다."""
    fmin, fmax = float(field.min()), float(field.max())
    if fmax - fmin < 1e-9:
        return np.full_like(field, (lo + hi) * 0.5)
    return lo + (field - fmin) / (fmax - fmin) * (hi - lo)


def contrast(field: np.ndarray, amount: float = 1.0, pivot: float = 0.5) -> np.ndarray:
    return np.clip((field - pivot) * amount + pivot, 0.0, 1.0)


def sstep(field: np.ndarray, edge0: float, edge1: float) -> np.ndarray:
    t = np.clip((field - edge0) / max(1e-9, edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def tint(mono: np.ndarray, dark: Sequence[float], light: Sequence[float]) -> np.ndarray:
    """0..1 그레이스케일을 두 색 사이로 매핑한다.

    베이스컬러는 **채도를 낮게** 유지한다. 5분 아크의 색 전환이 three.js에서
    위에 얹히는데, 텍스처가 이미 색을 갖고 있으면 두 색이 싸워 탁해진다.
    """
    d = np.asarray(dark, dtype=np.float64).reshape(1, 1, 3)
    l = np.asarray(light, dtype=np.float64).reshape(1, 1, 3)
    m = mono[..., None]
    return d * (1.0 - m) + l * m


def height_to_normal(height: np.ndarray, strength: float = 1.0) -> np.ndarray:
    """하이트맵을 탄젠트 공간 노멀맵(0..1 RGB)으로 바꾼다."""
    dx = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5
    dy = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5
    scale = strength * height.shape[0] / 256.0
    nx = -dx * scale
    ny = -dy * scale
    nz = np.ones_like(height)
    length = np.sqrt(nx * nx + ny * ny + nz * nz)
    normal = np.stack([nx / length, ny / length, nz / length], axis=-1)
    return normal * 0.5 + 0.5


def ambient_occlusion(height: np.ndarray, radius: int = 8, strength: float = 1.0) -> np.ndarray:
    """하이트맵 기반 근사 AO. 넓은 블러와의 차이를 오목함으로 읽는다."""
    blurred = height.copy()
    kernel = max(1, radius)
    for _ in range(3):
        blurred = (
            blurred
            + np.roll(blurred, kernel, axis=0)
            + np.roll(blurred, -kernel, axis=0)
            + np.roll(blurred, kernel, axis=1)
            + np.roll(blurred, -kernel, axis=1)
        ) / 5.0
    occlusion = np.clip(1.0 - (blurred - height) * strength * 6.0, 0.0, 1.0)
    return occlusion


def _write_png(path: str, rgba: np.ndarray) -> None:
    """8비트 RGBA PNG를 직접 쓴다.

    Blender의 `image.save()`를 쓰지 않는 이유는 색공간 때문이다. Blender 이미지
    버퍼는 항상 선형이고 저장 시 이미지의 colorspace로 변환하는데, 그 변환이
    버전·뷰 트랜스폼·비트뎁스에 따라 달라진다. 실제로 처음 구현에서 베이스컬러가
    두 번 감마를 먹어 거의 검게 나왔다. 배열이 곧 파일 바이트가 되는 경로가
    유일하게 검증 가능한 방법이다.

    필터는 전 행 0(None)이다. 압축률은 나쁘지만 이 PNG는 중간 산출물이고,
    최종 배포본은 WebP로 다시 인코딩된다.
    """
    import struct
    import zlib

    height, width, _ = rgba.shape
    stride = width * 4
    flat = rgba.reshape(height, stride)
    raw = bytearray(height * (stride + 1))
    for y in range(height):
        offset = y * (stride + 1)
        raw[offset] = 0
        raw[offset + 1 : offset + 1 + stride] = flat[y].tobytes()

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    blob = b"\x89PNG\r\n\x1a\n"
    blob += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    blob += chunk(b"IDAT", zlib.compress(bytes(raw), 6))
    blob += chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(blob)


def save_texture(
    name: str,
    channels: np.ndarray,
    *,
    srgb: bool,
    subdir: str = "",
) -> str:
    """float 배열(H,W,3 또는 H,W,4, 0..1)을 중간 PNG로 저장한다.

    **배열 값은 최종 표시값 그대로다.** sRGB 텍스처면 이미 sRGB로 인코딩된
    값(눈으로 보는 밝기)을 넣고, 논컬러면 원시 값을 넣는다. 변환은 없다 —
    three.js가 `colorSpace`만 맞게 잡아 준다.

    반환값은 **변환 후 WebP의 `public/` 기준 경로**다. 매니페스트와 three.js가
    그대로 쓰고, `tools/art/optimize-env-tex.mjs`가 그 자리에 파일을 만든다.
    """
    _ensure_dirs()
    data = np.clip(np.asarray(channels, dtype=np.float64), 0.0, 1.0)
    if data.ndim == 2:
        data = np.stack([data, data, data], axis=-1)
    if data.shape[-1] == 3:
        data = np.concatenate([data, np.ones(data.shape[:2] + (1,))], axis=-1)

    height, width = data.shape[0], data.shape[1]
    # +0.5 반올림. floor로 자르면 전체가 미세하게 어두워지고, 노멀맵에서는
    # 그 편향이 표면 전체를 한쪽으로 기울인다.
    rgba = np.clip(data * 255.0 + 0.5, 0, 255).astype(np.uint8)

    out_dir = os.path.join(TEXTURE_RAW_DIR, subdir) if subdir else TEXTURE_RAW_DIR
    os.makedirs(out_dir, exist_ok=True)
    _write_png(os.path.join(out_dir, f"{name}.png"), rgba)

    rel = f"{TEXTURE_OUT_REL}/{subdir}/{name}.webp" if subdir else f"{TEXTURE_OUT_REL}/{name}.webp"
    _MANIFEST.textures.append(
        {
            "name": name,
            "path": rel,
            "raw": os.path.relpath(
                os.path.join(out_dir, f"{name}.png"), PROJECT_ROOT
            ).replace("\\", "/"),
            "size": [width, height],
            "srgb": srgb,
        }
    )
    return rel


def pack_orm(occlusion: np.ndarray, roughness: np.ndarray, metalness: np.ndarray) -> np.ndarray:
    """glTF 규격 ORM: R=AO, G=Roughness, B=Metalness. 텍스처 3장을 1장으로 줄인다."""
    def as2d(value):
        return np.full_like(occlusion, float(value)) if np.isscalar(value) else np.asarray(value)
    return np.stack([as2d(occlusion), as2d(roughness), as2d(metalness)], axis=-1)


# ---------------------------------------------------------------------------
# 머티리얼
# ---------------------------------------------------------------------------


@dataclass
class MaterialSpec:
    """머티리얼 정의. **텍스처는 GLB에 넣지 않는다.**

    GLB에는 지오메트리와 머티리얼 *이름*만 담고, 실제 텍스처는 `public/env/tex/`에
    따로 둔 뒤 three.js가 매니페스트를 보고 묶는다. 이유가 셋 있다.

    1. 같은 석재 텍스처를 성벽·계단·석등이 공유하는데, GLB에 넣으면 에셋마다
       사본이 생겨 다운로드가 몇 배로 늘어난다.
    2. 5분 아크의 색 전환·바람·차폐 디더링은 전부 three.js 셰이더 개조가
       필요하다. 익스포터가 만든 머티리얼을 어차피 갈아끼워야 한다.
    3. PNG를 WebP로 줄이는 후처리(`tools/optimize-env-art.ts`)를 GLB 바깥에서
       돌릴 수 있다.

    `shader`는 three.js 쪽에서 어떤 확장을 붙일지 고르는 힌트다.
    'stone' | 'foliage' | 'cloth' | 'emissive' | 'water' | 'default'
    """

    name: str
    base_color: tuple[float, float, float, float] = (0.5, 0.5, 0.5, 1.0)
    roughness: float = 0.8
    metallic: float = 0.0
    emission: tuple[float, float, float] | None = None
    emission_strength: float = 0.0
    base_color_map: str | None = None
    normal_map: str | None = None
    orm_map: str | None = None
    normal_strength: float = 1.0
    uv_scale: float = 1.0
    alpha_blend: bool = False
    alpha_test: float = 0.0
    double_sided: bool = False
    shader: str = "default"
    # 표면이 5분 아크 색 전환에 반응하는 정도. 0이면 고정색.
    arc_response: float = 1.0


def _bsdf_input(bsdf: bpy.types.Node, *names: str):
    for name in names:
        socket = bsdf.inputs.get(name)
        if socket is not None:
            return socket
    return None


def _raw_path(rel: str) -> str:
    """매니페스트의 WebP 경로를 Blender가 실제로 읽을 수 있는 원본 PNG로 되돌린다.

    WebP는 최적화 단계가 만들므로 에셋 스크립트가 도는 시점에는 아직 없다.
    """
    stem = rel[len(TEXTURE_OUT_REL) + 1 :] if rel.startswith(TEXTURE_OUT_REL + "/") else rel
    if stem.endswith(".webp"):
        stem = stem[: -len(".webp")] + ".png"
    return os.path.join(TEXTURE_RAW_DIR, *stem.split("/"))


def _image_node(nodes, links, path: str, *, non_color: bool, uv_scale: float, mapping):
    absolute = _raw_path(path)
    if not os.path.exists(absolute):
        raise FileNotFoundError(
            f"텍스처 원본이 없다: {absolute}\n"
            "해당 텍스처를 만드는 스크립트(10_tex_*.py 등)를 먼저 실행하라."
        )
    image = bpy.data.images.load(absolute, check_existing=True)
    if non_color:
        image.colorspace_settings.name = "Non-Color"
    node = nodes.new("ShaderNodeTexImage")
    node.image = image
    node.interpolation = "Smart"
    if mapping is not None:
        links.new(mapping.outputs["Vector"], node.inputs["Vector"])
    return node


def material(spec: MaterialSpec) -> bpy.types.Material:
    """Principled BSDF 머티리얼. glTF가 그대로 이해하는 채널만 쓴다.

    **같은 이름으로 두 번 부르면 기존 것을 돌려준다.** Blender는 이름이 겹치면
    조용히 `.001`을 붙이는데, three.js는 머티리얼 이름으로 텍스처와 셰이더
    확장을 찾으므로 그 순간 그 오브젝트만 텍스처 없이 회색으로 렌더된다.
    원인을 찾기 어려운 종류의 실패라 여기서 막는다.
    """
    existing = bpy.data.materials.get(spec.name)
    if existing is not None:
        return existing
    mat = bpy.data.materials.new(spec.name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    output = nodes.get("Material Output")
    if bsdf is None:
        bsdf = nodes.new("ShaderNodeBsdfPrincipled")
        links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])

    bsdf.inputs["Base Color"].default_value = spec.base_color
    bsdf.inputs["Roughness"].default_value = spec.roughness
    bsdf.inputs["Metallic"].default_value = spec.metallic

    if spec.emission is not None:
        socket = _bsdf_input(bsdf, "Emission Color", "Emission")
        if socket is not None:
            socket.default_value = (*spec.emission, 1.0)
        strength = bsdf.inputs.get("Emission Strength")
        if strength is not None:
            strength.default_value = spec.emission_strength

    mapping = None
    if spec.uv_scale != 1.0:
        uv = nodes.new("ShaderNodeUVMap")
        mapping = nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = (spec.uv_scale, spec.uv_scale, 1.0)
        links.new(uv.outputs["UV"], mapping.inputs["Vector"])

    if spec.base_color_map:
        node = _image_node(nodes, links, spec.base_color_map, non_color=False, uv_scale=spec.uv_scale, mapping=mapping)
        links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
        if spec.alpha_blend:
            links.new(node.outputs["Alpha"], bsdf.inputs["Alpha"])

    if spec.normal_map:
        node = _image_node(nodes, links, spec.normal_map, non_color=True, uv_scale=spec.uv_scale, mapping=mapping)
        normal = nodes.new("ShaderNodeNormalMap")
        normal.inputs["Strength"].default_value = spec.normal_strength
        links.new(node.outputs["Color"], normal.inputs["Color"])
        links.new(normal.outputs["Normal"], bsdf.inputs["Normal"])

    if spec.orm_map:
        node = _image_node(nodes, links, spec.orm_map, non_color=True, uv_scale=spec.uv_scale, mapping=mapping)
        separate = nodes.new("ShaderNodeSeparateColor")
        links.new(node.outputs["Color"], separate.inputs["Color"])
        links.new(separate.outputs["Green"], bsdf.inputs["Roughness"])
        links.new(separate.outputs["Blue"], bsdf.inputs["Metallic"])
        # glTF 익스포터가 ORM을 인식하려면 전용 노드 그룹이 필요하다. 없으면
        # AO는 버려지고 R/M만 나가는데, three.js 쪽에서 같은 텍스처를 aoMap으로
        # 다시 물려 주므로 손실은 없다.

    if spec.alpha_blend:
        try:
            mat.surface_render_method = "BLENDED"
        except Exception:
            pass
    mat.use_backface_culling = not spec.double_sided

    _MANIFEST.materials.append(
        {
            "name": spec.name,
            "baseColor": list(spec.base_color),
            "roughness": spec.roughness,
            "metalness": spec.metallic,
            "emission": list(spec.emission) if spec.emission else None,
            "emissionStrength": spec.emission_strength,
            "maps": {
                "baseColor": spec.base_color_map,
                "normal": spec.normal_map,
                "orm": spec.orm_map,
            },
            "normalScale": spec.normal_strength,
            "uvScale": spec.uv_scale,
            "transparent": spec.alpha_blend,
            "alphaTest": spec.alpha_test,
            "doubleSided": spec.double_sided,
            "shader": spec.shader,
            "arcResponse": spec.arc_response,
        }
    )
    return mat


def assign(obj: bpy.types.Object, mat: bpy.types.Material) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def assign_by_index(obj: bpy.types.Object, materials: Sequence[bpy.types.Material], index_fn) -> None:
    """폴리곤별 머티리얼 배정. 하나의 메시에 석재/목재/금속을 섞을 때 쓴다."""
    obj.data.materials.clear()
    for mat in materials:
        obj.data.materials.append(mat)
    matrix = obj.matrix_world
    for polygon in obj.data.polygons:
        center = matrix @ polygon.center
        normal = (matrix.to_3x3() @ polygon.normal).normalized()
        polygon.material_index = max(0, min(len(materials) - 1, int(index_fn(center, normal))))


# ---------------------------------------------------------------------------
# 베이크
# ---------------------------------------------------------------------------


def bake_high_to_low(
    low: bpy.types.Object,
    high: bpy.types.Object,
    name: str,
    *,
    size: int = 1024,
    cage_extrusion: float = 0.06,
    bake_ao: bool = True,
) -> dict[str, str]:
    """하이폴리의 표면 디테일을 로우폴리의 노멀맵·AO로 전사한다.

    이 함수를 통과한 에셋만 "게임 CG"로 보인다. 로우폴리에는 UV가 있어야 하고,
    하이폴리는 로우폴리를 감싸는 위치에 있어야 한다.
    """
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.render.bake.use_selected_to_active = True
    scene.render.bake.cage_extrusion = cage_extrusion
    scene.render.bake.margin = max(4, size // 128)
    scene.render.bake.use_clear = True

    if not low.data.uv_layers:
        uv_smart(low)

    results: dict[str, str] = {}
    passes = [("normal", "NORMAL", False)]
    if bake_ao:
        passes.append(("ao", "AO", False))

    for suffix, bake_type, srgb in passes:
        image = bpy.data.images.new(
            f"{name}_{suffix}", width=size, height=size, alpha=False, float_buffer=False
        )
        image.colorspace_settings.name = "sRGB" if srgb else "Non-Color"

        for mat in low.data.materials:
            if mat is None or not mat.use_nodes:
                continue
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = image
            node.name = "mw-bake-target"
            mat.node_tree.nodes.active = node

        deselect_all()
        high.select_set(True)
        low.select_set(True)
        bpy.context.view_layer.objects.active = low
        bpy.ops.object.bake(type=bake_type, use_clear=True)

        pixels = np.empty(size * size * 4, dtype=np.float32)
        image.pixels.foreach_get(pixels)
        data = np.flipud(pixels.reshape((size, size, 4)))
        results[suffix] = save_texture(f"{name}_{suffix}", data[..., :3], srgb=srgb)

        for mat in low.data.materials:
            if mat is None or not mat.use_nodes:
                continue
            node = mat.node_tree.nodes.get("mw-bake-target")
            if node is not None:
                mat.node_tree.nodes.remove(node)

    scene.render.bake.use_selected_to_active = False
    return results


# ---------------------------------------------------------------------------
# 매니페스트 & 내보내기
# ---------------------------------------------------------------------------


@dataclass
class Manifest:
    assets: list[dict] = field(default_factory=list)
    textures: list[dict] = field(default_factory=list)
    materials: list[dict] = field(default_factory=list)


_MANIFEST = Manifest()


def _validate_geometry(name: str, objects: Sequence[bpy.types.Object]) -> None:
    """내보내기 전에 지오메트리 위생을 검사한다.

    ## 왜 필요한가

    석등 스크립트가 정점 하나를 x = 2.97e24 에 만든 적이 있다. 나눗셈에서
    분모가 0에 가까워진 결과였는데, Blender는 아무 경고도 하지 않고, 익스포터도
    통과시키고, 브라우저도 로드에 성공한다. 화면에는 **바닥에 깔린 납작한
    판** 하나만 보였다.

    더 나쁜 건 부수 효과다. 그 정점 하나 때문에 바운딩 박스가 우주 크기가 되어
    절두체 컬링이 무력화되고, 그림자 카메라가 그 범위를 덮으려다 그림자
    해상도가 전부 날아간다. **에셋 하나가 씬 전체의 성능과 그림자를 망가뜨리는데
    증상은 "석등이 안 보인다"로만 나타난다.**

    그래서 파이프라인 맨 끝에서 한 번 걸러 낸다. 여기서 죽는 게 브라우저에서
    원인 불명으로 헤매는 것보다 낫다.
    """
    problems: list[str] = []
    for obj in objects:
        if obj.type != "MESH":
            continue
        mesh = obj.data
        if len(mesh.vertices) == 0:
            problems.append(f"{obj.name}: 정점이 없다")
            continue

        count = len(mesh.vertices)
        coords = np.empty(count * 3, dtype=np.float64)
        mesh.vertices.foreach_get("co", coords)

        if not np.all(np.isfinite(coords)):
            bad = int(np.count_nonzero(~np.isfinite(coords)))
            problems.append(f"{obj.name}: 좌표에 NaN/Inf {bad}개")
            continue

        extent = float(np.max(np.abs(coords)))
        # 이 프로젝트에서 가장 큰 에셋(바깥 지형)이 반경 48m다. 200m를 넘으면
        # 의도한 것일 수 없다.
        if extent > 200.0:
            index = int(np.argmax(np.abs(coords)))
            problems.append(
                f"{obj.name}: 좌표가 범위를 벗어났다 — |{coords[index]:.3g}| "
                f"(정점 {index // 3}, 축 {'xyz'[index % 3]}). "
                "0으로 나누는 곳이 없는지 확인하라"
            )

        if not mesh.uv_layers:
            problems.append(f"{obj.name}: UV가 없다 — uv_box()/uv_smart()를 부르지 않았다")

        if len(mesh.polygons) == 0:
            problems.append(f"{obj.name}: 면이 없다")

    if problems:
        raise SystemExit(
            f"[mw] export_glb({name}) 지오메트리 검사 실패:\n  "
            + "\n  ".join(problems)
        )


def _tri_count(obj: bpy.types.Object) -> int:
    total = 0
    for polygon in obj.data.polygons:
        total += max(0, len(polygon.vertices) - 2)
    return total


def _gltf_kwargs(**wanted) -> dict:
    """Blender 버전 간 glTF 익스포터 인자 차이를 흡수한다.

    4.x와 5.x 사이에서 인자 이름이 여러 번 바뀌었다. 존재하지 않는 인자를
    넘기면 오퍼레이터 전체가 실패하므로 RNA에서 실제 속성만 걸러낸다.
    """
    try:
        properties = bpy.ops.export_scene.gltf.get_rna_type().properties
        valid = {p.identifier for p in properties}
    except Exception:
        valid = set(wanted)
    return {key: value for key, value in wanted.items() if key in valid}


def export_glb(
    name: str,
    objects: Sequence[bpy.types.Object],
    *,
    subdir: str = "",
    animations: bool = False,
    max_triangles: int | None = None,
    notes: str = "",
    extras: dict | None = None,
    embed_textures: bool = False,
    compress: bool = True,
) -> str:
    """선택 오브젝트를 GLB로 내보내고 매니페스트에 기록한다.

    좌표계는 glTF 규약(Y-up)으로 변환된다. Blender에서 +Z가 위, three.js에서
    +Y가 위이므로 익스포터의 `export_yup`을 켜 두면 추가 회전이 필요 없다.
    """
    _ensure_dirs()
    alive = [o for o in objects if o.name in bpy.data.objects]
    if not alive:
        raise ValueError(f"export_glb({name}): 내보낼 오브젝트가 없다")

    _validate_geometry(name, alive)

    deselect_all()
    for obj in alive:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = alive[0]

    out_dir = os.path.join(ASSET_OUT_DIR, subdir) if subdir else ASSET_OUT_DIR
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, f"{name}.glb")

    kwargs = _gltf_kwargs(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        # 정점 컬러는 **한 벌만** 나가야 한다.
        #
        # Blender 5.2 익스포터는 기본값(`export_all_vertex_colors=True`)에서
        # 색 속성이 하나뿐이어도 COLOR_0과 COLOR_1을 둘 다 내보낸다. 하나는
        # 머티리얼이 참조하는 것으로 간주된 흰색이고, 나머지가 실제 데이터다.
        #
        # 이게 조용히 망가지는 이유: three.js GLTFLoader는 COLOR_0을
        # `geometry.attributes.color`로 매핑하고 셰이더의 `vColor`가 그걸
        # 읽는다. 즉 **마스크가 아니라 흰색이 도착한다.** 지면 블렌드가
        # 전 구간 1.0으로 계산되어 아레나 전체가 이끼로 덮이는데, 텍스처도
        # UV도 정상이라 원인을 찾기까지 오래 걸린다.
        export_all_vertex_colors=False,
        export_vertex_color="ACTIVE",
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="AUTO" if embed_textures else "NONE",
        export_animations=animations,
        export_frame_range=animations,
        export_force_sampling=animations,
        export_bake_animation=animations,
        export_optimize_animation_size=animations,
        export_skins=animations,
        export_morph=animations,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        # meshopt은 draco와 달리 스킨·모프·인스턴싱과 함께 써도 안전하고,
        # three.js가 EXT_meshopt_compression을 디코더 없이도 읽는 경로가 있다.
        # 다만 애니메이션 클립이 붙은 GLB에서는 압축을 끈다 — 키프레임 정밀도가
        # 떨어지면 손목 각도가 눈에 띄게 흔들린다.
        export_draco_mesh_compression_enable=bool(compress) and not animations,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
    )
    bpy.ops.export_scene.gltf(**kwargs)

    triangles = sum(_tri_count(o) for o in alive if o.type == "MESH")
    size_bytes = os.path.getsize(path)
    rel = os.path.relpath(path, os.path.join(PROJECT_ROOT, "public")).replace("\\", "/")
    record = {
        "name": name,
        "path": rel,
        "triangles": triangles,
        "bytes": size_bytes,
        "objects": [o.name for o in alive],
        "animated": bool(animations),
        "notes": notes,
    }
    if extras:
        record["extras"] = extras
    _MANIFEST.assets.append(record)

    print(f"[mw] {name}: {triangles:,} tris, {size_bytes / 1024:.1f} KB -> {rel}")
    if max_triangles is not None and triangles > max_triangles:
        raise SystemExit(
            f"[mw] 예산 초과: {name} {triangles:,} tris > {max_triangles:,}. "
            "decimate()로 줄이거나 디테일을 노멀맵으로 옮겨라."
        )
    return rel


def write_manifest() -> None:
    """이번 실행이 만든 산출물을 전역 매니페스트에 병합한다.

    스크립트마다 따로 돌기 때문에 통째로 덮어쓰면 마지막 하나만 남는다.
    이름을 키로 병합한다.
    """
    _ensure_dirs()
    existing = {"assets": [], "textures": []}
    if os.path.exists(MANIFEST_PATH):
        try:
            with open(MANIFEST_PATH, "r", encoding="utf-8") as handle:
                existing = json.load(handle)
        except Exception:
            pass

    def merge(old: list[dict], new: list[dict]) -> list[dict]:
        table = {row["name"]: row for row in old}
        for row in new:
            table[row["name"]] = row
        return sorted(table.values(), key=lambda r: r["name"])

    merged = {
        "assets": merge(existing.get("assets", []), _MANIFEST.assets),
        "textures": merge(existing.get("textures", []), _MANIFEST.textures),
        "materials": merge(existing.get("materials", []), _MANIFEST.materials),
    }
    with open(MANIFEST_PATH, "w", encoding="utf-8") as handle:
        json.dump(merged, handle, ensure_ascii=False, indent=2)
    print(
        f"[mw] manifest: {len(merged['assets'])} assets, "
        f"{len(merged['textures'])} textures, {len(merged['materials'])} materials"
    )


def finish() -> None:
    """에셋 스크립트 마지막에 한 번 부른다."""
    write_manifest()
