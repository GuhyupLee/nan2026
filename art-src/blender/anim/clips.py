"""Author and bake the 18 Myeongwol combat clips with the Blender IK rig."""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, Sequence, Tuple

import bpy
from mathutils import Euler, Quaternion, Vector


PROJECT_ROOT = Path(
    os.environ.get("MW_PROJECT_ROOT", Path(__file__).resolve().parents[3])
).resolve()
ANIM_DIR = PROJECT_ROOT / "art-src" / "blender" / "anim"
OUT_DIR = ANIM_DIR / "out"
sys.path.insert(0, str(ANIM_DIR))

import rig  # noqa: E402


STAGES = ("start", "anticipation", "contact", "followThrough", "recovery")
ACTION_NAMES = ("attack", "empowered", "ult", "q", "w", "e", "r")
FK_BONES = (
    "hips",
    "spine",
    "chest",
    "neck",
    "head",
    "leftShoulder",
    "leftLowerArm",
    "leftHand",
    "rightShoulder",
    "rightLowerArm",
    "rightHand",
    "leftLowerLeg",
    "leftFoot",
    "rightLowerLeg",
    "rightFoot",
)

HAND_BASE: Mapping[str, Tuple[Tuple[float, float, float], Tuple[float, float, float]]] = {
    "ranged": ((0.22, 1.13, -0.19), (-0.22, 1.15, -0.17)),
    "melee": ((0.19, 1.10, -0.13), (-0.26, 1.13, -0.08)),
}

