"""Inspect a Meshy avatar export with Blender and write a deterministic JSON report.

Usage:
  blender --background --python inspect_avatar.py -- input.glb report.json
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy


def arguments() -> tuple[Path, Path]:
    if "--" not in sys.argv:
        raise SystemExit("Expected: -- INPUT OUTPUT")
    values = sys.argv[sys.argv.index("--") + 1 :]
    if len(values) != 2:
        raise SystemExit("Expected exactly two arguments: INPUT OUTPUT")
    return Path(values[0]).resolve(), Path(values[1]).resolve()


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_model(path: Path) -> None:
    suffix = path.suffix.lower()
    if suffix in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=str(path))
    elif suffix == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path), use_anim=True)
    else:
        raise ValueError(f"Unsupported model format: {suffix}")


def rounded_vector(value) -> list[float]:
    return [round(float(component), 6) for component in value]


def object_bounds(obj: bpy.types.Object) -> dict[str, list[float]] | None:
    if not getattr(obj, "bound_box", None):
        return None
    corners = [obj.matrix_world @ mathutils_vector(corner) for corner in obj.bound_box]
    return {
        "min": [round(min(point[index] for point in corners), 6) for index in range(3)],
        "max": [round(max(point[index] for point in corners), 6) for index in range(3)],
    }


def mathutils_vector(value):
    from mathutils import Vector

    return Vector(value)


def mesh_report(obj: bpy.types.Object) -> dict:
    mesh = obj.data
    loop_triangles = len(mesh.loop_triangles)
    if not loop_triangles:
        mesh.calc_loop_triangles()
        loop_triangles = len(mesh.loop_triangles)

    influences = []
    unweighted = 0
    max_influences = 0
    for vertex in mesh.vertices:
        weights = [group.weight for group in vertex.groups if group.weight > 0.00001]
        count = len(weights)
        max_influences = max(max_influences, count)
        if count == 0:
            unweighted += 1
        influences.append(count)

    modifier_armatures = [
        modifier.object.name if modifier.object else None
        for modifier in obj.modifiers
        if modifier.type == "ARMATURE"
    ]
    shape_keys = []
    if mesh.shape_keys:
        shape_keys = [block.name for block in mesh.shape_keys.key_blocks]

    group_stats = {}
    interesting = {
        group.index: group.name
        for group in obj.vertex_groups
        if any(token in group.name.lower() for token in ("hand", "forearm", "arm", "head", "neck"))
    }
    for group_index, group_name in interesting.items():
        weighted = []
        for vertex in mesh.vertices:
            weight = next((entry.weight for entry in vertex.groups if entry.group == group_index), 0.0)
            if weight >= 0.05:
                weighted.append((obj.matrix_world @ vertex.co, weight))
        if weighted:
            points = [entry[0] for entry in weighted]
            group_stats[group_name] = {
                "vertices_005": len(weighted),
                "vertices_025": sum(1 for _, weight in weighted if weight >= 0.25),
                "vertices_050": sum(1 for _, weight in weighted if weight >= 0.5),
                "vertices_090": sum(1 for _, weight in weighted if weight >= 0.9),
                "bounds": {
                    "min": [round(min(point[index] for point in points), 6) for index in range(3)],
                    "max": [round(max(point[index] for point in points), 6) for index in range(3)],
                },
                "centroid": [
                    round(sum(point[index] for point in points) / len(points), 6)
                    for index in range(3)
                ],
            }

    return {
        "name": obj.name,
        "vertices": len(mesh.vertices),
        "edges": len(mesh.edges),
        "polygons": len(mesh.polygons),
        "triangles": loop_triangles,
        "materials": [slot.material.name if slot.material else None for slot in obj.material_slots],
        "uv_layers": [layer.name for layer in mesh.uv_layers],
        "shape_keys": shape_keys,
        "vertex_groups": [group.name for group in obj.vertex_groups],
        "armature_modifiers": modifier_armatures,
        "unweighted_vertices": unweighted,
        "max_vertex_influences": max_influences,
        "average_vertex_influences": round(sum(influences) / max(1, len(influences)), 4),
        "deformation_group_stats": group_stats,
        "bounds": object_bounds(obj),
    }


def armature_report(obj: bpy.types.Object) -> dict:
    bones = []
    for bone in obj.data.bones:
        bones.append(
            {
                "name": bone.name,
                "parent": bone.parent.name if bone.parent else None,
                "head": rounded_vector(bone.head_local),
                "tail": rounded_vector(bone.tail_local),
                "world_head": rounded_vector(obj.matrix_world @ bone.head_local),
                "world_tail": rounded_vector(obj.matrix_world @ bone.tail_local),
                "length": round(float(bone.length), 6),
                "deform": bool(bone.use_deform),
            }
        )
    return {
        "name": obj.name,
        "bones": bones,
        "bone_count": len(bones),
        "bounds": object_bounds(obj),
        "action": obj.animation_data.action.name if obj.animation_data and obj.animation_data.action else None,
    }


def material_report(material: bpy.types.Material) -> dict:
    images = []
    if material.use_nodes and material.node_tree:
        for node in material.node_tree.nodes:
            if node.type == "TEX_IMAGE" and node.image:
                images.append(
                    {
                        "name": node.image.name,
                        "size": list(node.image.size),
                        "packed": bool(node.image.packed_file),
                        "filepath": node.image.filepath,
                    }
                )
    return {
        "name": material.name,
        "blend_method": getattr(material, "surface_render_method", "DITHERED"),
        "images": images,
    }


def main() -> None:
    input_path, output_path = arguments()
    reset_scene()
    import_model(input_path)

    meshes = [mesh_report(obj) for obj in bpy.context.scene.objects if obj.type == "MESH"]
    armatures = [armature_report(obj) for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    objects = [
        {
            "name": obj.name,
            "type": obj.type,
            "parent": obj.parent.name if obj.parent else None,
            "location": rounded_vector(obj.location),
            "rotation_euler": rounded_vector(obj.rotation_euler),
            "scale": rounded_vector(obj.scale),
        }
        for obj in bpy.context.scene.objects
    ]

    report = {
        "input": str(input_path),
        "blender": bpy.app.version_string,
        "objects": objects,
        "meshes": meshes,
        "armatures": armatures,
        "materials": [material_report(material) for material in bpy.data.materials],
        "actions": [
            {
                "name": action.name,
                "frame_range": [round(float(value), 4) for value in action.frame_range],
                "slots": len(action.slots),
            }
            for action in bpy.data.actions
        ],
        "totals": {
            "objects": len(objects),
            "meshes": len(meshes),
            "armatures": len(armatures),
            "vertices": sum(mesh["vertices"] for mesh in meshes),
            "polygons": sum(mesh["polygons"] for mesh in meshes),
            "triangles": sum(mesh["triangles"] for mesh in meshes),
            "bones": sum(armature["bone_count"] for armature in armatures),
            "shape_keys": sum(len(mesh["shape_keys"]) for mesh in meshes),
        },
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"AVATAR_REPORT={output_path}")


if __name__ == "__main__":
    main()
