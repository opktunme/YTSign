"""Round-trip QA for the browser GLB built from the YTSign hybrid signer.

The source ``.blend`` must be open when this script runs.  The script imports
the supplied GLB beside the source objects, compares the complete skeleton,
skin registration, neutral surfaces, and one deliberately non-lexical
deformation pose, and records any extra visible geometry.

Bone display-tail length is reported but is not a gate.  Blender's glTF
importer reconstructs display tails and can make them much longer than the
source bones; joint heads, hierarchy, basis axes, and evaluated skin are the
meaningful runtime checks.

Usage:
  blender HYBRID.blend --background --python inspect_hybrid_glb_parity.py \
      -- HYBRID.glb REPORT.json

This is mechanical export QA only.  It does not certify PSL handshapes or
linguistic intelligibility.
"""

from __future__ import annotations

import json
import math
import statistics
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Quaternion, Vector
from mathutils.kdtree import KDTree


RIG_NAME = "YTSign_PSL_Rig"
BODY_NAME = "YTSign_PSL_Signer_Body"
HAND_NAMES = {
    "Left": "YTSign_PSL_Hand_L",
    "Right": "YTSign_PSL_Hand_R",
}
DIGITS = ("Thumb", "Index", "Middle", "Ring", "Pinky")
METACARPALS = ("Index", "Middle", "Ring", "Pinky")

HEAD_LIMIT_MM = 0.10
AXIS_LIMIT_DEGREES = 0.10
CENTROID_LIMIT_MM = 2.0
HAND_SURFACE_LIMIT_MM = 1.0
BODY_SAMPLE_LIMIT_MM = 1.0
BOUNDS_LIMIT_MM = 1.0
BODY_SAMPLE_COUNT = 50000


def arguments() -> tuple[Path, Path]:
    if "--" not in sys.argv:
        raise SystemExit("Expected GLB and REPORT_JSON after --")
    values = sys.argv[sys.argv.index("--") + 1 :]
    if len(values) != 2:
        raise SystemExit("Expected exactly GLB and REPORT_JSON after --")
    return Path(values[0]).resolve(), Path(values[1]).resolve()


def reset_pose(rig: bpy.types.Object) -> None:
    for bone in rig.pose.bones:
        bone.matrix_basis = Matrix.Identity(4)
    bpy.context.view_layer.update()


def clear_shape_keys(mesh: bpy.types.Object) -> None:
    if mesh.data.shape_keys is None:
        return
    for key in mesh.data.shape_keys.key_blocks[1:]:
        key.value = 0.0


def imported_object(
    new_objects: list[bpy.types.Object],
    source_name: str,
    object_type: str,
) -> tuple[bpy.types.Object | None, list[str]]:
    candidates = [
        obj
        for obj in new_objects
        if obj.type == object_type
        and (obj.name == source_name or obj.name.startswith(f"{source_name}."))
    ]
    if len(candidates) == 1:
        return candidates[0], [obj.name for obj in candidates]
    return None, [obj.name for obj in candidates]


def world_pose_endpoints(
    rig: bpy.types.Object,
    bone_name: str,
) -> tuple[Vector, Vector]:
    bone = rig.pose.bones[bone_name]
    return rig.matrix_world @ bone.head, rig.matrix_world @ bone.tail


def normalized_world_basis(rig: bpy.types.Object, bone_name: str) -> list[Vector]:
    local = rig.data.bones[bone_name].matrix_local.to_3x3()
    world = rig.matrix_world.to_3x3() @ local
    return [world.col[index].normalized() for index in range(3)]


def angle_degrees(a: Vector, b: Vector) -> float:
    if a.length_squared == 0.0 or b.length_squared == 0.0:
        return 180.0
    return math.degrees(a.angle(b))


def bounds(points: list[Vector]) -> dict | None:
    if not points:
        return None
    minimum = [min(point[index] for point in points) for index in range(3)]
    maximum = [max(point[index] for point in points) for index in range(3)]
    return {"min": minimum, "max": maximum}


