# -*- coding: utf-8 -*-
"""연속 킬 초승 문양 — 단일 스킨 메시와 4본 비루프 crescendo."""

import json
import math
import os
import struct
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402
from mathutils import Matrix  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=5200)

FPS = 30
DURATION = 1.1
END_FRAME = round(DURATION * FPS)
BONES = ("crescent", "ring-inner", "ring-outer", "shards")


def radial_band(
    name: str,
    *,
    segments: int,
    outer_radius,
    inner_radius,
    depth: float,
    start: float = 0.0,
    end: float = math.tau,
    closed: bool,
):
    """X/Z 평면의 얕은 입체 밴드. +Y가 문양의 정면이다."""

    sample_count = segments if closed else segments + 1
    verts = []
    for index in range(sample_count):
        t = index / segments
        angle = start + (end - start) * t
        outer = float(outer_radius(t))
        inner = float(inner_radius(t))
        cos_a = math.cos(angle)
        sin_a = math.sin(angle)
        half = depth * 0.5
        verts.extend(
            (
                (cos_a * outer, -half, sin_a * outer),
                (cos_a * inner, -half, sin_a * inner),
                (cos_a * outer, half, sin_a * outer),
                (cos_a * inner, half, sin_a * inner),
            )
        )

    faces = []
    interval_count = segments
    for index in range(interval_count):
        nxt = (index + 1) % sample_count
        a = index * 4
        b = nxt * 4
        faces.extend(
            (
                (a + 2, b + 2, b + 3, a + 3),  # front
                (a, a + 1, b + 1, b),  # back
                (a, b, b + 2, a + 2),  # outer edge
                (a + 1, a + 3, b + 3, b + 1),  # inner edge
            )
        )

    if not closed:
        last = segments * 4
        faces.extend(
            (
                (0, 2, 3, 1),
                (last, last + 1, last + 3, last + 2),
            )
        )

    return mw.new_mesh(name, verts, faces)


def shard_field(name: str, count: int = 14):
    """길이가 어긋난 방사 파편을 하나의 연결되지 않은 메시로 만든다."""

    verts = []
    faces = []
    for index in range(count):
        # 규칙적인 태양 문양보다 전투의 파열처럼 읽히도록 길이와 위상을 어긋낸다.
        angle = (
            math.tau * index / count
            + math.sin(index * 2.173) * 0.052
            + (0.035 if index % 3 == 0 else -0.012)
        )
        inner = 1.145 + (index % 3) * 0.018
        outer = inner + 0.17 + ((index * 7) % 5) * 0.023
        inner_half = 0.037 + (index % 2) * 0.008
        outer_half = 0.012 + (index % 4) * 0.004
        half_depth = 0.022

        footprint = (
            (
                math.cos(angle - inner_half) * inner,
                math.sin(angle - inner_half) * inner,
            ),
            (
                math.cos(angle + inner_half) * inner,
                math.sin(angle + inner_half) * inner,
            ),
            (
                math.cos(angle + outer_half) * outer,
                math.sin(angle + outer_half) * outer,
            ),
            (
                math.cos(angle - outer_half) * outer,
                math.sin(angle - outer_half) * outer,
            ),
        )
        base = len(verts)
        for y in (-half_depth, half_depth):
            verts.extend((x, y, z) for x, z in footprint)
        faces.extend(
            (
                (base, base + 3, base + 2, base + 1),
                (base + 4, base + 5, base + 6, base + 7),
                (base, base + 4, base + 7, base + 3),
                (base + 1, base + 2, base + 6, base + 5),
                (base, base + 1, base + 5, base + 4),
                (base + 3, base + 7, base + 6, base + 2),
            )
        )
    return mw.new_mesh(name, verts, faces)


def bind_part(part, bone_name: str) -> None:
    group = part.vertex_groups.new(name=bone_name)
    group.add(list(range(len(part.data.vertices))), 1.0, "REPLACE")


