"""Render and measure mechanical hand QA for the shipped hybrid signer.

This file deliberately separates mechanical evidence from linguistic evidence.
It verifies that all hand controls exist, deform the intended mesh, survive as a
usable bilateral rig, and can form a small set of diagnostic handshapes.  Those
checks are not PSL linguistic certification; fluent Deaf PSL signers must still
validate vocabulary, grammar, timing, facial grammar, and intelligibility.
"""

from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree
from mathutils.kdtree import KDTree


SIDES = ("Left", "Right")
DIGITS = ("Thumb", "Index", "Middle", "Ring", "Pinky")
FINGERS = ("Index", "Middle", "Ring", "Pinky")
METACARPALS = ("Index", "Middle", "Ring", "Pinky")
SIDE_CODE = {"Left": "L", "Right": "R"}
ABDUCTION_SIGN = {"Left": -1.0, "Right": 1.0}
THUMB_ROLL_SIGN = {"Left": -1.0, "Right": 1.0}
OUTWARD_Z_SIGN = {"Left": 1.0, "Right": -1.0}

DEFORM_CONTROLS = tuple(
    [f"{side}Hand{digit}Meta" for side in SIDES for digit in METACARPALS]
    + [
        f"{side}Hand{digit}{joint}"
        for side in SIDES
        for digit in DIGITS
        for joint in (1, 2, 3)
    ]
)
END_TARGETS = tuple(
    f"{side}Hand{digit}End" for side in SIDES for digit in DIGITS
)
CONTROL_PATTERN = re.compile(
    r"^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)(Meta|[123]|End)$"
)

CONTROL_SWEEP_DEGREES = 20.0
CONTROL_ANGLE_ERROR_LIMIT_DEGREES = 0.10
CONTROL_TIP_MOTION_MIN_MM = 1.0
CONTROL_GROUP_P95_MOTION_MIN_MM = 0.35
OPPOSITE_HAND_MOTION_MAX_MM = 0.05
TRANSITION_STEP_MAX_SCALE = 0.18
TRANSITION_MONOTONIC_EPSILON_SCALE = 0.015
TRANSITION_ENDPOINT_MAX_MM = 0.50
AREA_RATIO_P01_MIN = 0.12
AREA_RATIO_P99_MAX = 4.0
EDGE_RATIO_P01_MIN = 0.30
EDGE_RATIO_P99_MAX = 2.50

# Populated once from the neutral evaluated meshes before named-pose QA. The
# full arrays remain internal; JSON receives only bounded aggregate evidence.
NEUTRAL_GEOMETRY: dict[str, dict] = {}


def arguments() -> tuple[Path, bool, bool]:
    values = sys.argv[sys.argv.index("--") + 1 :]
    return (
        Path(values[0]).resolve(),
        "--metrics-only" in values[1:],
        "--skin-only" in values[1:],
    )


def reset_pose(rig: bpy.types.Object) -> None:
    for bone in rig.pose.bones:
        bone.rotation_mode = "QUATERNION"
        bone.rotation_quaternion.identity()
        bone.location = (0.0, 0.0, 0.0)
        bone.scale = (1.0, 1.0, 1.0)
    bpy.context.view_layer.update()


def expected_parent(name: str) -> str:
    match = CONTROL_PATTERN.fullmatch(name)
    if not match:
        raise ValueError(name)
    side, digit, kind = match.groups()
    if kind == "Meta":
        return f"{side}Hand"
    if kind == "End":
        return f"{side}Hand{digit}3"
    joint = int(kind)
    if joint > 1:
        return f"{side}Hand{digit}{joint - 1}"
    if digit == "Thumb":
        return f"{side}Hand"
    return f"{side}Hand{digit}Meta"


def hand_object(side: str) -> bpy.types.Object:
    return bpy.data.objects[f"YTSign_PSL_Hand_{SIDE_CODE[side]}"]


def rest_point(rig: bpy.types.Object, bone_name: str, endpoint: str) -> Vector:
    bone = rig.data.bones[bone_name]
    point = bone.head_local if endpoint == "head" else bone.tail_local
    return rig.matrix_world @ point


def posed_point(rig: bpy.types.Object, bone_name: str, endpoint: str) -> Vector:
    bone = rig.pose.bones[bone_name]
    point = bone.head if endpoint == "head" else bone.tail
    return rig.matrix_world @ point


def rest_palm_frame(rig: bpy.types.Object, side: str) -> tuple[Vector, Vector, Vector, Vector]:
    """Stable rest frame used for every authored local control axis."""

    wrist = rest_point(rig, f"{side}Hand", "head")
    # Stop at the knuckles. A fingertip must not define a palm frame because
    # curling it would rotate every axis computed later in the same pose.
    middle = rest_point(rig, f"{side}HandMiddle1", "head")
    index = rest_point(rig, f"{side}HandIndex1", "head")
    pinky = rest_point(rig, f"{side}HandPinky1", "head")
    height = (middle - wrist).normalized()
    transverse = (index - pinky).normalized()
    normal = height.cross(transverse).normalized()
    if normal.dot(Vector((0.0, -1.0, 0.0))) < 0.0:
        normal.negate()
    return wrist, height, transverse, normal


def posed_palm_frame(rig: bpy.types.Object, side: str) -> tuple[Vector, Vector, Vector, Vector]:
    """Current palm frame based on wrist/knuckles, never a moving fingertip."""

    wrist = posed_point(rig, f"{side}Hand", "head")
    middle = posed_point(rig, f"{side}HandMiddle1", "head")
    index = posed_point(rig, f"{side}HandIndex1", "head")
    pinky = posed_point(rig, f"{side}HandPinky1", "head")
    height = (middle - wrist).normalized()
    transverse = (index - pinky).normalized()
    normal = height.cross(transverse).normalized()
    if normal.dot(rest_palm_frame(rig, side)[3]) < 0.0:
        normal.negate()
    return wrist, height, transverse, normal


def armature_axis(rig: bpy.types.Object, world_axis: Vector) -> Vector:
    return (rig.matrix_world.to_3x3().inverted() @ world_axis).normalized()


def bone_local_axis(rig: bpy.types.Object, bone_name: str, axis: Vector) -> Vector:
    rest = rig.data.bones[bone_name]
    return (rest.matrix_local.to_3x3().inverted() @ axis).normalized()


def finger_axis(rig: bpy.types.Object, side: str, name: str) -> Vector:
    _wrist, _height, _transverse, normal = rest_palm_frame(rig, side)
    rest = rig.data.bones[name]
    direction = (rest.tail_local - rest.head_local).normalized()
    rig_normal = armature_axis(rig, normal)
    world_axis = direction.cross(rig_normal).normalized()
    return bone_local_axis(rig, name, world_axis)


def metacarpal_axis(rig: bpy.types.Object, side: str, name: str) -> Vector:
    normal = armature_axis(rig, rest_palm_frame(rig, side)[3])
    return bone_local_axis(rig, name, normal)


def flex(
    rig: bpy.types.Object,
    side: str,
    fingers=FINGERS,
    angles=(60.0, 82.0, 52.0),
) -> None:
    for finger in fingers:
        for joint, degrees in enumerate(angles, start=1):
            name = f"{side}Hand{finger}{joint}"
            bone = rig.pose.bones[name]
            bone.rotation_mode = "QUATERNION"
            bone.rotation_quaternion = Quaternion(finger_axis(rig, side, name), math.radians(degrees))
    bpy.context.view_layer.update()


