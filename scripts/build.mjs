import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const src = resolve(root, "src");
const dist = resolve(root, "dist");

await mkdir(dist, { recursive: true });
await mkdir(resolve(dist, "vendor", "pose-viewer"), { recursive: true });
await mkdir(resolve(dist, "vendor", "transformers"), { recursive: true });
await mkdir(resolve(dist, "licenses"), { recursive: true });

await build({
  entryPoints: [resolve(src, "content-entry.js")],
  outfile: resolve(dist, "content.js"),
  bundle: true,
  format: "iife",
  target: ["chrome138"],
  sourcemap: false,
  minify: false,
  legalComments: "eof",
});

await build({
  entryPoints: [resolve(src, "avatar-renderer.js")],
  outfile: resolve(dist, "avatar-renderer.js"),
  bundle: true,
  format: "esm",
  target: ["chrome138"],
  sourcemap: false,
  minify: false,
  legalComments: "eof",
});

for (const file of [
  "manifest.json",
  "background.js",
  "offscreen.html",
  "offscreen.js",
  "viewer.html",
  "viewer.css",
  "viewer-app.js",
  "pose-sandbox.html",
  "pose-sandbox.js",
  "asr-engine.js",
  "popup.html",
  "popup.css",
  "popup.js",
]) {
  await cp(resolve(src, file), resolve(dist, file), { force: true });
}

for (const file of ["README.md", "PRIVACY.md", "THIRD_PARTY_NOTICES.md"]) {
  await cp(resolve(root, file), resolve(dist, file), { force: true });
}

await cp(
  resolve(root, "node_modules", "@huggingface", "transformers", "LICENSE"),
  resolve(dist, "licenses", "TRANSFORMERS-JS-APACHE-2.0.txt"),
  { force: true },
);
await cp(
  resolve(root, "node_modules", "pose-viewer", "LICENSE"),
  resolve(dist, "licenses", "POSE-VIEWER-MIT.txt"),
  { force: true },
);
await cp(
  resolve(root, "node_modules", "three", "LICENSE"),
  resolve(dist, "licenses", "THREE-MIT.txt"),
  { force: true },
);

await cp(
  resolve(root, "licenses", "ONNX-RUNTIME-WEB-MIT.txt"),
  resolve(dist, "licenses", "ONNX-RUNTIME-WEB-MIT.txt"),
  { force: true },
);

await cp(
  resolve(root, "node_modules", "pose-viewer", "dist", "pose-viewer"),
  resolve(dist, "vendor", "pose-viewer"),
  { recursive: true, force: true },
);

for (const file of [
  "transformers.min.js",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
]) {
  await cp(
    resolve(root, "node_modules", "@huggingface", "transformers", "dist", file),
    resolve(dist, "vendor", "transformers", file),
    { force: true },
  );
}

const manifest = JSON.parse(await readFile(resolve(dist, "manifest.json"), "utf8"));
await writeFile(resolve(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Built unpacked Chrome extension at ${dist}`);