def build_emblem():
    # 오른쪽이 열린 초승. 가운데가 두껍고 끝으로 갈수록 날카롭게 닫힌다.
    crescent = radial_band(
        "crescent",
        segments=30,
        outer_radius=lambda _t: 0.68,
        inner_radius=lambda t: 0.68 - (0.052 + 0.305 * math.sin(math.pi * t) ** 0.72),
        depth=0.085,
        start=math.radians(42.0),
        end=math.radians(318.0),
        closed=False,
    )
    inner_ring = radial_band(
        "ring-inner",
        segments=32,
        outer_radius=lambda _t: 0.855,
        inner_radius=lambda _t: 0.812,
        depth=0.058,
        closed=True,
    )
    outer_ring = radial_band(
        "ring-outer",
        segments=36,
        outer_radius=lambda _t: 1.055,
        inner_radius=lambda _t: 1.024,
        depth=0.047,
        closed=True,
    )
    shards = shard_field("shards")

    parts = (
        (crescent, "crescent"),
        (inner_ring, "ring-inner"),
        (outer_ring, "ring-outer"),
        (shards, "shards"),
    )
    for part, bone_name in parts:
        bind_part(part, bone_name)
        # 한 세그먼트 베벨은 삼각형 예산을 지키면서 금속 테두리 하이라이트를 만든다.
        mw.bevel(part, 0.008, 1, angle_deg=34.0)

    mesh = mw.join("moonflow-crescendo", [part for part, _bone in parts])
    mw.assign(
        mesh,
        mw.material(
            mw.MaterialSpec(
                name="mw/fx/moonflow-crescendo",
                base_color=(0.055, 0.17, 0.22, 1.0),
                roughness=0.25,
                metallic=0.84,
                emission=(0.28, 0.88, 1.0),
                emission_strength=3.2,
                shader="emissive",
                arc_response=0.18,
            )
        ),
    )
    mw.shade_auto_smooth(mesh, 38.0)
    mw.uv_box(mesh, 0.8)
    return mesh


def create_armature(mesh):
    armature_data = bpy.data.armatures.new("moonflow-crescendo-armature-data")
    armature = bpy.data.objects.new("moonflow-crescendo-armature", armature_data)
    bpy.context.scene.collection.objects.link(armature)

    mw.activate(armature)
    bpy.ops.object.mode_set(mode="EDIT")
    for index, bone_name in enumerate(BONES):
        bone = armature.data.edit_bones.new(bone_name)
        bone.head = (0.0, 0.0, 0.0)
        # 같은 회전 중심을 공유하되 길이를 달리해 Blender가 본을 구별하기 쉽다.
        bone.tail = (0.0, 0.0, 0.20 + index * 0.035)
        bone.use_deform = True
    bpy.ops.object.mode_set(mode="OBJECT")

    modifier = mesh.modifiers.new("moonflow-crescendo-skin", "ARMATURE")
    modifier.object = armature
    mesh.parent = armature
    return armature


def set_world_y_rotation(armature, bone_name: str, angle: float) -> None:
    """문양 정면축(+Y) 기준 회전을 pose-bone basis로 바꾼다."""

    rest = armature.data.bones[bone_name].matrix_local.to_3x3()
    world_delta = Matrix.Rotation(angle, 3, "Y")
    basis = rest.transposed() @ world_delta @ rest
    pose_bone = armature.pose.bones[bone_name]
    pose_bone.rotation_mode = "QUATERNION"
    pose_bone.rotation_quaternion = basis.to_quaternion().normalized()


def key_pose(armature, frame: int, values) -> None:
    for bone_name, scale, angle_deg in values:
        pose_bone = armature.pose.bones[bone_name]
        pose_bone.scale = (scale, scale, scale)
        set_world_y_rotation(armature, bone_name, math.radians(angle_deg))
        pose_bone.keyframe_insert(data_path="scale", frame=frame, group=bone_name)
        pose_bone.keyframe_insert(
            data_path="rotation_quaternion", frame=frame, group=bone_name
        )


