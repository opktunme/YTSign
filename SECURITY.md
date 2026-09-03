# Security policy

## Supported version

Security fixes are applied to the latest code on the `main` branch. This is a prototype and does not currently maintain older release branches.

## Reporting a vulnerability

Please do not disclose a suspected vulnerability in a public issue. Use the repository's **Security** tab to submit a private vulnerability report to the maintainers. Include reproduction steps, affected versions, impact, and any suggested mitigation.

Reports involving unintended audio capture, transcript disclosure, extension-origin isolation, cross-frame messaging, or remote-code execution are particularly important. Please allow a reasonable period for investigation before public disclosure.

## Dependency note

The npm development tree for Transformers.js 3.8.1 includes `sharp` and currently inherits a high-severity libvips advisory for which npm reports no compatible fix. YTSign does not copy or execute `sharp` in the Chrome extension: the build ships the Transformers.js web bundle and ONNX Runtime Web files. This distinction reduces exposure but does not make the advisory disappear from dependency scanners. It will be reassessed when the browser ASR stack is upgraded.

YTSign is not suitable for emergency, medical, legal, financial, or other high-stakes interpretation.