def abduct(rig: bpy.types.Object, side: str, amount: float) -> None:
    distribution = {"Index": 1.0, "Middle": 0.25, "Ring": -0.35, "Pinky": -1.0}
    for finger, factor in distribution.items():
        name = f"{side}Hand{finger}Meta"
        bone = rig.pose.bones[name]
        bone.rotation_mode = "QUATERNION"
        bone.rotation_quaternion = Quaternion(
            metacarpal_axis(rig, side, name),
            math.radians(amount * factor * ABDUCTION_SIGN[side]),
        )
    bpy.context.view_layer.update()


def thumb(
    rig: bpy.types.Object,
    side: str,
    *,
    cmc_flex=0.0,
    cmc_roll=0.0,
    outward=0.0,
    across=0.0,
    mcp_flex=0.0,
    ip_flex=0.0,
) -> None:
    # Preserve the donor's authored local XYZ semantics, but store quaternion
    # results so transition interpolation has one deterministic representation.
    cmc = rig.pose.bones[f"{side}HandThumb1"]
    cmc.rotation_mode = "QUATERNION"
    cmc.rotation_quaternion = Euler(
        (
            math.radians(cmc_flex),
            math.radians(cmc_roll * THUMB_ROLL_SIGN[side]),
            math.radians((across - outward) * OUTWARD_Z_SIGN[side]),
        ),
        "XYZ",
    ).to_quaternion()
    mcp = rig.pose.bones[f"{side}HandThumb2"]
    mcp.rotation_mode = "QUATERNION"
    mcp.rotation_quaternion = Quaternion(Vector((1.0, 0.0, 0.0)), math.radians(mcp_flex))
    ip = rig.pose.bones[f"{side}HandThumb3"]
    ip.rotation_mode = "QUATERNION"
    ip.rotation_quaternion = Quaternion(Vector((1.0, 0.0, 0.0)), math.radians(ip_flex))
    bpy.context.view_layer.update()


def apply_pose(rig: bpy.types.Object, side: str, name: str) -> None:
    if name == "open":
        return
    if name == "spread":
        abduct(rig, side, -15.0)
        thumb(rig, side, outward=36.0)
    elif name == "curl-quarter":
        flex(rig, side, angles=(20.0, 30.0, 20.0))
    elif name == "curl-half":
        flex(rig, side, angles=(44.0, 60.0, 40.0))
    elif name == "fist":
        flex(rig, side, angles=(65.0, 90.0, 60.0))
        thumb(rig, side, cmc_flex=18.0, cmc_roll=10.0, across=32.0, mcp_flex=38.0, ip_flex=32.0)
    elif name == "hook":
        flex(rig, side, angles=(0.0, 88.0, 58.0))
    elif name == "tabletop":
        flex(rig, side, angles=(68.0, 0.0, 0.0))
    elif name == "index":
        flex(rig, side, fingers=("Middle", "Ring", "Pinky"), angles=(65.0, 90.0, 60.0))
        thumb(rig, side, cmc_flex=14.0, across=24.0, mcp_flex=30.0, ip_flex=24.0)
    elif name == "v":
        flex(rig, side, fingers=("Ring", "Pinky"), angles=(65.0, 90.0, 60.0))
        abduct(rig, side, -12.0)
        thumb(rig, side, cmc_flex=14.0, across=24.0, mcp_flex=30.0, ip_flex=24.0)
    elif name == "o":
        flex(rig, side, angles=(35.0, 50.0, 28.0))
        thumb(rig, side, cmc_flex=24.0, cmc_roll=12.0, across=42.0, mcp_flex=36.0, ip_flex=38.0)
    elif name == "c":
        abduct(rig, side, 9.0)
        flex(rig, side, angles=(31.0, 37.0, 17.0))
        thumb(rig, side, cmc_flex=12.0, cmc_roll=8.0, outward=14.0, mcp_flex=22.0, ip_flex=18.0)
    else:
        raise ValueError(name)


def vertex_group_stats(obj: bpy.types.Object, name: str) -> dict:
    group = obj.vertex_groups.get(name)
    if group is None:
        return {
            "present": False,
            "vertex_count": 0,
            "weight_sum": 0.0,
            "maximum_weight": 0.0,
        }
    weights = [
        entry.weight
        for vertex in obj.data.vertices
        for entry in vertex.groups
        if entry.group == group.index and entry.weight > 0.0
    ]
    return {
        "present": True,
        "vertex_count": len(weights),
        "weight_sum": sum(weights),
        "maximum_weight": max(weights, default=0.0),
    }


def build_control_manifest(rig: bpy.types.Object) -> dict:
    expected_all = set(DEFORM_CONTROLS) | set(END_TARGETS)
    actual_control_like = sorted(
        bone.name for bone in rig.data.bones if CONTROL_PATTERN.fullmatch(bone.name)
    )
    control_records = []
    for name in DEFORM_CONTROLS:
        side = "Left" if name.startswith("Left") else "Right"
        other_side = "Right" if side == "Left" else "Left"
        bone = rig.data.bones.get(name)
        own_stats = vertex_group_stats(hand_object(side), name)
        opposite_stats = vertex_group_stats(hand_object(other_side), name)
        parent = bone.parent.name if bone and bone.parent else None
        record_pass = bool(
            bone
            and bone.use_deform
            and parent == expected_parent(name)
            and own_stats["vertex_count"] > 0
            and own_stats["weight_sum"] > 0.0
            and own_stats["maximum_weight"] > 0.10
            and not opposite_stats["present"]
        )
        control_records.append(
            {
                "name": name,
                "expected_parent": expected_parent(name),
                "actual_parent": parent,
                "use_deform": bone.use_deform if bone else None,
                "own_hand_weights": own_stats,
                "opposite_hand_weights": opposite_stats,
                "pass": record_pass,
            }
        )

    end_records = []
    for name in END_TARGETS:
        bone = rig.data.bones.get(name)
        parent = bone.parent.name if bone and bone.parent else None
        group_presence = {
            side: vertex_group_stats(hand_object(side), name)["present"] for side in SIDES
        }
        record_pass = bool(
            bone
            and not bone.use_deform
            and parent == expected_parent(name)
            and not any(group_presence.values())
        )
        end_records.append(
            {
                "name": name,
                "expected_parent": expected_parent(name),
                "actual_parent": parent,
                "use_deform": bone.use_deform if bone else None,
                "vertex_group_presence": group_presence,
                "pass": record_pass,
            }
        )

    exact_names = set(actual_control_like) == expected_all
    return {
        "deforming_controls": list(DEFORM_CONTROLS),
        "orientation_targets": list(END_TARGETS),
        "deforming_control_count": len(DEFORM_CONTROLS),
        "orientation_target_count": len(END_TARGETS),
        "actual_control_like_bones": actual_control_like,
        "unexpected_control_like_bones": sorted(set(actual_control_like) - expected_all),
        "missing_expected_bones": sorted(expected_all - set(actual_control_like)),
        "controls": control_records,
        "ends": end_records,
        "pass": bool(
            exact_names
            and len(DEFORM_CONTROLS) == len(set(DEFORM_CONTROLS)) == 38
            and len(END_TARGETS) == len(set(END_TARGETS)) == 10
            and all(record["pass"] for record in control_records)
            and all(record["pass"] for record in end_records)
        ),
    }


def evaluated_object_points(source: bpy.types.Object) -> list[Vector]:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    obj = source.evaluated_get(depsgraph)
    mesh = obj.to_mesh(preserve_all_data_layers=False, depsgraph=depsgraph)
    try:
        return [obj.matrix_world @ vertex.co for vertex in mesh.vertices]
    finally:
        obj.to_mesh_clear()