def author_animation(armature) -> None:
    armature.animation_data_create()
    action = bpy.data.actions.new("moonflow-crescendo")
    armature.animation_data.action = action

    # 작은 씨앗에서 급팽창하고, 두 링과 파편이 서로 반대로 튄 뒤 1.1초에 정착한다.
    key_pose(
        armature,
        0,
        (
            ("crescent", 0.10, -8.0),
            ("ring-inner", 0.04, 20.0),
            ("ring-outer", 0.025, -26.0),
            ("shards", 0.01, 35.0),
        ),
    )
    key_pose(
        armature,
        3,
        (
            ("crescent", 1.22, 10.0),
            ("ring-inner", 1.10, -28.0),
            ("ring-outer", 1.26, 33.0),
            ("shards", 1.38, -42.0),
        ),
    )
    key_pose(
        armature,
        8,
        (
            ("crescent", 0.92, -5.0),
            ("ring-inner", 1.04, 16.0),
            ("ring-outer", 0.96, -18.0),
            ("shards", 1.08, 24.0),
        ),
    )
    key_pose(
        armature,
        14,
        (
            ("crescent", 1.05, 2.0),
            ("ring-inner", 0.98, -6.0),
            ("ring-outer", 1.05, 8.0),
            ("shards", 0.97, -10.0),
        ),
    )
    key_pose(
        armature,
        22,
        (
            ("crescent", 0.995, -0.7),
            ("ring-inner", 1.01, 2.0),
            ("ring-outer", 0.99, -2.0),
            ("shards", 1.015, 3.0),
        ),
    )
    key_pose(
        armature,
        END_FRAME,
        tuple((bone_name, 1.0, 0.0) for bone_name in BONES),
    )

    # Blender 5.2의 slotted Action은 fcurves를 직접 노출하지 않는다. 키는
    # 정상적으로 생성·내보내지므로, 구형 API에서만 핸들을 다듬는다.
    if hasattr(action, "fcurves"):
        for fcurve in action.fcurves:
            for point in fcurve.keyframe_points:
                point.interpolation = "BEZIER"
                point.handle_left_type = "AUTO_CLAMPED"
                point.handle_right_type = "AUTO_CLAMPED"


def verify_mesh_contract(mesh) -> None:
    triangles = sum(max(0, len(polygon.vertices) - 2) for polygon in mesh.data.polygons)
    if triangles < 600 or triangles > 2500:
        raise SystemExit(
            f"[52_anim_crescendo] triangle contract failed: {triangles} not in 600..2500"
        )
    if len(mesh.data.materials) != 1:
        raise SystemExit(
            f"[52_anim_crescendo] expected one material, found {len(mesh.data.materials)}"
        )
    if set(group.name for group in mesh.vertex_groups) != set(BONES):
        raise SystemExit(
            f"[52_anim_crescendo] vertex groups differ: "
            f"{[group.name for group in mesh.vertex_groups]}"
        )
    for vertex in mesh.data.vertices:
        weighted = [entry for entry in vertex.groups if entry.weight > 0.999]
        if len(weighted) != 1:
            raise SystemExit(
                f"[52_anim_crescendo] vertex {vertex.index} has {len(weighted)} full weights"
            )
    print(
        f"[52_anim_crescendo] mesh contract: {triangles} tris, "
        f"{len(mesh.data.vertices)} vertices, 1 material, 4 exclusive groups"
    )


def read_glb_json(path: str):
    with open(path, "rb") as handle:
        blob = handle.read()
    if len(blob) < 20 or blob[:4] != b"glTF":
        raise SystemExit("[52_anim_crescendo] GLB header missing")

    offset = 12
    while offset + 8 <= len(blob):
        chunk_length, chunk_type = struct.unpack_from("<II", blob, offset)
        offset += 8
        payload = blob[offset : offset + chunk_length]
        offset += chunk_length
        if chunk_type == 0x4E4F534A:
            return blob, json.loads(payload.rstrip(b" \x00").decode("utf-8"))
    raise SystemExit("[52_anim_crescendo] GLB JSON chunk missing")