# Absolute VRM-space hand targets.  Each move preserves the old intent while
# replacing hand-tuned shoulder/elbow triples with spatial IK goals.
HAND_TARGETS: Mapping[
    str,
    Mapping[str, Tuple[Tuple[float, float, float], Tuple[float, float, float]]],
] = {
    "ranged.attack": {
        "anticipation": ((0.20, 1.14, -0.15), (-0.18, 1.17, 0.13)),
        "contact": ((0.22, 1.16, -0.17), (-0.12, 1.25, -0.39)),
        "followThrough": ((0.20, 1.14, -0.14), (-0.15, 1.22, -0.43)),
    },
    "ranged.empowered": {
        "anticipation": ((0.12, 1.13, 0.04), (-0.12, 1.13, 0.04)),
        "contact": ((0.15, 1.20, -0.36), (-0.15, 1.20, -0.36)),
        "followThrough": ((0.22, 1.22, -0.40), (-0.22, 1.22, -0.40)),
    },
    "ranged.ult": {
        "anticipation": ((0.13, 1.18, 0.02), (-0.13, 1.18, 0.02)),
        "contact": ((0.12, 1.39, -0.28), (-0.12, 1.39, -0.28)),
        "followThrough": ((0.19, 1.45, -0.25), (-0.19, 1.45, -0.25)),
    },
    "ranged.q": {
        "anticipation": ((0.12, 1.48, -0.01), (-0.12, 1.48, -0.01)),
        "contact": ((0.37, 1.31, -0.24), (-0.37, 1.31, -0.24)),
        "followThrough": ((0.41, 1.25, -0.27), (-0.31, 1.28, -0.30)),
    },
    "ranged.w": {
        "anticipation": ((0.28, 1.05, 0.05), (-0.29, 1.06, 0.06)),
        "contact": ((0.20, 1.20, -0.32), (-0.22, 1.21, -0.30)),
        "followThrough": ((0.31, 1.14, -0.21), (-0.28, 1.16, -0.18)),
    },
    "ranged.e": {
        "anticipation": ((0.19, 1.10, -0.12), (-0.13, 1.47, 0.01)),
        "contact": ((0.24, 1.16, -0.18), (-0.11, 1.39, -0.34)),
        "followThrough": ((0.20, 1.12, -0.14), (-0.18, 1.08, -0.34)),
    },
    "ranged.r": {
        "anticipation": ((0.10, 1.13, 0.02), (-0.10, 1.13, 0.02)),
        "contact": ((0.10, 1.24, -0.40), (-0.10, 1.24, -0.40)),
        "followThrough": ((0.17, 1.20, -0.43), (-0.17, 1.20, -0.43)),
    },
    "melee.attack": {
        "anticipation": ((0.18, 1.10, -0.08), (-0.28, 1.12, 0.16)),
        "contact": ((0.21, 1.17, -0.20), (-0.10, 1.22, -0.39)),
        "followThrough": ((0.12, 1.02, -0.24), (0.17, 1.06, -0.31)),
    },
    "melee.empowered": {
        "anticipation": ((0.22, 1.16, 0.10), (-0.17, 1.19, 0.15)),
        "contact": ((0.18, 1.15, -0.31), (0.16, 1.18, -0.34)),
        "followThrough": ((-0.18, 1.06, -0.27), (-0.32, 1.10, -0.22)),
    },
    "melee.ult": {
        "anticipation": ((0.20, 1.06, -0.07), (-0.24, 1.02, -0.05)),
        "contact": ((0.08, 1.36, -0.29), (-0.07, 1.43, -0.25)),
        "followThrough": ((0.19, 1.48, -0.17), (-0.10, 1.49, -0.14)),
    },
    "melee.q": {
        "anticipation": ((0.22, 0.99, 0.05), (-0.22, 1.01, 0.10)),
        "contact": ((0.14, 1.31, -0.32), (-0.09, 1.39, -0.27)),
        "followThrough": ((-0.04, 1.43, -0.20), (-0.23, 1.39, -0.17)),
    },
    "melee.w": {
        "anticipation": ((0.24, 0.98, 0.08), (-0.30, 0.96, 0.10)),
        "contact": ((0.12, 1.12, -0.36), (-0.10, 1.13, -0.38)),
        "followThrough": ((-0.25, 1.00, -0.24), (-0.34, 1.02, -0.20)),
    },
    "melee.e": {
        "anticipation": ((-0.18, 1.14, 0.04), (-0.31, 1.16, 0.08)),
        "contact": ((0.31, 1.16, -0.22), (0.20, 1.19, -0.30)),
        "followThrough": ((0.13, 1.05, 0.02), (-0.12, 1.08, 0.07)),
    },
    "melee.r": {
        "anticipation": ((0.11, 1.48, 0.01), (-0.11, 1.48, 0.01)),
        "contact": ((0.08, 1.10, -0.34), (-0.08, 1.10, -0.34)),
        "followThrough": ((0.15, 0.96, -0.28), (-0.15, 0.96, -0.28)),
    },
}


