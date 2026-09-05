import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const work = resolve(root, "work");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const profile = resolve(work, `edge-extension-${runId}`);
const screenshot = resolve(work, `extension-smoke-${runId}.png`);
const reportFile = resolve(work, `extension-smoke-${runId}.json`);
const report = {
  browser: "Microsoft Edge (Chromium)",
  target: "https://www.youtube.com/watch?v=aircAruvnKk",
  profile,
  checks: {},
  poseResponses: [],
  consoleErrors: [],
};
const runHindi = process.env.TEST_HINDI === "1";

await mkdir(work, { recursive: true });
let context;
let page;

async function setMockCaption(page, text) {
  await page.evaluate((caption) => {
    let player = document.querySelector("#movie_player");
    if (!player) {
      player = document.createElement("div");
      player.id = "movie_player";
      player.style.display = "none";
      document.body.appendChild(player);
    }
    let segment = player.querySelector(".ytp-caption-segment[data-extension-smoke]");
    if (!segment) {
      segment = document.createElement("span");
      segment.className = "ytp-caption-segment";
      segment.dataset.extensionSmoke = "true";
      player.appendChild(segment);
    }
    segment.textContent = caption;
  }, text);
}

async function waitForFrame(page, fragment, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = page.frames().find((frame) => frame.url().includes(fragment));
    if (match) return match;
    await page.waitForTimeout(100);
  }
  return null;
}

async function posePixelStats(renderer) {
  return renderer.evaluate(() => {
    const canvas = document.getElementById("avatarCanvas");
    if (!canvas) return null;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data;
    let posePixels = 0;
    let edgePosePixels = 0;
    let bottomCropPixels = 0;
    let minX = canvas.width;
    let maxX = -1;
    let minY = canvas.height;
    let maxY = -1;
    if (pixels) {
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index];
        const green = pixels[index + 1];
        const blue = pixels[index + 2];
        const foreground = Math.abs(red - 7) + Math.abs(green - 19) + Math.abs(blue - 31) > 80;
        if (!foreground) continue;
        const pixel = index / 4;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        posePixels += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        if (x < 3 || y < 3 || x >= canvas.width - 3) edgePosePixels += 1;
        if (y >= canvas.height - 3) bottomCropPixels += 1;
      }
    }
    const rect = canvas.getBoundingClientRect();
    return {
      width: canvas.width,
      height: canvas.height,
      clientWidth: rect.width,
      clientHeight: rect.height,
      posePixels,
      edgePosePixels,
      bottomCropPixels,
      bounds: posePixels ? { minX, maxX, minY, maxY } : null,
    };
  });
}

async function poseTimelineStats(renderer) {
  return renderer.evaluate(async () => {
    const signer = document.getElementById("signer");
    const canvas = document.getElementById("avatarCanvas");
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    const pose = await signer?.getPose?.();
    if (!signer || !canvas || !context || !pose?.body?.frames?.length) return null;

    await signer.pause?.();
    const fps = Number(pose.body.fps) || 25;
    const stats = {
      frames: pose.body.frames.length,
      framesWithAvatar: 0,
      minPosePixels: Infinity,
      maxPosePixels: 0,
      edgeFrames: [],
      bottomCropFrameCount: 0,
      maximumBottomCropPixels: 0,
      bounds: { minX: canvas.width, maxX: -1, minY: canvas.height, maxY: -1 },
    };
    for (let frameIndex = 0; frameIndex < pose.body.frames.length; frameIndex += 1) {
      signer.currentTime = frameIndex / fps;
      signer.dispatchEvent(new CustomEvent("render$"));
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let posePixels = 0;
      let edgePixels = 0;
      let bottomCropPixels = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const foreground = Math.abs(pixels[index] - 7) +
          Math.abs(pixels[index + 1] - 19) +
          Math.abs(pixels[index + 2] - 31) > 80;
        if (!foreground) continue;
        const pixel = index / 4;
        const x = pixel % canvas.width;
        const y = Math.floor(pixel / canvas.width);
        posePixels += 1;
        stats.bounds.minX = Math.min(stats.bounds.minX, x);
        stats.bounds.maxX = Math.max(stats.bounds.maxX, x);
        stats.bounds.minY = Math.min(stats.bounds.minY, y);
        stats.bounds.maxY = Math.max(stats.bounds.maxY, y);
        if (x < 3 || y < 3 || x >= canvas.width - 3) edgePixels += 1;
        if (y >= canvas.height - 3) bottomCropPixels += 1;
      }
      if (posePixels) stats.framesWithAvatar += 1;
      stats.minPosePixels = Math.min(stats.minPosePixels, posePixels);
      stats.maxPosePixels = Math.max(stats.maxPosePixels, posePixels);
      if (edgePixels) stats.edgeFrames.push({ frameIndex, edgePixels });
      if (bottomCropPixels) stats.bottomCropFrameCount += 1;
      stats.maximumBottomCropPixels = Math.max(stats.maximumBottomCropPixels, bottomCropPixels);
    }
    signer.currentTime = 0;
    signer.dispatchEvent(new CustomEvent("render$"));
    if (!Number.isFinite(stats.minPosePixels)) stats.minPosePixels = 0;
    return stats;
  });
}