def verify_animation_glb():
    path = os.path.join(mw.ASSET_OUT_DIR, "moonflow-crescendo.glb")
    blob, document = read_glb_json(path)
    animations = document.get("animations", [])
    skins = document.get("skins", [])
    meshes = document.get("meshes", [])
    materials = document.get("materials", [])
    if len(animations) != 1 or animations[0].get("name") != "moonflow-crescendo":
        raise SystemExit(
            f"[52_anim_crescendo] animation contract failed: "
            f"{[animation.get('name') for animation in animations]}"
        )
    if len(skins) != 1 or len(skins[0].get("joints", [])) != len(BONES):
        raise SystemExit(
            f"[52_anim_crescendo] skin contract failed: "
            f"skins={len(skins)}, joints={len(skins[0].get('joints', [])) if skins else 0}"
        )
    primitive_count = sum(len(mesh.get("primitives", [])) for mesh in meshes)
    if len(meshes) != 1 or primitive_count != 1 or len(materials) != 1:
        raise SystemExit(
            f"[52_anim_crescendo] draw contract failed: "
            f"meshes={len(meshes)}, primitives={primitive_count}, materials={len(materials)}"
        )

    node_names = {
        index: node.get("name", "") for index, node in enumerate(document.get("nodes", []))
    }
    targeted = {
        node_names.get(channel.get("target", {}).get("node"), "")
        for channel in animations[0].get("channels", [])
    }
    if not set(BONES).issubset(targeted):
        raise SystemExit(
            f"[52_anim_crescendo] animated bones missing: {sorted(set(BONES) - targeted)}"
        )

    durations = []
    for sampler in animations[0].get("samplers", []):
        accessor = document["accessors"][sampler["input"]]
        if accessor.get("max"):
            durations.append(float(accessor["max"][0]))
    duration = max(durations, default=-1.0)
    if abs(duration - DURATION) > (1.0 / FPS + 1.0e-4):
        raise SystemExit(
            f"[52_anim_crescendo] duration {duration:.4f}s != {DURATION:.4f}s"
        )

    primitive = meshes[0]["primitives"][0]
    triangle_count = document["accessors"][primitive["indices"]]["count"] // 3
    if triangle_count < 600 or triangle_count > 2500:
        raise SystemExit(
            f"[52_anim_crescendo] GLB triangles {triangle_count} not in 600..2500"
        )

    pbr = materials[0].get("pbrMetallicRoughness", {})
    emission = materials[0].get("emissiveFactor", [0.0, 0.0, 0.0])
    if float(pbr.get("metallicFactor", 0.0)) < 0.5 or max(emission) <= 0.0:
        raise SystemExit(
            f"[52_anim_crescendo] material is not metallic+emissive: "
            f"metal={pbr.get('metallicFactor')}, emissive={emission}"
        )

    print(
        f"[52_anim_crescendo] GLB verify: {triangle_count} tris, "
        f"{len(blob)} bytes, 1 mesh/primitive/material, 4-bone skin, "
        f"{len(animations[0]['channels'])} channels, {duration:.3f}s"
    )


scene = bpy.context.scene
scene.render.fps = FPS
scene.render.fps_base = 1.0
scene.frame_start = 0
scene.frame_end = END_FRAME

emblem = build_emblem()
verify_mesh_contract(emblem)
armature = create_armature(emblem)
author_animation(armature)
scene.frame_set(0)

mw.export_glb(
    "moonflow-crescendo",
    [emblem, armature],
    animations=True,
    max_triangles=2500,
    notes=(
        "single-draw metallic emissive kill-crescendo emblem; beveled crescent, "
        "two concentric rings and 14 radial shards; 4-bone 1.1s non-loop "
        "rapid expansion, counter-rotation and settle"
    ),
    extras={
        "clip": "moonflow-crescendo",
        "duration": DURATION,
        "loop": False,
        "bones": list(BONES),
        "role": "kill-crescendo",
    },
)
verify_animation_glb()
mw.finish()
print("[52_anim_crescendo] moonflow-crescendo export + verification OK")