def evaluated_points(objects: list[bpy.types.Object]) -> list[Vector]:
    return [point for obj in objects for point in evaluated_object_points(obj)]


def group_indices_and_weights(
    obj: bpy.types.Object,
    name: str,
) -> tuple[list[int], list[float]]:
    group = obj.vertex_groups.get(name)
    if group is None:
        return [], []
    indices = []
    weights = []
    for vertex in obj.data.vertices:
        entry = next((item for item in vertex.groups if item.group == group.index), None)
        if entry and entry.weight > 0.0:
            indices.append(vertex.index)
            weights.append(entry.weight)
    return indices, weights


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = max(0.0, min(1.0, fraction)) * (len(ordered) - 1)
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return ordered[lower]
    blend = position - lower
    return ordered[lower] * (1.0 - blend) + ordered[upper] * blend


def boundary_topology(obj: bpy.types.Object) -> dict:
    edge_uses: Counter[tuple[int, int]] = Counter()
    for polygon in obj.data.polygons:
        vertices = list(polygon.vertices)
        for index, first in enumerate(vertices):
            second = vertices[(index + 1) % len(vertices)]
            edge_uses[tuple(sorted((first, second)))] += 1
    boundary = [edge for edge, count in edge_uses.items() if count == 1]
    adjacency: defaultdict[int, set[int]] = defaultdict(set)
    for first, second in boundary:
        adjacency[first].add(second)
        adjacency[second].add(first)
    remaining = set(adjacency)
    components = []
    while remaining:
        seed = remaining.pop()
        stack = [seed]
        component = {seed}
        while stack:
            current = stack.pop()
            for neighbor in adjacency[current]:
                if neighbor in remaining:
                    remaining.remove(neighbor)
                    component.add(neighbor)
                    stack.append(neighbor)
        components.append(component)
    world_points = evaluated_object_points(obj)
    component_records = []
    for component in sorted(components, key=len, reverse=True):
        component_points = [world_points[index] for index in component]
        centroid = sum(component_points, Vector()) / len(component_points)
        component_records.append(
            {
                "vertex_count": len(component),
                "centroid_m": list(centroid),
                "bounds_min_m": [
                    min(point[axis] for point in component_points) for axis in range(3)
                ],
                "bounds_max_m": [
                    max(point[axis] for point in component_points) for axis in range(3)
                ],
            }
        )
    return {
        "vertex_count": len(obj.data.vertices),
        "polygon_count": len(obj.data.polygons),
        "boundary_edge_count": len(boundary),
        "boundary_component_count": len(components),
        "boundary_component_vertex_counts": sorted(
            (len(component) for component in components), reverse=True
        ),
        "boundary_components": component_records,
        "nonmanifold_edge_count": sum(1 for count in edge_uses.values() if count != 2),
    }


def capture_neutral_geometry(obj: bpy.types.Object) -> dict:
    points = evaluated_object_points(obj)
    obj.data.calc_loop_triangles()
    triangles = [tuple(triangle.vertices) for triangle in obj.data.loop_triangles]
    edges = sorted(
        {
            tuple(sorted((triangle[index], triangle[(index + 1) % 3])))
            for triangle in triangles
            for index in range(3)
        }
    )
    triangle_areas = [
        (points[second] - points[first]).cross(points[third] - points[first]).length
        * 0.5
        for first, second, third in triangles
    ]
    edge_lengths = [
        (points[second] - points[first]).length for first, second in edges
    ]
    return {
        "points": points,
        "triangles": triangles,
        "triangle_areas": triangle_areas,
        "edges": edges,
        "edge_lengths": edge_lengths,
        "topology": boundary_topology(obj),
    }


def neutral_bone_pivot_metrics(rig: bpy.types.Object, side: str) -> dict:
    """Locate every deform-control pivot relative to the neutral skin shell."""

    reset_pose(rig)
    obj = hand_object(side)
    points = evaluated_object_points(obj)
    polygons = [tuple(polygon.vertices) for polygon in obj.data.polygons]
    tree = BVHTree.FromPolygons(points, polygons, all_triangles=False)
    records = []
    for name in DEFORM_CONTROLS:
        if not name.startswith(f"{side}Hand"):
            continue
        pivot = posed_point(rig, name, "head")
        nearest, normal, _polygon_index, distance = tree.find_nearest(pivot)
        indices, weights = group_indices_and_weights(obj, name)
        weight_sum = sum(weights)
        centroid = (
            sum((points[index] * weight for index, weight in zip(indices, weights)), Vector())
            / weight_sum
            if weight_sum > 0.0
            else None
        )
        # With outward mesh normals, a point inside the hand has a negative
        # signed offset from its nearest surface. The neutral hand has only one
        # known open boundary at the wrist, far from these finger pivots.
        signed_distance = (
            (pivot - nearest).dot(normal) * 1000.0
            if nearest is not None and normal is not None
            else None
        )
        records.append(
            {
                "control": name,
                "pivot": list(pivot),
                "nearest_surface_distance_mm": distance * 1000.0 if distance is not None else None,
                "signed_surface_distance_mm": signed_distance,
                "weighted_group_centroid_distance_mm": (
                    (pivot - centroid).length * 1000.0 if centroid is not None else None
                ),
                "outside_skin_by_more_than_0_75_mm": (
                    signed_distance is None or signed_distance > 0.75
                ),
            }
        )
    outside = [
        record["control"]
        for record in records
        if record["outside_skin_by_more_than_0_75_mm"]
    ]
    return {
        "method": "nearest neutral surface signed along outward polygon normal",
        "outside_limit_mm": 0.75,
        "records": records,
        "outside_pivots": outside,
        "pass": not outside,
    }


