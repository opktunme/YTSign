"""Estimate hand landmarks from the Meshy mesh for finger-rig placement."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import bpy
import numpy as np


def args() -> tuple[Path, Path]:
    values = sys.argv[sys.argv.index("--") + 1 :]
    return Path(values[0]).resolve(), Path(values[1]).resolve()


def weighted_points(mesh_obj: bpy.types.Object, group_name: str, minimum: float = 0.5) -> np.ndarray:
    group = mesh_obj.vertex_groups[group_name]
    result = []
    for vertex in mesh_obj.data.vertices:
        weight = next((entry.weight for entry in vertex.groups if entry.group == group.index), 0.0)
        if weight >= minimum:
            point = mesh_obj.matrix_world @ vertex.co
            result.append((point.x, point.y, point.z, weight))
    return np.asarray(result, dtype=np.float64)


def kmeans_1d(values: np.ndarray, count: int = 4) -> tuple[np.ndarray, np.ndarray]:
    centers = np.quantile(values, np.linspace(0.1, 0.9, count))
    labels = np.zeros(len(values), dtype=np.int32)
    for _ in range(40):
        distances = np.abs(values[:, None] - centers[None, :])
        labels = np.argmin(distances, axis=1)
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


def point(values: np.ndarray) -> list[float]:
    return [round(float(value), 6) for value in values[:3]]


def analyze(mesh_obj: bpy.types.Object, armature: bpy.types.Object, side: str) -> dict:
    name = f"{side}Hand"
    points = weighted_points(mesh_obj, name)
    xyz = points[:, :3]
    wrist = armature.matrix_world @ armature.data.bones[name].head_local
    wrist_np = np.asarray(wrist[:], dtype=np.float64)

    # The source is an A-pose with open palms and the four long fingers pointing
    # downward. Restrict clustering to the distal half so palm density does not
    # swallow the shorter pinky/index clusters.
    low_cut = np.quantile(xyz[:, 2], 0.44)
    distal = xyz[xyz[:, 2] <= low_cut]
    centers, labels = kmeans_1d(distal[:, 0], 4)
    fingers = []
    for cluster in range(4):
        cluster_points = distal[labels == cluster]
        tip_cut = np.quantile(cluster_points[:, 2], 0.035)
        tip_points = cluster_points[cluster_points[:, 2] <= tip_cut]
        tip = np.median(tip_points, axis=0)
        fingers.append({
            "center_x": round(float(centers[cluster]), 6),
            "points": int(len(cluster_points)),
            "tip": point(tip),
            "z_range": [round(float(cluster_points[:, 2].min()), 6), round(float(cluster_points[:, 2].max()), 6)],
        })

    outward = 1 if side == "Left" else -1
    signed_x = xyz[:, 0] * outward
    thumb_cut = np.quantile(signed_x, 0.992)
    thumb_points = xyz[signed_x >= thumb_cut]
    thumb_tip = np.median(thumb_points, axis=0)

    return {
        "group": name,
        "point_count": int(len(xyz)),
        "bounds": {
            "min": point(xyz.min(axis=0)),
            "max": point(xyz.max(axis=0)),
        },
        "quantiles": {
            "x": [round(float(value), 6) for value in np.quantile(xyz[:, 0], [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1])],
            "y": [round(float(value), 6) for value in np.quantile(xyz[:, 1], [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1])],
            "z": [round(float(value), 6) for value in np.quantile(xyz[:, 2], [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1])],
        },
        "wrist": point(wrist_np),
        "palm_center": point(np.median(xyz, axis=0)),
        "finger_candidates_x_order": fingers,
        "thumb_tip": point(thumb_tip),
    }


def main() -> None:
    input_path, output_path = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(input_path))
    mesh_obj = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name == "char1")
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    report = {side: analyze(mesh_obj, armature, side) for side in ("Left", "Right")}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"HAND_REPORT={output_path}")


if __name__ == "__main__":
    main()
