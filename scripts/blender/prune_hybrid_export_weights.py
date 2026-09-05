"""Match the body master's skin weights to Blender 4.5's four-influence GLB.

Usage: blender INPUT.blend --background --python prune_hybrid_export_weights.py
       -- OUTPUT.blend OUTPUT.glb REPORT.json
Hand meshes, bone transforms, topology, and materials are unchanged.
"""
from __future__ import annotations
import json
import sys
from pathlib import Path
import bpy
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_hybrid_signer import export_avatar
from repair_hybrid_sleeves import checksum


def main():
    args = sys.argv[sys.argv.index("--")+1:]
    if len(args) != 3:
        raise SystemExit("Expected OUTPUT.blend OUTPUT.glb REPORT.json")
    blend, glb, report_path = map(lambda value: Path(value).resolve(), args)
    source = bpy.data.filepath
    rig = bpy.data.objects["YTSign_PSL_Rig"]
    body = bpy.data.objects["YTSign_PSL_Signer_Body"]
    hands = [bpy.data.objects[f"YTSign_PSL_Hand_{side}"] for side in ("L", "R")]
    before = {hand.name: checksum(hand) for hand in hands}
    bone_groups = {group.index: group for group in body.vertex_groups if group.name in rig.data.bones}
    buckets = {}
    changed = []
    pruned = 0
    largest_discard = 0.0
    for vertex in body.data.vertices:
        original = [(entry.group, entry.weight) for entry in vertex.groups if entry.group in bone_groups]
        # Blender primitive_extract.py uses this threshold and a stable
        # descending sort in the existing vertex-group order.
        influences = [(group, weight) for group, weight in original if weight > .0001]
        influences.sort(key=lambda entry: entry[1], reverse=True)
        if not influences:
            continue
        keep = influences[:4]
        if len(influences)>4:
            pruned += 1
            largest_discard = max(largest_discard, sum(weight for _,weight in influences[4:]))
        # primitive_attributes.py pads to four float32 lanes then normalizes.
        values = np.zeros(4, dtype=np.float32)
        values[:len(keep)] = [weight for _,weight in keep]
        values /= values.sum(dtype=np.float32)
        new = [(group, float(values[index])) for index,(group,_) in enumerate(keep)]
        old = dict(original)
        if len(old)==len(new) and all(abs(old[group]-weight)<1e-9 for group,weight in new):
            continue
        changed.append(vertex.index)
        for group,weight in new: buckets.setdefault((group,weight),[]).append(vertex.index)
    for group in bone_groups.values(): group.remove(changed)
    for (group,weight),indices in buckets.items(): bone_groups[group].add(indices,weight,"REPLACE")
    body.data.update()
    after = {hand.name:checksum(hand) for hand in hands}
    assert before==after, "Hand weights changed"
    extras=[obj for obj in bpy.context.scene.objects if obj.type=="MESH" and obj not in [body,*hands] and obj.get("ytsign_export")]
    textures=export_avatar(rig,body,hands,extras,blend,glb)
    report={"source":source,"blend":str(blend),"glb":str(glb),
            "changed_body_vertices":len(changed),"vertices_pruned_to_four":pruned,
            "largest_removed_weight":largest_discard,"hand_weights_unchanged":before==after,
            "hand_checksums":after,"strategy":"stable-top-four-min-influence-0.0001-float32-normalization",
            "textures":textures}
    report_path.parent.mkdir(parents=True,exist_ok=True)
    report_path.write_text(json.dumps(report,indent=2),encoding="utf8")
    print(json.dumps(report))

if __name__=="__main__": main()