def bounds_error_mm(source: dict | None, imported: dict | None) -> float | None:
    if source is None or imported is None:
        return None
    differences = [
        abs(source[key][axis] - imported[key][axis]) * 1000.0
        for key in ("min", "max")
        for axis in range(3)
    ]
    return max(differences)


def evaluated_world_vertices(mesh: bpy.types.Object) -> list[Vector]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = mesh.evaluated_get(depsgraph)
    data = evaluated.to_mesh(preserve_all_data_layers=False, depsgraph=depsgraph)
    try:
        return [evaluated.matrix_world @ vertex.co for vertex in data.vertices]
    finally:
        evaluated.to_mesh_clear()


def sample_evenly(points: list[Vector], limit: int) -> list[Vector]:
    if len(points) <= limit:
        return points
    return [points[(index * len(points)) // limit] for index in range(limit)]


def directed_nearest_mm(
    query: list[Vector],
    reference: list[Vector],
) -> dict:
    if not query or not reference:
        return {
            "query_count": len(query),
            "reference_count": len(reference),
            "maximum_mm": None,
            "mean_mm": None,
            "p95_mm": None,
        }
    tree = KDTree(len(reference))
    for index, point in enumerate(reference):
        tree.insert(point, index)
    tree.balance()
    distances = []
    worst_distance = -1.0
    worst_query = None
    worst_reference = None
    for point in query:
        nearest, _index, distance = tree.find(point)
        distance_mm = distance * 1000.0
        distances.append(distance_mm)
        if distance_mm > worst_distance:
            worst_distance = distance_mm
            worst_query = point.copy()
            worst_reference = nearest.copy()
    ordered = sorted(distances)
    p95_index = min(len(ordered) - 1, int(math.ceil(0.95 * len(ordered))) - 1)
    return {
        "query_count": len(query),
        "reference_count": len(reference),
        "maximum_mm": max(distances),
        "mean_mm": statistics.fmean(distances),
        "p95_mm": ordered[p95_index],
        "worst_query_point": list(worst_query) if worst_query else None,
        "nearest_reference_point": list(worst_reference) if worst_reference else None,
    }


def symmetric_nearest(
    source_points: list[Vector],
    imported_points: list[Vector],
    limit_mm: float,
    sample_limit: int | None = None,
) -> dict:
    source_query = sample_evenly(source_points, sample_limit) if sample_limit else source_points
    imported_query = sample_evenly(imported_points, sample_limit) if sample_limit else imported_points
    source_to_imported = directed_nearest_mm(source_query, imported_points)
    imported_to_source = directed_nearest_mm(imported_query, source_points)
    maxima = [
        value
        for value in (
            source_to_imported["maximum_mm"],
            imported_to_source["maximum_mm"],
        )
        if value is not None
    ]
    maximum = max(maxima) if maxima else None
    return {
        "source_vertex_count": len(source_points),
        "imported_vertex_count": len(imported_points),
        "sample_limit_each_direction": sample_limit,
        "source_to_imported": source_to_imported,
        "imported_to_source": imported_to_source,
        "maximum_symmetric_mm": maximum,
        "limit_mm": limit_mm,
        "pass": maximum is not None and maximum <= limit_mm,
    }


def vertex_weight(vertex: bpy.types.MeshVertex, group_index: int) -> float:
    return next(
        (entry.weight for entry in vertex.groups if entry.group == group_index),
        0.0,
    )


def weighted_centroid(
    mesh: bpy.types.Object,
    group_name: str,
    minimum_weight: float = 0.05,
) -> tuple[Vector | None, int, float]:
    group = mesh.vertex_groups.get(group_name)
    if group is None:
        return None, 0, 0.0
    total = Vector()
    weight_sum = 0.0
    count = 0
    for vertex in mesh.data.vertices:
        amount = vertex_weight(vertex, group.index)
        if amount <= minimum_weight:
            continue
        total += vertex.co * amount
        weight_sum += amount
        count += 1
    if weight_sum == 0.0:
        return None, 0, 0.0
    return mesh.matrix_world @ (total / weight_sum), count, weight_sum


def transplanted_names(side: str) -> list[str]:
    names = [f"{side}Hand{digit}Meta" for digit in METACARPALS]
    names.extend(
        f"{side}Hand{digit}{joint}"
        for digit in DIGITS
        for joint in range(1, 4)
    )
    return names


def compare_weighted_centroids(
    source_mesh: bpy.types.Object,
    imported_mesh: bpy.types.Object,
    side: str,
) -> dict:
    records = []
    for name in transplanted_names(side):
        source, source_count, source_sum = weighted_centroid(source_mesh, name)
        imported, imported_count, imported_sum = weighted_centroid(imported_mesh, name)
        error = (source - imported).length * 1000.0 if source and imported else None
        records.append(
            {
                "bone": name,
                "source_centroid": list(source) if source else None,
                "imported_centroid": list(imported) if imported else None,
                "error_mm": error,
                "source_weighted_vertex_count": source_count,
                "imported_weighted_vertex_count": imported_count,
                "source_weight_sum": source_sum,
                "imported_weight_sum": imported_sum,
                "limit_mm": CENTROID_LIMIT_MM,
                "pass": error is not None and error <= CENTROID_LIMIT_MM,
            }
        )
    errors = [record["error_mm"] for record in records if record["error_mm"] is not None]
    return {
        "records": records,
        "maximum_error_mm": max(errors) if errors else None,
        "pass": len(records) == 19 and all(record["pass"] for record in records),
    }


def compare_skeleton(
    source_rig: bpy.types.Object,
    imported_rig: bpy.types.Object,
) -> dict:
    source_names = set(source_rig.data.bones.keys())
    imported_names = set(imported_rig.data.bones.keys())
    common = sorted(source_names & imported_names)
    records = []
    for name in common:
        source_head, source_tail = world_pose_endpoints(source_rig, name)
        imported_head, imported_tail = world_pose_endpoints(imported_rig, name)
        source_vector = source_tail - source_head
        imported_vector = imported_tail - imported_head
        direction_error = angle_degrees(source_vector, imported_vector)
        source_axes = normalized_world_basis(source_rig, name)
        imported_axes = normalized_world_basis(imported_rig, name)
        axis_errors = [
            angle_degrees(source_axes[index], imported_axes[index]) for index in range(3)
        ]
        source_parent = (
            source_rig.data.bones[name].parent.name
            if source_rig.data.bones[name].parent
            else None
        )
        imported_parent = (
            imported_rig.data.bones[name].parent.name
            if imported_rig.data.bones[name].parent
            else None
        )
        source_length = source_vector.length
        imported_length = imported_vector.length
        head_error = (source_head - imported_head).length * 1000.0
        records.append(
            {
                "bone": name,
                "source_parent": source_parent,
                "imported_parent": imported_parent,
                "hierarchy_match": source_parent == imported_parent,
                "source_head": list(source_head),
                "imported_head": list(imported_head),
                "head_error_mm": head_error,
                "head_limit_mm": HEAD_LIMIT_MM,
                "source_display_tail": list(source_tail),
                "imported_display_tail": list(imported_tail),
                "source_display_length_m": source_length,
                "imported_display_length_m": imported_length,
                "display_length_ratio": (
                    imported_length / source_length if source_length > 1.0e-12 else None
                ),
                "display_direction_error_degrees": direction_error,
                "basis_axis_errors_degrees": axis_errors,
                "maximum_basis_axis_error_degrees": max(axis_errors),
                "axis_limit_degrees": AXIS_LIMIT_DEGREES,
                "pass": (
                    source_parent == imported_parent
                    and head_error <= HEAD_LIMIT_MM
                    and max(axis_errors) <= AXIS_LIMIT_DEGREES
                ),
            }
        )
    head_errors = [record["head_error_mm"] for record in records]
    axis_errors = [record["maximum_basis_axis_error_degrees"] for record in records]
    return {
        "source_bone_count": len(source_names),
        "imported_bone_count": len(imported_names),
        "missing_from_import": sorted(source_names - imported_names),
        "extra_in_import": sorted(imported_names - source_names),
        "maximum_head_error_mm": max(head_errors) if head_errors else None,
        "maximum_basis_axis_error_degrees": max(axis_errors) if axis_errors else None,
        "records": records,
        "pass": (
            source_names == imported_names
            and len(records) == len(source_names)
            and all(record["pass"] for record in records)
        ),
        "note": (
            "Display-tail length is informational only. Joint heads, parent hierarchy, "
            "basis axes, and evaluated skin are the gates."
        ),
    }


def compare_posed_skeleton(
    source_rig: bpy.types.Object,
    imported_rig: bpy.types.Object,
) -> dict:
    common = sorted(set(source_rig.pose.bones.keys()) & set(imported_rig.pose.bones.keys()))
    records = []
    for name in common:
        source = source_rig.pose.bones[name]
        imported = imported_rig.pose.bones[name]
        source_head = source_rig.matrix_world @ source.head
        imported_head = imported_rig.matrix_world @ imported.head
        source_world = source_rig.matrix_world.to_3x3() @ source.matrix.to_3x3()
        imported_world = imported_rig.matrix_world.to_3x3() @ imported.matrix.to_3x3()
        axis_errors = [
            angle_degrees(
                source_world.col[index].normalized(),
                imported_world.col[index].normalized(),
            )
            for index in range(3)
        ]
        head_error = (source_head - imported_head).length * 1000.0
        records.append(
            {
                "bone": name,
                "source_head": list(source_head),
                "imported_head": list(imported_head),
                "head_error_mm": head_error,
                "maximum_axis_error_degrees": max(axis_errors),
                "axis_errors_degrees": axis_errors,
                "pass": (
                    head_error <= HEAD_LIMIT_MM
                    and max(axis_errors) <= AXIS_LIMIT_DEGREES
                ),
            }
        )
    return {
        "bone_count": len(records),
        "maximum_head_error_mm": max(record["head_error_mm"] for record in records),
        "maximum_axis_error_degrees": max(
            record["maximum_axis_error_degrees"] for record in records
        ),
        "records": records,
        "pass": all(record["pass"] for record in records),
    }


def shape_key_names(mesh: bpy.types.Object) -> list[str]:
    if mesh.data.shape_keys is None:
        return []
    return [key.name for key in mesh.data.shape_keys.key_blocks]


def armature_binding(mesh: bpy.types.Object, rig: bpy.types.Object) -> dict:
    modifiers = [modifier for modifier in mesh.modifiers if modifier.type == "ARMATURE"]
    targets = [modifier.object.name if modifier.object else None for modifier in modifiers]
    return {
        "armature_modifier_count": len(modifiers),
        "targets": targets,
        "preserve_volume": [
            modifier.use_deform_preserve_volume for modifier in modifiers
        ],
        "pass": len(modifiers) == 1 and modifiers[0].object == rig,
    }


def object_record(obj: bpy.types.Object) -> dict:
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    materials = []
    if getattr(obj, "data", None) and hasattr(obj.data, "materials"):
        materials = [material.name if material else None for material in obj.data.materials]
    custom_shape_users = [
        f"{rig.name}:{bone.name}"
        for rig in bpy.data.objects
        if rig.type == "ARMATURE"
        for bone in rig.pose.bones
        if bone.custom_shape == obj
    ]
    collections = [
        {
            "name": collection.name,
            "hide_render": collection.hide_render,
            "hide_viewport": collection.hide_viewport,
        }
        for collection in obj.users_collection
    ]
    visible_scene_geometry = (
        obj.type == "MESH"
        and len(obj.data.vertices) > 0
        and not obj.hide_render
        and obj.visible_get()
        and not custom_shape_users
    )
    return {
        "name": obj.name,
        "type": obj.type,
        "parent": obj.parent.name if obj.parent else None,
        "parent_type": obj.parent_type,
        "parent_bone": obj.parent_bone,
        "hide_render": obj.hide_render,
        "hide_viewport": obj.hide_viewport,
        "hide_get": obj.hide_get(),
        "visible_get": obj.visible_get(),
        "collections": collections,
        "custom_shape_users": custom_shape_users,
        "classified_as_blender_import_display_helper": bool(custom_shape_users),
        "visible_scene_geometry": visible_scene_geometry,
        "vertex_count": len(obj.data.vertices) if obj.type == "MESH" else None,
        "materials": materials,
        "bounds": bounds(points),
        "dimensions_m": list(obj.dimensions),
    }


def skin_influence_stats(mesh: bpy.types.Object, rig: bpy.types.Object) -> dict:
    bone_names = set(rig.data.bones.keys())
    deform_groups = {
        group.index for group in mesh.vertex_groups if group.name in bone_names
    }
    counts = []
    totals = []
    discarded = []
    for vertex in mesh.data.vertices:
        weights = sorted(
            (
                entry.weight
                for entry in vertex.groups
                if entry.group in deform_groups and entry.weight > 1.0e-8
            ),
            reverse=True,
        )
        counts.append(len(weights))
        total = sum(weights)
        totals.append(total)
        discarded.append(sum(weights[4:]) / total if total > 0.0 else 0.0)
    influenced = [index for index, count in enumerate(counts) if count > 0]
    over_four = [index for index, count in enumerate(counts) if count > 4]
    return {
        "vertex_count": len(mesh.data.vertices),
        "influenced_vertex_count": len(influenced),
        "maximum_influences": max(counts) if counts else 0,
        "vertices_over_four_influences": len(over_four),
        "maximum_discarded_fraction_beyond_four": max(discarded) if discarded else 0.0,
        "mean_discarded_fraction_beyond_four": statistics.fmean(discarded) if discarded else 0.0,
        "minimum_total_weight_for_influenced_vertex": (
            min(totals[index] for index in influenced) if influenced else None
        ),
        "maximum_total_weight_for_influenced_vertex": (
            max(totals[index] for index in influenced) if influenced else None
        ),
    }


def palm_frame(rig: bpy.types.Object, side: str):
    wrist = rig.matrix_world @ rig.pose.bones[f"{side}Hand"].head
    middle = rig.matrix_world @ rig.pose.bones[f"{side}HandMiddle3"].tail
    index = rig.matrix_world @ rig.pose.bones[f"{side}HandIndex1"].head
    little = rig.matrix_world @ rig.pose.bones[f"{side}HandPinky1"].head
    height = (middle - wrist).normalized()
    transverse = (index - little).normalized()
    normal = height.cross(transverse).normalized()
    if normal.dot(Vector((0.0, -1.0, 0.0))) < 0.0:
        normal.negate()
    return wrist, height, transverse, normal


def finger_axis(rig: bpy.types.Object, side: str, name: str) -> Vector:
    _wrist, _height, _transverse, normal = palm_frame(rig, side)
    rest = rig.data.bones[name]
    direction = (rest.tail_local - rest.head_local).normalized()
    rig_normal = (rig.matrix_world.to_3x3().inverted() @ normal).normalized()
    world_axis = direction.cross(rig_normal).normalized()
    return (rest.matrix_local.to_3x3().inverted() @ world_axis).normalized()


def set_nonlexical_deformation_pose(rig: bpy.types.Object) -> None:
    """Apply broad arm/wrist/digit motion solely to exercise exported skinning."""

    reset_pose(rig)
    arm_pose = {
        "LeftArm": (7.0, -11.0, 14.0),
        "LeftForeArm": (18.0, 7.0, -23.0),
        "LeftHand": (-9.0, 12.0, 7.0),
        "RightArm": (-8.0, 10.0, -13.0),
        "RightForeArm": (17.0, -8.0, 22.0),
        "RightHand": (8.0, -12.0, -7.0),
    }
    for name, degrees in arm_pose.items():
        if name not in rig.pose.bones:
            continue
        bone = rig.pose.bones[name]
        bone.rotation_mode = "XYZ"
        bone.rotation_euler = tuple(math.radians(value) for value in degrees)

    for side in ("Left", "Right"):
        for finger in ("Index", "Middle", "Ring", "Pinky"):
            for joint, degrees in enumerate((34.0, 57.0, 31.0), start=1):
                name = f"{side}Hand{finger}{joint}"
                bone = rig.pose.bones[name]
                bone.rotation_mode = "QUATERNION"
                bone.rotation_quaternion = Quaternion(
                    finger_axis(rig, side, name), math.radians(degrees)
                )
        for joint, degrees in enumerate((18.0, 31.0, 17.0), start=1):
            name = f"{side}HandThumb{joint}"
            bone = rig.pose.bones[name]
            bone.rotation_mode = "QUATERNION"
            bone.rotation_quaternion = Quaternion(
                finger_axis(rig, side, name), math.radians(degrees)
            )
    bpy.context.view_layer.update()


def copy_pose(source_rig: bpy.types.Object, imported_rig: bpy.types.Object) -> None:
    reset_pose(imported_rig)
    for source in source_rig.pose.bones:
        imported = imported_rig.pose.bones.get(source.name)
        if imported is not None:
            imported.matrix_basis = source.matrix_basis.copy()
    bpy.context.view_layer.update()


def compare_mesh_state(
    source_mesh: bpy.types.Object,
    imported_mesh: bpy.types.Object,
    limit_mm: float,
    sample_limit: int | None = None,
) -> dict:
    source_points = evaluated_world_vertices(source_mesh)
    imported_points = evaluated_world_vertices(imported_mesh)
    source_bounds = bounds(source_points)
    imported_bounds = bounds(imported_points)
    bound_error = bounds_error_mm(source_bounds, imported_bounds)
    surface = symmetric_nearest(
        source_points,
        imported_points,
        limit_mm,
        sample_limit=sample_limit,
    )
    return {
        "source_bounds": source_bounds,
        "imported_bounds": imported_bounds,
        "maximum_bounds_error_mm": bound_error,
        "bounds_limit_mm": BOUNDS_LIMIT_MM,
        "bounds_pass": bound_error is not None and bound_error <= BOUNDS_LIMIT_MM,
        "surface": surface,
        "pass": (
            bound_error is not None
            and bound_error <= BOUNDS_LIMIT_MM
            and surface["pass"]
        ),
    }


def main() -> None:
    glb_path, output = arguments()
    if not glb_path.is_file():
        raise RuntimeError(f"GLB does not exist: {glb_path}")

    source_rig = bpy.data.objects.get(RIG_NAME)
    source_body = bpy.data.objects.get(BODY_NAME)
    source_hands = {
        side: bpy.data.objects.get(name) for side, name in HAND_NAMES.items()
    }
    if source_rig is None or source_body is None or any(
        mesh is None for mesh in source_hands.values()
    ):
        raise RuntimeError("Source hybrid rig/body/hands are not all present")

    reset_pose(source_rig)
    clear_shape_keys(source_body)
    before = {obj.as_pointer() for obj in bpy.data.objects}
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.import_scene.gltf(filepath=str(glb_path))
    bpy.context.view_layer.update()
    new_objects = [obj for obj in bpy.data.objects if obj.as_pointer() not in before]

    imported_rig, rig_candidates = imported_object(new_objects, RIG_NAME, "ARMATURE")
    imported_body, body_candidates = imported_object(new_objects, BODY_NAME, "MESH")
    imported_hands = {}
    candidate_map = {
        "rig": rig_candidates,
        "body": body_candidates,
        "hands": {},
        "extras": {},
    }
    for side, name in HAND_NAMES.items():
        imported_hands[side], candidates = imported_object(new_objects, name, "MESH")
        candidate_map["hands"][side] = candidates

    expected = {obj for obj in [imported_rig, imported_body, *imported_hands.values()] if obj}
    source_extras = [
        obj
        for obj in bpy.data.objects
        if obj.get("ytsign_export")
        and obj not in {source_rig, source_body, *source_hands.values()}
    ]
    missing_expected_exports = []
    for source_extra in source_extras:
        imported_extra, candidates = imported_object(
            new_objects,
            source_extra.name,
            source_extra.type,
        )
        candidate_map["extras"][source_extra.name] = candidates
        if imported_extra is None:
            missing_expected_exports.append(source_extra.name)
        else:
            expected.add(imported_extra)
    unexpected = [obj for obj in new_objects if obj not in expected]
    unexpected_records = [object_record(obj) for obj in unexpected]
    visible_unexpected_meshes = [
        record["name"]
        for record in unexpected_records
        if record["visible_scene_geometry"]
    ]

    complete = (
        imported_rig is not None
        and imported_body is not None
        and all(mesh is not None for mesh in imported_hands.values())
    )
    report = {
        "source_blend": bpy.data.filepath,
        "glb": str(glb_path),
        "thresholds": {
            "bone_head_mm": HEAD_LIMIT_MM,
            "bone_basis_axis_degrees": AXIS_LIMIT_DEGREES,
            "weighted_centroid_mm": CENTROID_LIMIT_MM,
            "hand_surface_mm": HAND_SURFACE_LIMIT_MM,
            "body_sample_surface_mm": BODY_SAMPLE_LIMIT_MM,
            "bounds_mm": BOUNDS_LIMIT_MM,
            "body_sample_count_each_direction": BODY_SAMPLE_COUNT,
        },
        "import": {
            "new_objects": [object_record(obj) for obj in new_objects],
            "candidates": candidate_map,
            "expected_objects_complete": complete,
            "unexpected_objects": unexpected_records,
            "visible_unexpected_meshes": visible_unexpected_meshes,
            "expected_extra_objects": [obj.name for obj in source_extras],
            "missing_expected_export_objects": missing_expected_exports,
            "expected_export_objects_complete": not missing_expected_exports,
            "no_visible_unexpected_geometry_pass": not visible_unexpected_meshes,
        },
        "skeleton": None,
        "bindings": None,
        "shape_keys": None,
        "neutral": None,
        "deformed": None,
        "rig_skin_parity_pass": False,
        "glb_reimport_parity_pass": False,
        "limitations": [
            "This is Blender glTF re-import parity, not direct Three.js/browser-render parity.",
            "The deformation pose is a non-lexical stress pose and is not a PSL sign.",
            "Mechanical parity does not establish PSL linguistic intelligibility.",
            "Body nearest-surface checks use deterministic samples; both hand checks are exhaustive.",
        ],
    }

    if complete:
        reset_pose(imported_rig)
        clear_shape_keys(imported_body)
        report["skeleton"] = compare_skeleton(source_rig, imported_rig)
        report["bindings"] = {
            "source": {
                "body": armature_binding(source_body, source_rig),
                "hands": {
                    side: armature_binding(source_hands[side], source_rig)
                    for side in ("Left", "Right")
                },
            },
            "imported": {
                "body": armature_binding(imported_body, imported_rig),
                "hands": {
                    side: armature_binding(imported_hands[side], imported_rig)
                    for side in ("Left", "Right")
                },
            },
            "source_import_skinning_mode_match": (
                armature_binding(source_body, source_rig)["preserve_volume"]
                == armature_binding(imported_body, imported_rig)["preserve_volume"]
                and all(
                    armature_binding(source_hands[side], source_rig)["preserve_volume"]
                    == armature_binding(imported_hands[side], imported_rig)["preserve_volume"]
                    for side in ("Left", "Right")
                )
            ),
        }
        report["skin_influences"] = {
            "source": {
                "body": skin_influence_stats(source_body, source_rig),
                "hands": {
                    side: skin_influence_stats(source_hands[side], source_rig)
                    for side in ("Left", "Right")
                },
            },
            "imported": {
                "body": skin_influence_stats(imported_body, imported_rig),
                "hands": {
                    side: skin_influence_stats(imported_hands[side], imported_rig)
                    for side in ("Left", "Right")
                },
            },
            "export_all_influences": False,
            "note": (
                "The build exports at most four influences per vertex. Non-zero discarded "
                "fractions in the source are a likely cause of deformation drift."
            ),
        }
        source_keys = shape_key_names(source_body)
        imported_keys = shape_key_names(imported_body)
        report["shape_keys"] = {
            "source": source_keys,
            "imported": imported_keys,
            "missing": sorted(set(source_keys) - set(imported_keys)),
            "extra": sorted(set(imported_keys) - set(source_keys)),
            "pass": source_keys == imported_keys,
        }

        neutral_hands = {}
        centroid_checks = {}
        for side in ("Left", "Right"):
            neutral_hands[side] = compare_mesh_state(
                source_hands[side],
                imported_hands[side],
                HAND_SURFACE_LIMIT_MM,
            )
            centroid_checks[side] = compare_weighted_centroids(
                source_hands[side], imported_hands[side], side
            )
        neutral_body = compare_mesh_state(
            source_body,
            imported_body,
            BODY_SAMPLE_LIMIT_MM,
            sample_limit=BODY_SAMPLE_COUNT,
        )
        report["neutral"] = {
            "hands": neutral_hands,
            "weighted_centroids": centroid_checks,
            "body": neutral_body,
            "pass": (
                all(record["pass"] for record in neutral_hands.values())
                and all(record["pass"] for record in centroid_checks.values())
                and neutral_body["pass"]
            ),
        }

        set_nonlexical_deformation_pose(source_rig)
        copy_pose(source_rig, imported_rig)
        posed_skeleton = compare_posed_skeleton(source_rig, imported_rig)
        deformed_hands = {
            side: compare_mesh_state(
                source_hands[side],
                imported_hands[side],
                HAND_SURFACE_LIMIT_MM,
            )
            for side in ("Left", "Right")
        }
        deformed_body = compare_mesh_state(
            source_body,
            imported_body,
            BODY_SAMPLE_LIMIT_MM,
            sample_limit=BODY_SAMPLE_COUNT,
        )
        report["deformed"] = {
            "pose": "nonlexical bilateral arm/wrist/finger stress pose",
            "skeleton": posed_skeleton,
            "hands": deformed_hands,
            "body": deformed_body,
            "pass": (
                posed_skeleton["pass"]
                and
                all(record["pass"] for record in deformed_hands.values())
                and deformed_body["pass"]
            ),
        }

        bindings_pass = (
            report["bindings"]["source"]["body"]["pass"]
            and report["bindings"]["imported"]["body"]["pass"]
            and all(
                report["bindings"][stage]["hands"][side]["pass"]
                for stage in ("source", "imported")
                for side in ("Left", "Right")
            )
            and report["bindings"]["source_import_skinning_mode_match"]
        )
        report["rig_skin_parity_pass"] = (
            report["skeleton"]["pass"]
            and bindings_pass
            and report["shape_keys"]["pass"]
            and report["neutral"]["pass"]
            and report["deformed"]["pass"]
        )
        report["glb_reimport_parity_pass"] = (
            report["rig_skin_parity_pass"]
            and report["import"]["no_visible_unexpected_geometry_pass"]
            and report["import"]["expected_export_objects_complete"]
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"YTSIGN_HYBRID_GLB_PARITY={output}")
    print(f"YTSIGN_HYBRID_RIG_SKIN_PARITY_PASS={report['rig_skin_parity_pass']}")
    print(f"YTSIGN_HYBRID_GLB_PARITY_PASS={report['glb_reimport_parity_pass']}")
    if visible_unexpected_meshes:
        print(f"YTSIGN_HYBRID_UNEXPECTED_VISIBLE_MESHES={visible_unexpected_meshes}")


if __name__ == "__main__":
    main()