def deformation_quality(obj: bpy.types.Object, baseline: dict) -> dict:
    points = evaluated_object_points(obj)
    if len(points) != len(baseline["points"]):
        return {
            "topology_match": False,
            "pass": False,
            "reason": "evaluated vertex count changed",
        }
    areas = [
        (points[second] - points[first]).cross(points[third] - points[first]).length
        * 0.5
        for first, second, third in baseline["triangles"]
    ]
    indexed_area_ratios = [
        (index, current / neutral)
        for index, (current, neutral) in enumerate(
            zip(areas, baseline["triangle_areas"])
        )
        if neutral > 1.0e-12
    ]
    area_ratios = [ratio for _index, ratio in indexed_area_ratios]
    lengths = [
        (points[second] - points[first]).length
        for first, second in baseline["edges"]
    ]
    indexed_edge_ratios = [
        (index, current / neutral)
        for index, (current, neutral) in enumerate(
            zip(lengths, baseline["edge_lengths"])
        )
        if neutral > 1.0e-12
    ]
    edge_ratios = [ratio for _index, ratio in indexed_edge_ratios]
    area_p01 = percentile(area_ratios, 0.01)
    area_p99 = percentile(area_ratios, 0.99)
    edge_p01 = percentile(edge_ratios, 0.01)
    edge_p99 = percentile(edge_ratios, 0.99)
    finite = all(
        math.isfinite(value)
        for value in (area_p01, area_p99, edge_p01, edge_p99)
    )
    severe_area_collapses = sum(value < 0.05 for value in area_ratios)
    severe_edge_collapses = sum(value < 0.15 for value in edge_ratios)
    severe_edge_stretches = sum(value > 3.0 for value in edge_ratios)
    quality_pass = bool(
        finite
        and area_p01 >= AREA_RATIO_P01_MIN
        and area_p99 <= AREA_RATIO_P99_MAX
        and edge_p01 >= EDGE_RATIO_P01_MIN
        and edge_p99 <= EDGE_RATIO_P99_MAX
        and severe_area_collapses == 0
        and severe_edge_collapses == 0
        and severe_edge_stretches == 0
    )

    group_names = {group.index: group.name for group in obj.vertex_groups}

    def influences(vertex_index: int) -> list[dict]:
        return [
            {"group": group_names.get(entry.group, str(entry.group)), "weight": entry.weight}
            for entry in sorted(
                obj.data.vertices[vertex_index].groups,
                key=lambda item: item.weight,
                reverse=True,
            )[:4]
            if entry.weight > 1.0e-5
        ]

    def triangle_record(index: int, ratio: float) -> dict:
        vertices = baseline["triangles"][index]
        centroid = sum((points[vertex] for vertex in vertices), Vector()) / 3.0
        return {
            "triangle_index": index,
            "vertices": list(vertices),
            "area_ratio": ratio,
            "posed_centroid_m": list(centroid),
            "vertex_influences": {
                str(vertex): influences(vertex) for vertex in vertices
            },
        }

    def edge_record(index: int, ratio: float) -> dict:
        vertices = baseline["edges"][index]
        midpoint = sum((points[vertex] for vertex in vertices), Vector()) / 2.0
        return {
            "edge_index": index,
            "vertices": list(vertices),
            "length_ratio": ratio,
            "posed_midpoint_m": list(midpoint),
            "vertex_influences": {
                str(vertex): influences(vertex) for vertex in vertices
            },
        }

    worst_collapsed_triangles = [
        triangle_record(index, ratio)
        for index, ratio in sorted(indexed_area_ratios, key=lambda item: item[1])[:12]
    ]
    worst_collapsed_edges = [
        edge_record(index, ratio)
        for index, ratio in sorted(indexed_edge_ratios, key=lambda item: item[1])[:12]
    ]
    worst_stretched_edges = [
        edge_record(index, ratio)
        for index, ratio in sorted(
            indexed_edge_ratios, key=lambda item: item[1], reverse=True
        )[:12]
    ]
    return {
        "topology_match": True,
        "area_ratio_p01": area_p01,
        "area_ratio_p99": area_p99,
        "edge_length_ratio_p01": edge_p01,
        "edge_length_ratio_p99": edge_p99,
        "triangles_below_0_05_area_ratio": severe_area_collapses,
        "edges_below_0_15_length_ratio": severe_edge_collapses,
        "edges_above_3_length_ratio": severe_edge_stretches,
        "worst_collapsed_triangles": worst_collapsed_triangles,
        "worst_collapsed_edges": worst_collapsed_edges,
        "worst_stretched_edges": worst_stretched_edges,
        "thresholds": {
            "area_ratio_p01_min": AREA_RATIO_P01_MIN,
            "area_ratio_p99_max": AREA_RATIO_P99_MAX,
            "edge_length_ratio_p01_min": EDGE_RATIO_P01_MIN,
            "edge_length_ratio_p99_max": EDGE_RATIO_P99_MAX,
        },
        "finite": finite,
        "pass": quality_pass,
    }


def maximum_point_motion_mm(before: list[Vector], after: list[Vector]) -> float:
    if len(before) != len(after) or not before:
        return math.inf
    return max(
        (current - initial).length for initial, current in zip(before, after)
    ) * 1000.0


def tip_target_for_control(name: str) -> str:
    match = CONTROL_PATTERN.fullmatch(name)
    if not match:
        raise ValueError(name)
    side, digit, _kind = match.groups()
    return f"{side}Hand{digit}End"


def isolated_control_sweep(rig: bpy.types.Object) -> dict:
    reset_pose(rig)
    neutral_points = {side: evaluated_object_points(hand_object(side)) for side in SIDES}
    neutral_tips = {
        name: posed_point(rig, tip_target_for_control(name), "head")
        for name in DEFORM_CONTROLS
    }
    records = []
    for name in DEFORM_CONTROLS:
        reset_pose(rig)
        side = "Left" if name.startswith("Left") else "Right"
        other_side = "Right" if side == "Left" else "Left"
        axis = (
            metacarpal_axis(rig, side, name)
            if name.endswith("Meta")
            else finger_axis(rig, side, name)
        )
        pose_bone = rig.pose.bones[name]
        pose_bone.rotation_mode = "QUATERNION"
        pose_bone.rotation_quaternion = Quaternion(
            axis, math.radians(CONTROL_SWEEP_DEGREES)
        )
        bpy.context.view_layer.update()

        own_points = evaluated_object_points(hand_object(side))
        opposite_points = evaluated_object_points(hand_object(other_side))
        indices, weights = group_indices_and_weights(hand_object(side), name)
        topology_match = len(own_points) == len(neutral_points[side])
        motions_mm = (
            [
                (own_points[index] - neutral_points[side][index]).length * 1000.0
                for index in indices
            ]
            if topology_match
            else []
        )
        weight_sum = sum(weights)
        weighted_rms_mm = (
            math.sqrt(
                sum(
                    weight * distance * distance
                    for weight, distance in zip(weights, motions_mm)
                )
                / weight_sum
            )
            if weight_sum > 0.0 and motions_mm
            else 0.0
        )
        group_p95_mm = percentile(motions_mm, 0.95)
        tip = posed_point(rig, tip_target_for_control(name), "head")
        tip_delta = tip - neutral_tips[name]
        tip_motion_mm = tip_delta.length * 1000.0
        palm_normal_motion_mm = tip_delta.dot(rest_palm_frame(rig, side)[3]) * 1000.0
        actual_angle = math.degrees(pose_bone.rotation_quaternion.angle)
        angle_error = abs(actual_angle - CONTROL_SWEEP_DEGREES)
        opposite_motion_mm = maximum_point_motion_mm(
            neutral_points[other_side], opposite_points
        )
        finite = topology_match and all(
            math.isfinite(value)
            for value in (
                actual_angle,
                angle_error,
                tip_motion_mm,
                weighted_rms_mm,
                group_p95_mm,
                opposite_motion_mm,
            )
        )
        record_pass = bool(
            finite
            and angle_error <= CONTROL_ANGLE_ERROR_LIMIT_DEGREES
            and tip_motion_mm >= CONTROL_TIP_MOTION_MIN_MM
            and group_p95_mm >= CONTROL_GROUP_P95_MOTION_MIN_MM
            and opposite_motion_mm <= OPPOSITE_HAND_MOTION_MAX_MM
        )
        records.append(
            {
                "control": name,
                "side": side,
                "commanded_degrees": CONTROL_SWEEP_DEGREES,
                "commanded_local_axis": list(axis),
                "actual_local_degrees": actual_angle,
                "local_angle_error_degrees": angle_error,
                "descendant_tip": tip_target_for_control(name),
                "descendant_tip_motion_mm": tip_motion_mm,
                "descendant_tip_motion_along_palm_normal_mm": palm_normal_motion_mm,
                "weighted_group_rms_motion_mm": weighted_rms_mm,
                "group_p95_motion_mm": group_p95_mm,
                "weighted_vertex_count": len(indices),
                "opposite_hand_max_motion_mm": opposite_motion_mm,
                "topology_match": topology_match,
                "finite": finite,
                "pass": record_pass,
            }
        )
    reset_pose(rig)
    tested = [record["control"] for record in records]
    duplicates = sorted({name for name in tested if tested.count(name) > 1})
    return {
        "command_degrees": CONTROL_SWEEP_DEGREES,
        "thresholds": {
            "local_angle_error_degrees": CONTROL_ANGLE_ERROR_LIMIT_DEGREES,
            "descendant_tip_motion_mm": CONTROL_TIP_MOTION_MIN_MM,
            "group_p95_motion_mm": CONTROL_GROUP_P95_MOTION_MIN_MM,
            "opposite_hand_max_motion_mm": OPPOSITE_HAND_MOTION_MAX_MM,
        },
        "tested_control_count": len(tested),
        "duplicate_controls": duplicates,
        "missing_controls": sorted(set(DEFORM_CONTROLS) - set(tested)),
        "unexpected_controls": sorted(set(tested) - set(DEFORM_CONTROLS)),
        "records": records,
        "failed_controls": [
            record["control"] for record in records if not record["pass"]
        ],
        "pass": bool(
            len(tested) == 38
            and len(set(tested)) == 38
            and set(tested) == set(DEFORM_CONTROLS)
            and all(record["pass"] for record in records)
        ),
    }


