# -*- coding: utf-8 -*-
"""환경 애니메이션 — 1본 스킨 범종 감쇠 진동과 무거운 문짝 개방."""

import json
import math
import os
import struct
import sys

sys.path.append(os.path.join(os.environ["MW_PROJECT_ROOT"], "art-src", "blender", "lib"))

import bpy  # noqa: E402

import mw  # noqa: E402

mw.reset(seed=5000)

TAU = math.tau
FPS = 30


def shared_material(
    name: str,
    roughness: float,
    uv_scale: float,
    *,
    metallic: float = 0.0,
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
            shader="default",
            arc_response=0.55 if metallic else 1.0,
        )
    )


bronze = shared_material("mw/arch/bronze", 0.52, 0.85, metallic=1.0)
timber = shared_material("mw/arch/timber", 0.78, 0.72)
painted = shared_material("mw/arch/painted-wood", 0.72, 0.78)


def one_bone_skin(mesh, armature_name: str, bone_name: str, *, tail):
    armature_data = bpy.data.armatures.new(f"{armature_name}-data")
    armature = bpy.data.objects.new(armature_name, armature_data)
    bpy.context.scene.collection.objects.link(armature)

    mw.activate(armature)
    bpy.ops.object.mode_set(mode="EDIT")
    bone = armature.data.edit_bones.new(bone_name)
    bone.head = (0.0, 0.0, 0.0)
    bone.tail = tail
    bone.use_deform = True
    bpy.ops.object.mode_set(mode="OBJECT")

    group = mesh.vertex_groups.new(name=bone_name)
    group.add(list(range(len(mesh.data.vertices))), 1.0, "REPLACE")
    modifier = mesh.modifiers.new("mw-one-bone-skin", "ARMATURE")
    modifier.object = armature
    mesh.parent = armature
    return armature, armature.pose.bones[bone_name]


def new_action(armature, name: str):
    armature.animation_data_create()
    action = bpy.data.actions.new(name)
    armature.animation_data.action = action
    return action


def build_bell():
    parts = [
        mw.lathe(
            "bell-swing-body",
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
    ]
    for z, radius in ((-0.245, 0.305), (-0.915, 0.397)):
        band = mw.lathe(
            "bell-swing-band",
            [(radius - 0.012, z - 0.022), (radius + 0.012, z), (radius - 0.010, z + 0.022)],
            24,
        )
        parts.append(band)

    # 정적 종과 같은 4×9 유두가 애니메이션 중에도 실루엣을 유지한다.
    for panel_index in range(4):
        angle = TAU * panel_index / 4.0
        normal = (math.cos(angle), math.sin(angle))
        tangent = (-math.sin(angle), math.cos(angle))
        for row in range(3):
            for column in range(3):
                tangential = (column - 1) * 0.073
                z = -0.430 + (row - 1) * 0.072
                bpy.ops.mesh.primitive_ico_sphere_add(
                    subdivisions=1,
                    radius=0.021,
                    location=(
                        normal[0] * 0.346 + tangent[0] * tangential,
                        normal[1] * 0.346 + tangent[1] * tangential,
                        z,
                    ),
                )
                nipple = bpy.context.object
                nipple.name = "bell-swing-nipple"
                nipple.scale = (0.78, 0.78, 0.72)
                mw.apply_transform(nipple)
                parts.append(nipple)

    for sign in (-1.0, 1.0):
        bpy.ops.mesh.primitive_cylinder_add(
            vertices=16,
            radius=0.115,
            depth=0.028,
            location=(0.0, sign * 0.365, -0.690),
            rotation=(math.pi * 0.5, 0.0, 0.0),
        )
        parts.append(bpy.context.object)

    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.105,
        minor_radius=0.032,
        major_segments=16,
        minor_segments=6,
        location=(0.0, 0.0, 0.045),
        rotation=(math.pi * 0.5, 0.0, 0.0),
    )
    parts.append(bpy.context.object)
    sound_tube = mw.prism(
        "bell-swing-sound-tube",
        10,
        0.035,
        0.031,
        0.215,
        location=(0.155, 0.0, -0.065),
        rotation=math.pi / 10.0,
    )
    parts.append(sound_tube)

    mesh = mw.join("bell-swing", parts)
    mw.apply_transform(mesh)
    mw.assign(mesh, bronze)
    mw.shade_auto_smooth(mesh, 34.0)
    mw.uv_cylinder(mesh)
    return mesh


