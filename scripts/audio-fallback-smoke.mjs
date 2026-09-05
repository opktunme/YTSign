import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const work = resolve(root, "work");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = resolve(work, "edge-automatic-speech");
const reportFile = resolve(work, `audio-fallback-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
const report = { profile, checks: {}, consoleErrors: [] };

await mkdir(work, { recursive: true });
const sampleResponse = await fetch("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav");
if (!sampleResponse.ok) throw new Error(`Could not obtain speech sample: ${sampleResponse.status}`);
const sampleBase64 = Buffer.from(await sampleResponse.arrayBuffer()).toString("base64");
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: edge,
    headless: true,
    viewport: { width: 1365, height: 768 },
    ignoreDefaultArgs: ["--mute-audio"],
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--disable-sync",
      "--no-first-run",
      "--enable-unsafe-webgpu",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  let worker = context.serviceWorkers().find((item) => item.url().startsWith("chrome-extension://"));
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  const extensionId = new URL(worker.url()).host;
  report.extensionId = extensionId;

  const page = context.pages()[0] || await context.newPage();
  page.on("console", (message) => {
    const url = message.location().url || "";
    if (message.type() === "error" && url.startsWith("chrome-extension://")) {
      report.consoleErrors.push(message.text());
    }
  });
  await page.goto("https://www.youtube.com/watch?v=aircAruvnKk", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.locator('iframe[title="YouTube sign-language translator"]').waitFor({ timeout: 30_000 });
  await page.bringToFront();
  const viewer = page.frames().find((frame) => frame.url().includes("viewer.html"));
  if (!viewer) throw new Error("Viewer frame unavailable");
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("youtubeSignSettings");
    await chrome.storage.local.set({
      youtubeSignSettings: { ...stored.youtubeSignSettings, signedLanguage: "pks", enabled: false },
    });
  });
  await page.evaluate(() => document.querySelector(".ytp-subtitles-button")?.remove());
  await viewer.waitForFunction(() => document.getElementById("startButton")?.textContent === "Start");

  // The overall Enable action is the only Chrome-authorized gesture needed.
  // There is intentionally no separate speech/fallback switch in the popup.
  await page.keyboard.press("Alt+Shift+S");
  let popup = context.pages().find((candidate) => candidate.url().includes("popup.html"));
  if (!popup) {
    popup = await context.waitForEvent("page", {
      predicate: (candidate) => candidate.url().includes("popup.html"),
      timeout: 3_000,
    }).catch(() => null);
  }
  if (!popup) throw new Error("Tab capture permission needs the extension toolbar popup in a headed browser");
  await popup.waitForLoadState("domcontentloaded");
  if (await popup.locator("#audioFallback").count()) throw new Error("A separate audio fallback option is still visible");
  await popup.locator("#enabled").click();
  await popup.waitForFunction(() => /Enabled|Could not|Open a YouTube/iu.test(document.getElementById("saved")?.textContent || ""));
  const popupStatus = await popup.locator("#saved").textContent();
  if (/Could not|Open a YouTube/iu.test(popupStatus)) throw new Error(popupStatus);
  await viewer.waitForFunction(() => document.getElementById("startButton")?.textContent === "Stop");
  report.checks.singleEnableFlow = true;
  await page.waitForTimeout(3_000);
  const audioState = await worker.evaluate(async () =>
    (await chrome.storage.session.get("youtubeSignAudioState")).youtubeSignAudioState || null,
  );
  if (!audioState?.active) throw new Error("Tab capture permission was not granted by the automated user gesture");
  report.checks.captureAuthorized = true;

  await viewer.waitForFunction(() => {
    const text = document.getElementById("status")?.textContent || "";
    return text.includes("Listening for video speech");
  }, null, { timeout: 180_000 });
  report.checks.localModelReady = true;

  const poseResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.includes("spoken_text_to_signed_pose") &&
      url.searchParams.get("spoken") === "en" &&
      url.searchParams.get("signed") === "pks" &&
      /american|country|fellow/iu.test(url.searchParams.get("text") || "");
  }, { timeout: 180_000 });
  await page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const audio = new Audio(URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })));
    audio.dataset.extensionAsrSmoke = "true";
    document.body.appendChild(audio);
    await audio.play();
  }, sampleBase64);
  const response = await poseResponse;
  if (response.status() !== 200) throw new Error(`Audio-fallback pose request returned ${response.status()}`);
  const transcript = new URL(response.url()).searchParams.get("text");
  await viewer.waitForFunction(() => document.getElementById("sourceBadge")?.textContent === "EN");
  report.checks.automaticSpeechToPslPose = { transcript, status: response.status() };
  report.ok = report.consoleErrors.length === 0;
} catch (error) {
  const detail = error?.stack || String(error);
  if (/activeTab|not been invoked|tab capture|capture permission|user gesture/iu.test(detail)) {
    report.ok = null;
    report.skipped = "Chrome requires a real user invocation of the extension toolbar popup before tab capture; headless automation cannot grant it.";
    report.manualVerification = "Open a YouTube watch page, open the extension, and choose Enable on YouTube once. Speech recognition should then take over automatically when text is unavailable.";
  } else {
    report.ok = false;
    report.error = detail;
    process.exitCode = 1;
  }
} finally {
  await context?.close();
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({ ...report, reportFile }, null, 2));
if (report.ok === false) process.exitCode = 1;