def local_angle_degrees(rig: bpy.types.Object, name: str) -> float:
    return math.degrees(rig.pose.bones[name].matrix_basis.to_quaternion().angle)


def hand_scale(rig: bpy.types.Object, side: str) -> float:
    return (
        posed_point(rig, f"{side}HandMiddleEnd", "head")
        - posed_point(rig, f"{side}Hand", "head")
    ).length


def distal_group_surface_gap_mm(
    obj: bpy.types.Object,
    first_group_name: str,
    second_group_name: str,
    minimum_weight: float = 0.25,
) -> float | None:
    """Nearest evaluated vertices strongly owned by two distal controls."""

    first_group = obj.vertex_groups.get(first_group_name)
    second_group = obj.vertex_groups.get(second_group_name)
    if first_group is None or second_group is None:
        return None
    first_indices = []
    second_indices = []
    for vertex in obj.data.vertices:
        for entry in vertex.groups:
            if entry.weight < minimum_weight:
                continue
            if entry.group == first_group.index:
                first_indices.append(vertex.index)
            if entry.group == second_group.index:
                second_indices.append(vertex.index)
    points = evaluated_object_points(obj)
    if not first_indices or not second_indices or len(points) != len(obj.data.vertices):
        return None
    tree = KDTree(len(second_indices))
    for insertion_index, vertex_index in enumerate(second_indices):
        tree.insert(points[vertex_index], insertion_index)
    tree.balance()
    return min(tree.find(points[index])[2] for index in first_indices) * 1000.0


def pose_state(
    rig: bpy.types.Object,
    side: str,
    scale: float,
    pose_name: str,
    include_surface_contact: bool = False,
) -> dict:
    wrist, _height, _transverse, _normal = posed_palm_frame(rig, side)
    knuckles = [
        posed_point(rig, f"{side}Hand{digit}1", "head") for digit in FINGERS
    ]
    palm_center = sum(knuckles, Vector()) / len(knuckles)
    tips = {
        digit: posed_point(rig, f"{side}Hand{digit}End", "head")
        for digit in DIGITS
    }
    angles = {
        digit: {
            str(joint): local_angle_degrees(rig, f"{side}Hand{digit}{joint}")
            for joint in (1, 2, 3)
        }
        for digit in DIGITS
    }
    meta_angles = {
        digit: local_angle_degrees(rig, f"{side}Hand{digit}Meta")
        for digit in METACARPALS
    }
    record = {
        "pose": pose_name,
        "hand_scale_m": scale,
        "tip_to_palm_center_scale": {
            digit: (tip - palm_center).length / scale for digit, tip in tips.items()
        },
        "tip_to_wrist_scale": {
            digit: (tip - wrist).length / scale for digit, tip in tips.items()
        },
        "index_pinky_span_scale": (tips["Index"] - tips["Pinky"]).length / scale,
        "thumb_tip_gaps_scale": {
            digit: (tips["Thumb"] - tips[digit]).length / scale for digit in FINGERS
        },
        "local_joint_angles_degrees": angles,
        "local_metacarpal_angles_degrees": meta_angles,
        "all_values_finite": all(
            math.isfinite(value)
            for point in (wrist, palm_center, *tips.values())
            for value in point
        ),
    }
    if include_surface_contact:
        record["thumb_index_distal_group_surface_gap_mm"] = (
            distal_group_surface_gap_mm(
                hand_object(side), f"{side}HandThumb3", f"{side}HandIndex3"
            )
        )
    baseline = NEUTRAL_GEOMETRY.get(side)
    if baseline is not None:
        record["deformation_quality"] = deformation_quality(hand_object(side), baseline)
    return record


def gate(value, relation: str, passed: bool) -> dict:
    return {"value": value, "requirement": relation, "pass": bool(passed)}


