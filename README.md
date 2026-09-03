# YTSign

[![CI](https://github.com/opktunme/YTSign/actions/workflows/ci.yml/badge.svg)](https://github.com/opktunme/YTSign/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](src/manifest.json)
[![Status: prototype](https://img.shields.io/badge/status-prototype-orange)](#project-status)

YTSign is a Chrome extension that follows a YouTube video's transcript—or transcribes tab audio locally when text is unavailable—and displays a signing avatar over the video.

It currently offers:

- **Pakistan (PSL)** — the default, using the `pks` sign.mt target
- **Global (ASL)** — American Sign Language, using the `ase` sign.mt target

> [!CAUTION]
> YTSign produces AI-generated signing that may contain linguistic, handshape, timing, or motion errors. It is not a substitute for a qualified interpreter and must not be relied on for emergency, medical, legal, financial, or other high-stakes communication.

## Features

- Automatically reads YouTube timed transcripts without requiring visible captions.
- Internally observes caption data when public timed text is unavailable.
- Falls back automatically to local multilingual Whisper speech recognition.
- Handles English, Urdu, and Hindi text inputs in the verified transcript pipeline.
- Renders pose data as a lightweight procedural 3D character.
- Uses a deterministic animation clock and wrist-aligned fallback hands.
- Keeps the animation envelope within the overlay at different sizes.
- Supports drag, resize, minimize, close, fullscreen, and playback-rate changes.
- Stores only extension preferences and transient capture state.

## How it works

```text
YouTube transcript / internal caption data
                    │
                    ├── unavailable ──> tab audio ──> local Whisper ──┐
                    │                                                  │
                    └────────────────── text phrases <─────────────────┘
                                               │
                                               v
                                    sign.mt pose translation
                                               │
                                               v
                                  sandboxed procedural 3D signer
```

Transcript text and locally derived speech text are sent to the sign.mt pose service only after the user enables signing. Raw tab audio is processed locally and is not intentionally uploaded or retained.

## Install from source

YTSign is not currently distributed through the Chrome Web Store. To load it locally, install [Node.js 20 or newer](https://nodejs.org/) and a current version of Chrome or Chromium.

```bash
git clone https://github.com/opktunme/YTSign.git
cd YTSign
npm ci
npm run build
```

Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the generated `dist` directory.
5. Open or refresh a YouTube video.
6. Open YTSign, choose the signing language, and select **Enable on YouTube**.

The first speech-recognition fallback can take several minutes because Chrome must download and cache the Whisper model. Subsequent uses reuse the browser cache.

## Source priority

YTSign chooses the text source automatically:

1. Public YouTube timed transcript
2. Internal YouTube caption data, with the visible caption layer kept off
3. Local tab-audio recognition with `onnx-community/whisper-tiny`

Timed text always wins. Whisper runs only when text sources are unavailable. Whisper translates recognized speech to English before the text enters the PSL/ASL pose pipeline; this is not a direct Urdu-to-PSL or Hindi-to-PSL translation model.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Activate YTSign for the YouTube tab chosen by the user. |
| `tabCapture` | Capture that tab's audio when transcript and caption sources fail. |
| `offscreen` | Run local audio processing outside the YouTube page. |
| `storage` | Save language, enabled state, and overlay-size preferences. |
| sign.mt host access | Request signing-pose data for enabled text phrases. |
| Hugging Face host access | Download the local Whisper model on first use. |

See [PRIVACY.md](PRIVACY.md) for the complete data-flow summary.

## Development

```bash
npm ci
npm run check
```

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm test` | Run unit tests. |
| `npm run build` | Build the unpacked extension in `dist/`. |
| `npm run check` | Run unit tests and build. |
| `npm run test:browser` | Exercise PSL/ASL rendering and the reported freeze regression. |
| `npm run test:extension` | Load the actual extension on YouTube and verify motion, clipping, refresh recovery, and both signing options. |
| `npm run test:asr-extension` | Test local Whisper under the extension Content Security Policy. |
| `npm run test:audio-fallback` | Test automatic transcript-to-audio fallback where browser automation permits tab capture. |
| `npm run verify` | Run the complete local verification suite. |

The browser integration scripts currently look for Microsoft Edge at its standard Windows installation path. Unit tests and the production build run in GitHub Actions on Linux.

## Repository layout

```text
src/        Chrome extension source
tests/      Unit tests
scripts/    Build and browser/extension smoke tests
licenses/   Notices copied into the extension build
.github/    CI, issue templates, and contribution metadata
```

Generated builds, downloaded models, browser profiles, Blender binaries, vendor research checkouts, and experimental 3D source artwork are intentionally excluded from Git.

## Project status

YTSign is an early functional prototype, not a production interpreting service.

- Pose translation requires the external sign.mt service and an internet connection.
- The procedural character prioritizes readable motion over realism.
- Whisper Tiny favors browser-friendly size over maximum recognition accuracy and may mishear names, noisy speech, Urdu/Hindi dialects, or low-resource languages.
- Signing output has not yet undergone the Deaf-led linguistic validation required for production use.
- The npm tree inherits a high-severity `sharp`/libvips advisory through Transformers.js 3.8.1. `sharp` is not copied into or executed by the Chrome extension; see [SECURITY.md](SECURITY.md).

## Contributing and security

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Sign-language changes should be reviewed by fluent members of the relevant signing community.

Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not in a public issue. Community participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## Licensing

YTSign's original source code is available under the [MIT License](LICENSE). Bundled libraries, downloaded model files, and the external sign.mt service remain under their own licenses and terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

The sign.mt project describes non-commercial conditions for its public client/service. Review the current terms and obtain the appropriate permission before commercial deployment.
