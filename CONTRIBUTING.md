# Contributing to YTSign

Thanks for helping improve accessible video playback. Contributions from Deaf and hard-of-hearing signers, interpreters, linguists, accessibility specialists, and developers are especially valuable.

## Before opening a change

1. Search the existing issues and pull requests.
2. Open an issue before undertaking a large architectural or language-model change.
3. Keep changes focused and avoid committing generated builds, downloaded models, browser profiles, or experimental 3D source assets.

## Development setup

Requirements: Node.js 20 or newer, npm, and Chrome or another Chromium browser.

```bash
npm ci
npm run check
```

Load `dist/` as an unpacked extension after building. The browser integration scripts currently expect Microsoft Edge at its standard Windows installation path; the unit tests and build are cross-platform.

## Pull requests

- Explain the user-visible behavior and accessibility impact.
- Add or update tests for logic changes.
- Run `npm run check` before submitting.
- Include manual YouTube verification details for overlay, transcript, audio-capture, or animation changes.
- Never include API keys, captured audio, private transcripts, browser profiles, or copyrighted video content.

AI-generated signing can be wrong even when the animation works technically. Changes to sign vocabulary, grammar, handshape, facial expression, or motion should be reviewed by fluent members of the relevant signing community before being described as accurate.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
