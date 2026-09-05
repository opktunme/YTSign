"""Repair only hybrid body sleeve/torso weights; preserve hand meshes and bones.

Usage: blender INPUT.blend --background --python repair_hybrid_sleeves.py --
       OUTPUT.blend OUTPUT.glb REPORT.json
"""
from __future__ import annotations
import hashlib
import json
import sys
from pathlib import Path
import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_hybrid_signer import closest_segment, export_avatar


def smooth(low, high, value):
    x = max(0.0, min(1.0, (value - low) / (high - low)))
    return x * x * (3.0 - 2.0 * x)


def checksum(obj):
    values = [[(g.group, round(g.weight, 8)) for g in v.groups] for v in obj.data.vertices]
    return hashlib.sha256(json.dumps(values).encode()).hexdigest()


def main():
    args = sys.argv[sys.argv.index("--") + 1:]
    if len(args) != 3:
        raise SystemExit("Expected OUTPUT.blend OUTPUT.glb REPORT.json")
    blend, glb, report_path = map(lambda p: Path(p).resolve(), args)
    rig = bpy.data.objects["YTSign_PSL_Rig"]
    source_path = bpy.data.filepath
    body = bpy.data.objects["YTSign_PSL_Signer_Body"]
    hands = [bpy.data.objects[f"YTSign_PSL_Hand_{side}"] for side in ("L", "R")]
    before = {hand.name: checksum(hand) for hand in hands}
    groups = {g.index: g.name for g in body.vertex_groups}
    arm_names = {f"{side}{bone}" for side in ("Left", "Right") for bone in ("Shoulder", "Arm", "ForeArm", "Hand")}
    segments = {}
    for side in ("Left", "Right"):
        segments[side] = tuple(rig.matrix_world @ rig.data.bones[f"{side}{bone}"].head_local
                               for bone in ("Arm", "ForeArm", "Hand"))
    assignments = {}
    counts = {"Left": 0, "Right": 0, "torso": 0, "boundary": 0}
    for vertex in body.data.vertices:
        p = body.matrix_world @ vertex.co
        if not (.80 < p.z < 1.43 and .055 < abs(p.x) < .43):
            continue
        old = {groups[g.group]: g.weight for g in vertex.groups if g.weight > 1e-7}
        if not any(name in arm_names for name in old):
            # Include prior torso-reset vertices within the same continuous
            # boundary as their arm-weighted neighbors.
            if not (p.z > .88 and abs(p.x) > .10):
                continue
        side = "Left" if p.x > 0 else "Right"
        shoulder, elbow, wrist = segments[side]
        upper_t, upper_distance = closest_segment(p, shoulder, elbow)
        lower_t, lower_distance = closest_segment(p, elbow, wrist)
        distance = min(upper_distance, lower_distance)
        # One continuous membership function governs both sleeve and torso.
        # The medial boundary follows the source A-pose arm toward the wrist,
        # keeping low abdomen vertices (.15-.18m from center) on the torso.
        arm_x = abs(elbow.x + (wrist.x - elbow.x) * max(0.0, min(1.0, (elbow.z-p.z)/(elbow.z-wrist.z))))
        if p.z >= elbow.z:
            t = max(0.0, min(1.0, (p.z-elbow.z)/(shoulder.z-elbow.z)))
            arm_x = abs(elbow.x + (shoulder.x-elbow.x)*t)
        medial = arm_x - .100
        membership = smooth(medial - .005, medial + .025, abs(p.x))
        membership *= 1.0 - smooth(.085, .125, distance)
        membership *= smooth(.80, .89, p.z) * (1.0 - smooth(1.38, 1.43, p.z))
        torso = {name: value for name, value in old.items() if name not in arm_names}
        total = sum(torso.values())
        if total > .04:
            torso = {name: value / total for name, value in torso.items()}
        else:
            blend_spine = max(0.0, min(.85, (p.z-.78)/.52))
            torso = {"Hips": 1.0-blend_spine, "Spine": blend_spine}
        if upper_distance <= lower_distance:
            shoulder_weight = (1.0-smooth(0, .20, upper_t))*.42
            forearm_weight = smooth(.72, 1.0, upper_t)*.5
            arm = {f"{side}Shoulder": shoulder_weight,
                   f"{side}Arm": 1.0-shoulder_weight-forearm_weight,
                   f"{side}ForeArm": forearm_weight}
        else:
            upper_weight = (1.0-smooth(0, .22, lower_t))*.5
            arm = {f"{side}Arm": upper_weight, f"{side}ForeArm": 1.0-upper_weight}
        weights = {name: value*(1.0-membership) for name,value in torso.items()}
        for name,value in arm.items(): weights[name] = weights.get(name, 0)+value*membership
        assignments[vertex.index] = {name:value for name,value in weights.items() if value>1e-6}
        counts[side] += 1
        if membership<.01: counts["torso"] += 1
        elif membership<.99: counts["boundary"] += 1
    indices = list(assignments)
    for group in body.vertex_groups: group.remove(indices)
    buckets = {}
    for index, weights in assignments.items():
        for name, value in weights.items():
            quantized = max(0, min(1000, round(value*1000)))
            if quantized: buckets.setdefault((name,quantized), []).append(index)
    for (name,weight), vertices in buckets.items():
        group=body.vertex_groups.get(name) or body.vertex_groups.new(name=name)
        group.add(vertices, weight/1000.0, "REPLACE")
    body.data.update()
    after={hand.name:checksum(hand) for hand in hands}
    assert before==after, "Hand weights changed unexpectedly"
    extras=[obj for obj in bpy.context.scene.objects if obj.type=="MESH" and obj not in [body,*hands] and obj.get("ytsign_export")]
    textures=export_avatar(rig,body,hands,extras,blend,glb)
    report={"source":source_path,"output":str(blend),"glb":str(glb),"counts":counts,
            "strategy":"actual-child-head-segments-with-single-smooth-sleeve-membership",
            "hand_weights_unchanged":before==after,"hand_checksums":after,"textures":textures}
    report_path.parent.mkdir(parents=True,exist_ok=True)
    report_path.write_text(json.dumps(report,indent=2),encoding="utf8")
    print(json.dumps(report))

if __name__=="__main__": main()