def evaluate_pose_gates(states: dict[str, dict]) -> dict:
    open_state = states["open"]
    spread = states["spread"]
    quarter = states["curl-quarter"]
    half = states["curl-half"]
    fist = states["fist"]
    hook = states["hook"]
    tabletop = states["tabletop"]
    index_pose = states["index"]
    v_pose = states["v"]
    o_pose = states["o"]
    c_pose = states["c"]

    def joint_values(state: dict, digits: tuple[str, ...], joint: int) -> list[float]:
        return [
            state["local_joint_angles_degrees"][digit][str(joint)]
            for digit in digits
        ]

    def totals(state: dict, digits: tuple[str, ...]) -> dict[str, float]:
        return {
            digit: sum(state["local_joint_angles_degrees"][digit].values())
            for digit in digits
        }

    open_nonthumb = [
        open_state["local_joint_angles_degrees"][digit][str(joint)]
        for digit in FINGERS
        for joint in (1, 2, 3)
    ]
    open_tip_distances = [
        open_state["thumb_tip_gaps_scale"][digit] for digit in FINGERS
    ]
    spread_ratio = spread["index_pinky_span_scale"] / max(
        open_state["index_pinky_span_scale"], 1.0e-9
    )
    curl_monotonic = all(
        open_state["tip_to_palm_center_scale"][digit]
        + TRANSITION_MONOTONIC_EPSILON_SCALE
        >= quarter["tip_to_palm_center_scale"][digit]
        and quarter["tip_to_palm_center_scale"][digit]
        + TRANSITION_MONOTONIC_EPSILON_SCALE
        >= half["tip_to_palm_center_scale"][digit]
        and half["tip_to_palm_center_scale"][digit]
        + TRANSITION_MONOTONIC_EPSILON_SCALE
        >= fist["tip_to_palm_center_scale"][digit]
        for digit in FINGERS
    )
    index_totals = totals(index_pose, FINGERS)
    v_totals = totals(v_pose, FINGERS)
    o_surface_gap = o_pose.get("thumb_index_distal_group_surface_gap_mm")
    o_thumb_index = o_pose["thumb_tip_gaps_scale"]["Index"]
    c_thumb_index = c_pose["thumb_tip_gaps_scale"]["Index"]

    gates = {
        "skin_deformation_quality": gate(
            {
                pose_name: states[pose_name].get("deformation_quality")
                for pose_name in ("open", "fist", "c", "o", "index", "v")
            },
            "all selected poses remain within triangle-area and edge-stretch limits",
            all(
                states[pose_name].get("deformation_quality", {}).get("pass", False)
                for pose_name in ("open", "fist", "c", "o", "index", "v")
            ),
        ),
        "open_joint_neutral": gate(
            max(open_nonthumb), "maximum <= 5 degrees", max(open_nonthumb) <= 5.0
        ),
        "open_distinct_tips": gate(
            min(open_tip_distances),
            "minimum thumb-to-finger gap > 0.04 hand scale",
            min(open_tip_distances) > 0.04,
        ),
        "spread_width": gate(
            spread_ratio, "Index-Pinky span >= 1.12x open", spread_ratio >= 1.12
        ),
        "spread_outer_metas": gate(
            {
                digit: spread["local_metacarpal_angles_degrees"][digit]
                for digit in ("Index", "Pinky")
            },
            "Index and Pinky Meta rotations >= 12 degrees",
            all(
                spread["local_metacarpal_angles_degrees"][digit] >= 12.0
                for digit in ("Index", "Pinky")
            ),
        ),
        "curl_progression": gate(
            {
                digit: [
                    state["tip_to_palm_center_scale"][digit]
                    for state in (open_state, quarter, half, fist)
                ]
                for digit in FINGERS
            },
            "open >= quarter >= half >= fist within 0.015 hand-scale tolerance",
            curl_monotonic,
        ),
        "hook_angles": gate(
            {
                "mcp": joint_values(hook, FINGERS, 1),
                "pip": joint_values(hook, FINGERS, 2),
                "dip": joint_values(hook, FINGERS, 3),
            },
            "MCP <= 8, PIP 70-100, DIP 45-75 degrees",
            max(joint_values(hook, FINGERS, 1)) <= 8.0
            and min(joint_values(hook, FINGERS, 2)) >= 70.0
            and max(joint_values(hook, FINGERS, 2)) <= 100.0
            and min(joint_values(hook, FINGERS, 3)) >= 45.0
            and max(joint_values(hook, FINGERS, 3)) <= 75.0,
        ),
        "tabletop_angles": gate(
            {
                "mcp": joint_values(tabletop, FINGERS, 1),
                "pip": joint_values(tabletop, FINGERS, 2),
                "dip": joint_values(tabletop, FINGERS, 3),
            },
            "MCP 55-80, PIP/DIP <= 8 degrees",
            min(joint_values(tabletop, FINGERS, 1)) >= 55.0
            and max(joint_values(tabletop, FINGERS, 1)) <= 80.0
            and max(joint_values(tabletop, FINGERS, 2)) <= 8.0
            and max(joint_values(tabletop, FINGERS, 3)) <= 8.0,
        ),
        "index_shape": gate(
            index_totals,
            "Index <= 8 total; Middle/Ring/Pinky >= 180 total degrees",
            index_totals["Index"] <= 8.0
            and all(
                index_totals[digit] >= 180.0
                for digit in ("Middle", "Ring", "Pinky")
            ),
        ),
        "v_shape": gate(
            v_totals,
            "Index/Middle <= 8 total; Ring/Pinky >= 180 total degrees",
            v_totals["Index"] <= 8.0
            and v_totals["Middle"] <= 8.0
            and v_totals["Ring"] >= 180.0
            and v_totals["Pinky"] >= 180.0,
        ),
        "o_contact": gate(
            {
                "endpoint_gap_scale": o_thumb_index,
                "distal_group_surface_gap_mm": o_surface_gap,
            },
            "Thumb-Index endpoint <= 0.10 hand scale and distal surface gap <= 3 mm",
            o_thumb_index <= 0.10
            and o_surface_gap is not None
            and o_surface_gap <= 3.0,
        ),
        "o_contact_is_closest": gate(
            o_pose["thumb_tip_gaps_scale"],
            "Index is the smallest thumb-to-finger endpoint gap",
            o_thumb_index == min(o_pose["thumb_tip_gaps_scale"].values()),
        ),
        "c_aperture": gate(
            c_thumb_index,
            "Thumb-Index endpoint gap is 0.22-0.65 hand scale",
            0.22 <= c_thumb_index <= 0.65,
        ),
    }
    return {
        "gates": gates,
        "failed": [name for name, record in gates.items() if not record["pass"]],
        "pass": all(record["pass"] for record in gates.values()),
    }


def evaluate_selected_pose_gates(states: dict[str, dict]) -> dict:
    """Hard gates for the bounded open/fist/C/O/index/V evidence set."""

    open_state = states["open"]
    fist = states["fist"]
    c_pose = states["c"]
    o_pose = states["o"]
    index_pose = states["index"]
    v_pose = states["v"]

    def totals(state: dict) -> dict[str, float]:
        return {
            digit: sum(state["local_joint_angles_degrees"][digit].values())
            for digit in FINGERS
        }

    open_angles = [
        open_state["local_joint_angles_degrees"][digit][str(joint)]
        for digit in FINGERS
        for joint in (1, 2, 3)
    ]
    fist_totals = totals(fist)
    index_totals = totals(index_pose)
    v_totals = totals(v_pose)
    open_distances = open_state["tip_to_palm_center_scale"]
    fist_distances = fist["tip_to_palm_center_scale"]
    fist_closes = all(
        fist_distances[digit]
        <= open_distances[digit] + TRANSITION_MONOTONIC_EPSILON_SCALE
        for digit in FINGERS
    )
    o_gap = o_pose["thumb_tip_gaps_scale"]["Index"]
    o_surface_gap = o_pose.get("thumb_index_distal_group_surface_gap_mm")
    c_gap = c_pose["thumb_tip_gaps_scale"]["Index"]
    v_meta_angles = v_pose["local_metacarpal_angles_degrees"]
    c_meta_angles = c_pose["local_metacarpal_angles_degrees"]

    gates = {
        "open_joint_neutral": gate(
            max(open_angles), "maximum non-thumb joint rotation <= 5 degrees", max(open_angles) <= 5.0
        ),
        "fist_joint_flexion": gate(
            fist_totals,
            "every non-thumb chain has >= 180 total degrees of flexion",
            all(value >= 180.0 for value in fist_totals.values()),
        ),
        "fist_closes_toward_palm": gate(
            {
                digit: {"open": open_distances[digit], "fist": fist_distances[digit]}
                for digit in FINGERS
            },
            "each fingertip is no farther from the palm than open (+0.015 scale tolerance)",
            fist_closes,
        ),
        "index_shape": gate(
            index_totals,
            "Index <= 8 total; Middle/Ring/Pinky >= 180 total degrees",
            index_totals["Index"] <= 8.0
            and all(index_totals[digit] >= 180.0 for digit in ("Middle", "Ring", "Pinky")),
        ),
        "v_shape": gate(
            v_totals,
            "Index/Middle <= 8 total; Ring/Pinky >= 180 total degrees",
            v_totals["Index"] <= 8.0
            and v_totals["Middle"] <= 8.0
            and v_totals["Ring"] >= 180.0
            and v_totals["Pinky"] >= 180.0,
        ),
        "v_uses_metacarpals": gate(
            v_meta_angles,
            "outer Index and Pinky Meta rotations >= 9 degrees",
            v_meta_angles["Index"] >= 9.0 and v_meta_angles["Pinky"] >= 9.0,
        ),
        "c_uses_metacarpals": gate(
            c_meta_angles,
            "outer Index and Pinky Meta rotations >= 7 degrees",
            c_meta_angles["Index"] >= 7.0 and c_meta_angles["Pinky"] >= 7.0,
        ),
        "o_contact": gate(
            {"endpoint_gap_scale": o_gap, "distal_group_surface_gap_mm": o_surface_gap},
            "Thumb-Index endpoint <= 0.10 scale and distal-group surface gap <= 3 mm",
            o_gap <= 0.10 and o_surface_gap is not None and o_surface_gap <= 3.0,
        ),
        "o_index_is_closest": gate(
            o_pose["thumb_tip_gaps_scale"],
            "Index is the smallest thumb-to-finger endpoint gap",
            o_gap == min(o_pose["thumb_tip_gaps_scale"].values()),
        ),
        "c_aperture": gate(
            c_gap,
            "Thumb-Index endpoint gap is 0.22-0.65 hand scale",
            0.22 <= c_gap <= 0.65,
        ),
    }
    return {
        "gates": gates,
        "failed": [name for name, record in gates.items() if not record["pass"]],
        "pass": all(record["pass"] for record in gates.values()),
    }


