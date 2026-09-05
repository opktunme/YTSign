# v0.6.0 technical verification — 5 September 2026

This is an engineering/appearance report, not certification of PSL intelligibility.

| Check | Result |
| --- | --- |
| Unit tests and extension build | 19 tests passed; build passed |
| Navigation without refreshing | Home → watch → search → watch passed in a controlled YouTube-origin document |
| Rig controls | 38/38 weighted finger/metacarpal controls move; 20/20 controls tracked on each supplied hand |
| Rendering regression | Hand skin is opaque and writes depth; decorative nail plates hidden; false disappearing-finger holes resolved |
| Depth, handedness, tracking dropout | Passed synthetic regression checks |
| Blender → GLB | Rig/skin parity passed; body skin has at most four influences |
| Camera containment | Both actual deformed hand surfaces stayed in frame across 516 frames in three cached PSL/ASL fixtures |
| YouTube integration | Actual unpacked extension loaded; controlled captions produced live PSL/ASL service requests and moving output; refresh recovery and player containment passed |
| Upper-body appearance | Reviewer approved selected neutral, greeting, and curled-hand frames; minor hair and cloth artifacts remain |
| Local Whisper | Runs within extension CSP; English reference sample transcribed correctly; multilingual execution tested, translation accuracy not certified |
| Automatic tab-audio capture | **Manual check pending**: headless Chrome cannot grant the required real toolbar invocation; reported as skipped, not passed |
| PSL intelligibility and facial grammar | **Pending fluent Deaf PSL review**; current textured renderer does not animate nonmanual/facial grammar |

`npm run verify` runs the unit/build, navigation, browser, YouTube, local-ASR, and audio-fallback checks. Its audio test can report a documented skip. `npm run demo:avatar` additionally renders local pose fixtures and records labeled PSL videos; the generated videos were decoded and checked for changing frames at 640 × 640 pixels.

Source poses from the external translation service are candidates, not linguistic ground truth. Use [PSL_REVIEW.md](PSL_REVIEW.md) to record timestamped corrections from a fluent signer. Extreme curls may show ordinary linear-skinning creases/contact; do not alter meaningful palm orientation merely to expose fingers to the camera.

For the manual audio check, enable YTSign through Chrome's toolbar on a YouTube watch tab, then use a video without available text and confirm speech-derived signing begins automatically. No separate Whisper toggle should be required.
