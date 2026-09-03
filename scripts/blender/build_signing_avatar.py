"""Turn the Meshy body rig into a browser-ready signing avatar.

The Meshy export contains body/wrist bones but no finger or facial rig. This
script preserves its body weights, estimates finger chains from the open-palm
A-pose, adds MediaPipe-compatible finger bones, transfers the hand weights,
reduces runtime geometry, downsizes the 4K texture, and exports GLB.

Usage:
  blender --background --python build_signing_avatar.py -- \
    INPUT.glb OUTPUT.blend OUTPUT.glb REPORT.json [TARGET_TRIANGLES]
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector


FINGER_ORDER = {
    "Left": ["Pinky", "Ring", "Middle", "Index"],
    "Right": ["Index", "Middle", "Ring", "Pinky"],
}


def arguments() -> tuple[Path, Path, Path, Path, int]:
    if "--" not in sys.argv:
        raise SystemExit("Expected arguments after --")
    values = sys.argv[sys.argv.index("--") + 1 :]
    if len(values) not in (4, 5):
        raise SystemExit("Expected INPUT BLEND GLB REPORT [TARGET_TRIANGLES]")
    target = int(values[4]) if len(values) == 5 else 120_000
    return tuple(Path(value).resolve() for value in values[:4]) + (target,)


def import_source(path: Path) -> tuple[bpy.types.Object, bpy.types.Object]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    mesh = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name == "char1")
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")

    for obj in list(bpy.context.scene.objects):
        if obj.type == "MESH" and obj != mesh:
            bpy.data.objects.remove(obj, do_unlink=True)

    armature.animation_data_clear()
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    for pose_bone in armature.pose.bones:
        pose_bone.matrix_basis.identity()
        # Meshy's terminal-bone display spheres are Blender custom shapes. If
        # kept, glTF exports the helper as a visible mesh at the model origin.
        pose_bone.custom_shape = None
    bpy.context.view_layer.update()
    return mesh, armature


def group_weight(vertex: bpy.types.MeshVertex, group_index: int) -> float:
    return next((entry.weight for entry in vertex.groups if entry.group == group_index), 0.0)


def weighted_points(mesh: bpy.types.Object, group_name: str, minimum: float = 0.5) -> np.ndarray:
    group = mesh.vertex_groups[group_name]
    values = []
    for vertex in mesh.data.vertices:
        weight = group_weight(vertex, group.index)
        if weight >= minimum:
            world = mesh.matrix_world @ vertex.co
            values.append((world.x, world.y, world.z))
    return np.asarray(values, dtype=np.float64)


def kmeans_1d(values: np.ndarray, count: int = 4) -> tuple[np.ndarray, np.ndarray]:
    centers = np.quantile(values, np.linspace(0.1, 0.9, count))
    labels = np.zeros(len(values), dtype=np.int32)
    for _ in range(50):
        labels = np.argmin(np.abs(values[:, None] - centers[None, :]), axis=1)
        updated = np.asarray(
            [values[labels == index].mean() if np.any(labels == index) else centers[index] for index in range(count)]
        )
        if np.allclose(updated, centers):
            break
        centers = updated
    order = np.argsort(centers)
    remap = np.empty_like(order)
    remap[order] = np.arange(count)
    return centers[order], remap[labels]


def estimate_chains(mesh: bpy.types.Object, armature: bpy.types.Object, side: str) -> dict[str, list[Vector]]:
    hand_name = f"{side}Hand"
    xyz = weighted_points(mesh, hand_name)
    palm = np.median(xyz, axis=0)

    low_cut = np.quantile(xyz[:, 2], 0.44)
    distal = xyz[xyz[:, 2] <= low_cut]
    centers, labels = kmeans_1d(distal[:, 0], 4)
    chains: dict[str, list[Vector]] = {}
    for cluster, finger_name in enumerate(FINGER_ORDER[side]):
        cluster_points = distal[labels == cluster]
        tip_cut = np.quantile(cluster_points[:, 2], 0.035)
        tip = np.median(cluster_points[cluster_points[:, 2] <= tip_cut], axis=0)
        base = np.asarray(
            [
                centers[cluster],
                palm[1],
                max(float(palm[2] - 0.006), float(tip[2] + 0.064)),
            ],
            dtype=np.float64,
        )
        fractions = (0.0, 0.36, 0.69, 1.0)
        chains[finger_name] = [Vector(base + (tip - base) * fraction) for fraction in fractions]

    outward = 1.0 if side == "Left" else -1.0
    signed_x = xyz[:, 0] * outward
    thumb_cut = np.quantile(signed_x, 0.992)
    thumb_tip = np.median(xyz[signed_x >= thumb_cut], axis=0)
    thumb_base = np.asarray(
        [palm[0] + outward * 0.014, palm[1], palm[2] + 0.014],
        dtype=np.float64,
    )
    chains["Thumb"] = [
        Vector(thumb_base + (thumb_tip - thumb_base) * fraction)
        for fraction in (0.0, 0.35, 0.68, 1.0)
    ]
    return chains


def add_finger_bones(
    armature: bpy.types.Object,
    all_chains: dict[str, dict[str, list[Vector]]],
) -> list[str]:
    inverse = armature.matrix_world.inverted()
    created = []
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    for side, chains in all_chains.items():
        hand_parent = armature.data.edit_bones[f"{side}Hand"]
        for finger_name in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
            points = chains[finger_name]
            parent = hand_parent
            for index in range(3):
                name = f"{side}Hand{finger_name}{index + 1}"
                bone = armature.data.edit_bones.new(name)
                bone.head = inverse @ points[index]
                bone.tail = inverse @ points[index + 1]
                bone.parent = parent
                bone.use_connect = index > 0
                bone.use_deform = True
                parent = bone
                created.append(name)
            direction = (points[3] - points[2]).normalized()
            end = armature.data.edit_bones.new(f"{side}Hand{finger_name}End")
            end.head = inverse @ points[3]
            end.tail = inverse @ (points[3] + direction * 0.006)
            end.parent = parent
            end.use_connect = True
            end.use_deform = False
            created.append(end.name)
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()
    return created


def closest_chain(point: Vector, chains: dict[str, list[Vector]], side: str):
    outward = 1.0 if side == "Left" else -1.0
    best = None
    for finger_name, joints in chains.items():
        base = joints[0]
        tip = joints[-1]
        if finger_name == "Thumb":
            # Keep the thenar/palm mass on the hand bone. Only the clearly
            # separated thumb shaft should follow the phalanx chain.
            if point.x * outward < base.x * outward - 0.003:
                continue
        elif point.z > base.z + 0.008:
            continue

        total = sum((joints[index + 1] - joints[index]).length for index in range(3))
        elapsed = 0.0
        for segment in range(3):
            start = joints[segment]
            finish = joints[segment + 1]
            vector = finish - start
            length = vector.length
            local = max(0.0, min(1.0, (point - start).dot(vector) / max(vector.length_squared, 1e-9)))
            nearest = start + vector * local
            # Ignore depth when deciding which separated finger owns a vertex;
            # the bone runs through the middle while front/back surfaces are far
            # apart relative to finger spacing.
            distance_2d = math.hypot(point.x - nearest.x, point.z - nearest.z)
            global_t = (elapsed + length * local) / max(total, 1e-9)
            candidate = (distance_2d, finger_name, global_t)
            if best is None or candidate[0] < best[0]:
                best = candidate
            elapsed += length

    if best is None:
        return None
    threshold = 0.045 if best[1] == "Thumb" else 0.04
    return best if best[0] <= threshold else None


def smoothstep(edge0: float, edge1: float, value: float) -> float:
    t = max(0.0, min(1.0, (value - edge0) / max(edge1 - edge0, 1e-9)))
    return t * t * (3.0 - 2.0 * t)


def segment_weights(t: float) -> list[float]:
    centers = (0.18, 0.525, 0.845)
    raw = [max(0.0, 1.0 - abs(t - center) / 0.34) for center in centers]
    if not any(raw):
        raw[0 if t < 0.5 else 2] = 1.0
    total = sum(raw)
    return [value / total for value in raw]


def transfer_finger_weights(
    mesh: bpy.types.Object,
    all_chains: dict[str, dict[str, list[Vector]]],
) -> dict:
    report = {}
    for side, chains in all_chains.items():
        hand_name = f"{side}Hand"
        hand_group = mesh.vertex_groups[hand_name]
        new_groups = {
            finger: [mesh.vertex_groups.new(name=f"{side}Hand{finger}{index}") for index in range(1, 4)]
            for finger in ("Thumb", "Index", "Middle", "Ring", "Pinky")
        }
        assigned = {finger: 0 for finger in new_groups}
        for vertex in mesh.data.vertices:
            original = group_weight(vertex, hand_group.index)
            if original <= 0.001:
                continue
            world = mesh.matrix_world @ vertex.co
            match = closest_chain(world, chains, side)
            if not match:
                continue
            _, finger, t = match
            amount = smoothstep(0.04, 0.22, t)
            if amount <= 0.001:
                continue
            weights = segment_weights(t)
            # Distal finger vertices must follow the finger chain completely.
            # Meshy's original rig sometimes leaves small arm/forearm weights
            # on fingertips; retaining those produces anchored spikes on curl.
            previous = [(entry.group, entry.weight) for entry in vertex.groups]
            previous_total = sum(weight for _, weight in previous)
            for group_index, weight in previous:
                mesh.vertex_groups[group_index].add([vertex.index], weight * (1.0 - amount), "REPLACE")
            for group, weight in zip(new_groups[finger], weights):
                if weight > 0.0001:
                    group.add([vertex.index], max(previous_total, 1.0) * amount * weight, "REPLACE")
            assigned[finger] += 1
        report[side] = assigned
    return report


def triangle_count(mesh: bpy.types.Object) -> int:
    mesh.data.calc_loop_triangles()
    return len(mesh.data.loop_triangles)


def optimize_mesh(mesh: bpy.types.Object, target_triangles: int) -> tuple[int, int]:
    before = triangle_count(mesh)
    if before <= target_triangles:
        return before, before
    modifier = mesh.modifiers.new(name="RuntimeDecimate", type="DECIMATE")
    modifier.decimate_type = "COLLAPSE"
    modifier.ratio = max(0.01, min(1.0, target_triangles / before))
    modifier.use_collapse_triangulate = True
    bpy.context.view_layer.objects.active = mesh
    mesh.select_set(True)
    while mesh.modifiers.find(modifier.name) > 0:
        bpy.ops.object.modifier_move_up(modifier=modifier.name)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    return before, triangle_count(mesh)


def limit_influences(mesh: bpy.types.Object, maximum: int = 4) -> int:
    """Prune and normalize weights so glTF does not silently choose joints."""
    changed = 0
    for vertex in mesh.data.vertices:
        influences = sorted(
            [(entry.group, entry.weight) for entry in vertex.groups if entry.weight > 0.00001],
            key=lambda item: item[1],
            reverse=True,
        )
        if len(influences) > maximum:
            changed += 1
            for group_index, _ in influences[maximum:]:
                mesh.vertex_groups[group_index].remove([vertex.index])
            influences = influences[:maximum]
        total = sum(weight for _, weight in influences)
        if total > 0:
            for group_index, weight in influences:
                mesh.vertex_groups[group_index].add([vertex.index], weight / total, "REPLACE")
    return changed


def resize_textures(maximum: int = 2048) -> list[dict]:
    report = []
    for image in bpy.data.images:
        width, height = image.size
        if width <= 0 or height <= 0:
            continue
        original = [int(width), int(height)]
        if max(width, height) > maximum:
            scale = maximum / max(width, height)
            image.scale(max(1, round(width * scale)), max(1, round(height * scale)))
        report.append({"name": image.name, "from": original, "to": [int(image.size[0]), int(image.size[1])]})
    return report


def export(mesh: bpy.types.Object, armature: bpy.types.Object, blend_path: Path, glb_path: Path) -> None:
    blend_path.parent.mkdir(parents=True, exist_ok=True)
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    mesh["signing_avatar"] = True
    armature["signing_rig_version"] = 1
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.export_scene.gltf(
        filepath=str(glb_path),
        export_format="GLB",
        use_selection=True,
        export_animations=False,
        export_skins=True,
        export_morph=False,
        export_def_bones=False,
        export_lights=False,
        export_cameras=False,
        export_yup=True,
    )


def main() -> None:
    source, blend_path, glb_path, report_path, target_triangles = arguments()
    mesh, armature = import_source(source)
    chains = {side: estimate_chains(mesh, armature, side) for side in ("Left", "Right")}
    created = add_finger_bones(armature, chains)
    weights = transfer_finger_weights(mesh, chains)
    before, after = optimize_mesh(mesh, target_triangles)
    pruned_vertices = limit_influences(mesh, 4)
    textures = resize_textures(2048)
    export(mesh, armature, blend_path, glb_path)

    report = {
        "source": str(source),
        "blend": str(blend_path),
        "glb": str(glb_path),
        "target_triangles": target_triangles,
        "triangles_before": before,
        "triangles_after": after,
        "created_bones": created,
        "bone_count": len(armature.data.bones),
        "assigned_vertices": weights,
        "vertices_pruned_to_four_influences": pruned_vertices,
        "textures": textures,
        "chains": {
            side: {
                finger: [[round(value, 6) for value in point] for point in points]
                for finger, points in side_chains.items()
            }
            for side, side_chains in chains.items()
        },
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"SIGNING_AVATAR={glb_path}")
    print(f"SIGNING_AVATAR_REPORT={report_path}")


if __name__ == "__main__":
    main()