def capture_control_quaternions(
    rig: bpy.types.Object,
    side: str,
) -> dict[str, Quaternion]:
    prefix = f"{side}Hand"
    return {
        name: rig.pose.bones[name].matrix_basis.to_quaternion().normalized()
        for name in DEFORM_CONTROLS
        if name.startswith(prefix)
    }


def set_control_quaternions(
    rig: bpy.types.Object,
    values: dict[str, Quaternion],
) -> None:
    for name, quaternion in values.items():
        bone = rig.pose.bones[name]
        bone.rotation_mode = "QUATERNION"
        bone.rotation_quaternion = quaternion
    bpy.context.view_layer.update()


def interpolate_controls(
    start: dict[str, Quaternion],
    end: dict[str, Quaternion],
    fraction: float,
) -> dict[str, Quaternion]:
    return {
        name: start[name].slerp(end[name], fraction).normalized()
        for name in start
    }


def capture_named_pose(
    rig: bpy.types.Object,
    side: str,
    pose_name: str,
) -> tuple[dict[str, Quaternion], dict[str, Vector]]:
    reset_pose(rig)
    apply_pose(rig, side, pose_name)
    quaternions = capture_control_quaternions(rig, side)
    tips = {
        digit: posed_point(rig, f"{side}Hand{digit}End", "head") for digit in DIGITS
    }
    return quaternions, tips


def transition_metrics(
    rig: bpy.types.Object,
    side: str,
    scale: float,
    start_name: str,
    end_name: str,
) -> dict:
    start_quats, _start_tips = capture_named_pose(rig, side, start_name)
    end_quats, end_tips = capture_named_pose(rig, side, end_name)
    other_side = "Right" if side == "Left" else "Left"
    reset_pose(rig)
    opposite_neutral = evaluated_object_points(hand_object(other_side))
    samples = []
    previous_tips = None
    for index in range(11):
        fraction = index / 10.0
        reset_pose(rig)
        set_control_quaternions(
            rig, interpolate_controls(start_quats, end_quats, fraction)
        )
        state = pose_state(
            rig, side, scale, f"{start_name}->{end_name}@{fraction:.1f}"
        )
        tips = {
            digit: posed_point(rig, f"{side}Hand{digit}End", "head")
            for digit in DIGITS
        }
        adjacent_step = (
            max((tips[digit] - previous_tips[digit]).length for digit in DIGITS)
            / scale
            if previous_tips
            else 0.0
        )
        opposite_motion = maximum_point_motion_mm(
            opposite_neutral, evaluated_object_points(hand_object(other_side))
        )
        samples.append(
            {
                "fraction": fraction,
                "maximum_adjacent_tip_step_scale": adjacent_step,
                "mean_nonthumb_tip_to_palm_scale": sum(
                    state["tip_to_palm_center_scale"][digit] for digit in FINGERS
                )
                / len(FINGERS),
                "thumb_index_gap_scale": state["thumb_tip_gaps_scale"]["Index"],
                "opposite_hand_max_motion_mm": opposite_motion,
                "finite": state["all_values_finite"] and math.isfinite(adjacent_step),
            }
        )
        previous_tips = tips

    endpoint_error = max(
        (previous_tips[digit] - end_tips[digit]).length for digit in DIGITS
    ) * 1000.0
    values_key = (
        "mean_nonthumb_tip_to_palm_scale"
        if {start_name, end_name} == {"open", "fist"}
        else "thumb_index_gap_scale"
    )
    values = [sample[values_key] for sample in samples]
    decreasing = end_name in {"fist", "o"}
    monotonic = all(
        (current <= previous + TRANSITION_MONOTONIC_EPSILON_SCALE)
        if decreasing
        else (current + TRANSITION_MONOTONIC_EPSILON_SCALE >= previous)
        for previous, current in zip(values, values[1:])
    )
    maximum_step = max(sample["maximum_adjacent_tip_step_scale"] for sample in samples)
    maximum_opposite = max(
        sample["opposite_hand_max_motion_mm"] for sample in samples
    )
    record_pass = bool(
        all(sample["finite"] for sample in samples)
        and maximum_step <= TRANSITION_STEP_MAX_SCALE
        and monotonic
        and endpoint_error <= TRANSITION_ENDPOINT_MAX_MM
        and maximum_opposite <= OPPOSITE_HAND_MOTION_MAX_MM
    )
    return {
        "start": start_name,
        "end": end_name,
        "monotonic_metric": values_key,
        "monotonic": monotonic,
        "maximum_adjacent_tip_step_scale": maximum_step,
        "endpoint_error_mm": endpoint_error,
        "opposite_hand_max_motion_mm": maximum_opposite,
        "thresholds": {
            "maximum_adjacent_tip_step_scale": TRANSITION_STEP_MAX_SCALE,
            "monotonic_epsilon_scale": TRANSITION_MONOTONIC_EPSILON_SCALE,
            "endpoint_error_mm": TRANSITION_ENDPOINT_MAX_MM,
            "opposite_hand_max_motion_mm": OPPOSITE_HAND_MOTION_MAX_MM,
        },
        "samples": samples,
        "pass": record_pass,
    }


def camera_basis(view_axis: Vector, up_hint: Vector) -> Matrix:
    back = view_axis.normalized()
    forward = -back
    right = forward.cross(up_hint).normalized()
    up = right.cross(forward).normalized()
    return Matrix((right, up, back)).transposed().to_4x4()


def place_camera(
    camera: bpy.types.Object,
    points: list[Vector],
    height: Vector,
    transverse: Vector,
    normal: Vector,
    view: str,
) -> dict:
    axes = {
        "palm": normal,
        "dorsal": -normal,
        "radial": transverse,
        "ulnar": -transverse,
        # Transverse always points Pinky -> Index, so this is an anatomical
        # mirrored view instead of the old global +X bias.
        "three-quarter": (normal + transverse * 0.72).normalized(),
    }
    view_axis = axes[view].normalized()
    center = sum(points, Vector()) / len(points)
    orientation = camera_basis(view_axis, height)
    camera.matrix_world = orientation
    camera.location = center + view_axis * 0.65
    right = orientation.to_3x3().col[0].normalized()
    up = orientation.to_3x3().col[1].normalized()
    widths = [(point - center).dot(right) for point in points]
    heights = [(point - center).dot(up) for point in points]
    width = max(widths) - min(widths)
    height_extent = max(heights) - min(heights)
    extent = max(width, height_extent, 0.11)
    camera.data.ortho_scale = extent / 0.72
    return {
        "center": list(center),
        "view_axis": list(view_axis),
        "anatomical_transverse": list(transverse),
        "surface_width_m": width,
        "surface_height_m": height_extent,
        "ortho_scale": camera.data.ortho_scale,
    }


