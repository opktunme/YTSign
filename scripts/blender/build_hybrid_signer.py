"""Build the YTSign PSL hybrid signer.

The authored Meshy character supplies the face, hair, and embroidered kameez.
The mechanically validated MPFB runtime supplies both five-digit hand surfaces
and their exact metacarpal/phalange rigs.  Source files remain untouched.

Usage:
  blender --background --python build_hybrid_signer.py -- \
    MESHY.glb MPFB_RUNTIME.blend OUTPUT.blend OUTPUT.glb REPORT.json
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector


SCRIPT_DIRECTORY = Path(__file__).resolve().parent
if str(SCRIPT_DIRECTORY) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIRECTORY))

import build_signing_avatar as meshy_base


SIDE_INFO = {
    "Left": {"mpfb": "L", "sign": 1.0},
    "Right": {"mpfb": "R", "sign": -1.0},
}
DIGITS = {1: "Thumb", 2: "Index", 3: "Middle", 4: "Ring", 5: "Pinky"}
METACARPALS = {1: "Index", 2: "Middle", 3: "Ring", 4: "Pinky"}


def arguments() -> tuple[Path, Path, Path, Path, Path]:
    if "--" not in sys.argv:
        raise SystemExit("Expected MESHY MPFB OUTPUT_BLEND OUTPUT_GLB REPORT_JSON")
    values = sys.argv[sys.argv.index("--") + 1 :]
    if len(values) != 5:
        raise SystemExit("Expected exactly five paths")
    return tuple(Path(value).resolve() for value in values)


def weight(vertex: bpy.types.MeshVertex, group_index: int) -> float:
    return next((entry.weight for entry in vertex.groups if entry.group == group_index), 0.0)


def topology_components(mesh: bpy.types.Object) -> tuple[list[int], dict[int, dict]]:
    """Return stable topology-island IDs and compact world-space metadata."""
    parent = list(range(len(mesh.data.vertices)))
    sizes = [1] * len(parent)

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left, right = find(left), find(right)
        if left == right:
            return
        if sizes[left] < sizes[right]:
            left, right = right, left
        parent[right] = left
        sizes[left] += sizes[right]

    for edge in mesh.data.edges:
        union(edge.vertices[0], edge.vertices[1])
    roots = [find(index) for index in range(len(parent))]
    records: dict[int, dict] = {}
    for vertex, root in zip(mesh.data.vertices, roots):
        point = mesh.matrix_world @ vertex.co
        record = records.setdefault(
            root,
            {
                "count": 0,
                "face_anchors": 0,
                "min": Vector(point),
                "max": Vector(point),
            },
        )
        record["count"] += 1
        if abs(point.x) < 0.090 and point.y < -0.084 and 1.430 < point.z < 1.615:
            record["face_anchors"] += 1
        for axis in range(3):
            record["min"][axis] = min(record["min"][axis], point[axis])
            record["max"][axis] = max(record["max"][axis], point[axis])
    return roots, records


def clean_accessory_artifacts(mesh: bpy.types.Object) -> dict:
    """Remove only the two measured skin-tone dangling accessory islands."""
    roots, records = topology_components(mesh)
    signatures = (
        {
            "name": "right_ear_dangle",
            "count": (60, 72),
            "min": Vector((0.077, 0.009, 1.453)),
            "max": Vector((0.092, 0.022, 1.514)),
        },
        {
            "name": "left_ear_dangle",
            "count": (440, 465),
            "min": Vector((-0.087, 0.002, 1.419)),
            "max": Vector((-0.050, 0.062, 1.525)),
        },
    )
    matched = {}
    selected_roots = set()
    for signature in signatures:
        candidates = []
        for root, record in records.items():
            low, high = signature["count"]
            if not low <= record["count"] <= high:
                continue
            if all(record["min"][axis] >= signature["min"][axis] for axis in range(3)) and all(
                record["max"][axis] <= signature["max"][axis] for axis in range(3)
            ):
                candidates.append(root)
        if len(candidates) != 1:
            raise RuntimeError(f"Accessory signature {signature['name']} matched {len(candidates)} islands")
        root = candidates[0]
        selected_roots.add(root)
        matched[signature["name"]] = records[root]["count"]
    selected = [vertex.index for vertex, root in zip(mesh.data.vertices, roots) if root in selected_roots]
    editable = bmesh.new()
    editable.from_mesh(mesh.data)
    editable.verts.ensure_lookup_table()
    bmesh.ops.delete(editable, geom=[editable.verts[index] for index in selected], context="VERTS")
    editable.to_mesh(mesh.data)
    editable.free()
    mesh.data.update()
    return {"components": matched, "vertices": len(selected)}


@dataclass
class HandFrame:
    origin: Vector
    transverse: Vector
    normal: Vector
    longitudinal: Vector
    transverse_scale: float
    normal_scale: float
    longitudinal_scale: float

    @property
    def basis(self) -> Matrix:
        return Matrix((self.transverse, self.normal, self.longitudinal)).transposed()

    def point_from(self, source: "HandFrame", point: Vector) -> Vector:
        local = source.basis.inverted() @ (point - source.origin)
        scaled = Vector(
            (
                local.x * self.transverse_scale,
                local.y * self.normal_scale,
                local.z * self.longitudinal_scale,
            )
        )
        return self.origin + self.basis @ scaled

    def direction_from(self, source: "HandFrame", direction: Vector) -> Vector:
        local = source.basis.inverted() @ direction
        return (self.basis @ local).normalized()


def orthonormal_frame(
    origin: Vector,
    longitudinal: Vector,
    transverse_hint: Vector,
    side_sign: float,
    *,
    transverse_scale: float = 1.0,
    normal_scale: float = 1.0,
    longitudinal_scale: float = 1.0,
) -> HandFrame:
    longitudinal = longitudinal.normalized()
    transverse = transverse_hint - longitudinal * transverse_hint.dot(longitudinal)
    transverse.normalize()
    # Multiplying by side_sign makes the anatomical palm normal point toward
    # the character's front for both mirrored hands while retaining an
    # index-to-pinky transverse axis.
    normal = longitudinal.cross(transverse).normalized() * side_sign
    return HandFrame(
        origin,
        transverse,
        normal,
        longitudinal,
        transverse_scale,
        normal_scale,
        longitudinal_scale,
    )


def append_mpfb(path: Path) -> tuple[bpy.types.Object, bpy.types.Object]:
    requested = {"YTSign_PSL_Rig", "YTSign_PSL_Signer"}
    with bpy.data.libraries.load(str(path), link=False) as (available, loaded):
        loaded.objects = [name for name in available.objects if name in requested]
    objects = {obj.name: obj for obj in loaded.objects if obj is not None}
    missing = requested - set(objects)
    if missing:
        raise RuntimeError(f"MPFB runtime objects are missing: {sorted(missing)}")
    for obj in objects.values():
        if not obj.users_collection:
            bpy.context.scene.collection.objects.link(obj)
    return objects["YTSign_PSL_Signer"], objects["YTSign_PSL_Rig"]


def source_frame(mesh: bpy.types.Object, rig: bpy.types.Object, side: str) -> HandFrame:
    bpy.context.view_layer.update()
    wrist = rig.matrix_world @ rig.pose.bones[f"wrist.{side}"].head
    middle_tip = rig.matrix_world @ rig.pose.bones[f"finger3-3.{side}"].tail
    index_base = rig.matrix_world @ rig.pose.bones[f"finger2-1.{side}"].head
    pinky_base = rig.matrix_world @ rig.pose.bones[f"finger5-1.{side}"].head
    sign = 1.0 if side == "L" else -1.0
    return orthonormal_frame(wrist, middle_tip - wrist, index_base - pinky_base, sign)


def target_frame(
    armature: bpy.types.Object,
    chains: dict[str, list[Vector]],
    side: str,
    source: HandFrame,
) -> HandFrame:
    info = SIDE_INFO[side]
    wrist = armature.matrix_world @ armature.data.bones[f"{side}Hand"].head_local
    middle_tip = chains["Middle"][-1]
    index_base = chains["Index"][0]
    pinky_base = chains["Pinky"][0]
    target_length = (middle_tip - wrist).length
    source_length = 1.0
    # The source basis stores a unit longitudinal axis, so compare against the
    # actual MPFB middle-tip distance supplied by the caller below.
    source_length = getattr(source, "reference_length", target_length)
    target_width = (index_base - pinky_base).length
    source_width = getattr(source, "reference_width", target_width)
    return orthonormal_frame(
        wrist - (middle_tip - wrist).normalized() * 0.004,
        middle_tip - wrist,
        index_base - pinky_base,
        info["sign"],
        transverse_scale=(target_width / max(source_width, 1.0e-6)) * 0.98,
        normal_scale=(target_width / max(source_width, 1.0e-6)) * 0.88,
        longitudinal_scale=(target_length / max(source_length, 1.0e-6)) * 0.94,
    )


def decorate_source_frame(frame: HandFrame, rig: bpy.types.Object, side: str) -> None:
    wrist = frame.origin
    middle_tip = rig.matrix_world @ rig.pose.bones[f"finger3-3.{side}"].tail
    index_base = rig.matrix_world @ rig.pose.bones[f"finger2-1.{side}"].head
    pinky_base = rig.matrix_world @ rig.pose.bones[f"finger5-1.{side}"].head
    frame.reference_length = (middle_tip - wrist).length
    frame.reference_width = (index_base - pinky_base).length


def delete_legacy_hands(
    mesh: bpy.types.Object,
    armature: bpy.types.Object,
    targets: dict[str, HandFrame],
) -> dict[str, int]:
    selected: set[int] = set()
    counts = {}
    for side, frame in targets.items():
        family = [group for group in mesh.vertex_groups if group.name.startswith(f"{side}Hand")]
        side_selected = []
        for vertex in mesh.data.vertices:
            family_weight = sum(weight(vertex, group.index) for group in family)
            if family_weight < 0.06:
                continue
            point = mesh.matrix_world @ vertex.co
            offset = point - frame.origin
            along = offset.dot(frame.longitudinal)
            radial = (offset - frame.longitudinal * along).length
            if along >= -0.012 and radial <= 0.13:
                side_selected.append(vertex.index)
                selected.add(vertex.index)
        counts[side] = len(side_selected)

    # glTF imports may leave polygon/edge selection flags set even after all
    # vertex flags are cleared, which makes an Edit Mode delete erase the
    # entire character.  BMesh deletion uses the explicit index set only.
    editable = bmesh.new()
    editable.from_mesh(mesh.data)
    editable.verts.ensure_lookup_table()
    bmesh.ops.delete(
        editable,
        geom=[editable.verts[index] for index in sorted(selected)],
        context="VERTS",
    )
    editable.to_mesh(mesh.data)
    editable.free()
    mesh.data.update()
    return counts


def clean_cuff_slivers(
    mesh: bpy.types.Object,
    targets: dict[str, HandFrame],
) -> dict[str, dict]:
    """Delete only tiny proximal legacy-hand islands hidden under each cuff."""
    roots, records = topology_components(mesh)
    members: dict[int, list[int]] = {}
    for vertex, root in zip(mesh.data.vertices, roots):
        members.setdefault(root, []).append(vertex.index)
    selected_roots: set[int] = set()
    report = {}
    for side, frame in targets.items():
        family_names = {f"{side}ForeArm", f"{side}Hand"}
        family_names.update(group.name for group in mesh.vertex_groups if group.name.startswith(f"{side}Hand"))
        family_indices = {mesh.vertex_groups[name].index for name in family_names if mesh.vertex_groups.get(name)}
        matched = []
        for root, indices in members.items():
            if len(indices) > 100:
                continue
            along_values = []
            radial_values = []
            family_coverage = []
            for index in indices:
                vertex = mesh.data.vertices[index]
                point = mesh.matrix_world @ vertex.co
                offset = point - frame.origin
                along = offset.dot(frame.longitudinal)
                along_values.append(along)
                radial_values.append((offset - frame.longitudinal * along).length)
                family_coverage.append(sum(entry.weight for entry in vertex.groups if entry.group in family_indices))
            if not indices:
                continue
            if (
                min(along_values) > -0.040
                and max(along_values) < -0.010
                and max(radial_values) < 0.027
                and sum(value >= 0.75 for value in family_coverage) / len(indices) >= 0.80
            ):
                matched.append(root)
                selected_roots.add(root)
        total = sum(len(members[root]) for root in matched)
        if not 20 <= total <= 220:
            raise RuntimeError(f"Cuff cleanup for {side} selected an unsafe {total} vertices")
        report[side] = {"components": len(matched), "vertices": total}

    selected = [vertex.index for vertex, root in zip(mesh.data.vertices, roots) if root in selected_roots]
    editable = bmesh.new()
    editable.from_mesh(mesh.data)
    editable.verts.ensure_lookup_table()
    bmesh.ops.delete(editable, geom=[editable.verts[index] for index in selected], context="VERTS")
    editable.to_mesh(mesh.data)
    editable.free()
    mesh.data.update()
    return report


def clean_proximal_skin_wedges(
    mesh: bpy.types.Object,
    targets: dict[str, HandFrame],
) -> dict[str, dict]:
    """Remove only the measured skin-textured islands trapped by the cuffs."""
    roots, records = topology_components(mesh)
    members: dict[int, list[int]] = {}
    for vertex, root in zip(mesh.data.vertices, roots):
        members.setdefault(root, []).append(vertex.index)
    colors = vertex_texture_colors(mesh)
    worlds = [mesh.matrix_world @ vertex.co for vertex in mesh.data.vertices]
    cheek = [
        index
        for index, point in enumerate(worlds)
        if 0.015 < abs(point.x) < 0.095 and point.y < -0.066 and 1.515 < point.z < 1.585
    ]
    if len(cheek) < 10:
        raise RuntimeError("Could not establish the skin reference for cuff cleanup")
    reference = np.median(colors[cheek], axis=0)
    reference_chroma = reference / max(float(reference.sum()), 1.0e-6)
    chroma = colors / np.maximum(colors.sum(axis=1, keepdims=True), 1.0e-6)
    luma = colors @ np.asarray((0.2126, 0.7152, 0.0722), dtype=np.float32)
    reference_luma = float(reference @ np.asarray((0.2126, 0.7152, 0.0722), dtype=np.float32))
    skin = (luma >= reference_luma * 0.34) & (np.linalg.norm(chroma - reference_chroma, axis=1) <= 0.16)

    selected_roots: set[int] = set()
    report = {}
    for side, frame in targets.items():
        wrist = mesh.parent.matrix_world @ mesh.parent.data.bones[f"{side}Hand"].head_local
        elbow = mesh.parent.matrix_world @ mesh.parent.data.bones[f"{side}ForeArm"].head_local
        cuff_axis = (elbow - wrist).normalized()
        family_names = {f"{side}ForeArm", f"{side}Hand"}
        family_names.update(group.name for group in mesh.vertex_groups if group.name.startswith(f"{side}Hand"))
        family_indices = {mesh.vertex_groups[name].index for name in family_names if mesh.vertex_groups.get(name)}
        matched = []
        for root, indices in members.items():
            if len(indices) > 100:
                continue
            along_values = []
            radial_values = []
            coverage = []
            for index in indices:
                vertex = mesh.data.vertices[index]
                # target_frame.origin deliberately overlaps the transplanted
                # hand by 4 mm.  Artifact measurements use the anatomical
                # wrist pivot and the wrist-to-elbow cuff axis instead.
                offset = worlds[index] - wrist
                along = offset.dot(cuff_axis)
                along_values.append(along)
                radial_values.append((offset - cuff_axis * along).length)
                coverage.append(sum(entry.weight for entry in vertex.groups if entry.group in family_indices))
            if (
                min(along_values) > 0.012
                and max(along_values) < 0.045
                and max(radial_values) < 0.045
                and sum(value >= 0.75 for value in coverage) / len(indices) >= 0.90
                and sum(bool(skin[index]) for index in indices) / len(indices) >= 0.60
                # The source texture shades the wedges differently across the
                # wrist.  The five remaining measured islands are tan rather
                # than bright skin, but still match the cheek chroma, the
                # forearm/hand weights, and the tightly bounded cuff volume.
                and float(np.median(colors[np.asarray(indices, dtype=np.int32)], axis=0)[0]) >= 0.44
            ):
                matched.append(root)
                selected_roots.add(root)
        total = sum(len(members[root]) for root in matched)
        expected = (218, 230) if side == "Left" else (75, 95)
        if not expected[0] <= total <= expected[1]:
            raise RuntimeError(f"Proximal skin cleanup for {side} selected an unsafe {total} vertices")
        report[side] = {"components": len(matched), "vertices": total}

    selected = [vertex.index for vertex, root in zip(mesh.data.vertices, roots) if root in selected_roots]
    editable = bmesh.new()
    editable.from_mesh(mesh.data)
    editable.verts.ensure_lookup_table()
    bmesh.ops.delete(editable, geom=[editable.verts[index] for index in selected], context="VERTS")
    editable.to_mesh(mesh.data)
    editable.free()
    mesh.data.update()
    return report


def hand_indices(mesh: bpy.types.Object, rig: bpy.types.Object, side: str) -> set[int]:
    names = {
        f"{stem}.{side}"
        for stem in (
            "wrist",
            "metacarpal1",
            "metacarpal2",
            "metacarpal3",
            "metacarpal4",
            *tuple(f"finger{digit}-{joint}" for digit in range(1, 6) for joint in range(1, 4)),
        )
    }
    group_names = {group.index: group.name for group in mesh.vertex_groups}
    wrist = rig.matrix_world @ rig.pose.bones[f"wrist.{side}"].head
    result = set()
    for vertex in mesh.data.vertices:
        point = mesh.matrix_world @ vertex.co
        authored = any(
            group_names.get(entry.group) in names and entry.weight > 0.025
            for entry in vertex.groups
        )
        forearm = any(
            group_names.get(entry.group) in {f"lowerarm01.{side}", f"lowerarm02.{side}"}
            and entry.weight > 0.08
            for entry in vertex.groups
        )
        if authored or (forearm and (point - wrist).length <= 0.028):
            result.add(vertex.index)
    return result


def remove_shape_keys(obj: bpy.types.Object) -> None:
    if not obj.data.shape_keys:
        return
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.shape_key_remove(all=True)


def target_group_name(source_name: str, side: str) -> str | None:
    target_side = "Left" if side == "L" else "Right"
    if source_name in {f"wrist.{side}", f"palm.{side}"}:
        return f"{target_side}Hand"
    if source_name in {f"lowerarm01.{side}", f"lowerarm02.{side}"}:
        return f"{target_side}ForeArm"
    if source_name.startswith("metacarpal") and source_name.endswith(f".{side}"):
        number = int(source_name[len("metacarpal")])
        return f"{target_side}Hand{METACARPALS[number]}Meta"
    if source_name.startswith("finger") and source_name.endswith(f".{side}"):
        stem = source_name.split(".")[0]
        digit, joint = stem[len("finger") :].split("-")
        return f"{target_side}Hand{DIGITS[int(digit)]}{joint}"
    return None


def remap_weights(obj: bpy.types.Object, side: str) -> dict:
    old_names = {group.index: group.name for group in obj.vertex_groups}
    mapped: list[dict[str, float]] = []
    default = f"{'Left' if side == 'L' else 'Right'}Hand"
    for vertex in obj.data.vertices:
        accum: dict[str, float] = {}
        for entry in vertex.groups:
            name = target_group_name(old_names.get(entry.group, ""), side)
            if name:
                accum[name] = accum.get(name, 0.0) + entry.weight
        if not accum:
            accum[default] = 1.0
        total = sum(accum.values()) or 1.0
        mapped.append({name: value / total for name, value in accum.items()})

    for group in list(obj.vertex_groups):
        obj.vertex_groups.remove(group)
    groups = {
        name: obj.vertex_groups.new(name=name)
        for name in sorted({name for assignment in mapped for name in assignment})
    }
    for index, assignment in enumerate(mapped):
        for name, value in assignment.items():
            groups[name].add([index], value, "REPLACE")
    return {name: sum(1 for assignment in mapped if name in assignment) for name in groups}


def warm_hand_materials(obj: bpy.types.Object, side: str) -> None:
    for slot_index, material in enumerate(list(obj.data.materials)):
        if material is None:
            continue
        copied = material.copy()
        copied.name = f"YTSign_Hybrid_Hand_Skin_{side}_{slot_index}"
        obj.data.materials[slot_index] = copied
        if not copied.use_nodes:
            continue
        shader = next((node for node in copied.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
        if shader:
            # Anatomical skin is opaque. The donor material can retain an
            # alpha connection that glTF classifies as BLEND; Chromium then
            # sorts overlapping fingers as transparent surfaces. Keep alpha
            # independent of the albedo texture on future exports.
            if "Alpha" in shader.inputs:
                for link in list(shader.inputs["Alpha"].links):
                    copied.node_tree.links.remove(link)
                shader.inputs["Alpha"].default_value = 1.0
            shader.inputs["Roughness"].default_value = 0.60
            if "Specular IOR Level" in shader.inputs:
                shader.inputs["Specular IOR Level"].default_value = 0.25
            if "Subsurface Weight" in shader.inputs:
                shader.inputs["Subsurface Weight"].default_value = 0.075


def create_hand_object(
    source_mesh: bpy.types.Object,
    source_rig: bpy.types.Object,
    target_body: bpy.types.Object,
    target_rig: bpy.types.Object,
    source: HandFrame,
    target: HandFrame,
    side: str,
) -> tuple[bpy.types.Object, dict]:
    indices = hand_indices(source_mesh, source_rig, side)
    obj = source_mesh.copy()
    obj.data = source_mesh.data.copy()
    obj.name = f"YTSign_PSL_Hand_{side}"
    bpy.context.scene.collection.objects.link(obj)
    remove_shape_keys(obj)

    editable = bmesh.new()
    editable.from_mesh(obj.data)
    editable.verts.ensure_lookup_table()
    bmesh.ops.delete(
        editable,
        geom=[editable.verts[index] for index in range(len(editable.verts)) if index not in indices],
        context="VERTS",
    )
    editable.to_mesh(obj.data)
    editable.free()

    original_world = obj.matrix_world.copy()
    target_inverse = target_body.matrix_world.inverted()
    for vertex in obj.data.vertices:
        target_world = target.point_from(source, original_world @ vertex.co)
        vertex.co = target_inverse @ target_world
    # Match the exact coordinate/bind frame used by Meshy's skinned body.  Its
    # armature carries a 0.01 import scale, so storing metre-space hand
    # vertices under an identity object matrix would apply that scale twice.
    obj.parent = target_rig
    obj.matrix_parent_inverse = target_body.matrix_parent_inverse.copy()
    obj.matrix_basis = target_body.matrix_basis.copy()
    obj.data.update()
    for polygon in obj.data.polygons:
        polygon.use_smooth = True

    mapping_report = remap_weights(obj, side)
    for modifier in list(obj.modifiers):
        obj.modifiers.remove(modifier)
    armature_modifier = obj.modifiers.new("YTSign_Hybrid_Armature", "ARMATURE")
    armature_modifier.object = target_rig
    # glTF/Three.js uses linear blend skinning.  Keeping Blender's dual-
    # quaternion preserve-volume mode here creates a ~2 mm posed round-trip
    # mismatch even though the neutral mesh is exact.
    armature_modifier.use_deform_preserve_volume = False
    warm_hand_materials(obj, side)
    obj["ytsign_role"] = "anatomical_signing_hand"
    return obj, {
        "vertices": len(obj.data.vertices),
        "polygons": len(obj.data.polygons),
        "source_indices": len(indices),
        "groups": mapping_report,
    }


def source_to_target_bone_name(name: str, side: str) -> str | None:
    return target_group_name(name, side)


def add_hand_bones(
    source_rig: bpy.types.Object,
    target_rig: bpy.types.Object,
    source_frames: dict[str, HandFrame],
    target_frames: dict[str, HandFrame],
) -> list[str]:
    # Cache donor pose-space transforms before changing the target armature's
    # mode.  The MPFB export's evaluated pose carries its grounded character
    # offset; data-rest coordinates are about 0.82 m below the actual mesh.
    donor = {}
    bpy.context.view_layer.update()
    for target_side, info in SIDE_INFO.items():
        side = info["mpfb"]
        source_names = [f"metacarpal{index}.{side}" for index in range(1, 5)]
        source_names += [
            f"finger{digit}-{joint}.{side}"
            for digit in range(1, 6)
            for joint in range(1, 4)
        ]
        for source_name in source_names:
            pose_bone = source_rig.pose.bones[source_name]
            donor[source_name] = {
                "head": source_rig.matrix_world @ pose_bone.head,
                "tail": source_rig.matrix_world @ pose_bone.tail,
                "z_axis": (
                    source_rig.matrix_world.to_3x3()
                    @ (pose_bone.matrix.to_3x3() @ Vector((0.0, 0.0, 1.0)))
                ).normalized(),
            }
    inverse = target_rig.matrix_world.inverted()
    created = []
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = target_rig
    target_rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    for target_side, info in SIDE_INFO.items():
        side = info["mpfb"]
        source_frame_value = source_frames[side]
        target_frame_value = target_frames[target_side]
        parent_hand = target_rig.data.edit_bones[f"{target_side}Hand"]
        source_names = [f"metacarpal{index}.{side}" for index in range(1, 5)]
        source_names += [
            f"finger{digit}-{joint}.{side}"
            for digit in range(1, 6)
            for joint in range(1, 4)
        ]
        for source_name in source_names:
            target_name = source_to_target_bone_name(source_name, side)
            bone = target_rig.data.edit_bones.new(target_name)
            source_head = donor[source_name]["head"]
            source_tail = donor[source_name]["tail"]
            target_head = target_frame_value.point_from(source_frame_value, source_head)
            target_tail = target_frame_value.point_from(source_frame_value, source_tail)
            bone.head = inverse @ target_head
            bone.tail = inverse @ target_tail
            if source_name.startswith("metacarpal"):
                bone.parent = parent_hand
            elif source_name.startswith("finger"):
                stem = source_name.split(".")[0]
                digit, joint = stem[len("finger") :].split("-")
                if int(joint) > 1:
                    previous = f"{target_side}Hand{DIGITS[int(digit)]}{int(joint) - 1}"
                    bone.parent = target_rig.data.edit_bones[previous]
                    bone.use_connect = True
                elif int(digit) == 1:
                    bone.parent = parent_hand
                else:
                    meta_number = int(digit) - 1
                    bone.parent = target_rig.data.edit_bones[
                        f"{target_side}Hand{METACARPALS[meta_number]}Meta"
                    ]
            bone.use_deform = True
            source_z_world = donor[source_name]["z_axis"]
            target_z_world = target_frame_value.direction_from(source_frame_value, source_z_world)
            target_z_local = (target_rig.matrix_world.to_3x3().inverted() @ target_z_world).normalized()
            bone.align_roll(target_z_local)
            created.append(target_name)

        # Three.js needs a child transform at every fingertip to recover the
        # authored direction of the distal phalanx.  Blender's source rig ends
        # each chain at Finger3, so add non-deforming leaf bones whose heads
        # coincide with the anatomical tips.  They do not affect skinning;
        # they are orientation targets for the live MediaPipe 3->4, 7->8,
        # 11->12, 15->16 and 19->20 landmark segments.
        for digit_name in DIGITS.values():
            distal = target_rig.data.edit_bones[f"{target_side}Hand{digit_name}3"]
            end_name = f"{target_side}Hand{digit_name}End"
            tip = target_rig.data.edit_bones.new(end_name)
            tip.parent = distal
            tip.use_connect = True
            tip.head = distal.tail
            direction = (distal.tail - distal.head).normalized()
            tip.tail = distal.tail + direction * max(distal.length * 0.18, 0.0005)
            tip.roll = distal.roll
            tip.use_deform = False
            created.append(end_name)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()
    return created


def repair_imported_arm_tails(rig: bpy.types.Object) -> dict[str, float]:
    """Shorten Meshy's collinear display tails to the actual child joints.

    The GLB stores correct joint heads but imports several bone tails roughly
    100x too long.  Skinning around the head pivots still works, while Blender
    IK does not.  Replacing each collinear tail with its child head preserves
    orientation and makes two-bone arm solving numerically well conditioned.
    """
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = rig
    rig.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    repaired = {}
    for side in ("Left", "Right"):
        chain = (
            (f"{side}Shoulder", f"{side}Arm"),
            (f"{side}Arm", f"{side}ForeArm"),
            (f"{side}ForeArm", f"{side}Hand"),
        )
        for parent_name, child_name in chain:
            parent = rig.data.edit_bones[parent_name]
            child = rig.data.edit_bones[child_name]
            old_length = parent.length
            parent.tail = child.head
            repaired[parent_name] = old_length / max(parent.length, 1.0e-9)
        hand = rig.data.edit_bones[f"{side}Hand"]
        meta_heads = [
            rig.data.edit_bones[f"{side}Hand{finger}Meta"].head
            for finger in ("Index", "Middle", "Ring", "Pinky")
        ]
        old_length = hand.length
        hand.tail = sum(meta_heads, Vector()) / len(meta_heads)
        repaired[f"{side}Hand"] = old_length / max(hand.length, 1.0e-9)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()
    return repaired


def closest_segment(point: Vector, start: Vector, end: Vector) -> tuple[float, float]:
    axis = end - start
    length_squared = axis.length_squared
    if length_squared <= 1.0e-12:
        return 0.0, (point - start).length
    t = max(0.0, min(1.0, (point - start).dot(axis) / length_squared))
    return t, (point - (start + axis * t)).length


def reweight_arm_surfaces(mesh: bpy.types.Object, rig: bpy.types.Object) -> dict[str, int]:
    """Give the loose kameez sleeves stable two-segment arm weights."""
    report = {}
    for side, sign in (("Left", 1.0), ("Right", -1.0)):
        shoulder = rig.matrix_world @ rig.pose.bones[f"{side}Arm"].head
        elbow = rig.matrix_world @ rig.pose.bones[f"{side}ForeArm"].head
        wrist = rig.matrix_world @ rig.pose.bones[f"{side}Hand"].head
        assignments = {}
        for vertex in mesh.data.vertices:
            point = mesh.matrix_world @ vertex.co
            if point.x * sign < 0.060 or not 0.900 < point.z < 1.420:
                continue
            upper_t, upper_distance = closest_segment(point, shoulder, elbow)
            lower_t, lower_distance = closest_segment(point, elbow, wrist)
            if min(upper_distance, lower_distance) > 0.105:
                continue
            weights = {}
            if upper_distance <= lower_distance:
                shoulder_weight = max(0.0, min(0.42, (0.20 - upper_t) / 0.20 * 0.42))
                forearm_weight = max(0.0, min(0.50, (upper_t - 0.72) / 0.28 * 0.50))
                arm_weight = 1.0 - shoulder_weight - forearm_weight
                if shoulder_weight:
                    weights[f"{side}Shoulder"] = shoulder_weight
                weights[f"{side}Arm"] = arm_weight
                if forearm_weight:
                    weights[f"{side}ForeArm"] = forearm_weight
            else:
                arm_weight = max(0.0, min(0.50, (0.22 - lower_t) / 0.22 * 0.50))
                weights[f"{side}Arm"] = arm_weight
                weights[f"{side}ForeArm"] = 1.0 - arm_weight
            assignments[vertex.index] = weights

        indices = sorted(assignments)
        # These surface vertices belong to a single anatomical arm segment;
        # stale torso/opposite-side weights are the source of ballooning.
        for group in mesh.vertex_groups:
            group.remove(indices)
        needed = {
            name: mesh.vertex_groups.get(name) or mesh.vertex_groups.new(name=name)
            for assignment in assignments.values()
            for name in assignment
        }
        buckets: dict[tuple[str, int], list[int]] = {}
        for index, assignment in assignments.items():
            for name, value in assignment.items():
                quantized = max(0, min(100, round(value * 100)))
                if quantized:
                    buckets.setdefault((name, quantized), []).append(index)
        for (name, quantized), bucket in buckets.items():
            needed[name].add(bucket, quantized / 100.0, "REPLACE")
        report[side] = len(indices)
    mesh.data.update()
    return report


def improve_meshy_material(mesh: bpy.types.Object) -> None:
    for material in mesh.data.materials:
        if not material or not material.use_nodes:
            continue
        material.name = "YTSign_Meshy_Character_Matte"
        shader = next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
        if not shader:
            continue
        shader.inputs["Roughness"].default_value = 0.72
        shader.inputs["Metallic"].default_value = 0.0
        if "Specular IOR Level" in shader.inputs:
            shader.inputs["Specular IOR Level"].default_value = 0.23
        if "Coat Weight" in shader.inputs:
            shader.inputs["Coat Weight"].default_value = 0.0


def local_delta(mesh: bpy.types.Object, world_delta: Vector) -> Vector:
    return mesh.matrix_world.to_3x3().inverted() @ world_delta


def vertex_texture_colors(mesh: bpy.types.Object) -> np.ndarray:
    """Sample the packed base-colour texture once per vertex at reduced size."""
    image_nodes = [
        node
        for material in mesh.data.materials
        if material and material.use_nodes
        for node in material.node_tree.nodes
        if node.type == "TEX_IMAGE" and node.image
    ]
    if not image_nodes or not mesh.data.uv_layers.active:
        raise RuntimeError("Facial mask generation requires the packed base-colour texture and UVMap")
    image = max((node.image for node in image_nodes), key=lambda item: item.size[0] * item.size[1])
    sampled = image.copy()
    sampled.name = "YTSign_FaceMask_Texture_Sample"
    if max(sampled.size) > 1024:
        scale = 1024 / max(sampled.size)
        sampled.scale(max(1, round(sampled.size[0] * scale)), max(1, round(sampled.size[1] * scale)))
    width, height = sampled.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    sampled.pixels.foreach_get(pixels)
    pixels = pixels.reshape((height, width, 4))
    uvs = np.zeros((len(mesh.data.vertices), 2), dtype=np.float32)
    seen = np.zeros(len(mesh.data.vertices), dtype=bool)
    layer = mesh.data.uv_layers.active.data
    for loop in mesh.data.loops:
        index = loop.vertex_index
        if not seen[index]:
            uvs[index] = layer[loop.index].uv
            seen[index] = True
    xs = np.clip((np.mod(uvs[:, 0], 1.0) * (width - 1)).round().astype(np.int32), 0, width - 1)
    ys = np.clip((np.mod(uvs[:, 1], 1.0) * (height - 1)).round().astype(np.int32), 0, height - 1)
    colors = pixels[ys, xs, :3].copy()
    bpy.data.images.remove(sampled)
    return colors


def face_adjacency(mesh: bpy.types.Object, worlds: list[Vector]) -> dict[int, set[int]]:
    eligible = {
        index
        for index, point in enumerate(worlds)
        if abs(point.x) < 0.135 and point.y < -0.052 and 1.410 < point.z < 1.660
    }
    neighbors = {index: set() for index in eligible}
    for edge in mesh.data.edges:
        left, right = edge.vertices
        if left in eligible and right in eligible:
            neighbors[left].add(right)
            neighbors[right].add(left)
    return neighbors


def elliptical_mask(
    worlds: list[Vector],
    colors: np.ndarray,
    skin: np.ndarray,
    neighbors: dict[int, set[int]],
    center_x: float,
    center_z: float,
    radius_x: float,
    radius_z: float,
    *,
    rings: int,
    dark_core: float = 0.0,
    side_sign: float = 0.0,
) -> dict[int, float]:
    q_values = {}
    for index, point in enumerate(worlds):
        if point.y >= -0.068:
            continue
        if side_sign and side_sign * point.x <= 0.006:
            continue
        q = ((point.x - center_x) / radius_x) ** 2 + ((point.z - center_z) / radius_z) ** 2
        if q < 1.0:
            q_values[index] = q
    selected = {index for index in q_values if skin[index]}
    if dark_core > 0.0:
        selected.update(index for index, q in q_values.items() if q <= dark_core)
    frontier = set(selected)
    for _ in range(rings):
        grown = {
            neighbor
            for index in frontier
            for neighbor in neighbors.get(index, ())
            if neighbor in q_values and neighbor not in selected
        }
        selected.update(grown)
        frontier = grown
    result = {}
    for index in selected:
        if q_values[index] >= 1.0:
            continue
        value = max(0.0, (1.0 - q_values[index]) ** 2)
        if side_sign:
            signed_x = side_sign * worlds[index].x
            fade = max(0.0, min(1.0, (signed_x - 0.006) / 0.006))
            fade = fade * fade * (3.0 - 2.0 * fade)
            value *= fade
        if value > 0.0:
            result[index] = value
    return result


def create_face_masks(mesh: bpy.types.Object) -> tuple[dict[str, dict[int, float]], dict]:
    worlds = [mesh.matrix_world @ vertex.co for vertex in mesh.data.vertices]
    colors = vertex_texture_colors(mesh)
    luma = colors @ np.asarray((0.2126, 0.7152, 0.0722), dtype=np.float32)
    cheek_indices = [
        index
        for index, point in enumerate(worlds)
        if 0.015 < abs(point.x) < 0.095 and point.y < -0.066 and 1.515 < point.z < 1.585
    ]
    if len(cheek_indices) < 10:
        raise RuntimeError("Could not establish a stable central-cheek skin reference")
    reference_luma = float(np.median(luma[cheek_indices]))
    reference_rgb = np.median(colors[cheek_indices], axis=0)
    chroma = colors / np.maximum(colors.sum(axis=1, keepdims=True), 1.0e-6)
    reference_chroma = np.median(chroma[cheek_indices], axis=0)
    chroma_distance = np.linalg.norm(chroma - reference_chroma, axis=1)
    skin = (luma >= reference_luma * 0.34) & (chroma_distance <= 0.16)
    neighbors = face_adjacency(mesh, worlds)

    masks = {}
    # Landmarks were measured from orthographic front renders of the imported
    # neutral mesh.  Meshy's eyes sit materially lower than the first rough
    # estimates; keeping these masks tight is essential because the hair and
    # face live in the same patchwork mesh.
    # Keep the two sockets disjoint.  Earlier masks overlapped across the
    # bridge of the nose, so a bilateral blink collapsed a strip of nasal
    # skin into one long horizontal seam.
    for side, center_x, side_sign in (("Left", 0.041, 1.0), ("Right", -0.041, -1.0)):
        eyelid = elliptical_mask(
            worlds, colors, skin, neighbors, center_x, 1.559, 0.035, 0.020,
            rings=1, dark_core=1.0, side_sign=side_sign,
        )
        # Eyelids need a much gentler edge falloff than other expressions so
        # the full sclera retreats behind the lash line at value 1.0.
        masks[f"Eyelid{side}"] = {
            index: min(1.0, math.sqrt(value) * 1.55)
            for index, value in eyelid.items()
        }
        masks[f"Brow{side}"] = elliptical_mask(
            worlds, colors, skin, neighbors, center_x, 1.584, 0.046, 0.013,
            rings=1, dark_core=0.92,
        )
    overlap = set(masks["EyelidLeft"]) & set(masks["EyelidRight"])
    if overlap:
        raise RuntimeError(f"Eyelid masks overlap on {len(overlap)} vertices")
    if any(abs(worlds[index].x) <= 0.006 for side in ("Left", "Right") for index in masks[f"Eyelid{side}"]):
        raise RuntimeError("Eyelid mask crossed into the protected nose strip")
    masks["Mouth"] = elliptical_mask(
        worlds, colors, skin, neighbors, 0.0, 1.490, 0.073, 0.030,
        rings=2, dark_core=0.82,
    )
    masks["Jaw"] = elliptical_mask(
        worlds, colors, skin, neighbors, 0.0, 1.469, 0.090, 0.062,
        rings=2, dark_core=0.72,
    )
    masks["CheekLeft"] = elliptical_mask(
        worlds, colors, skin, neighbors, 0.070, 1.535, 0.052, 0.040,
        rings=1,
    )
    masks["CheekRight"] = elliptical_mask(
        worlds, colors, skin, neighbors, -0.070, 1.535, 0.052, 0.040,
        rings=1,
    )
    metadata = {
        "skin_reference_luma": reference_luma,
        "skin_reference_rgb": [float(value) for value in reference_rgb],
        "skin_vertex_count": int(np.count_nonzero(skin)),
        "mask_vertex_counts": {name: len(mask) for name, mask in masks.items()},
    }
    return masks, metadata


def add_expression(
    mesh: bpy.types.Object,
    name: str,
    mask: dict[int, float],
    displacement,
) -> int:
    if mesh.data.shape_keys is None:
        mesh.shape_key_add(name="Basis", from_mix=False)
    basis = mesh.data.shape_keys.key_blocks[0]
    key = mesh.shape_key_add(name=name, from_mix=False)
    affected = 0
    max_delta = 0.0
    for index, mask_weight in mask.items():
        if mask_weight <= 0.0:
            continue
        world = mesh.matrix_world @ basis.data[index].co
        delta = displacement(world) * mask_weight
        key.data[index].co = basis.data[index].co + local_delta(mesh, delta)
        max_delta = max(max_delta, delta.length)
        affected += 1
    key.value = 0.0
    key.slider_min = 0.0
    key.slider_max = 1.0
    return affected


def create_face_rig(mesh: bpy.types.Object) -> tuple[dict[str, int], dict]:
    masks, metadata = create_face_masks(mesh)
    shapes = {}
    shapes["BlinkLeft"] = add_expression(
        mesh,
        "BlinkLeft",
        masks["EyelidLeft"],
        lambda p: Vector((0.0, 0.0080, (1.5585 - p.z) * 1.15)),
    )
    shapes["BlinkRight"] = add_expression(
        mesh,
        "BlinkRight",
        masks["EyelidRight"],
        lambda p: Vector((0.0, 0.0080, (1.5585 - p.z) * 1.15)),
    )
    for side in ("Left", "Right"):
        shapes[f"BrowRaise{side}"] = add_expression(
            mesh,
            f"BrowRaise{side}",
            masks[f"Brow{side}"],
            lambda p: Vector((0.0, -0.0008, 0.0105)),
        )
    furrow_mask = dict(masks["BrowLeft"])
    furrow_mask.update(masks["BrowRight"])
    shapes["BrowFurrow"] = add_expression(
        mesh,
        "BrowFurrow",
        furrow_mask,
        lambda p: Vector((-math.copysign(0.0055, p.x or 1.0), -0.0010, -0.0045)),
    )
    shapes["Smile"] = add_expression(
        mesh,
        "Smile",
        masks["Mouth"],
        lambda p: Vector((math.copysign(0.0055, p.x), -0.0020, 0.014 * min(1.0, abs(p.x) / 0.052))),
    )
    shapes["Frown"] = add_expression(
        mesh,
        "Frown",
        masks["Mouth"],
        lambda p: Vector((0.0, 0.0008, -0.012 * min(1.0, abs(p.x) / 0.052))),
    )
    shapes["JawOpen"] = add_expression(
        mesh,
        "JawOpen",
        masks["Jaw"],
        lambda p: Vector((0.0, 0.0025, (0.004 if p.z >= 1.490 else -0.023))),
    )
    shapes["MouthPucker"] = add_expression(
        mesh,
        "MouthPucker",
        masks["Mouth"],
        lambda p: Vector((-p.x * 0.32, -0.009, (1.490 - p.z) * 0.16)),
    )
    shapes["MouthWide"] = add_expression(
        mesh,
        "MouthWide",
        masks["Mouth"],
        lambda p: Vector((p.x * 0.30, 0.0008, (p.z - 1.490) * 0.34)),
    )
    cheek_mask = dict(masks["CheekLeft"])
    cheek_mask.update(masks["CheekRight"])
    shapes["CheekRaise"] = add_expression(
        mesh,
        "CheekRaise",
        cheek_mask,
        lambda p: Vector((math.copysign(0.002, p.x), -0.001, 0.005)),
    )
    return shapes, metadata


def overlay_material(name: str, color: tuple[float, float, float, float], roughness: float) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Roughness"].default_value = roughness
    if "Specular IOR Level" in shader.inputs:
        shader.inputs["Specular IOR Level"].default_value = 0.22
    return material


def bind_head_object(
    obj: bpy.types.Object,
    body: bpy.types.Object,
    rig: bpy.types.Object,
) -> None:
    obj.parent = rig
    obj.matrix_parent_inverse = body.matrix_parent_inverse.copy()
    obj.matrix_basis = body.matrix_basis.copy()
    group = obj.vertex_groups.new(name="Head")
    group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    modifier = obj.modifiers.new("YTSign_Head_Armature", "ARMATURE")
    modifier.object = rig
    modifier.use_deform_preserve_volume = False
    obj["ytsign_export"] = True


def create_morph_disk(
    name: str,
    body: bpy.types.Object,
    rig: bpy.types.Object,
    center_x: float,
    center_y: float,
    center_z: float,
    targets: dict[str, tuple[float, float]],
    material: bpy.types.Material,
    *,
    segments: int = 48,
    neutral_z_offset: float = 0.0,
) -> bpy.types.Object:
    max_rx = max(value[0] for value in targets.values())
    max_rz = max(value[1] for value in targets.values())
    world_vertices = [Vector((center_x, center_y, center_z))]
    for index in range(segments):
        angle = math.tau * index / segments
        world_vertices.append(
            Vector((center_x + max_rx * math.cos(angle), center_y, center_z + max_rz * math.sin(angle)))
        )
    local_vertices = [body.matrix_world.inverted() @ point for point in world_vertices]
    faces = [(0, index + 1, ((index + 1) % segments) + 1) for index in range(segments)]
    data = bpy.data.meshes.new(f"{name}_Mesh")
    data.from_pydata(local_vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(material)
    bind_head_object(obj, body, rig)
    basis = obj.shape_key_add(name="Basis", from_mix=False)
    for index, point in enumerate(world_vertices):
        collapsed = Vector((point.x, center_y, center_z + neutral_z_offset))
        basis.data[index].co = body.matrix_world.inverted() @ collapsed
    for target_name, (radius_x, radius_z) in targets.items():
        key = obj.shape_key_add(name=target_name, from_mix=False)
        target_world = [Vector((center_x, center_y, center_z))]
        for index in range(segments):
            angle = math.tau * index / segments
            target_world.append(
                Vector((center_x + radius_x * math.cos(angle), center_y, center_z + radius_z * math.sin(angle)))
            )
        for index, point in enumerate(target_world):
            key.data[index].co = body.matrix_world.inverted() @ point
        key.value = 0.0
    return obj


def create_face_overlays(
    body: bpy.types.Object,
    rig: bpy.types.Object,
    metadata: dict,
) -> list[bpy.types.Object]:
    sampled = metadata.get("skin_reference_rgb", (0.72, 0.42, 0.31))
    # A restrained warm adjustment matches the rendered cheek more closely
    # than unmodified bright texture samples under studio lighting.
    skin_color = tuple(max(0.0, min(1.0, value * 0.90)) for value in sampled) + (1.0,)
    lid_material = overlay_material("YTSign_Eyelid_Skin", skin_color, 0.64)
    mouth_material = overlay_material("YTSign_Mouth_Interior", (0.055, 0.006, 0.009, 1.0), 0.72)
    overlays = []
    for side, center_x in (("Left", 0.040), ("Right", -0.040)):
        overlays.append(
            create_morph_disk(
                f"YTSign_Eyelid_{side}",
                body,
                rig,
                center_x,
                -0.0945,
                1.592,
                {f"Blink{side}": (0.036, 0.0145)},
                lid_material,
                neutral_z_offset=0.0145,
            )
        )
    overlays.append(
        create_morph_disk(
            "YTSign_Mouth_Interior",
            body,
            rig,
            0.0,
            -0.1115,
            1.506,
            {
                "JawOpen": (0.044, 0.017),
                "MouthPucker": (0.025, 0.018),
                "MouthWide": (0.057, 0.010),
            },
            mouth_material,
        )
    )
    return overlays


def clean_lower_hair_fragments(mesh: bpy.types.Object) -> dict:
    """Trim only verified rear-hair components below the retained crown.

    The source's face frame and crown are intentionally preserved.  A topology
    component is eligible only when at least 90% of it classifies as dark hair,
    its complete bounds sit behind the face inside the measured head volume,
    and it has no face-plane anchor.  Only the portion below the crown cut is
    removed; the compact shell covers that cut.  This fail-closed recipe was
    measured against rendered component isolates, not inferred from colour
    alone.
    """
    roots, records = topology_components(mesh)
    colors = vertex_texture_colors(mesh)
    luma = colors @ np.asarray((0.2126, 0.7152, 0.0722), dtype=np.float32)
    worlds = np.asarray([mesh.matrix_world @ vertex.co for vertex in mesh.data.vertices])
    members: dict[int, list[int]] = {}
    for vertex, root in zip(mesh.data.vertices, roots):
        members.setdefault(root, []).append(vertex.index)

    selected_roots: set[int] = set()
    selected: set[int] = set()
    component_report = []
    for root, indices in members.items():
        index_array = np.asarray(indices, dtype=np.int32)
        points = worlds[index_array]
        sampled = colors[index_array]
        sampled_luma = luma[index_array]
        bounds_min = points.min(axis=0)
        bounds_max = points.max(axis=0)
        sampled_chroma = sampled / np.maximum(sampled.sum(axis=1, keepdims=True), 1.0e-6)
        hair_mask = (sampled_luma < 0.24) & (sampled_chroma[:, 0] < 0.56)
        hair_ratio = float(np.count_nonzero(hair_mask) / len(indices))
        face_anchors = int(
            np.count_nonzero(
                (np.abs(points[:, 0]) < 0.105)
                & (points[:, 1] < -0.055)
                & (points[:, 2] > 1.40)
                & (points[:, 2] < 1.66)
            )
        )
        bounded = (
            float(bounds_min[0]) > -0.19
            and float(bounds_max[0]) < 0.19
            and float(bounds_min[1]) > -0.030
            and float(bounds_max[1]) < 0.180
            and float(bounds_min[2]) > 1.29
            and float(bounds_max[2]) < 1.70
        )
        if bounded and hair_ratio >= 0.90 and face_anchors == 0:
            selected_roots.add(root)
            trimmed = [index for index in indices if worlds[index][2] < 1.505]
            selected.update(trimmed)
            component_report.append(
                {
                    "root": root,
                    "component_vertices": len(indices),
                    "trimmed_vertices": len(trimmed),
                    "hair_ratio": hair_ratio,
                    "face_anchors": face_anchors,
                }
            )

    if not 16500 <= len(selected) <= 17300:
        raise RuntimeError(f"Legacy hair cleanup selected an unsafe {len(selected)} vertices")
    if not 580 <= len(selected_roots) <= 630:
        raise RuntimeError(f"Legacy hair cleanup matched an unsafe {len(selected_roots)} components")
    editable = bmesh.new()
    editable.from_mesh(mesh.data)
    editable.verts.ensure_lookup_table()
    bmesh.ops.delete(editable, geom=[editable.verts[index] for index in sorted(selected)], context="VERTS")
    editable.to_mesh(mesh.data)
    editable.free()
    mesh.data.update()
    return {
        "strategy": "verified-rear-components-below-crown",
        "components": len(selected_roots),
        "vertices": len(selected),
        "removed": component_report,
    }


def stabilize_central_garment(mesh: bpy.types.Object) -> dict:
    """Remove leaked arm weights from garment vertices away from the arms.

    The source contains body-spanning topology islands, so topology and simple
    height gates cannot distinguish a sleeve from an abdomen patch.  Distance
    from the authored upper/forearm bone segments is the reliable separator:
    true sleeve surface stays near an arm axis; wrongly weighted torso cloth is
    many centimetres away.  Only those distant vertices lose arm influence.
    """
    rig = mesh.parent
    if rig is None or rig.type != "ARMATURE":
        raise RuntimeError("Central-garment stabilization requires the parent armature")

    def segment_distance(point: Vector, start: Vector, end: Vector) -> float:
        delta = end - start
        length_squared = delta.length_squared
        if length_squared < 1.0e-10:
            return (point - start).length
        factor = max(0.0, min(1.0, (point - start).dot(delta) / length_squared))
        return (point - (start + delta * factor)).length

    arm_segments = []
    for side in ("Left", "Right"):
        for name in (f"{side}Arm", f"{side}ForeArm"):
            bone = rig.data.bones[name]
            arm_segments.append(
                (
                    rig.matrix_world @ bone.head_local,
                    rig.matrix_world @ bone.tail_local,
                )
            )
    arm_names = {
        f"{side}{bone}"
        for side in ("Left", "Right")
        for bone in ("Shoulder", "Arm", "ForeArm", "Hand")
    }
    arm_groups = {group.index: group for group in mesh.vertex_groups if group.name in arm_names}
    selected = []
    assignments: dict[int, dict[str, float]] = {}
    for vertex in mesh.data.vertices:
        point = mesh.matrix_world @ vertex.co
        if not (0.50 < point.z < 1.16 and abs(point.x) < 0.30 and point.y < 0.075):
            continue
        distance = min(segment_distance(point, start, end) for start, end in arm_segments)
        if distance < 0.082:
            continue
        arm_sum = sum(entry.weight for entry in vertex.groups if entry.group in arm_groups)
        if arm_sum < 0.003:
            continue
        survivor = {
            mesh.vertex_groups[entry.group].name: entry.weight
            for entry in vertex.groups
            if entry.group not in arm_groups and entry.weight > 1.0e-5
        }
        total = sum(survivor.values())
        if total < 0.04:
            blend = max(0.0, min(0.45, (point.z - 0.68) / 0.245 * 0.45))
            survivor = {"Hips": 1.0 - blend, "Spine": blend}
        else:
            survivor = {name: value / total for name, value in survivor.items()}
        selected.append(vertex.index)
        assignments[vertex.index] = survivor
    for group in arm_groups.values():
        group.remove(selected)
    buckets: dict[tuple[str, int], list[int]] = {}
    for index, values in assignments.items():
        for name, value in values.items():
            quantized = max(1, min(1000, round(value * 1000)))
            buckets.setdefault((name, quantized), []).append(index)
    for (name, quantized), indices in buckets.items():
        group = mesh.vertex_groups.get(name) or mesh.vertex_groups.new(name=name)
        group.add(indices, quantized / 1000.0, "REPLACE")
    mesh.data.update()
    return {
        "vertices": len(selected),
        "region": "front-kameez-away-from-arm-segments",
        "minimum_arm_axis_distance": 0.082,
    }


def bind_bone_object(
    obj: bpy.types.Object,
    body: bpy.types.Object,
    rig: bpy.types.Object,
    bone_name: str,
) -> None:
    obj.parent = rig
    obj.matrix_parent_inverse = body.matrix_parent_inverse.copy()
    obj.matrix_basis = body.matrix_basis.copy()
    group = obj.vertex_groups.new(name=bone_name)
    group.add(list(range(len(obj.data.vertices))), 1.0, "REPLACE")
    modifier = obj.modifiers.new("YTSign_Armature", "ARMATURE")
    modifier.object = rig
    modifier.use_deform_preserve_volume = False
    obj["ytsign_export"] = True


def create_sleeve_hem(
    body: bpy.types.Object,
    rig: bpy.types.Object,
    side: str,
) -> bpy.types.Object:
    """Close the raw sleeve opening with a recessed, cloth-matched annulus.

    This is deliberately not an external bracelet or a replacement cuff.  All
    geometry sits between the anatomical wrist and the inside of the authored
    sleeve, so the embroidered source edge remains the visible silhouette.
    """
    wrist = rig.matrix_world @ rig.data.bones[f"{side}Hand"].head_local
    elbow = rig.matrix_world @ rig.data.bones[f"{side}ForeArm"].head_local
    axis = (elbow - wrist).normalized()
    depth = Vector((0.0, -1.0, 0.0))
    tangent = axis.cross(depth).normalized()
    normal = tangent.cross(axis).normalized()
    # The outer ring is buried inside the existing sleeve and the inner ring
    # meets the donor wrist.  A middle ring gives the fill a soft rolled-cloth
    # profile while keeping the hand opening clear.
    if side == "Left":
        rings = (
            (0.0160, 0.0248, 0.0208),
            (0.0240, 0.0315, 0.0255),
            (0.0320, 0.0425, 0.0325),
        )
    else:
        rings = (
            (0.0160, 0.0248, 0.0208),
            (0.0240, 0.0305, 0.0250),
            (0.0320, 0.0405, 0.0320),
        )
    segments = 48
    world_vertices = []
    for offset, radius_t, radius_n in rings:
        center = wrist + axis * offset
        for index in range(segments):
            angle = math.tau * index / segments
            world_vertices.append(
                center + tangent * (math.cos(angle) * radius_t) + normal * (math.sin(angle) * radius_n)
            )
    faces = []
    for ring in range(len(rings) - 1):
        for index in range(segments):
            following = (index + 1) % segments
            faces.append(
                (
                    ring * segments + index,
                    ring * segments + following,
                    (ring + 1) * segments + following,
                    (ring + 1) * segments + index,
                )
            )
    inverse = body.matrix_world.inverted()
    data = bpy.data.meshes.new(f"YTSign_SleeveHem_{side}_Mesh")
    data.from_pydata([inverse @ point for point in world_vertices], [], faces)
    data.update()
    source_uv = body.data.uv_layers.active
    if source_uv is None:
        raise RuntimeError("Source body is missing its cuff UV map")
    target_uv = data.uv_layers.new(name=source_uv.name)
    for loop in data.loops:
        vertex_index = loop.vertex_index
        ring = vertex_index // segments
        segment = vertex_index % segments
        # Sample one uninterrupted, plain-maroon fabric patch from the source
        # atlas.  Nearest-point UV transfer crossed dozens of atlas islands and
        # produced striped plastic; this continuous patch preserves the exact
        # kameez weave and colour without borrowing embroidery or skin.
        target_uv.data[loop.index].uv = (
            0.52 + (segment / (segments - 1) - 0.5) * 0.012,
            0.58 + (ring / (len(rings) - 1) - 0.5) * 0.012,
        )
    obj = bpy.data.objects.new(f"YTSign_SleeveHem_{side}", data)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(body.data.materials[0])
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
        polygon.material_index = 0
    bind_bone_object(obj, body, rig, f"{side}ForeArm")
    return obj


def create_fingernails(
    body: bpy.types.Object,
    rig: bpy.types.Object,
    frames: dict[str, HandFrame],
) -> list[bpy.types.Object]:
    """Add restrained nail plates to all distal phalanges for dorsal clarity."""
    material = overlay_material("YTSign_Nail_Material", (0.24, 0.12, 0.10, 1.0), 0.56)
    material.use_backface_culling = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    if "Coat Weight" in shader.inputs:
        shader.inputs["Coat Weight"].default_value = 0.07
    if "Coat Roughness" in shader.inputs:
        shader.inputs["Coat Roughness"].default_value = 0.38
    inverse = body.matrix_world.inverted()
    objects = []
    for side, frame in frames.items():
        dorsal = -frame.normal.normalized()
        for finger in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
            bone_name = f"{side}Hand{finger}3"
            bone = rig.data.bones[bone_name]
            head = rig.matrix_world @ bone.head_local
            tail = rig.matrix_world @ bone.tail_local
            along = (tail - head).normalized()
            across = dorsal.cross(along)
            if across.length < 1.0e-5:
                across = frame.transverse.copy()
            across.normalize()
            surface = along.cross(across).normalized()
            if surface.dot(dorsal) < 0.0:
                surface.negate()
            bone_length = (tail - head).length
            width = 0.0048 if finger == "Thumb" else 0.0038
            length = max(0.0048, min(0.0065, bone_length * 0.30))
            center = tail - along * (length + 0.0018) + surface * 0.0034
            segments = 24
            world_vertices = [center + surface * 0.00035]
            for ring in range(1, 5):
                radius = ring / 4.0
                for segment in range(segments):
                    angle = math.tau * segment / segments
                    world_vertices.append(
                        center
                        + across * (math.sin(angle) * radius * width)
                        + along * (math.cos(angle) * radius * length)
                        + surface * (0.00035 * (1.0 - radius * radius))
                    )
            faces = []
            for segment in range(segments):
                following = (segment + 1) % segments
                faces.append((0, 1 + segment, 1 + following))
            for ring in range(3):
                start = 1 + ring * segments
                following_start = start + segments
                for segment in range(segments):
                    following = (segment + 1) % segments
                    faces.append(
                        (
                            start + segment,
                            following_start + segment,
                            following_start + following,
                            start + following,
                        )
                    )
            data = bpy.data.meshes.new(f"YTSign_Nail_{side}_{finger}_Mesh")
            data.from_pydata([inverse @ point for point in world_vertices], [], faces)
            data.update()
            obj = bpy.data.objects.new(f"YTSign_Nail_{side}_{finger}", data)
            bpy.context.scene.collection.objects.link(obj)
            for polygon in obj.data.polygons:
                polygon.use_smooth = True
            obj.data.materials.append(material)
            bind_bone_object(obj, body, rig, bone_name)
            objects.append(obj)
    return objects


def create_hair_clump(
    body: bpy.types.Object,
    rig: bpy.types.Object,
    name: str,
    center: Vector,
    scale: Vector,
    phase: float,
    material: bpy.types.Material,
    bottom_taper: float = 0.90,
    tip_sweep: Vector | None = None,
    face_clamp: bool = False,
) -> bpy.types.Object:
    editable = bmesh.new()
    bmesh.ops.create_uvsphere(editable, u_segments=40, v_segments=28, radius=1.0)
    data = bpy.data.meshes.new(f"{name}_Mesh")
    editable.to_mesh(data)
    editable.free()
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    inverse = body.matrix_world.inverted()
    for vertex in obj.data.vertices:
        unit = vertex.co.copy()
        longitude = math.atan2(unit.y, unit.x)
        # Broad, restrained silhouette breakup; high-frequency longitude
        # ridges produced an artificial vertical moire pattern in the browser.
        ridge = 1.0 + 0.003 * math.sin(longitude * 3.0 + phase) * (1.0 - 0.35 * abs(unit.z))
        height = (unit.z + 1.0) * 0.5
        smooth_height = height * height * (3.0 - 2.0 * height)
        taper = bottom_taper + (1.0 - bottom_taper) * smooth_height
        sweep = (tip_sweep or Vector((0.0, 0.0, 0.0))) * ((1.0 - height) ** 2)
        lower = max(0.0, min(1.0, (-unit.z - 0.10) / 0.68))
        lower = lower * lower * (3.0 - 2.0 * lower)
        bun_side = max(0.0, min(1.0, (unit.y - 0.10) / 0.62))
        bun_side = bun_side * bun_side * (3.0 - 2.0 * bun_side)
        bun = math.exp(-((unit.z + 0.50) / 0.26) ** 2) * bun_side
        world = Vector(
            (
                center.x + unit.x * scale.x * ridge * taper * (1.0 - 0.15 * lower) + sweep.x,
                center.y + unit.y * scale.y * ridge + 0.030 * bun + sweep.y,
                center.z + unit.z * scale.z + sweep.z,
            )
        )
        world.x *= 1.0 - 0.10 * bun
        if face_clamp:
            side = max(0.0, min(1.0, (abs(unit.x) - 0.35) / 0.50))
            side = side * side * (3.0 - 2.0 * side)
            front_limit = -0.010 + (-0.028 + 0.010) * side
            world.y = max(world.y, front_limit)
            world.y += 0.022 * max(0.0, -unit.y) * side
        vertex.co = inverse @ world
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    obj.data.materials.append(material)
    bind_head_object(obj, body, rig)
    return obj


def create_hair_material() -> bpy.types.Material:
    """Return a warm dark-brown strand material shared by the whole groom."""
    existing = bpy.data.materials.get("YTSign_Hair_Material")
    if existing is not None:
        return existing
    material = bpy.data.materials.new("YTSign_Hair_Material")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    for node in list(nodes):
        nodes.remove(node)
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Roughness"].default_value = 0.52
    if "Specular IOR Level" in shader.inputs:
        shader.inputs["Specular IOR Level"].default_value = 0.18
    if "Coat Weight" in shader.inputs:
        shader.inputs["Coat Weight"].default_value = 0.04
    if "Coat Roughness" in shader.inputs:
        shader.inputs["Coat Roughness"].default_value = 0.42
    if "Anisotropic IOR Level" in shader.inputs:
        shader.inputs["Anisotropic IOR Level"].default_value = 0.24
    texture_coordinate = nodes.new("ShaderNodeTexCoord")
    noise = nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 4.2
    noise.inputs["Detail"].default_value = 2.4
    noise.inputs["Roughness"].default_value = 0.55
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.18
    ramp.color_ramp.elements[0].color = (0.010, 0.0035, 0.0018, 1.0)
    ramp.color_ramp.elements[1].position = 0.82
    ramp.color_ramp.elements[1].color = (0.060, 0.020, 0.009, 1.0)
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.012
    bump.inputs["Distance"].default_value = 0.0015
    links.new(texture_coordinate.outputs["Generated"], noise.inputs["Vector"])
    links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    links.new(ramp.outputs["Color"], shader.inputs["Base Color"])
    links.new(noise.outputs["Fac"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return material


def create_hair_lock(
    body: bpy.types.Object,
    rig: bpy.types.Object,
    name: str,
    path: list[Vector],
    radii: list[tuple[float, float]],
    phase: float,
    material: bpy.types.Material,
) -> bpy.types.Object:
    """Build a tapered, ridged tube lock along a world-space guide path."""
    if len(path) != len(radii) or len(path) < 2:
        raise ValueError("Hair-lock path and radii must have matching lengths")
    segments = 18
    inverse = body.matrix_world.inverted()
    local_vertices = []
    for ring, (point, (radius_x, radius_y)) in enumerate(zip(path, radii)):
        previous = path[max(0, ring - 1)]
        following = path[min(len(path) - 1, ring + 1)]
        tangent = (following - previous).normalized()
        across = tangent.cross(Vector((0.0, 1.0, 0.0)))
        if across.length < 1.0e-5:
            across = tangent.cross(Vector((1.0, 0.0, 0.0)))
        across.normalize()
        depth = across.cross(tangent).normalized()
        for segment in range(segments):
            angle = math.tau * segment / segments
            strand = 1.0 + 0.035 * math.sin(angle * 5.0 + phase + ring * 0.38)
            world = (
                point
                + across * (math.cos(angle) * radius_x * strand)
                + depth * (math.sin(angle) * radius_y * strand)
            )
            local_vertices.append(inverse @ world)
    faces = []
    for ring in range(len(path) - 1):
        for segment in range(segments):
            following = (segment + 1) % segments
            faces.append(
                (
                    ring * segments + segment,
                    ring * segments + following,
                    (ring + 1) * segments + following,
                    (ring + 1) * segments + segment,
                )
            )
    faces.append(tuple(reversed(range(segments))))
    last = (len(path) - 1) * segments
    faces.append(tuple(last + index for index in range(segments)))
    data = bpy.data.meshes.new(f"{name}_Mesh")
    data.from_pydata(local_vertices, [], faces)
    data.update()
    for polygon in data.polygons:
        polygon.use_smooth = True
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(material)
    bind_head_object(obj, body, rig)
    return obj


def create_signing_safe_hair(body: bpy.types.Object, rig: bpy.types.Object) -> list[bpy.types.Object]:
    """Build one connected, close-to-head shoulder-clear bob shell."""
    hair = create_hair_material()
    shell = create_hair_clump(
        body,
        rig,
        "YTSign_Hair",
        Vector((0.0, 0.076, 1.482)),
        Vector((0.117, 0.084, 0.140)),
        0.7,
        hair,
        bottom_taper=0.70,
        face_clamp=True,
    )
    return [shell]


def create_mouth_interior(body: bpy.types.Object, rig: bpy.types.Object) -> list[bpy.types.Object]:
    """Add recessed oral-cavity and upper-teeth volumes behind the real lips."""
    specifications = (
        (
            "YTSign_Mouth_Cavity",
            Vector((0.0, -0.109, 1.489)),
            Vector((0.062, 0.014, 0.029)),
            overlay_material("YTSign_Mouth_Cavity_Material", (0.055, 0.006, 0.009, 1.0), 0.80),
        ),
        (
            "YTSign_Upper_Teeth",
            Vector((0.0, -0.112, 1.499)),
            Vector((0.039, 0.008, 0.0055)),
            overlay_material("YTSign_Teeth_Material", (0.72, 0.57, 0.44, 1.0), 0.52),
        ),
    )
    objects = []
    inverse = body.matrix_world.inverted()
    for name, center, scale, material in specifications:
        editable = bmesh.new()
        bmesh.ops.create_uvsphere(editable, u_segments=32, v_segments=20, radius=1.0)
        data = bpy.data.meshes.new(f"{name}_Mesh")
        editable.to_mesh(data)
        editable.free()
        obj = bpy.data.objects.new(name, data)
        bpy.context.scene.collection.objects.link(obj)
        full_coordinates = []
        for vertex in obj.data.vertices:
            unit = vertex.co.copy()
            coordinate = inverse @ Vector(
                (
                    center.x + unit.x * scale.x,
                    center.y + unit.y * scale.y,
                    center.z + unit.z * scale.z,
                )
            )
            vertex.co = coordinate
            full_coordinates.append(coordinate.copy())
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
        obj.data.materials.append(material)
        bind_head_object(obj, body, rig)
        basis = obj.shape_key_add(name="Basis", from_mix=False)
        opened = obj.shape_key_add(name="JawOpen", from_mix=False)
        wide = obj.shape_key_add(name="MouthWide", from_mix=False)
        collapsed = inverse @ center
        for index, coordinate in enumerate(full_coordinates):
            basis.data[index].co = collapsed
            opened.data[index].co = coordinate
            delta = coordinate - collapsed
            wide.data[index].co = collapsed + Vector((delta.x * 1.16, delta.y, delta.z * 0.56))
        opened.value = 0.0
        wide.value = 0.0
        objects.append(obj)
    return objects


def create_garment_repair_panel(body: bpy.types.Object, rig: bpy.types.Object) -> tuple[bpy.types.Object, dict]:
    """Duplicate the actual textured kameez front as a stable repair shell.

    A generated UV grid visibly mismatched the source pattern.  Copying each
    selected source polygon and every loop UV preserves the exact authored
    texture while independent torso weights keep the shell closed during arm
    motion.  Per-loop vertices intentionally preserve UV seams losslessly.
    """
    body.data.update()
    world_matrix = body.matrix_world
    normal_matrix = world_matrix.to_3x3()
    inverse = world_matrix.inverted()
    selected_polygons = []
    for polygon in body.data.polygons:
        center = world_matrix @ polygon.center
        normal = (normal_matrix @ polygon.normal).normalized()
        # Meshy sleeve islands begin at roughly z=0.937 in rest pose.  The
        # wider lower shell stays below them; a narrower upper tongue reaches
        # the under-rib tear without touching the outer sleeve islands.
        lower_panel = 0.52 < center.z < 0.935 and abs(center.x) < 0.292
        upper_panel = 0.925 <= center.z < 1.075 and abs(center.x) < 0.225
        if not ((lower_panel or upper_panel) and center.y < 0.045):
            continue
        if normal.y > 0.15:
            continue
        selected_polygons.append(polygon)
    if len(selected_polygons) < 100:
        raise RuntimeError(f"Could not locate enough front-kameez polygons: {len(selected_polygons)}")

    source_uv = body.data.uv_layers.active
    if source_uv is None:
        raise RuntimeError("Source kameez does not have an active UV layer")
    local_vertices = []
    faces = []
    loop_uvs = []
    source_indices = []
    vertex_map: dict[int, int] = {}
    material_indices = []
    smooth_flags = []
    for polygon in selected_polygons:
        face = []
        for loop_index in polygon.loop_indices:
            loop = body.data.loops[loop_index]
            source_index = loop.vertex_index
            if source_index not in vertex_map:
                source_vertex = body.data.vertices[source_index]
                world = world_matrix @ source_vertex.co
                # The front camera looks along +Y, so a tiny negative-Y
                # offset prevents z-fighting and places the repair above the
                # source.  Sharing source vertices preserves smooth topology;
                # UV seams remain per-loop below.
                vertex_map[source_index] = len(local_vertices)
                local_vertices.append(inverse @ (world + Vector((0.0, -0.0100, 0.0))))
                source_indices.append(source_index)
            face.append(vertex_map[source_index])
            loop_uvs.append(source_uv.data[loop_index].uv.copy())
        faces.append(tuple(face))
        material_indices.append(polygon.material_index)
        smooth_flags.append(polygon.use_smooth)

    data = bpy.data.meshes.new("YTSign_Kameez_Repair_Mesh")
    data.from_pydata(local_vertices, [], faces)
    data.update()
    target_uv = data.uv_layers.new(name=source_uv.name)
    for loop in data.loops:
        target_uv.data[loop.index].uv = loop_uvs[loop.index]
    for material in body.data.materials:
        data.materials.append(material)
    for index, polygon in enumerate(data.polygons):
        polygon.material_index = min(material_indices[index], max(0, len(data.materials) - 1))
        polygon.use_smooth = smooth_flags[index]

    obj = bpy.data.objects.new("YTSign_Kameez_Repair", data)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = rig
    obj.matrix_parent_inverse = body.matrix_parent_inverse.copy()
    obj.matrix_basis = body.matrix_basis.copy()

    arm_names = {
        f"{side}{bone}"
        for side in ("Left", "Right")
        for bone in ("Shoulder", "Arm", "ForeArm", "Hand")
    }
    assignments: dict[str, list[tuple[int, float]]] = {}
    for new_index, source_index in enumerate(source_indices):
        source_vertex = body.data.vertices[source_index]
        survivors = {
            body.vertex_groups[item.group].name: item.weight
            for item in source_vertex.groups
            if body.vertex_groups[item.group].name not in arm_names and item.weight > 1.0e-5
        }
        total = sum(survivors.values())
        if total < 0.04:
            z = (world_matrix @ source_vertex.co).z
            spine_weight = max(0.0, min(0.62, (z - 0.68) / 0.30 * 0.62))
            survivors = {"Hips": 1.0 - spine_weight, "Spine": spine_weight}
        else:
            survivors = {name: value / total for name, value in survivors.items()}
        for name, value in survivors.items():
            assignments.setdefault(name, []).append((new_index, value))
    for name, values in assignments.items():
        group = obj.vertex_groups.new(name=name)
        buckets: dict[int, list[int]] = {}
        for index, value in values:
            buckets.setdefault(max(1, min(1000, round(value * 1000))), []).append(index)
        for quantized, indices in buckets.items():
            group.add(indices, quantized / 1000.0, "REPLACE")
    modifier = obj.modifiers.new("YTSign_Armature", "ARMATURE")
    modifier.object = rig
    modifier.use_deform_preserve_volume = False
    obj["ytsign_export"] = True
    metadata = {
        "strategy": "source-polygon-duplicate-with-loop-uvs",
        "source_polygons": len(selected_polygons),
        "vertices": len(local_vertices),
        "topology": "shared-source-vertices-with-per-loop-uvs",
        "offset_y": -0.0100,
    }
    return obj, metadata


def scene_metadata(armature: bpy.types.Object, body: bpy.types.Object) -> None:
    scene = bpy.context.scene
    scene["ytsign_avatar_version"] = "5.1-hybrid"
    scene["ytsign_primary_language"] = "PSL"
    scene["ytsign_source_note"] = "Meshy authored character + MPFB CC0 anatomical hands"
    armature.name = "YTSign_PSL_Rig"
    armature["ytsign_signing_rig"] = "psl-v5.1-hybrid"
    body.name = "YTSign_PSL_Signer_Body"
    body["ytsign_avatar"] = True


def export_avatar(
    armature: bpy.types.Object,
    body: bpy.types.Object,
    hands: list[bpy.types.Object],
    extras: list[bpy.types.Object],
    blend_path: Path,
    glb_path: Path,
) -> dict[str, dict]:
    blend_path.parent.mkdir(parents=True, exist_ok=True)
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    # Preserve the high-resolution textures in the saved authoring .blend,
    # then resize only the in-memory copies used for the browser GLB.  The
    # overlay is at most a few hundred pixels tall; 4K/2K source maps waste
    # download and GPU memory without improving visible hand readability.
    image_targets: dict[bpy.types.Image, int] = {}
    for objects, maximum in (([body], 2048), (hands, 1024)):
        for obj in objects:
            for material in obj.data.materials:
                if not material or not material.use_nodes:
                    continue
                for node in material.node_tree.nodes:
                    image = getattr(node, "image", None)
                    if image and image.size[0] > 0 and image.size[1] > 0:
                        image_targets[image] = min(image_targets.get(image, maximum), maximum)
    runtime_images = {}
    for image, maximum in image_targets.items():
        original = (int(image.size[0]), int(image.size[1]))
        scale = min(1.0, maximum / max(original))
        target = (
            max(1, round(original[0] * scale)),
            max(1, round(original[1] * scale)),
        )
        if target != original:
            image.scale(*target)
        runtime_images[image.name] = {
            "authoring_size": list(original),
            "runtime_size": list(target),
            "format": image.file_format,
        }
    bpy.ops.object.select_all(action="DESELECT")
    for obj in [armature, body, *hands, *extras]:
        obj.hide_render = False
        obj.hide_set(False)
        obj.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_animations=False,
        export_skins=True,
        export_morph=True,
        # Position morphs preserve all authored expressions. Exporting a full
        # dense normal delta for every shape key adds ~42 MB to this character
        # while making no perceptible difference in the small Chrome overlay.
        export_morph_normal=False,
        export_morph_tangent=False,
        export_def_bones=False,
        export_all_influences=False,
        export_lights=False,
        export_cameras=False,
        export_yup=True,
    )
    return runtime_images


def object_metrics(obj: bpy.types.Object) -> dict:
    obj.data.calc_loop_triangles()
    return {
        "vertices": len(obj.data.vertices),
        "triangles": len(obj.data.loop_triangles),
        "materials": [material.name if material else None for material in obj.data.materials],
        "vertex_groups": len(obj.vertex_groups),
    }


def main() -> None:
    meshy_path, mpfb_path, blend_path, glb_path, report_path = arguments()
    body, target_rig = meshy_base.import_source(meshy_path)
    body.name = "YTSign_PSL_Signer_Body"
    improve_meshy_material(body)
    accessory_cleanup = clean_accessory_artifacts(body)
    # Preserve the authored hair topology.  The measured trimming experiments
    # exposed jagged cut boundaries that are more distracting at overlay size
    # than the original strands; the compact shell below provides coherence.
    hair_cleanup = {"vertices": 0, "components": 0, "strategy": "preserve-source-and-cover"}
    chains = {side: meshy_base.estimate_chains(body, target_rig, side) for side in SIDE_INFO}

    source_mesh, source_rig = append_mpfb(mpfb_path)
    source_frames = {side: source_frame(source_mesh, source_rig, side) for side in ("L", "R")}
    for side, frame in source_frames.items():
        decorate_source_frame(frame, source_rig, side)
    target_frames = {
        side: target_frame(target_rig, chains[side], side, source_frames[info["mpfb"]])
        for side, info in SIDE_INFO.items()
    }

    removed = delete_legacy_hands(body, target_rig, target_frames)
    cuff_cleanup = clean_cuff_slivers(body, target_frames)
    proximal_wedge_cleanup = clean_proximal_skin_wedges(body, target_frames)
    sleeve_reweighting = reweight_arm_surfaces(body, target_rig)
    garment_stabilization = stabilize_central_garment(body)
    created_bones = add_hand_bones(source_rig, target_rig, source_frames, target_frames)
    hands = []
    hand_reports = {}
    for side, info in SIDE_INFO.items():
        hand, report = create_hand_object(
            source_mesh,
            source_rig,
            body,
            target_rig,
            source_frames[info["mpfb"]],
            target_frames[side],
            info["mpfb"],
        )
        hands.append(hand)
        hand_reports[side] = report

    repaired_arm_tails = repair_imported_arm_tails(target_rig)

    # The appended MPFB source objects served only as immutable donors.
    bpy.data.objects.remove(source_mesh, do_unlink=True)
    bpy.data.objects.remove(source_rig, do_unlink=True)
    face_shapes, face_mask_metadata = create_face_rig(body)
    hair_objects = create_signing_safe_hair(body, target_rig)
    # Separate liner experiments remain disabled until they can be proven
    # completely internal; a visible fin is worse than the authored raw hem.
    cuffs = []
    fingernails = create_fingernails(body, target_rig, target_frames)
    mouth_interior = create_mouth_interior(body, target_rig)
    garment_repair_metadata = {"strategy": "not-exported; repaired-source-weights-in-place"}
    extras = [*hair_objects, *cuffs, *fingernails, *mouth_interior]
    scene_metadata(target_rig, body)
    runtime_images = export_avatar(target_rig, body, hands, extras, blend_path, glb_path)

    report = {
        "avatar_version": "5.1-hybrid",
        "primary_language": "PSL",
        "sources": {"meshy": str(meshy_path), "mpfb_runtime": str(mpfb_path)},
        "blend": str(blend_path),
        "glb": str(glb_path),
        "glb_bytes": glb_path.stat().st_size,
        "runtime_images": runtime_images,
        "legacy_hand_vertices_removed": removed,
        "accessory_artifact_cleanup": accessory_cleanup,
        "lower_hair_cleanup": hair_cleanup,
        "cuff_sliver_cleanup": cuff_cleanup,
        "proximal_skin_wedge_cleanup": proximal_wedge_cleanup,
        "sleeve_reweighting": sleeve_reweighting,
        "central_garment_stabilization": garment_stabilization,
        "garment_repair": garment_repair_metadata,
        "imported_arm_tail_length_ratios_repaired": repaired_arm_tails,
        "created_hand_bones": created_bones,
        "created_hand_bone_count": len(created_bones),
        "bone_count": len(target_rig.data.bones),
        "facial_shape_keys": face_shapes,
        "facial_mask_metadata": face_mask_metadata,
        "face_overlays": {},
        "hair": {obj.name: object_metrics(obj) for obj in hair_objects},
        "cuffs": {obj.name: object_metrics(obj) for obj in cuffs},
        "fingernails": {obj.name: object_metrics(obj) for obj in fingernails},
        "mouth_interior": {obj.name: object_metrics(obj) for obj in mouth_interior},
        "body": object_metrics(body),
        "hands": {side: {**hand_reports[side], **object_metrics(hands[index])} for index, side in enumerate(SIDE_INFO)},
        "hand_frames": {
            side: {
                "origin": list(frame.origin),
                "transverse_scale": frame.transverse_scale,
                "normal_scale": frame.normal_scale,
                "longitudinal_scale": frame.longitudinal_scale,
            }
            for side, frame in target_frames.items()
        },
        "limitations": [
            "PSL linguistic accuracy still requires evaluation by fluent Deaf PSL signers.",
            "Meshy source licensing/redistribution terms must be confirmed before public release.",
        ],
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"YTSIGN_HYBRID_BLEND={blend_path}")
    print(f"YTSIGN_HYBRID_GLB={glb_path}")
    print(f"YTSIGN_HYBRID_REPORT={report_path}")


if __name__ == "__main__":
    main()
