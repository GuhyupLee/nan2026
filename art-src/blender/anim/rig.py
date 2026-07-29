"""Myeongwol's normalized 19-bone authoring rig.

The Blender scene is Z-up and faces +Y.  Baked animation is converted to the
VRM normalized-humanoid basis (Y-up, facing -Z) by conjugating every local
rotation with BLENDER_TO_VRM.
"""

from __future__ import annotations

import math
from typing import Dict, Iterable, Mapping, Tuple

import bpy
from mathutils import Matrix, Quaternion, Vector


FPS = 30

VRM_BONES: Tuple[str, ...] = (
    "hips",
    "spine",
    "chest",
    "neck",
    "head",
    "leftShoulder",
    "leftUpperArm",
    "leftLowerArm",
    "leftHand",
    "rightShoulder",
    "rightUpperArm",
    "rightLowerArm",
    "rightHand",
    "leftUpperLeg",
    "leftLowerLeg",
    "leftFoot",
    "rightUpperLeg",
    "rightLowerLeg",
    "rightFoot",
)

PARENT: Mapping[str, str | None] = {
    "hips": None,
    "spine": "hips",
    "chest": "spine",
    "neck": "chest",
    "head": "neck",
    "leftShoulder": "chest",
    "leftUpperArm": "leftShoulder",
    "leftLowerArm": "leftUpperArm",
    "leftHand": "leftLowerArm",
    "rightShoulder": "chest",
    "rightUpperArm": "rightShoulder",
    "rightLowerArm": "rightUpperArm",
    "rightHand": "rightLowerArm",
    "leftUpperLeg": "hips",
    "leftLowerLeg": "leftUpperLeg",
    "leftFoot": "leftLowerLeg",
    "rightUpperLeg": "hips",
    "rightLowerLeg": "rightUpperLeg",
    "rightFoot": "rightLowerLeg",
}

# World-space humanoid joint positions read from public/models/wola.vrm.  The
# original avatar is 1.58 m at the crown, so these positions already match the
# requested 1.6 m authoring scale.
VRM_JOINTS: Mapping[str, Tuple[float, float, float]] = {
    "hips": (0.0, 0.9225, 0.0036),
    "spine": (0.0, 0.9746, 0.0161),
    "chest": (0.0, 1.0876, 0.0191),
    "neck": (0.0, 1.3276, -0.0339),
    "head": (0.0, 1.4015, -0.0246),
    "leftShoulder": (0.0224, 1.3010, -0.0255),
    "leftUpperArm": (0.1086, 1.2887, -0.0255),
    "leftLowerArm": (0.3284, 1.2887, -0.0255),
    "leftHand": (0.5431, 1.2887, -0.0255),
    "rightShoulder": (-0.0224, 1.3010, -0.0255),
    "rightUpperArm": (-0.1086, 1.2887, -0.0255),
    "rightLowerArm": (-0.3284, 1.2887, -0.0255),
    "rightHand": (-0.5431, 1.2887, -0.0255),
    "leftUpperLeg": (0.0772, 0.8828, -0.0001),
    "leftLowerLeg": (0.0772, 0.5299, -0.0075),
    "leftFoot": (0.0772, 0.1151, -0.0324),
    "rightUpperLeg": (-0.0772, 0.8828, -0.0001),
    "rightLowerLeg": (-0.0772, 0.5299, -0.0075),
    "rightFoot": (-0.0772, 0.1151, -0.0324),
}

VRM_TAILS: Mapping[str, Tuple[float, float, float]] = {
    "head": (0.0, 1.5850, -0.0120),
    "leftHand": (0.6650, 1.2887, -0.0255),
    "rightHand": (-0.6650, 1.2887, -0.0255),
    "leftFoot": (0.0772, 0.0521, 0.0783),
    "rightFoot": (-0.0772, 0.0521, 0.0783),
}