def load_contract() -> dict:
    node = shutil.which("node")
    tsx_cli = PROJECT_ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
    exporter = PROJECT_ROOT / "tools" / "export-animation-contract.ts"
    if not node or not tsx_cli.exists():
        raise RuntimeError("Node/tsx is required to read animation-data.ts")
    completed = subprocess.run(
        [node, str(tsx_cli), str(exporter)],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return json.loads(completed.stdout)


def clean_number(value: float) -> float:
    rounded = round(float(value), 8)
    return 0.0 if abs(rounded) < 5e-9 else rounded


def vrm_position(value: Iterable[float]) -> Vector:
    return rig.vrm_point_to_blender(tuple(float(part) for part in value))


def clear_animation(armature: bpy.types.Object, controls: Mapping[str, bpy.types.Object]) -> None:
    armature.animation_data_clear()
    for control in controls.values():
        control.animation_data_clear()
    for pose_bone in armature.pose.bones:
        pose_bone.location = Vector((0.0, 0.0, 0.0))
        pose_bone.rotation_mode = "QUATERNION"
        pose_bone.rotation_quaternion = Quaternion((1.0, 0.0, 0.0, 0.0))
    # A perfectly straight T-pose is an IK singularity. These tiny, unbaked
    # solver seeds pick the elbow side; the evaluated IK result supplies the
    # actual bend and the authored pole controls keep it stable.
    rig.set_vrm_local_rotation(
        armature, "leftLowerArm", Euler((0.0, 0.0, -0.08), "XYZ").to_quaternion()
    )
    rig.set_vrm_local_rotation(
        armature, "rightLowerArm", Euler((0.0, 0.0, 0.08), "XYZ").to_quaternion()
    )
    for name, control in controls.items():
        control.rotation_mode = "QUATERNION"
        control.rotation_quaternion = Quaternion((1.0, 0.0, 0.0, 0.0))
        if name.startswith("ik.hand"):
            bone = "leftHand" if name.endswith(".L") else "rightHand"
            control.location = vrm_position(rig.VRM_JOINTS[bone])
        elif name.startswith("ik.foot"):
            bone = "leftFoot" if name.endswith(".L") else "rightFoot"
            control.location = vrm_position(rig.VRM_JOINTS[bone])
    bpy.context.scene.frame_set(0)
    bpy.context.view_layer.update()


def set_hips_height(armature: bpy.types.Object, hips_y: float) -> None:
    delta_armature = Vector((0.0, 0.0, (hips_y - 1.0) * rig.HIPS_REST_HEIGHT))
    rest_rotation = armature.data.bones["hips"].matrix_local.to_3x3()
    armature.pose.bones["hips"].location = rest_rotation.transposed() @ delta_armature


def key_bone_rotation(
    armature: bpy.types.Object,
    bone_name: str,
    euler_xyz: Sequence[float],
    time: float,
) -> None:
    quaternion = Euler(tuple(float(value) for value in euler_xyz), "XYZ").to_quaternion()
    rig.set_vrm_local_rotation(armature, bone_name, quaternion)
    armature.pose.bones[bone_name].keyframe_insert(
        data_path="rotation_quaternion", frame=time * rig.FPS, group=bone_name
    )


def key_hips_height(armature: bpy.types.Object, hips_y: float, time: float) -> None:
    set_hips_height(armature, hips_y)
    armature.pose.bones["hips"].keyframe_insert(
        data_path="location", frame=time * rig.FPS, group="hips"
    )


def key_control_location(
    control: bpy.types.Object,
    value_vrm: Sequence[float],
    time: float,
) -> None:
    control.location = vrm_position(value_vrm)
    control.keyframe_insert(data_path="location", frame=time * rig.FPS)


def key_control_blender(
    control: bpy.types.Object,
    value: Vector,
    time: float,
) -> None:
    control.location = value
    control.keyframe_insert(data_path="location", frame=time * rig.FPS)


def add_euler(
    base: Sequence[float],
    offset: Sequence[float],
) -> Tuple[float, float, float]:
    return tuple(float(base[index]) + float(offset[index]) for index in range(3))


def set_bezier(actions: Iterable[bpy.types.Action]) -> None:
    for action in actions:
        if not hasattr(action, "fcurves"):
            continue
        for fcurve in action.fcurves:
            for point in fcurve.keyframe_points:
                point.interpolation = "BEZIER"
                point.handle_left_type = "AUTO_CLAMPED"
                point.handle_right_type = "AUTO_CLAMPED"


def collect_actions(
    armature: bpy.types.Object, controls: Mapping[str, bpy.types.Object], clip_name: str
) -> List[bpy.types.Action]:
    actions: List[bpy.types.Action] = []
    objects = [armature, *controls.values()]
    for obj in objects:
        if obj.animation_data and obj.animation_data.action:
            obj.animation_data.action.name = f"{clip_name}:{obj.name}"
            actions.append(obj.animation_data.action)
    return actions


def key_action_feet_and_poles(
    controls: Mapping[str, bpy.types.Object],
    key: Mapping,
    time: float,
    stage_index: int,
) -> None:
    hips_yaw = float(key["rotations"]["hips"][1])
    direction = -1.0 if hips_yaw < 0.0 else 1.0
    strength = min(0.16, abs(hips_yaw) * 0.11)
    stage_scale = (0.0, -0.45, 1.0, 0.72, 0.0)[stage_index]

    left = list(rig.VRM_JOINTS["leftFoot"])
    right = list(rig.VRM_JOINTS["rightFoot"])
    left[0] += strength * 0.28 * stage_scale
    right[0] -= strength * 0.22 * stage_scale
    left[2] += direction * strength * stage_scale
    right[2] -= direction * strength * 0.62 * stage_scale
    key_control_location(controls["ik.foot.L"], left, time)
    key_control_location(controls["ik.foot.R"], right, time)

    for side, sign in (("L", 1.0), ("R", -1.0)):
        pole = Vector(
            (
                sign * 0.0772 + direction * strength * 0.42 * stage_scale,
                0.48 + strength * stage_scale,
                0.55 - abs(float(key["hipsY"]) - 1.0) * 0.2,
            )
        )
        key_control_blender(controls[f"pole.knee.{side}"], pole, time)


def author_action(
    clip_name: str,
    cls: str,
    motion: Mapping,
    armature: bpy.types.Object,
    controls: Mapping[str, bpy.types.Object],
) -> Tuple[float, List[Mapping]]:
    clear_animation(armature, controls)
    hand_targets = HAND_TARGETS[clip_name]
    base_left, base_right = HAND_BASE[cls]
    keys: List[Mapping] = list(motion["keys"])

    for stage_index, key in enumerate(keys):
        stage = str(key["stage"])
        time = float(key["time"])
        next_time = (
            float(keys[stage_index + 1]["time"]) if stage_index + 1 < len(keys) else time
        )

        key_hips_height(armature, float(key["hipsY"]), time)
        for bone_name in FK_BONES:
            # Pelvis leads, then spine/chest/shoulders/head arrive one or two
            # frames later. Recovery is pinned to the gameplay duration.
            if stage in ("start", "recovery"):
                delay = 0.0
            elif bone_name == "hips":
                delay = 0.0
            elif bone_name == "spine":
                delay = 1.0 / rig.FPS
            elif bone_name in ("chest", "neck"):
                delay = 2.0 / rig.FPS
            elif bone_name in ("leftShoulder", "rightShoulder", "head"):
                delay = 2.0 / rig.FPS
            else:
                delay = 0.0
            authored_time = min(time + delay, max(time, next_time - 0.001))
            key_bone_rotation(
                armature,
                bone_name,
                key["rotations"][bone_name],
                authored_time,
            )

        if stage == "start" or stage == "recovery":
            left_target, right_target = base_left, base_right
        else:
            left_target, right_target = hand_targets[stage]
        key_control_location(controls["ik.hand.L"], left_target, time)
        key_control_location(controls["ik.hand.R"], right_target, time)

        # Pole motion prevents planar-looking elbows and preserves a clean
        # weapon/palm silhouette through large target arcs.
        for side, target in (("L", left_target), ("R", right_target)):
            sign = 1.0 if side == "L" else -1.0
            pole_vrm = (
                sign * (0.33 + 0.06 * stage_index),
                max(0.88, float(target[1]) - 0.16),
                0.18 + 0.04 * math.sin(stage_index * 1.7),
            )
            key_control_location(controls[f"pole.elbow.{side}"], pole_vrm, time)

        key_action_feet_and_poles(controls, key, time, stage_index)

    set_bezier(collect_actions(armature, controls, clip_name))
    return float(motion["duration"]), list(motion["phases"])


def author_idle(
    clip_name: str,
    cls: str,
    stance: Mapping[str, Sequence[float]],
    armature: bpy.types.Object,
    controls: Mapping[str, bpy.types.Object],
) -> Tuple[float, None]:
    clear_animation(armature, controls)
    duration = 2.4
    base_left, base_right = HAND_BASE[cls]
    samples = (
        (0.0, 0.0, 0.0),
        (0.25, 1.0, 0.65),
        (0.5, 0.0, 0.0),
        (0.75, -1.0, -0.65),
        (1.0, 0.0, 0.0),
    )
    for fraction, sway, breath in samples:
        time = duration * fraction
        key_hips_height(armature, 1.0 + breath * 0.006, time)
        offsets = {
            "hips": (breath * 0.008, sway * 0.026, sway * 0.014),
            "spine": (-breath * 0.012, -sway * 0.021, -sway * 0.011),
            "chest": (breath * 0.018, -sway * 0.013, sway * 0.009),
            "neck": (-breath * 0.007, sway * 0.010, -sway * 0.005),
            "head": (-breath * 0.010, sway * 0.018, -sway * 0.007),
            "leftShoulder": (breath * 0.010, -sway * 0.009, sway * 0.007),
            "leftHand": (-breath * 0.008, sway * 0.009, sway * 0.007),
            "rightShoulder": (breath * 0.009, sway * 0.008, -sway * 0.006),
            "rightHand": (breath * 0.007, -sway * 0.008, -sway * 0.006),
            "leftFoot": (-sway * 0.008, sway * 0.006, -sway * 0.005),
            "rightFoot": (sway * 0.008, -sway * 0.006, sway * 0.005),
        }
        for bone_name in FK_BONES:
            key_bone_rotation(
                armature,
                bone_name,
                add_euler(stance[bone_name], offsets.get(bone_name, (0.0, 0.0, 0.0))),
                time,
            )
        key_control_location(
            controls["ik.hand.L"],
            (base_left[0], base_left[1] + breath * 0.008, base_left[2] + sway * 0.012),
            time,
        )
        key_control_location(
            controls["ik.hand.R"],
            (
                base_right[0],
                base_right[1] + breath * 0.008,
                base_right[2] - sway * 0.012,
            ),
            time,
        )
        key_control_location(controls["ik.foot.L"], rig.VRM_JOINTS["leftFoot"], time)
        key_control_location(controls["ik.foot.R"], rig.VRM_JOINTS["rightFoot"], time)

    set_bezier(collect_actions(armature, controls, clip_name))
    return duration, None


def author_walk(
    clip_name: str,
    cls: str,
    stance: Mapping[str, Sequence[float]],
    armature: bpy.types.Object,
    controls: Mapping[str, bpy.types.Object],
) -> Tuple[float, None]:
    clear_animation(armature, controls)
    duration = 0.68 if cls == "melee" else 0.72
    base_left, base_right = HAND_BASE[cls]
    fractions = (0.0, 0.20, 0.45, 0.55, 0.75, 1.0)

    for fraction in fractions:
        time = duration * fraction
        phase = fraction * math.tau
        stride = math.sin(phase)
        side = math.cos(phase)
        bounce = math.cos(phase * 2.0)
        key_hips_height(armature, 1.0 + bounce * 0.018, time)
        offsets = {
            "hips": (-stride * 0.045, stride * 0.15, side * 0.035),
            "spine": (0.055 + stride * 0.02, -stride * 0.12, -side * 0.028),
            "chest": (-0.025 - stride * 0.014, -stride * 0.075, side * 0.022),
            "neck": (-stride * 0.012, stride * 0.026, -side * 0.012),
            "head": (-0.02 - bounce * 0.008, stride * 0.045, -side * 0.018),
            "leftShoulder": (-stride * 0.035, stride * 0.025, side * 0.018),
            "leftHand": (stride * 0.06, stride * 0.04, side * 0.035),
            "rightShoulder": (stride * 0.032, -stride * 0.023, -side * 0.017),
            "rightHand": (-stride * 0.058, -stride * 0.038, -side * 0.032),
            "leftFoot": (-max(0.0, stride) * 0.32, stride * 0.04, -side * 0.03),
            "rightFoot": (-max(0.0, -stride) * 0.32, -stride * 0.04, side * 0.03),
        }
        for bone_name in FK_BONES:
            key_bone_rotation(
                armature,
                bone_name,
                add_euler(stance[bone_name], offsets.get(bone_name, (0.0, 0.0, 0.0))),
                time,
            )
        key_control_location(
            controls["ik.hand.L"],
            (
                base_left[0],
                base_left[1] + bounce * 0.012,
                base_left[2] + stride * 0.16,
            ),
            time,
        )
        key_control_location(
            controls["ik.hand.R"],
            (
                base_right[0],
                base_right[1] + bounce * 0.012,
                base_right[2] - stride * 0.16,
            ),
            time,
        )

    left_base = rig.VRM_JOINTS["leftFoot"]
    right_base = rig.VRM_JOINTS["rightFoot"]
    foot_keys = {
        "ik.foot.L": (
            (0.0, left_base),
            (0.45, left_base),  # planted: identical world target
            (0.55, (left_base[0] + 0.018, left_base[1] + 0.10, left_base[2] + 0.08)),
            (0.75, (left_base[0] - 0.015, left_base[1] + 0.15, left_base[2] - 0.19)),
            (1.0, left_base),
        ),
        "ik.foot.R": (
            (0.0, right_base),
            (0.20, (right_base[0] - 0.016, right_base[1] + 0.15, right_base[2] - 0.19)),
            (0.45, right_base),
            (0.55, right_base),
            (1.0, right_base),  # planted: identical world target
        ),
    }
    for control_name, entries in foot_keys.items():
        for fraction, value in entries:
            key_control_location(controls[control_name], value, duration * fraction)

    for side, sign in (("L", 1.0), ("R", -1.0)):
        for fraction in (0.0, 0.25, 0.5, 0.75, 1.0):
            phase = fraction * math.tau
            pole = Vector(
                (
                    sign * 0.0772 + math.sin(phase) * 0.025,
                    0.50 + math.cos(phase) * 0.045,
                    0.55,
                )
            )
            key_control_blender(controls[f"pole.knee.{side}"], pole, duration * fraction)

    set_bezier(collect_actions(armature, controls, clip_name))
    return duration, None


def sample_times(duration: float, phases: Sequence[Mapping] | None) -> List[float]:
    times = [index / rig.FPS for index in range(math.floor(duration * rig.FPS) + 1)]
    if times[-1] < duration - 1e-8:
        times.append(duration)
    if phases:
        times.extend(float(phase["time"]) for phase in phases)
    return sorted({round(time, 8) for time in times})


def bake_clip(
    clip_name: str,
    duration: float,
    phases: Sequence[Mapping] | None,
    loop: bool,
    armature: bpy.types.Object,
) -> dict:
    scene = bpy.context.scene
    scene.frame_start = 0
    scene.frame_end = math.ceil(duration * rig.FPS)
    times = sample_times(duration, phases)
    frames = []
    for time in times:
        frame = time * rig.FPS
        whole = math.floor(frame + 1e-9)
        scene.frame_set(whole, subframe=frame - whole)
        bpy.context.view_layer.update()
        rotations = rig.sampled_vrm_rotations(armature)
        frames.append(
            {
                "hipsPosition": [
                    clean_number(value)
                    for value in rig.normalized_hips_position(armature)
                ],
                "rotations": {
                    bone: [clean_number(value) for value in rotations[bone]]
                    for bone in rig.VRM_BONES
                },
            }
        )

    if loop:
        frames[-1] = json.loads(json.dumps(frames[0]))

    payload = {
        "name": clip_name,
        "fps": rig.FPS,
        "loop": loop,
        "times": [clean_number(value) for value in times],
        **({"phases": list(phases)} if phases else {}),
        "frames": frames,
    }
    path = OUT_DIR / f"{clip_name}.json"
    path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return payload


def verify_coordinate_conversion(armature: bpy.types.Object) -> None:
    """Round-trip non-commuting rotations before any authored clip is baked."""

    for pose_bone in armature.pose.bones:
        pose_bone.rotation_quaternion = Quaternion((1.0, 0.0, 0.0, 0.0))
        for constraint in pose_bone.constraints:
            constraint.influence = 0.0
    expected = {
        "hips": Euler((0.13, -0.21, 0.08), "XYZ").to_quaternion(),
        "spine": Euler((-0.09, 0.17, -0.12), "XYZ").to_quaternion(),
        "chest": Euler((0.07, 0.11, 0.16), "XYZ").to_quaternion(),
        "leftShoulder": Euler((-0.04, 0.08, -0.15), "XYZ").to_quaternion(),
    }
    for bone_name, quaternion in expected.items():
        rig.set_vrm_local_rotation(armature, bone_name, quaternion)
    bpy.context.view_layer.update()
    sampled = rig.sampled_vrm_rotations(armature)
    for bone_name, expected_quaternion in expected.items():
        actual_values = sampled[bone_name]
        actual = Quaternion(
            (actual_values[3], actual_values[0], actual_values[1], actual_values[2])
        )
        if rig.quaternion_distance(actual, expected_quaternion) > 2e-5:
            raise AssertionError(
                f"Blender/VRM local rotation round-trip failed for {bone_name}: "
                f"{tuple(actual)} != {tuple(expected_quaternion)}"
            )
    for pose_bone in armature.pose.bones:
        for constraint in pose_bone.constraints:
            constraint.influence = 1.0


def validate_payloads(payloads: Sequence[Mapping], contract: Mapping) -> None:
    expected_names = list(contract["clipOrder"])
    actual_names = [payload["name"] for payload in payloads]
    if actual_names != expected_names:
        raise AssertionError(f"Clip order mismatch: {actual_names}")
    for payload in payloads:
        if payload["fps"] != 30 or len(payload["frames"]) != len(payload["times"]):
            raise AssertionError(f"{payload['name']} has an invalid 30 fps bake")
        if set(payload["frames"][0]["rotations"]) != set(rig.VRM_BONES):
            raise AssertionError(f"{payload['name']} does not contain the exact 19 bones")
        gaps = [
            payload["times"][index] - payload["times"][index - 1]
            for index in range(1, len(payload["times"]))
        ]
        if max(gaps) > 1.0 / rig.FPS + 2e-6:
            raise AssertionError(f"{payload['name']} skipped a 30 fps sample")
        if payload["loop"] and payload["frames"][0] != payload["frames"][-1]:
            raise AssertionError(f"{payload['name']} has a loop seam")


def main() -> None:
    contract = load_contract()
    armature, controls = rig.create_rig()
    verify_coordinate_conversion(armature)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payloads = []

    for clip_name in contract["clipOrder"]:
        cls, state = clip_name.split(".", 1)
        stance = contract["stances"][cls]
        if state == "idle":
            duration, phases = author_idle(
                clip_name, cls, stance, armature, controls
            )
            loop = True
        elif state == "walk":
            duration, phases = author_walk(
                clip_name, cls, stance, armature, controls
            )
            loop = True
        else:
            duration, phases = author_action(
                clip_name,
                cls,
                contract["actions"][cls][state],
                armature,
                controls,
            )
            loop = False
        payloads.append(
            bake_clip(clip_name, duration, phases, loop, armature)
        )
        print(
            f"[anim] baked {clip_name}: {len(payloads[-1]['frames'])} samples, "
            f"{duration:.3f}s"
        )

    validate_payloads(payloads, contract)
    print(
        "[anim] coordinate check: Blender +Z/+Y -> VRM +Y/-Z; "
        "19 local quaternion tracks verified"
    )
    print(f"[anim] wrote {len(payloads)} clips to {OUT_DIR}")


if __name__ == "__main__":
    main()
