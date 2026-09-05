# Third-party notices

## Bundled signing avatar

The runtime GLB under `src/assets/avatar/` combines a character created with [Meshy](https://www.meshy.ai/) — [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — with MakeHuman/MPFB core anatomical hand geometry, rig data, and skin textures released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).

YTSign modifications made in Blender include replacement hand surfaces, adapted skeleton and skin weights, fingertip controls, material adjustments, and optimized textures. These avatar credits and terms are separate from the MIT license for YTSign's original source code.

Meshy's [Terms of Service](https://www.meshy.ai/terms-of-use), dated March 7, 2026, specify CC BY 4.0 for free-plan outputs. Its [asset-ownership guidance](https://help.meshy.ai/en/articles/9992001-can-i-use-meshy-assets-commercially-license-copyright-explained) describes ownership of paid-plan outputs. This project retains the CC BY 4.0 attribution without assuming which plan was used to generate the supplied character.

MakeHuman asset credits: Data Collection AB, Joel Palmius, Jonas Hauquier, and the MakeHuman Community. The donor uses the core `hm08` base mesh and system skin assets, including `young_asian_female` / `young_lightskinned_female_diffuse3.png`, with a blended and tinted skin texture. The original asset headers record their September 2020 CC0 release.

Sources: [MPFB 2.0.17 license, assets and output sections](https://github.com/makehumancommunity/mpfb2/blob/v2.0.17/LICENSE.md), [MakeHuman system asset pack](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html).

The MPFB application's GPL license is distinct from its core assets' CC0 dedication. Blender and MPFB are authoring tools; their application code is not bundled in the extension.

## pose-viewer

Copyright the sign-language-processing contributors. Distributed under the MIT License.

Source: https://github.com/sign-language-processing/pose

The unmodified browser distribution from `pose-viewer` 1.2.0 is bundled under `dist/vendor/pose-viewer`.

## Three.js

The textured-avatar renderer and procedural fallback use Three.js, distributed under the MIT License.

Source: https://github.com/mrdoob/three.js

## sign.mt / Rylo Translate pose service

Pose translations are requested from the public sign.mt spoken-to-signed pose endpoint. The sign.mt client project describes free use for individuals, nonprofits, and educational institutions under CC BY-NC-SA 4.0 and requires a separate license for commercial organizations.

Source: https://github.com/sign/translate

License: https://github.com/sign/translate/blob/master/LICENSE.md

Service: https://sign.mt

No sign.mt client source code is bundled in this extension. Review current service terms and obtain appropriate permission before commercial distribution.

## Transformers.js

`@huggingface/transformers` 3.8.1 is bundled to run speech recognition in the browser. It is distributed under the Apache License 2.0.

Source: https://github.com/huggingface/transformers.js

## Whisper Tiny ONNX model

Automatic speech recognition downloads `onnx-community/whisper-tiny`, an ONNX conversion/quantization of `openai/whisper-tiny`, from Hugging Face when video text is unavailable. The upstream model card identifies Whisper Tiny as Apache-2.0 licensed. Model weights are not committed to this project or copied into `dist`; Chrome downloads and caches them when the feature is first needed.

Model: https://huggingface.co/onnx-community/whisper-tiny

Upstream model: https://huggingface.co/openai/whisper-tiny

## ONNX Runtime Web

The Transformers.js browser bundle includes ONNX Runtime Web 1.22 development artifacts for WebAssembly/WebGPU inference. Its package declares the MIT License.

Source: https://github.com/microsoft/onnxruntime