CONTROL_NAMES: Tuple[str, ...] = (
    "ik.hand.L",
    "ik.hand.R",
    "pole.elbow.L",
    "pole.elbow.R",
    "ik.foot.L",
    "ik.foot.R",
    "pole.knee.L",
    "pole.knee.R",
    "ctrl.hips",
    "ctrl.chest",
    "ctrl.head",
)

# v_vrm = BLENDER_TO_VRM @ v_blender:
# Blender +Z -> VRM +Y, Blender +Y (front) -> VRM -Z.
BLENDER_TO_VRM = Matrix(
    (
        (1.0, 0.0, 0.0),
        (0.0, 0.0, 1.0),
        (0.0, -1.0, 0.0),
    )
)
VRM_TO_BLENDER = BLENDER_TO_VRM.transposed()
HIPS_REST_HEIGHT = VRM_JOINTS["hips"][1]


def vrm_point_to_blender(value: Iterable[float]) -> Vector:
    return VRM_TO_BLENDER @ Vector(tuple(value))


def blender_point_to_vrm(value: Vector) -> Vector:
    return BLENDER_TO_VRM @ value


def vrm_rotation_to_blender(value: Quaternion) -> Quaternion:
    matrix = BLENDER_TO_VRM.transposed() @ value.to_matrix() @ BLENDER_TO_VRM
    return matrix.to_quaternion().normalized()


def blender_rotation_to_vrm(value: Matrix) -> Quaternion:
    matrix = BLENDER_TO_VRM @ value.to_3x3() @ BLENDER_TO_VRM.transposed()
    return matrix.to_quaternion().normalized()


def clear_scene() -> None:
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.armatures, bpy.data.actions):
        for datablock in list(datablocks):
            datablocks.remove(datablock)


def _tail_for(name: str) -> Vector:
    if name in VRM_TAILS:
        return vrm_point_to_blender(VRM_TAILS[name])
    children = [bone for bone, parent in PARENT.items() if parent == name]
    if name == "hips":
        return vrm_point_to_blender(VRM_JOINTS["spine"])
    if name == "chest":
        return vrm_point_to_blender(VRM_JOINTS["neck"])
    if len(children) != 1:
        raise ValueError(f"Cannot infer a deterministic tail for {name}: {children}")
    return vrm_point_to_blender(VRM_JOINTS[children[0]])


def _align_roll(edit_bone: bpy.types.EditBone) -> None:
    axis = (edit_bone.tail - edit_bone.head).normalized()
    reference = Vector((0.0, 1.0, 0.0))
    if abs(axis.dot(reference)) > 0.92:
        reference = Vector((0.0, 0.0, 1.0))
    edit_bone.align_roll(reference)


def _new_control(
    name: str,
    location: Vector,
    display: str,
    size: float,
) -> bpy.types.Object:
    control = bpy.data.objects.new(name, None)
    control.empty_display_type = display
    control.empty_display_size = size
    control.location = location
    control.rotation_mode = "QUATERNION"
    bpy.context.scene.collection.objects.link(control)
    control["myeongwol_control"] = True
    return control


def _add_ik(
    pose_bone: bpy.types.PoseBone,
    target: bpy.types.Object,
    pole: bpy.types.Object,
    label: str,
) -> None:
    constraint = pose_bone.constraints.new("IK")
    constraint.name = label
    constraint.target = target
    constraint.pole_target = pole
    constraint.chain_count = 2
    constraint.use_stretch = False
    constraint.use_tail = True


