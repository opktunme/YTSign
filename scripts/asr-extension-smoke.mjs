import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const work = resolve(root, "work");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = resolve(work, "edge-asr-extension-model");
const reportFile = resolve(work, `asr-extension-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
const report = { model: "onnx-community/whisper-tiny", profile, consoleErrors: [] };

await mkdir(work, { recursive: true });
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: edge,
    headless: true,
    viewport: { width: 720, height: 480 },
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--disable-sync",
      "--no-first-run",
      "--enable-unsafe-webgpu",
    ],
  });
  let worker = context.serviceWorkers().find((item) => item.url().startsWith("chrome-extension://"));
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => report.consoleErrors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/offscreen.html`, { waitUntil: "domcontentloaded" });
  report.result = await page.evaluate(async () => {
    const { transcribeAudio } = await import("./asr-engine.js");
    const context = new AudioContext({ sampleRate: 16_000 });
    const progress = [];
    async function runSample(file, translateToEnglish) {
      const response = await fetch(`https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/${file}`);
      if (!response.ok) throw new Error(`${file} returned ${response.status}`);
      const decoded = await context.decodeAudioData(await response.arrayBuffer());
      return transcribeAudio(decoded.getChannelData(0).slice(), {
        translateToEnglish,
        onProgress(message) { progress.push(message); },
      });
    }
    const text = await runSample("jfk.wav", false);
    const bengaliToEnglish = await runSample("bengali-audio.wav", true);
    await context.close();
    return { text, bengaliToEnglish, progressEvents: progress.length, finalProgress: progress.slice(-5) };
  });
  report.consoleErrors = report.consoleErrors.filter((message) =>
    !message.includes("VerifyEachNodeIsAssignedToAnEp") &&
    !message.includes("session_state.cc:1282"),
  );
  report.ok = /american|country|fellow/iu.test(report.result.text) &&
    report.result.bengaliToEnglish.split(/\s+/u).length >= 3 &&
    report.consoleErrors.length === 0;
} catch (error) {
  report.ok = false;
  report.error = error?.stack || String(error);
  throw error;
} finally {
  await context?.close();
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({ ...report, reportFile }, null, 2));
if (!report.ok) process.exitCode = 1;