def stage(scene: bpy.types.Scene) -> bpy.types.Object:
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 560
    scene.render.resolution_y = 560
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.look = "AgX - Medium High Contrast"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("YTSign_Hybrid_Hand_QA_World")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.31, 0.25, 0.20, 1.0)
    background.inputs["Strength"].default_value = 0.36
    camera_data = bpy.data.cameras.new("YTSign_Hybrid_Hand_QA_Camera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("YTSign_Hybrid_Hand_QA_Camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    for name, location, energy, color in (
        ("Hand_Key", (-1.2, -1.5, 1.9), 145.0, (1.0, 0.86, 0.74)),
        ("Hand_Fill", (1.2, -0.8, 1.4), 95.0, (0.82, 0.90, 1.0)),
        ("Hand_Rim", (0.0, 1.4, 1.7), 85.0, (1.0, 0.72, 0.56)),
    ):
        data = bpy.data.lights.new(name, "AREA")
        data.energy = energy
        data.shape = "DISK"
        data.size = 1.4
        data.color = color
        light = bpy.data.objects.new(name, data)
        scene.collection.objects.link(light)
        light.location = Vector(location)
        light.rotation_euler = ((Vector((0.0, 0.0, 1.0)) - light.location).to_track_quat("-Z", "Y").to_euler())
    return camera


def main() -> None:
    output, metrics_only, skin_only = arguments()
    output.mkdir(parents=True, exist_ok=True)
    scene = bpy.context.scene
    camera = stage(scene)
    rig = bpy.data.objects["YTSign_PSL_Rig"]
    for obj in scene.objects:
        if obj.type not in {"CAMERA", "LIGHT"}:
            obj.hide_render = True
    report = {
        "blend": bpy.data.filepath,
        "linguistic_psl_certification": False,
        "linguistic_scope_statement": (
            "Mechanical rig and generic handshape QA only. This does not certify PSL; "
            "fluent Deaf PSL signers must validate linguistic intelligibility."
        ),
        "purpose": (
            "exact bilateral hand-control, deformation, handshape, transition, "
            "and render QA"
        ),
        "skin_only_renders": skin_only,
        "control_manifest": build_control_manifest(rig),
        "control_sweep": None,
        "neutral_hand_topology": {},
        "neutral_bone_pivots": {},
        "skin_deformation_quality": {},
        "preserve_volume_counterfactual": {
            "browser_compatible": False,
            "note": (
                "Diagnostic only: stock glTF/Three.js skinning is linear blend "
                "skinning and does not export Blender's Preserve Volume result."
            ),
            "sides": {},
        },
        "pose_metrics": {},
        "transitions": {},
        "sides": {},
        "passes": {},
        "pass": False,
    }
    report["control_sweep"] = isolated_control_sweep(rig)

    poses = (
        "open",
        "fist",
        "c",
        "o",
        "index",
        "v",
    )
    for side in SIDES:
        hand = hand_object(side)
        nails = [
            bpy.data.objects[f"YTSign_Nail_{side}_{finger}"] for finger in DIGITS
        ]
        visible = [hand] if skin_only else [hand, *nails]
        for obj in visible:
            obj.hide_render = False

        reset_pose(rig)
        scale = hand_scale(rig, side)
        NEUTRAL_GEOMETRY[side] = capture_neutral_geometry(hand)
        report["neutral_hand_topology"][side] = NEUTRAL_GEOMETRY[side]["topology"]
        report["neutral_bone_pivots"][side] = neutral_bone_pivot_metrics(rig, side)
        side_report = {}
        state_records = {}
        report["sides"][side] = side_report
        for pose_name in poses:
            reset_pose(rig)
            apply_pose(rig, side, pose_name)
            state_records[pose_name] = pose_state(
                rig,
                side,
                scale,
                pose_name,
                include_surface_contact=pose_name in {"o", "c"},
            )
            points = evaluated_points(visible)
            _wrist, height, transverse, normal = posed_palm_frame(rig, side)
            views = (
                ("palm", "dorsal", "three-quarter")
                if pose_name == "open"
                else ("palm", "three-quarter")
            )
            records = []
            if not metrics_only:
                for view in views:
                    camera_record = place_camera(
                        camera, points, height, transverse, normal, view
                    )
                    destination = output / side.lower() / pose_name / f"{view}.png"
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    scene.render.filepath = str(destination)
                    bpy.ops.render.render(write_still=True)
                    records.append({"view": view, "file": str(destination), **camera_record})
                    print(f"HYBRID_HAND_QA_RENDER={destination}")
            side_report[pose_name] = records

        report["pose_metrics"][side] = {
            "states": state_records,
            **evaluate_selected_pose_gates(state_records),
        }
        failed_deformation_poses = [
            pose_name
            for pose_name, state in state_records.items()
            if not state["deformation_quality"]["pass"]
        ]
        report["skin_deformation_quality"][side] = {
            "poses": {
                pose_name: state["deformation_quality"]
                for pose_name, state in state_records.items()
            },
            "failed_poses": failed_deformation_poses,
            "pass": not failed_deformation_poses,
        }

        armature_modifiers = [
            modifier for modifier in hand.modifiers if modifier.type == "ARMATURE"
        ]
        original_preserve_volume = [
            modifier.use_deform_preserve_volume for modifier in armature_modifiers
        ]
        for modifier in armature_modifiers:
            modifier.use_deform_preserve_volume = True
        preserve_volume_poses = {}
        for pose_name in poses:
            reset_pose(rig)
            apply_pose(rig, side, pose_name)
            preserve_volume_poses[pose_name] = deformation_quality(
                hand, NEUTRAL_GEOMETRY[side]
            )
        for modifier, original in zip(armature_modifiers, original_preserve_volume):
            modifier.use_deform_preserve_volume = original
        report["preserve_volume_counterfactual"]["sides"][side] = {
            "poses": preserve_volume_poses,
            "failed_poses": [
                pose_name
                for pose_name, record in preserve_volume_poses.items()
                if not record["pass"]
            ],
        }
        transition_records = [
            transition_metrics(rig, side, scale, start, end)
            for start, end in (
                ("open", "fist"),
                ("fist", "open"),
                ("c", "o"),
                ("o", "c"),
            )
        ]
        report["transitions"][side] = {
            "records": transition_records,
            "failed": [
                f"{record['start']}->{record['end']}"
                for record in transition_records
                if not record["pass"]
            ],
            "pass": all(record["pass"] for record in transition_records),
        }
        for obj in visible:
            obj.hide_render = True

    reset_pose(rig)
    report["passes"] = {
        "exact_control_manifest": report["control_manifest"]["pass"],
        "isolated_control_sweep": report["control_sweep"]["pass"],
        "neutral_bone_pivots": all(
            report["neutral_bone_pivots"][side]["pass"] for side in SIDES
        ),
        "skin_deformation_quality": all(
            report["skin_deformation_quality"][side]["pass"] for side in SIDES
        ),
        "pose_metrics": all(
            report["pose_metrics"][side]["pass"] for side in SIDES
        ),
        "transitions": all(
            report["transitions"][side]["pass"] for side in SIDES
        ),
    }
    report["pass"] = all(report["passes"].values())
    report_path = output / "hand-qa-report.json"
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"YTSIGN_HYBRID_HAND_QA={report_path}")
    print(f"YTSIGN_HYBRID_HAND_QA_PASS={report['pass']}")


if __name__ == "__main__":
    main()