def create_rig() -> Tuple[bpy.types.Object, Dict[str, bpy.types.Object]]:
    """Create the deform rig and its eleven world-space authoring controls."""

    clear_scene()
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.render.fps_base = 1.0
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0

    armature_data = bpy.data.armatures.new("MyeongwolHumanoid")
    armature = bpy.data.objects.new("MyeongwolHumanoid", armature_data)
    scene.collection.objects.link(armature)
    armature.show_in_front = True
    armature["coordinate_contract"] = "Blender Z-up +Y front -> VRM Y-up -Z front"
    armature["source_proportions"] = "public/models/wola.vrm"

    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    for name in VRM_BONES:
        edit_bone = armature_data.edit_bones.new(name)
        edit_bone.head = vrm_point_to_blender(VRM_JOINTS[name])
        edit_bone.tail = _tail_for(name)
        _align_roll(edit_bone)

    for name in VRM_BONES:
        parent_name = PARENT[name]
        if parent_name is not None:
            armature_data.edit_bones[name].parent = armature_data.edit_bones[parent_name]
            armature_data.edit_bones[name].use_connect = (
                armature_data.edit_bones[name].head
                - armature_data.edit_bones[parent_name].tail
            ).length < 1e-5

    bpy.ops.object.mode_set(mode="POSE")
    for pose_bone in armature.pose.bones:
        pose_bone.rotation_mode = "QUATERNION"

    controls = {
        "ik.hand.L": _new_control(
            "ik.hand.L", vrm_point_to_blender(VRM_JOINTS["leftHand"]), "CUBE", 0.055
        ),
        "ik.hand.R": _new_control(
            "ik.hand.R", vrm_point_to_blender(VRM_JOINTS["rightHand"]), "CUBE", 0.055
        ),
        "pole.elbow.L": _new_control(
            "pole.elbow.L",
            Vector((VRM_JOINTS["leftLowerArm"][0], -0.42, 1.18)),
            "SPHERE",
            0.045,
        ),
        "pole.elbow.R": _new_control(
            "pole.elbow.R",
            Vector((VRM_JOINTS["rightLowerArm"][0], -0.42, 1.18)),
            "SPHERE",
            0.045,
        ),
        "ik.foot.L": _new_control(
            "ik.foot.L", vrm_point_to_blender(VRM_JOINTS["leftFoot"]), "CUBE", 0.07
        ),
        "ik.foot.R": _new_control(
            "ik.foot.R", vrm_point_to_blender(VRM_JOINTS["rightFoot"]), "CUBE", 0.07
        ),
        "pole.knee.L": _new_control(
            "pole.knee.L",
            Vector((VRM_JOINTS["leftLowerLeg"][0], 0.48, 0.55)),
            "SPHERE",
            0.05,
        ),
        "pole.knee.R": _new_control(
            "pole.knee.R",
            Vector((VRM_JOINTS["rightLowerLeg"][0], 0.48, 0.55)),
            "SPHERE",
            0.05,
        ),
        "ctrl.hips": _new_control(
            "ctrl.hips", vrm_point_to_blender(VRM_JOINTS["hips"]), "CIRCLE", 0.12
        ),
        "ctrl.chest": _new_control(
            "ctrl.chest", vrm_point_to_blender(VRM_JOINTS["chest"]), "CIRCLE", 0.1
        ),
        "ctrl.head": _new_control(
            "ctrl.head", vrm_point_to_blender(VRM_JOINTS["head"]), "CIRCLE", 0.085
        ),
    }

    _add_ik(
        armature.pose.bones["leftLowerArm"],
        controls["ik.hand.L"],
        controls["pole.elbow.L"],
        "IK leftHand",
    )
    _add_ik(
        armature.pose.bones["rightLowerArm"],
        controls["ik.hand.R"],
        controls["pole.elbow.R"],
        "IK rightHand",
    )
    _add_ik(
        armature.pose.bones["leftLowerLeg"],
        controls["ik.foot.L"],
        controls["pole.knee.L"],
        "IK leftFoot",
    )
    _add_ik(
        armature.pose.bones["rightLowerLeg"],
        controls["ik.foot.R"],
        controls["pole.knee.R"],
        "IK rightFoot",
    )

    bpy.ops.object.mode_set(mode="OBJECT")
    validate_rig(armature, controls)
    return armature, controls