async function naturalMotionStats(renderer) {
  return renderer.evaluate(async () => {
    const signer = document.getElementById("signer");
    const canvas = document.getElementById("avatarCanvas");
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!signer || !canvas || !context) return null;
    const samples = [];
    for (let sampleIndex = 0; sampleIndex < 12; sampleIndex += 1) {
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (let index = 0; index < pixels.length; index += 32) {
        hash ^= pixels[index];
        hash = Math.imul(hash, 16777619);
      }
      samples.push({ time: signer.currentTime, hash: hash >>> 0 });
      await new Promise((resolveSample) => setTimeout(resolveSample, 140));
    }
    return {
      samples,
      timeAdvance: samples.at(-1).time - samples[0].time,
      uniqueFrames: new Set(samples.map((sample) => sample.hash)).size,
    };
  });
}

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: edge,
    headless: true,
    viewport: { width: 1365, height: 768 },
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--disable-sync",
      "--no-first-run",
    ],
  });
  page = context.pages()[0] || await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") report.consoleErrors.push({
      text: message.text(),
      url: message.location().url || "",
    });
  });
  page.on("pageerror", (error) => report.consoleErrors.push({ text: error.message, url: "pageerror" }));
  page.on("response", (response) => {
    if (response.url().includes("spoken_text_to_signed_pose")) {
      report.poseResponses.push({ url: response.url(), status: response.status() });
    }
  });

  await page.goto(report.target, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('iframe[title="YouTube sign-language translator"]').waitFor({ timeout: 30_000 });
  report.checks.injectedOnYouTube = true;

  let viewer = await waitForFrame(page, "viewer.html");
  if (!viewer) throw new Error("Extension viewer frame was injected but could not be reached");
  let renderer = await waitForFrame(page, "pose-sandbox.html");
  if (!renderer) throw new Error("Sandboxed pose renderer frame could not be reached");
  report.layout = await viewer.evaluate(() => Object.fromEntries([
    ["viewport", { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }],
    ...["dragHandle", "startButton", "languageSelect", "aslButton", "pslButton", "sizeButton", "minimizeButton", "closeButton", "rendererFrame"].map((id) => {
      const element = document.getElementById(id);
      const rect = element?.getBoundingClientRect();
      const style = element ? getComputedStyle(element) : null;
      return [id, rect ? {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        background: style.backgroundColor,
        color: style.color,
        hidden: element.hidden,
      } : null];
    }),
  ]));
  report.checks.hindiApi = await viewer.evaluate(async () => {
    if (!("Translator" in self)) return { available: false };
    try {
      return {
        available: true,
        status: await Translator.availability({ sourceLanguage: "hi", targetLanguage: "en" }),
      };
    } catch (error) {
      return { available: true, error: error.message };
    }
  });
  await viewer.locator("#startButton").click();
  await viewer.waitForFunction(() => document.getElementById("startButton")?.textContent === "Stop");
  await viewer.waitForFunction(() => /Listening|Translation ready|Signing/.test(document.getElementById("status")?.textContent || ""), null, {
    timeout: 15_000,
  });

  report.checks.defaultLanguage = await viewer.evaluate(() => ({
    pslActive: document.getElementById("pslButton")?.classList.contains("active"),
    pslLabel: document.getElementById("pslButton")?.textContent?.trim(),
    aslLabel: document.getElementById("aslButton")?.textContent?.trim(),
  }));
  if (!report.checks.defaultLanguage.pslActive ||
      report.checks.defaultLanguage.pslLabel !== "Pakistan (PSL)" ||
      report.checks.defaultLanguage.aslLabel !== "Global (ASL)") {
    throw new Error(`Language defaults/labels are incorrect: ${JSON.stringify(report.checks.defaultLanguage)}`);
  }

  const pslResponse = page.waitForResponse((response) =>
    response.url().includes("spoken_text_to_signed_pose") && response.url().includes("signed=pks"),
    { timeout: 45_000 },
  );
  await page.evaluate(async () => {
    const media = document.querySelector("video");
    if (!media) return;
    media.muted = true;
    if (media.duration > 18) media.currentTime = 12;
    await media.play().catch(() => {});
  });
  // YouTube sometimes withholds tracks from automated browsers. The mock is
  // only a deterministic CI fallback and exercises the same hidden caption
  // observer after the transcript-first attempt.
  await page.waitForTimeout(2_500);
  if (!report.poseResponses.some((entry) => entry.url.includes("signed=pks"))) {
    await setMockCaption(page, "accessibility makes video better for everyone");
  }
  const pslNetworkResponse = await pslResponse;
  if (pslNetworkResponse.status() !== 200) throw new Error(`Full-extension default PSL request returned ${pslNetworkResponse.status()}`);
  await renderer.waitForFunction(() => {
    const signer = document.getElementById("signer");
    const canvas = document.getElementById("avatarCanvas");
    if (!Number.isFinite(signer.duration) || signer.duration <= 0 || !canvas) return false;
    const pixels = canvas.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let index = 0; pixels && index < pixels.length; index += 4) {
      if (Math.abs(pixels[index] - 7) + Math.abs(pixels[index + 1] - 19) + Math.abs(pixels[index + 2] - 31) > 80) colored += 1;
    }
    return colored > 50;
  }, null, { timeout: 30_000 });
  await renderer.waitForFunction(() => {
    const canvas = document.getElementById("avatarCanvas");
    return canvas?.dataset?.avatarRenderer === "realistic" && canvas?.dataset?.avatarModel === "ready";
  }, null, { timeout: 120_000 });
  report.checks.pslDefaultEndToEnd = {
    caption: await viewer.locator("#caption").textContent(),
    source: await viewer.locator("#sourceBadge").textContent(),
    duration: await renderer.locator("#signer").evaluate((element) => element.duration),
    canvas: await posePixelStats(renderer),
    naturalMotion: await naturalMotionStats(renderer),
    timeline: await poseTimelineStats(renderer),
    renderer: await renderer.locator("#avatarCanvas").getAttribute("data-avatar-renderer"),
  };
  if (report.checks.pslDefaultEndToEnd.renderer !== "realistic") {
    throw new Error(`Expected the realistic GLB renderer, received ${report.checks.pslDefaultEndToEnd.renderer || "no renderer"}`);
  }
  if (!report.checks.pslDefaultEndToEnd.naturalMotion ||
      report.checks.pslDefaultEndToEnd.naturalMotion.timeAdvance < 0.5 ||
      report.checks.pslDefaultEndToEnd.naturalMotion.uniqueFrames < 3) {
    throw new Error(`Default PSL avatar stayed still during natural playback: ${JSON.stringify(report.checks.pslDefaultEndToEnd.naturalMotion)}`);
  }
  if (!report.checks.pslDefaultEndToEnd.canvas || report.checks.pslDefaultEndToEnd.canvas.posePixels < 200) {
    throw new Error(`Default PSL avatar did not render visible pixels: ${JSON.stringify(report.checks.pslDefaultEndToEnd.canvas)}`);
  }
  if (!report.checks.pslDefaultEndToEnd.timeline || report.checks.pslDefaultEndToEnd.timeline.edgeFrames.length) {
    throw new Error(`Default PSL avatar clipped during its animation: ${JSON.stringify(report.checks.pslDefaultEndToEnd.timeline)}`);
  }

  const pslDuration = report.checks.pslDefaultEndToEnd.duration;
  const aslResponse = page.waitForResponse((response) =>
    response.url().includes("spoken_text_to_signed_pose") && response.url().includes("signed=ase"),
    { timeout: 30_000 },
  );
  await viewer.locator("#aslButton").click();
  const aslNetworkResponse = await aslResponse;
  if (aslNetworkResponse.status() !== 200) throw new Error(`Full-extension Global ASL request returned ${aslNetworkResponse.status()}`);
  await renderer.waitForFunction((previousDuration) => {
    const signer = document.getElementById("signer");
    const canvas = document.getElementById("avatarCanvas");
    if (!Number.isFinite(signer.duration) || signer.duration <= 0 || signer.duration === previousDuration || !canvas) return false;
    const pixels = canvas.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let index = 0; pixels && index < pixels.length; index += 4) {
      if (Math.abs(pixels[index] - 7) + Math.abs(pixels[index + 1] - 19) + Math.abs(pixels[index + 2] - 31) > 80) colored += 1;
    }
    return colored > 50;
  }, pslDuration, { timeout: 30_000 });
  report.checks.aslEndToEnd = {
    caption: await viewer.locator("#caption").textContent(),
    source: await viewer.locator("#sourceBadge").textContent(),
    duration: await renderer.locator("#signer").evaluate((element) => element.duration),
    canvas: await posePixelStats(renderer),
    timeline: await poseTimelineStats(renderer),
  };
  report.checks.rendererViewport = await renderer.evaluate(() => {
    const rect = window.frameElement?.getBoundingClientRect?.();
    const canvas = document.getElementById("avatarCanvas");
    return {
      innerWidth,
      innerHeight,
      documentClientWidth: document.documentElement.clientWidth,
      documentClientHeight: document.documentElement.clientHeight,
      frameRect: rect ? { width: rect.width, height: rect.height, left: rect.left, top: rect.top } : null,
      canvas: canvas ? { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight } : null,
    };
  });
  const canvasLayout = report.checks.rendererViewport?.canvas;
  const expectedRendererWidth = report.layout.rendererFrame?.width;
  if (!canvasLayout || !expectedRendererWidth ||
      Math.abs(canvasLayout.width - expectedRendererWidth) > 4 ||
      Math.abs(canvasLayout.clientWidth - expectedRendererWidth) > 4) {
    throw new Error(`Avatar canvas did not match its visible iframe: ${JSON.stringify({ canvasLayout, expectedRendererWidth })}`);
  }
  if (!report.checks.aslEndToEnd.canvas || report.checks.aslEndToEnd.canvas.posePixels < 200) {
    throw new Error(`ASL avatar did not render visible pixels: ${JSON.stringify(report.checks.aslEndToEnd.canvas)}`);
  }
  if (!report.checks.aslEndToEnd.timeline || report.checks.aslEndToEnd.timeline.edgeFrames.length) {
    throw new Error(`ASL avatar clipped during its animation: ${JSON.stringify(report.checks.aslEndToEnd.timeline)}`);
  }
  if (report.checks.pslDefaultEndToEnd.canvas.edgePosePixels || report.checks.aslEndToEnd.canvas.edgePosePixels) {
    throw new Error(`Signing avatar touched the canvas edge: ${JSON.stringify({
      psl: report.checks.pslDefaultEndToEnd.canvas,
      asl: report.checks.aslEndToEnd.canvas,
    })}`);
  }

  if (runHindi) {
    await viewer.locator("#aslButton").click();
    await viewer.locator("#startButton").click();
    await viewer.waitForFunction(() => document.getElementById("startButton")?.textContent === "Start");
    await page.evaluate(() => {
      document.querySelector('iframe[title="YouTube sign-language translator"]')?.contentWindow?.postMessage({
        channel: "youtube-sign-live-v1",
        type: "caption-preview",
        text: "यह हिंदी अनुवाद की परीक्षा है",
        sourceLanguage: "hi",
      }, "*");
    });
    await viewer.waitForFunction(() => document.getElementById("sourceBadge")?.textContent === "HI");
    await viewer.locator("#startButton").click();
    await viewer.waitForFunction(() => document.getElementById("startButton")?.textContent === "Stop", null, {
      timeout: 240_000,
    });

    const hindiResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname.includes("spoken_text_to_signed_pose") &&
        url.searchParams.get("signed") === "ase" &&
        url.searchParams.get("spoken") === "hi" &&
        url.searchParams.get("text") !== "accessibility makes video better for everyone";
    }, { timeout: 60_000 });
    await setMockCaption(page, "यह हिंदी अनुवाद की परीक्षा है");
    const hindiNetworkResponse = await hindiResponse;
    if (hindiNetworkResponse.status() !== 200) {
      throw new Error(`Full-extension Hindi ASL request returned ${hindiNetworkResponse.status()}`);
    }
    const translatedRequest = new URL(hindiNetworkResponse.url()).searchParams.get("text");
    await viewer.waitForFunction(() => document.getElementById("sourceBadge")?.textContent === "HI");
    report.checks.hindiAslEndToEnd = {
      input: "यह हिंदी अनुवाद की परीक्षा है",
      translatedRequest,
      outputSpokenLanguage: "hi",
    };
  }

  const responseCountBeforeRefresh = report.poseResponses.length;
  const refreshPoseResponse = page.waitForResponse((response) =>
    response.url().includes("spoken_text_to_signed_pose") && response.status() === 200,
    { timeout: 45_000 },
  );
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator('iframe[title="YouTube sign-language translator"]').waitFor({ timeout: 30_000 });
  viewer = await waitForFrame(page, "viewer.html");
  renderer = await waitForFrame(page, "pose-sandbox.html");
  if (!viewer || !renderer) throw new Error("Overlay frames did not recover after refresh");
  await viewer.waitForFunction(() =>
    document.getElementById("startButton")?.textContent === "Stop" &&
    !/Waiting to start|Ready when you are/iu.test(document.getElementById("status")?.textContent || ""),
  null, { timeout: 15_000 });
  await page.waitForTimeout(2_500);
  if (report.poseResponses.length === responseCountBeforeRefresh) {
    await setMockCaption(page, "translator reliability after refresh");
  }
  const refreshNetworkResponse = await refreshPoseResponse;
  report.checks.reliableAfterRefresh = {
    status: await viewer.locator("#status").textContent(),
    responseStatus: refreshNetworkResponse.status(),
    startButton: await viewer.locator("#startButton").textContent(),
  };

  report.overlay = await page.evaluate(() => {
    const root = document.getElementById("youtube-sign-live-root");
    const frame = document.querySelector('iframe[title="YouTube sign-language translator"]');
    const player = document.getElementById("movie_player");
    const rootRect = root?.getBoundingClientRect();
    const frameRect = frame?.getBoundingClientRect();
    const playerRect = player?.getBoundingClientRect();
    return {
      root: rootRect ? { left: rootRect.left, top: rootRect.top, width: rootRect.width, height: rootRect.height } : null,
      frame: frameRect ? { left: frameRect.left, top: frameRect.top, width: frameRect.width, height: frameRect.height } : null,
      player: playerRect ? { left: playerRect.left, top: playerRect.top, right: playerRect.right, bottom: playerRect.bottom } : null,
      display: root ? getComputedStyle(root).display : null,
      visibility: root ? getComputedStyle(root).visibility : null,
      connected: Boolean(root?.isConnected),
    };
  });
  if (!report.overlay.root || report.overlay.display === "none" || report.overlay.root.width < 250) {
    throw new Error(`Overlay was not visibly positioned at test completion: ${JSON.stringify(report.overlay)}`);
  }
  const overlayRight = report.overlay.root.left + report.overlay.root.width;
  const overlayBottom = report.overlay.root.top + report.overlay.root.height;
  report.overlay.insidePlayer = Boolean(
    report.overlay.player &&
    report.overlay.root.left >= report.overlay.player.left &&
    report.overlay.root.top >= report.overlay.player.top &&
    overlayRight <= report.overlay.player.right &&
    overlayBottom <= report.overlay.player.bottom
  );
  if (!report.overlay.insidePlayer) {
    throw new Error(`Overlay was not anchored inside the YouTube player: ${JSON.stringify(report.overlay)}`);
  }
  await renderer.evaluate(() => {
    const signer = document.getElementById("signer");
    signer.pause?.();
    signer.currentTime = Math.max(0, signer.duration * 0.48);
    signer.dispatchEvent(new CustomEvent("render$"));
  });
  await page.waitForTimeout(100);
  await page.screenshot({ path: screenshot });
  report.screenshot = screenshot;
  report.consoleErrors = report.consoleErrors.filter((entry) =>
    entry.url.startsWith("chrome-extension://") ||
    entry.text.includes("YTSign") ||
    entry.text.includes("PoseViewer"),
  );
  report.ok = Boolean(
    report.checks.injectedOnYouTube &&
    report.checks.pslDefaultEndToEnd &&
    report.checks.aslEndToEnd &&
    report.checks.reliableAfterRefresh &&
    (!runHindi || report.checks.hindiAslEndToEnd) &&
    report.consoleErrors.length === 0,
  );
} catch (error) {
  report.ok = false;
  report.error = error?.stack || String(error);
  report.serviceWorkers = context?.serviceWorkers().map((worker) => worker.url()) || [];
  try {
    await page?.goto("edge://extensions", { waitUntil: "domcontentloaded" });
    report.extensionsPage = await page?.evaluate(() => {
      const manager = document.querySelector("extensions-manager");
      return manager?.shadowRoot?.textContent?.replace(/\s+/gu, " ").trim().slice(0, 5_000) || document.body.innerText;
    });
  } catch {}
  throw error;
} finally {
  await context?.close();
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({ ...report, reportFile }, null, 2));
if (!report.ok) process.exitCode = 1;
