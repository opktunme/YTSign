# Avatar pipeline

The extension loads a textured GLB prepared in Blender, combining the supplied Meshy character with anatomical hand surfaces from MakeHuman/MPFB core assets. The procedural character remains a fallback when the GLB cannot load.

The selected versioned GLB lives under `src/assets/avatar/`. Its filename must match the references in `src/gltf-avatar-renderer.js`, `scripts/build.mjs`, and `src/manifest.json`. The build copies that asset into `dist/assets/avatar/`; original Meshy downloads, Blender masters, donor assets, and earlier experiments remain local and are excluded from Git.

The hybrid rig contains 72 bones. Each hand has four metacarpal controls and three joints per digit: 38 weighted finger controls across both hands, plus ten non-deforming fingertip helpers. Two palm bones and four arm bones are driven separately. The browser maps pose landmarks to these controls and smooths brief tracking gaps. Bone counts alone do not demonstrate correct hand deformation or intelligible signing.

The browser explicitly treats anatomical skin as opaque with depth writes enabled. Some donor materials retain a glTF `BLEND` flag that incorrectly sorts overlapping fingers and makes them appear missing. The renderer also hides optional added nail plates; the hand texture retains its natural nail appearance. Do not remove these material guards when changing the avatar.

The overlay frames the upper body, preserving room for the face and moving hands while cropping the lower body. The default medium window is 380 × 480 pixels; small and large presets are 320 × 420 and 460 × 560. Camera checks must include low and wide hand positions, not merely the neutral body silhouette.

The selected avatar passes the current mechanical checks: complete control motion, opaque hand rendering, export parity, playback, and sampled full-timeline hand containment. Ordinary skin creasing/contact can remain in extreme bends. Facial shape keys are authored in the Blender model, but the current textured-avatar renderer does not yet drive facial grammar or mouth movements from the incoming pose stream.

## Rebuild

Building the extension with `npm run build` uses the selected runtime GLB and does not require Blender. Rebuilding the avatar itself requires the locally preserved Meshy source and the MPFB donor Blender file; those inputs are not included in the public repository.

With the local portable Blender 4.5 LTS and these inputs available, the following example writes a separate rebuild under `assets/avatar/local-rebuild/`:

```powershell
& '.\tools\blender-4.5.13-windows-x64\blender.exe' `
  --background `
  --python '.\scripts\blender\build_hybrid_signer.py' `
  -- `
  '.\assets\avatar\source\rigged-glb\Meshy_AI_signlang_interpreter__biped\Meshy_AI_signlang_interpreter__biped_Character_output.glb' `
  '.\assets\avatar\v4l\ytsign-psl-avatar-runtime.blend' `
  '.\assets\avatar\local-rebuild\ytsign-psl-hybrid.blend' `
  '.\assets\avatar\local-rebuild\ytsign-psl-hybrid.glb' `
  '.\work\avatar\local-rebuild\build-report.json'
```

Choose a fresh output directory for each revision to preserve earlier assets. Validate a rebuilt model before selecting it as the runtime GLB and updating all three filename references. Runtime texture sizes are recorded in the build report; the current pipeline retains a higher-resolution Blender master and downsizes browser textures to 2048 pixels for the body and 1024 pixels for the hands.

The selected runtime also includes `scripts/blender/repair_hybrid_sleeves.py`, applied to the hybrid master. It uses actual child-joint positions and a continuous sleeve/torso weight boundary to remove the stretched cloth triangles caused by raised arms. Run it with the input `.blend` open and pass three fresh output paths after `--`: output `.blend`, output `.glb`, and a JSON report. It preserves both anatomical hand meshes and their weights.

Finish with `scripts/blender/prune_hybrid_export_weights.py` using the same three-output argument format. This applies the exporter's four-influence limit and normalization to the authoring master itself, preventing the browser from silently dropping a fifth influence and deforming differently. The selected runtime passes the Blender-to-GLB rig/skin parity check.

## Validation outputs

- `work/avatar/<revision>/build-report.json` — source paths, skeleton, geometry, materials, and export parameters.
- `scripts/blender/inspect_hybrid_glb_parity.py` — compares the Blender master with the imported GLB, including skin registration and deformation.
- `scripts/blender/render_hybrid_hand_qa.py` — renders diagnostic handshapes and measures individual controls, topology, contacts, and transitions.
- `scripts/avatar-pose-qa.mjs` — renders fixed frames and hand closeups from cached PSL/ASL pose fixtures in Chromium.
- `work/browser-smoke-*.json` — synthetic finger-control checks and live pose playback evidence.
- `work/extension-smoke-*.json` — actual extension playback, framing, and recovery checks.

These are mechanical and visual checks. They can detect frozen controls, missing fingers, skin tears, export discrepancies, and cropping, but cannot certify PSL vocabulary, grammar, hand orientation, facial grammar, or intelligibility. Signing output still requires review by fluent Deaf PSL signers. Do not rotate a palm toward the camera merely to improve appearance: palm orientation can change a sign's meaning.

## Asset provenance

The Meshy-created character is credited under CC BY 4.0. The MakeHuman/MPFB core hand geometry, rig data, and skin assets are CC0; YTSign adapts their surfaces, weights, and materials. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the source credits and license links. The MIT license covers YTSign's original source code, not a replacement license for these upstream assets.
