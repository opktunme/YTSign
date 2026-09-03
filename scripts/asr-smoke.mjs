import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const work = resolve(root, "work");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = resolve(work, "edge-asr-model");
const reportFile = resolve(work, `asr-smoke-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
const report = { model: "onnx-community/whisper-tiny", profile, progress: [], consoleErrors: [] };
const mimeTypes = new Map([
  [".html", "text/html"], [".js", "text/javascript"], [".mjs", "text/javascript"],
  [".wasm", "application/wasm"], [".json", "application/json"],
]);

await mkdir(work, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end("<!doctype html><meta charset=utf-8><title>ASR smoke</title><p>ASR smoke</p>");
      return;
    }
    const file = resolve(dist, pathname.slice(1));
    if (file !== dist && !file.startsWith(`${dist}${sep}`)) throw new Error("Invalid path");
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "content-type": mimeTypes.get(extname(file)) || "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const { port } = server.address();
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: edge,
    headless: true,
    viewport: { width: 720, height: 480 },
    args: ["--disable-sync", "--no-first-run", "--enable-unsafe-webgpu"],
  });
  const page = context.pages()[0] || await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.consoleErrors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  report.result = await page.evaluate(async () => {
    const { transcribeAudio } = await import("/asr-engine.js");
    const response = await fetch("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav");
    if (!response.ok) throw new Error(`Sample audio returned ${response.status}`);
    const context = new AudioContext({ sampleRate: 16_000 });
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    const audio = decoded.getChannelData(0).slice();
    const progress = [];
    const text = await transcribeAudio(audio, {
      translateToEnglish: false,
      onProgress(message) { progress.push(message); },
    });
    await context.close();
    return { text, progress, sampleRate: decoded.sampleRate, seconds: decoded.duration };
  });
  report.progress = report.result.progress;
  report.consoleErrors = report.consoleErrors.filter((message) =>
    !message.includes("VerifyEachNodeIsAssignedToAnEp") &&
    !message.includes("session_state.cc:1282"),
  );
  report.ok = /american|country|fellow/iu.test(report.result.text) && report.consoleErrors.length === 0;
} catch (error) {
  report.ok = false;
  report.error = error?.stack || String(error);
  throw error;
} finally {
  await context?.close();
  await new Promise((closed) => server.close(closed));
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({ ...report, reportFile }, null, 2));
if (!report.ok) process.exitCode = 1;