def validate_rig(
    armature: bpy.types.Object,
    controls: Mapping[str, bpy.types.Object],
) -> None:
    actual_bones = tuple(bone.name for bone in armature.data.bones)
    if set(actual_bones) != set(VRM_BONES) or len(actual_bones) != len(VRM_BONES):
        raise AssertionError(f"Expected the exact 19 VRM bones, found {actual_bones}")
    if set(controls) != set(CONTROL_NAMES):
        raise AssertionError(f"Control contract mismatch: {tuple(controls)}")

    expected = {
        "leftLowerArm": "ik.hand.L",
        "rightLowerArm": "ik.hand.R",
        "leftLowerLeg": "ik.foot.L",
        "rightLowerLeg": "ik.foot.R",
    }
    for bone_name, target_name in expected.items():
        constraints = [
            constraint
            for constraint in armature.pose.bones[bone_name].constraints
            if constraint.type == "IK"
        ]
        if len(constraints) != 1:
            raise AssertionError(f"{bone_name} needs exactly one IK constraint")
        constraint = constraints[0]
        if constraint.chain_count != 2 or constraint.target.name != target_name:
            raise AssertionError(f"{bone_name} IK chain contract is invalid")

    up = blender_point_to_vrm(Vector((0.0, 0.0, 1.0)))
    forward = blender_point_to_vrm(Vector((0.0, 1.0, 0.0)))
    if (up - Vector((0.0, 1.0, 0.0))).length > 1e-8:
        raise AssertionError(f"Blender +Z did not map to VRM +Y: {tuple(up)}")
    if (forward - Vector((0.0, 0.0, -1.0))).length > 1e-8:
        raise AssertionError(f"Blender +Y did not map to VRM -Z: {tuple(forward)}")
    if abs(BLENDER_TO_VRM.determinant() - 1.0) > 1e-8:
        raise AssertionError("Coordinate conversion must preserve handedness")


def set_vrm_local_rotation(
    armature: bpy.types.Object,
    bone_name: str,
    quaternion: Quaternion,
) -> None:
    """Set a pose bone from a normalized-humanoid local VRM rotation."""

    rest_rotation = armature.data.bones[bone_name].matrix_local.to_3x3()
    local_blender = (
        BLENDER_TO_VRM.transposed()
        @ quaternion.to_matrix()
        @ BLENDER_TO_VRM
    )
    basis = rest_rotation.transposed() @ local_blender @ rest_rotation
    pose_bone = armature.pose.bones[bone_name]
    pose_bone.rotation_mode = "QUATERNION"
    pose_bone.rotation_quaternion = basis.to_quaternion().normalized()


def sampled_vrm_rotations(
    armature: bpy.types.Object,
) -> Dict[str, Tuple[float, float, float, float]]:
    """Read evaluated pose matrices as VRM-basis local delta rotations."""

    cumulative: Dict[str, Matrix] = {}
    result: Dict[str, Tuple[float, float, float, float]] = {}
    for name in VRM_BONES:
        rest_rotation = armature.data.bones[name].matrix_local.to_3x3()
        pose_rotation = armature.pose.bones[name].matrix.to_3x3()
        world_delta = pose_rotation @ rest_rotation.transposed()
        parent_name = PARENT[name]
        local_delta = (
            cumulative[parent_name].transposed() @ world_delta
            if parent_name is not None
            else world_delta
        )
        cumulative[name] = world_delta
        quaternion = blender_rotation_to_vrm(local_delta)
        result[name] = (
            float(quaternion.x),
            float(quaternion.y),
            float(quaternion.z),
            float(quaternion.w),
        )
    return result


def normalized_hips_position(armature: bpy.types.Object) -> Tuple[float, float, float]:
    """Return normalized Hips translation; authored clips are always in-place."""

    rest = vrm_point_to_blender(VRM_JOINTS["hips"])
    delta = armature.pose.bones["hips"].head - rest
    vrm_delta = blender_point_to_vrm(delta) / HIPS_REST_HEIGHT
    return (0.0, float(1.0 + vrm_delta.y), 0.0)


def quaternion_distance(a: Quaternion, b: Quaternion) -> float:
    dot = max(-1.0, min(1.0, abs(a.normalized().dot(b.normalized()))))
    return 2.0 * math.acos(dot)
