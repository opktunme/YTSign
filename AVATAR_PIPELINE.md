# Avatar pipeline

> Retained local experiment: the active extension does not load this GLB. The
> public repository uses the procedural 3D pose renderer. Heavy Meshy exports,
> Blender files, and downloaded Blender binaries are intentionally gitignored.

The original Meshy downloads remain preserved locally under
`assets/avatar/source`. A locally generated browser asset may be written to
`src/assets/avatar/signing-avatar.glb`, but it is not part of the public build.

The current runtime target is 220,000 triangles with a 2048 px texture. It contains 64 bones: the 24-bone Meshy body rig plus 40 generated finger-chain bones. The original Meshy model did not contain finger bones, facial bones, or facial blendshapes.

## Rebuild

If the local portable Blender 4.5 LTS and source model are available, rebuild
the processed Blender master and browser GLB from the repository root with:

```powershell
& '.\tools\blender-4.5.13-windows-x64\blender.exe' `
  --background `
  --python '.\scripts\blender\build_signing_avatar.py' `
  -- `
  '.\assets\avatar\source\rigged-glb\Meshy_AI_signlang_interpreter__biped\Meshy_AI_signlang_interpreter__biped_Character_output.glb' `
  '.\assets\avatar\processed\signing-avatar.blend' `
  '.\src\assets\avatar\signing-avatar.glb' `
  '.\work\avatar\signing-avatar-build.json' `
  220000
```

The current extension build does not copy or expose this experimental asset.

## Validation outputs

- `work\avatar\runtime-avatar-report.json` — imported runtime geometry, skinning, and bone audit
- `work\avatar\signing-avatar-build.json` — deterministic build parameters and generated finger chains
- `work\avatar\final-previews` — neutral front, three-quarter, hand, and stress-pose renders
- `work\browser-smoke-*.json` and `work\viewer-smoke-*.png` — browser-level PSL/ASL render evidence

The generated finger weights are suitable for the prototype but are not a substitute for artist-painted hand weights. Keep the `.blend` master for future manual cleanup, facial blendshapes, and expression work.