def build_gate():
    parts = []
    # 메시 원점은 왼쪽 경첩축 (x=0, z축). 문짝은 +X로 뻗는다.
    panel = mw.box("gate-swing-panel", (1.30, 0.12, 2.45), location=(0.65, 0.0, 0.0), pivot_bottom=True)
    mw.bevel(panel, 0.015, 2)
    parts.append(panel)
    for z in (0.28, 1.20, 2.12):
        rail = mw.box("gate-swing-rail", (1.24, 0.055, 0.16), location=(0.65, -0.085, z))
        mw.bevel(rail, 0.010, 1)
        parts.append(rail)
    for x in (0.12, 1.18):
        stile = mw.box("gate-swing-stile", (0.13, 0.055, 2.30), location=(x, -0.085, 1.225))
        mw.bevel(stile, 0.010, 1)
        parts.append(stile)
    for z in (0.42, 2.02):
        bpy.ops.mesh.primitive_torus_add(
            major_radius=0.070,
            minor_radius=0.017,
            major_segments=12,
            minor_segments=5,
            location=(0.02, 0.0, z),
            rotation=(math.pi * 0.5, 0.0, 0.0),
        )
        parts.append(bpy.context.object)

    gate = mw.join("gate-swing", parts)
    mw.apply_transform(gate)
    mw.assign_by_index(
        gate,
        (timber, painted),
        lambda _center, normal: 1 if normal.y < -0.55 else 0,
    )
    mw.shade_auto_smooth(gate, 34.0)
    mw.uv_box(gate, 1.0)
    return gate


def verify_animation_glb(asset_name: str, expected_clip: str, expected_duration: float):
    path = os.path.join(mw.ASSET_OUT_DIR, f"{asset_name}.glb")
    with open(path, "rb") as handle:
        blob = handle.read()
    if len(blob) < 20 or blob[:4] != b"glTF":
        raise SystemExit(f"[50_anim_env] {asset_name}: GLB 헤더가 없다")

    offset = 12
    document = None
    while offset + 8 <= len(blob):
        chunk_length, chunk_type = struct.unpack_from("<II", blob, offset)
        offset += 8
        payload = blob[offset : offset + chunk_length]
        offset += chunk_length
        if chunk_type == 0x4E4F534A:
            document = json.loads(payload.rstrip(b" \x00").decode("utf-8"))
            break
    if document is None:
        raise SystemExit(f"[50_anim_env] {asset_name}: JSON 청크가 없다")

    animations = document.get("animations", [])
    names = [animation.get("name", "") for animation in animations]
    if len(animations) != 1 or not any(expected_clip in name for name in names):
        raise SystemExit(f"[50_anim_env] {asset_name}: animations 클립 누락 — {names}")
    if not document.get("skins"):
        raise SystemExit(f"[50_anim_env] {asset_name}: skins 배열 누락")

    durations = []
    for animation in animations:
        for sampler in animation.get("samplers", []):
            accessor = document["accessors"][sampler["input"]]
            if accessor.get("max"):
                durations.append(float(accessor["max"][0]))
    duration = max(durations, default=-1.0)
    if abs(duration - expected_duration) > (1.0 / FPS + 1.0e-4):
        raise SystemExit(
            f"[50_anim_env] {asset_name}: duration {duration:.4f}s != {expected_duration:.4f}s"
        )
    channel_count = sum(len(animation.get("channels", [])) for animation in animations)
    print(
        f"[50_anim_env] verify {asset_name}: animations={names}, "
        f"channels={channel_count}, skins={len(document['skins'])}, duration={duration:.3f}s"
    )


scene = bpy.context.scene
scene.render.fps = FPS
scene.render.fps_base = 1.0

