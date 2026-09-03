# Third-party notices

## pose-viewer

Copyright the sign-language-processing contributors. Distributed under the MIT License.

Source: https://github.com/sign-language-processing/pose

The unmodified browser distribution from `pose-viewer` 1.2.0 is bundled under `dist/vendor/pose-viewer`.

## Three.js

The procedural 3D signing-avatar renderer uses Three.js, distributed under the MIT License.

Source: https://github.com/mrdoob/three.js

## sign.mt / Rylo Translate pose service

Pose translations are requested from the public sign.mt spoken-to-signed pose endpoint. The sign.mt client project describes free use for individuals, nonprofits, and educational institutions under CC BY-NC-SA 4.0 and requires a separate license for commercial organizations.

Source: https://github.com/sign/translate

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
