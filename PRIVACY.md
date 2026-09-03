# Privacy notes

- The extension only runs on YouTube watch pages.
- It first reads the video's available timed-text/transcript data. When necessary it activates YouTube caption data internally without requiring the viewer to turn captions on.
- No caption text is transmitted until the user enables signing.
- Enabled caption phrases are sent to `us-central1-sign-mt.cloudfunctions.net` to generate pose animation.
- The overall **Enable on YouTube** action also arms capture for that one tab, because Chrome requires the extension to be directly invoked. There is no separate speech-recognition option. Capture remains in standby unless timed text is unavailable and stops with signing.
- Captured audio is processed inside an extension offscreen document with multilingual Whisper. Raw audio and audio chunks are not uploaded or intentionally retained; in-memory samples are discarded after processing or when capture stops.
- Whisper model/configuration files are downloaded from Hugging Face on first use and may be cached by Chrome. The model executes locally with WebGPU when available and WebAssembly otherwise.
- English transcript/translation phrases produced locally are sent to the sign.mt pose service when signing is enabled. In other words, audio stays local, but derived text does not.
- The extension stores language, enabled state, and overlay-size preferences in Chrome local extension storage. Temporary audio-capture status is stored in Chrome session extension storage.
- This prototype does not operate a separate analytics service and does not intentionally retain caption history.