animation_flags = mw._gltf_kwargs(export_animations=True, export_frame_range=True)
missing_flags = {"export_animations", "export_frame_range"} - set(animation_flags)
print(f"[50_anim_env] glTF animation kwargs accepted: {sorted(animation_flags)}")
if missing_flags:
    raise SystemExit(f"[50_anim_env] glTF 익스포터 애니메이션 인자 누락: {sorted(missing_flags)}")


# ---------------------------------------------------------------------------
# 범종: 2.4초, 30fps, 비루프. 12° 진폭이 0.5°까지 지수 감쇠한다.
# ---------------------------------------------------------------------------

bell_mesh = build_bell()
bell_armature, bell_bone = one_bone_skin(
    bell_mesh,
    "bell-swing-armature",
    "bell-suspension",
    tail=(0.0, 0.0, 0.28),
)
bell_action = new_action(bell_armature, "bell-swing")
bell_bone.rotation_mode = "XYZ"

bell_start = 0
bell_end = bell_start + round(2.4 * FPS)
decay = math.log(12.0 / 0.5) / 2.4
for frame in range(bell_start, bell_end + 1):
    t = (frame - bell_start) / FPS
    amplitude = math.radians(12.0) * math.exp(-decay * t)
    phase = TAU * t / 0.62
    bell_bone.rotation_euler = (
        amplitude * math.cos(phase),
        amplitude * 0.045 * math.sin(phase * 0.52 + 0.35),
        amplitude * 0.075 * math.sin(phase + 0.72),
    )
    bell_bone.keyframe_insert(data_path="rotation_euler", frame=frame, group="bell-suspension")

scene.frame_start = bell_start
scene.frame_end = bell_end
scene.frame_set(bell_start)
mw.export_glb(
    "bell-swing",
    [bell_mesh, bell_armature],
    animations=True,
    max_triangles=4_000,
    notes="one-bone skinned bell; non-looping 2.4s exponential damped oscillation, 0.62s period, 12deg to 0.5deg with subtle secondary twist",
)
verify_animation_glb("bell-swing", "bell-swing", 2.4)
# Blender 5.2의 ACTIONS 모드는 선택되지 않은 아마추어의 전역 액션도 다음
# 내보내기의 후보로 본다. 첫 GLB를 쓴 뒤 제거해 문 GLB에 종 클립이 섞이지 않게 한다.
bell_armature.animation_data.action = None
bpy.data.actions.remove(bell_action)


# ---------------------------------------------------------------------------
# 문짝: 1.6초. 천천히 관성을 얻고 86°까지 지나친 뒤 82°로 반동한다.
# ---------------------------------------------------------------------------

gate_mesh = build_gate()
gate_armature, gate_bone = one_bone_skin(
    gate_mesh,
    "gate-swing-armature",
    "gate-hinge",
    tail=(0.0, 0.0, 2.45),
)
new_action(gate_armature, "gate-swing")
gate_bone.rotation_mode = "XYZ"

gate_start = 0
gate_keys = (
    (gate_start, 0.0),
    (gate_start + 7, 2.0),
    (gate_start + 17, 19.0),
    (gate_start + 29, 57.0),
    (gate_start + 41, 86.0),
    (gate_start + 48, 82.0),
)
for frame, angle_deg in gate_keys:
    gate_bone.rotation_euler = (0.0, 0.0, math.radians(-angle_deg))
    gate_bone.keyframe_insert(data_path="rotation_euler", frame=frame, group="gate-hinge")

scene.frame_start = gate_start
scene.frame_end = gate_start + 48
scene.frame_set(gate_start)
mw.export_glb(
    "gate-swing",
    [gate_mesh, gate_armature],
    animations=True,
    max_triangles=1_200,
    notes="one-bone skinned 1.6s gate; heavy delayed start, 86deg overshoot and 82deg settling rebound",
)
verify_animation_glb("gate-swing", "gate-swing", 1.6)

mw.finish()
print("[50_anim_env] bell-swing + gate-swing animation GLB verification OK")
