"""Render neutral validation views from the processed signing-avatar blend."""

from __future__ import annotations

import sys
import math
from pathlib import Path

import bpy
from mathutils import Vector


def look_at(camera: bpy.types.Object, target: Vector) -> None:
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def render_view(scene, camera, path: Path, location, target, scale: float) -> None:
    camera.location = Vector(location)
    camera.data.ortho_scale = scale
    look_at(camera, Vector(target))
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    print(f"PREVIEW={path}")


def main() -> None:
    if "--" not in sys.argv:
        raise SystemExit("Expected: -- OUTPUT_DIRECTORY")
    output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
    output.mkdir(parents=True, exist_ok=True)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 760
    scene.render.resolution_y = 760
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "WORLD"
    scene.display.shading.background_type = "WORLD"
    if scene.world is None:
        scene.world = bpy.data.worlds.new("PreviewWorld")
    scene.world.color = (0.018, 0.035, 0.055)

    camera_data = bpy.data.cameras.new("PreviewCamera")
    camera_data.type = "ORTHO"
    camera = bpy.data.objects.new("PreviewCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera

    for obj in scene.objects:
        if obj.type == "ARMATURE":
            obj.hide_render = True

    render_view(scene, camera, output / "avatar-front.png", (0, -4, 1.18), (0, 0, 1.18), 1.52)
    render_view(scene, camera, output / "avatar-three-quarter.png", (2.4, -3.7, 1.2), (0, 0, 1.18), 1.52)
    render_view(scene, camera, output / "avatar-left-hand.png", (0.32, -2.0, 0.87), (0.32, -0.05, 0.87), 0.31)
    render_view(scene, camera, output / "avatar-right-hand.png", (-0.32, -2.0, 0.87), (-0.32, -0.05, 0.87), 0.31)

    armature = next(obj for obj in scene.objects if obj.type == "ARMATURE")
    for side in ("Left", "Right"):
        for finger in ("Thumb", "Index", "Middle", "Ring", "Pinky"):
            for index, degrees in enumerate((22, 34, 42), start=1):
                bone = armature.pose.bones.get(f"{side}Hand{finger}{index}")
                if bone:
                    bone.rotation_mode = "XYZ"
                    bone.rotation_euler.x = math.radians(degrees)
    bpy.context.view_layer.update()
    render_view(scene, camera, output / "avatar-left-hand-curled.png", (0.32, -2.0, 0.87), (0.32, -0.05, 0.87), 0.31)
    render_view(scene, camera, output / "avatar-right-hand-curled.png", (-0.32, -2.0, 0.87), (-0.32, -0.05, 0.87), 0.31)


if __name__ == "__main__":
    main()
