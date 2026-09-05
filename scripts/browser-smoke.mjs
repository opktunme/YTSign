import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { chromium } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");
const work = resolve(root, "work");
const edge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const mimeTypes = new Map([
  [".css", "text/css"],
  [".html", "text/html"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".glb", "model/gltf-binary"],
  [".map", "application/json"],
]);

await mkdir(work, { recursive: true });

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const relative = pathname === "/" ? "viewer.html" : pathname.slice(1);
    const file = resolve(dist, relative);
    if (file !== dist && !file.startsWith(`${dist}${sep}`)) throw new Error("Invalid path");
    const info = await stat(file);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, {
      "content-type": mimeTypes.get(extname(file)) || "application/octet-stream",
      "content-length": info.size,
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
const { port } = server.address();
const runId = new Date().toISOString().replace(/[:.]/gu, "-");
const profile = resolve(work, `edge-smoke-${runId}`);
const screenshot = resolve(work, `viewer-smoke-${runId}.png`);
const reportedPhraseScreenshot = resolve(work, `reported-phrase-${runId}.png`);
const reportFile = resolve(work, `browser-smoke-${runId}.json`);
const report = { browser: "Microsoft Edge", profile, checks: {} };
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: edge,
    headless: true,
    viewport: { width: 720, height: 820 },
    args: ["--disable-sync", "--no-first-run"],
  });
  const page = await context.newPage();
  const consoleErrors = [];
  const consoleMessages = [];
  const failedRequests = [];
  const poseResponses = [];
  report.consoleErrors = consoleErrors;
  report.consoleMessages = consoleMessages;
  report.failedRequests = failedRequests;
  report.poseResponses = poseResponses;
  page.on("console", (message) => {
    consoleMessages.push(`${message.type()}: ${message.text()}`);
    if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${message.location().url}:${message.location().lineNumber}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(error.stack || error.message));
  page.on("requestfailed", (request) => failedRequests.push({
    url: request.url(),
    error: request.failure()?.errorText || "unknown",
  }));
  page.on("response", (response) => {
    if (response.url().includes("/assets/avatar/signing-avatar-")) {
      report.avatarResponse = { url: response.url(), status: response.status() };
    }
    if (response.url().includes("spoken_text_to_signed_pose")) {
      poseResponses.push({ url: response.url(), status: response.status() });
    }
  });

  await page.goto(`http://127.0.0.1:${port}/viewer.html`, { waitUntil: "networkidle" });
  const renderer = page.frames().find((frame) => frame.url().includes("pose-sandbox.html"));
  if (!renderer) throw new Error("Pose renderer frame did not load");
  await renderer.waitForFunction(() => customElements.get("pose-viewer"));
  await page.click("#startButton");
  await page.waitForFunction(() => document.getElementById("startButton")?.textContent === "Stop");
  report.checks.defaultLanguage = await page.evaluate(() => ({
    pslActive: document.getElementById("pslButton")?.classList.contains("active"),
    pslLabel: document.getElementById("pslButton")?.textContent?.trim(),
    aslLabel: document.getElementById("aslButton")?.textContent?.trim(),
  }));
  if (!report.checks.defaultLanguage.pslActive ||
      report.checks.defaultLanguage.pslLabel !== "Pakistan (PSL)" ||
      report.checks.defaultLanguage.aslLabel !== "Global (ASL)") {
    throw new Error(`Language defaults/labels are incorrect: ${JSON.stringify(report.checks.defaultLanguage)}`);
  }
  await page.click("#aslButton");

  const aslResponse = page.waitForResponse((response) =>
    response.url().includes("spoken_text_to_signed_pose") &&
    response.url().includes("signed=ase"),
  );
  await page.evaluate(() => window.postMessage({
    channel: "youtube-sign-live-v1",
    type: "caption",
    text: "hello world",
    sourceLanguage: "en",
    videoTime: 0,
    videoId: "smoke",
  }, "*"));
  const aslNetworkResponse = await aslResponse;
  if (aslNetworkResponse.status() !== 200) {
    const body = await aslNetworkResponse.text().catch(() => "");
    const headers = await aslNetworkResponse.allHeaders().catch(() => ({}));
    report.aslFailure = { body: body.slice(0, 2_000), headers };
    throw new Error(`ASL pose request returned ${aslNetworkResponse.status()}: ${body.slice(0, 240)}`);
  }
  await renderer.waitForFunction(() => {
    const signer = document.getElementById("signer");
    const canvas = document.getElementById("avatarCanvas");
    if (!Number.isFinite(signer.duration) || signer.duration <= 0 || !canvas) return false;
    const pixels = canvas.getContext("2d", { willReadFrequently: true })?.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let index = 0; pixels && index < pixels.length; index += 4) {
      if (Math.abs(pixels[index] - 7) + Math.abs(pixels[index + 1] - 19) + Math.abs(pixels[index + 2] - 31) > 80) colored += 1;
    }
    return colored > 200;
  }, null, { timeout: 60_000 });
  await renderer.waitForFunction(() => {
    const canvas = document.getElementById("avatarCanvas");
    return canvas?.dataset?.avatarRenderer === "realistic" && canvas?.dataset?.avatarModel === "ready";
  }, null, { timeout: 120_000 });
  report.checks.avatarRenderer = await renderer.locator("#avatarCanvas").getAttribute("data-avatar-renderer");
  if (report.checks.avatarRenderer !== "realistic") {
    throw new Error(`Expected the realistic GLB renderer, received ${report.checks.avatarRenderer || "no renderer"}`);
  }
  report.checks.syntheticRig = await renderer.evaluate(async () => {
    const avatar = globalThis.__ytsignCreateGltfAvatarRenderer?.();
    if (!avatar) return { ready: false, error: "QA renderer factory was not exposed" };
    avatar.resize(256, 256);
    await avatar.loadPromise;
    const components = [
      { name: "POSE_LANDMARKS" },
      { name: "LEFT_HAND_LANDMARKS" },
      { name: "RIGHT_HAND_LANDMARKS" },
    ];
    const joint = (X, Y, Z = 0, C = 1) => ({ X, Y, Z, C });
    const body = [
      joint(390, 235), joint(250, 235),
      joint(420, 315), joint(220, 315),
      joint(430, 420), joint(210, 420),
      joint(370, 510), joint(270, 510),
    ];
    const add = (origin, value, mirror) => joint(
      origin.X + value[0] * mirror,
      origin.Y + value[1],
      origin.Z + value[2],
    );
    const makeHand = (side, shape = "open") => {
      const mirror = side === "Left" ? 1 : -1;
      const wrist = joint(side === "Left" ? 430 : 210, 420, 0);
      const open = {
        Thumb: [[28, -7, 0], [47, -18, -2], [62, -29, -3], [75, -37, -4]],
        // Keep the neutral synthetic palm inside the donor's unsaturated
        // metacarpal range. The former extra-wide fixture saturated both the
        // open and curled IndexMeta at the same 18-degree limit, so a working
        // control falsely appeared frozen. The curled fixture below remains a
        // valid, wider differential-abduction target.
        Index: [[10, -38, 0], [11, -73, 0], [12, -103, 0], [13, -129, 0]],
        Middle: [[3, -40, 0], [3, -80, 0], [3, -115, 0], [3, -144, 0]],
        Ring: [[-4, -38, 0], [-5, -75, 0], [-6, -107, 0], [-7, -133, 0]],
        Pinky: [[-10, -34, 0], [-13, -65, 0], [-15, -91, 0], [-17, -113, 0]],
      };
      const curled = {
        Thumb: [[34, -2, 10], [48, -13, 22], [53, -29, 38], [48, -42, 51]],
        Index: [[29, -25, 7], [31, -50, 22], [29, -54, 49], [25, -41, 68]],
        Middle: [[9, -31, 9], [10, -59, 25], [8, -63, 55], [5, -48, 76]],
        Ring: [[-15, -27, 11], [-17, -53, 29], [-19, -56, 58], [-20, -42, 78]],
        Pinky: [[-35, -19, 13], [-39, -42, 31], [-42, -44, 57], [-43, -31, 75]],
      };
      const source = shape === "curled" ? curled : open;
      const result = [wrist];
      for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
        for (const [pointIndex, value] of source[finger].entries()) {
          const point = add(wrist, value, mirror);
          if (shape === "depth" && finger === "Index") {
            point.Z += [0, 10, 42, 84][pointIndex];
          }
          result.push(point);
        }
      }
      return result;
    };
    const handControls = (side) => [
      ...["Index", "Middle", "Ring", "Pinky"].map((finger) => `${side}Hand${finger}Meta`),
      ...["Thumb", "Index", "Middle", "Ring", "Pinky"].flatMap((finger) =>
        [1, 2, 3].map((jointIndex) => `${side}Hand${finger}${jointIndex}`)),
    ];
    const quaternion = (name) => avatar.bones.get(name)?.quaternion.clone();
    const snapshot = (names) => Object.fromEntries(names.map((name) => [name, quaternion(name)]));
    const angleDegrees = (left, right) => left && right
      ? left.angleTo(right) * 180 / Math.PI
      : Number.POSITIVE_INFINITY;
    const person = (leftHand, rightHand) => ({
      POSE_LANDMARKS: body,
      LEFT_HAND_LANDMARKS: leftHand || [],
      RIGHT_HAND_LANDMARKS: rightHand || [],
    });
    const controls = [...handControls("Left"), ...handControls("Right")];
    const handMaterials = [];
    const nailMeshes = [];
    avatar.root.traverse((node) => {
      if (!node.isMesh) return;
      if (node.name.startsWith("YTSign_PSL_Hand_")) {
        const materials = Array.isArray(node.material) ? node.material : [node.material];
        for (const material of materials) handMaterials.push({
          name: material.name,
          transparent: material.transparent,
          opacity: material.opacity,
          depthWrite: material.depthWrite,
          depthTest: material.depthTest,
        });
      }
      if (node.name.startsWith("YTSign_Nail_")) {
        nailMeshes.push({ name: node.name, visible: node.visible });
      }
    });
    const materialRegression = {
      handMeshCount: handMaterials.length,
      nailMeshCount: nailMeshes.length,
      handsOpaque: handMaterials.length === 2 && handMaterials.every((material) =>
        material.transparent === false && material.opacity === 1 &&
        material.depthWrite === true && material.depthTest === true),
      nailsHidden: nailMeshes.length === 10 && nailMeshes.every((mesh) => mesh.visible === false),
      handMaterials,
      nailMeshes,
    };

    avatar.resetSmoothing();
    avatar.draw(person(makeHand("Left"), makeHand("Right")), components, 0);
    const open = snapshot(controls);
    const openCounts = { left: avatar.handDriveCounts.Left, right: avatar.handDriveCounts.Right };
    avatar.draw(person(makeHand("Left", "curled"), makeHand("Right", "curled")), components, 0.25);
    const curled = snapshot(controls);
    const curledCounts = { left: avatar.handDriveCounts.Left, right: avatar.handDriveCounts.Right };
    const changed = Object.fromEntries(controls.map((name) => [name, angleDegrees(open[name], curled[name])]));
    const unchangedControls = Object.entries(changed)
      .filter(([, degrees]) => !Number.isFinite(degrees) || degrees < 0.5)
      .map(([name]) => name);

    avatar.resetSmoothing();
    avatar.draw(person(makeHand("Left"), []), components, 1);
    const explicitSide = { left: avatar.handDriveCounts.Left, right: avatar.handDriveCounts.Right };

    avatar.resetSmoothing();
    avatar.draw(person(makeHand("Left"), []), components, 2);
    const depthBaseline = snapshot(["LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3"]);
    avatar.draw(person(makeHand("Left", "depth"), []), components, 2.25);
    const depthPose = snapshot(["LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3"]);
    const depthResponseDegrees = Object.fromEntries(Object.keys(depthBaseline).map((name) =>
      [name, angleDegrees(depthBaseline[name], depthPose[name])]));

    avatar.resetSmoothing();
    avatar.draw(person(makeHand("Left", "curled"), []), components, 3);
    const dropoutBone = "LeftHandIndex2";
    const dropoutStart = quaternion(dropoutBone);
    const rest = avatar.rest.get(dropoutBone)?.quaternion.clone();
    avatar.draw(person([], []), components, 3.04);
    const dropoutHold = quaternion(dropoutBone);
    avatar.draw(person([], []), components, 3.20);
    const dropoutBlend = quaternion(dropoutBone);
    avatar.draw(person([], []), components, 3.50);
    const dropoutRelease = quaternion(dropoutBone);
    const dropout = {
      holdDeltaDegrees: angleDegrees(dropoutStart, dropoutHold),
      startFromRestDegrees: angleDegrees(dropoutStart, rest),
      blendFromRestDegrees: angleDegrees(dropoutBlend, rest),
      releaseFromRestDegrees: angleDegrees(dropoutRelease, rest),
    };

    const result = {
      ready: avatar.ready,
      requiredBoneCount: avatar.bones.size,
      weightedHandControlCount: controls.length,
      openCounts,
      curledCounts,
      changedControlCount: controls.length - unchangedControls.length,
      minimumControlChangeDegrees: Math.min(...Object.values(changed)),
      unchangedControls,
      explicitSide,
      depthResponseDegrees,
      dropout,
      materialRegression,
    };
    result.pass = result.ready && result.requiredBoneCount >= 72 &&
      openCounts.left === 20 && openCounts.right === 20 &&
      curledCounts.left === 20 && curledCounts.right === 20 &&
      result.changedControlCount === 38 && result.minimumControlChangeDegrees >= 0.5 &&
      materialRegression.handsOpaque && materialRegression.nailsHidden &&
      explicitSide.left === 20 && explicitSide.right === 0 &&
      Object.values(depthResponseDegrees).every((degrees) => degrees >= 0.5) &&
      dropout.holdDeltaDegrees < 0.1 &&
      dropout.blendFromRestDegrees < dropout.startFromRestDegrees &&
      dropout.releaseFromRestDegrees < 0.1;
    avatar.renderer.dispose();
    return result;
  });
  if (!report.checks.syntheticRig?.pass) {
    throw new Error(`Synthetic all-finger rig QA failed: ${JSON.stringify(report.checks.syntheticRig)}`);
  }
  const aslDuration = await renderer.locator("#signer").evaluate((element) => element.duration);
  report.checks.asl = {
    rendered: true,
    duration: aslDuration,
  };
  report.checks.naturalMotion = await renderer.evaluate(async () => {
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
  if (!report.checks.naturalMotion || report.checks.naturalMotion.timeAdvance < 0.5 || report.checks.naturalMotion.uniqueFrames < 3) {
    throw new Error(`Avatar did not animate during natural playback: ${JSON.stringify(report.checks.naturalMotion)}`);
  }
  report.checks.poseMotionLandmarks = await renderer.evaluate(async () => {
    const pose = await document.getElementById("signer").getPose();
    const fractions = [0.08, 0.24, 0.4, 0.56, 0.72, 0.88];
    return fractions.map((fraction) => {
      const frameIndex = Math.min(pose.body.frames.length - 1, Math.floor(pose.body.frames.length * fraction));
      const person = pose.body.frames[frameIndex]?.people?.[0] || {};
      const components = {};
      for (const component of pose.header.components || []) {
        const joints = person[component.name] || [];
        components[component.name] = {
          count: joints.length,
          valid: joints.filter((joint) => joint && Number(joint.C) > 0.12).length,
          signature: joints.slice(0, 21).map((joint) => joint
            ? [joint.X, joint.Y, joint.Z, joint.C].map((value) => Number(value).toFixed(2)).join(",")
            : "-").join("|"),
        };
      }
      return { fraction, frameIndex, components };
    });
  });
  report.checks.motion = await renderer.evaluate(async () => {
    const signer = document.getElementById("signer");
    const canvas = document.getElementById("avatarCanvas");
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!signer || !canvas || !context || !Number.isFinite(signer.duration) || signer.duration <= 0) return null;
    await signer.pause?.();
    const fractions = [0.08, 0.24, 0.4, 0.56, 0.72, 0.88];
    const samples = [];
    let previous = null;
    for (const fraction of fractions) {
      signer.currentTime = signer.duration * fraction;
      signer.dispatchEvent(new CustomEvent("render$"));
      await new Promise((resolveFrame) => requestAnimationFrame(resolveFrame));
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      let changedPixels = 0;
      let absoluteDelta = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        hash ^= pixels[index];
        hash = Math.imul(hash, 16777619);
        hash ^= pixels[index + 1];
        hash = Math.imul(hash, 16777619);
        hash ^= pixels[index + 2];
        hash = Math.imul(hash, 16777619);
        if (previous) {
          const delta = Math.abs(pixels[index] - previous[index]) +
            Math.abs(pixels[index + 1] - previous[index + 1]) +
            Math.abs(pixels[index + 2] - previous[index + 2]);
          absoluteDelta += delta;
          if (delta > 30) changedPixels += 1;
        }
      }
      samples.push({
        fraction,
        hash: hash >>> 0,
        changedPixels,
        absoluteDelta,
        drivenBones: Number(canvas.dataset.drivenBones || 0),
        trackedHands: Number(canvas.dataset.trackedHands || 0),
        leftHandBones: Number(canvas.dataset.leftHandBones || 0),
        rightHandBones: Number(canvas.dataset.rightHandBones || 0),
        leftMissingHandControls: canvas.dataset.leftMissingHandControls || "",
        rightMissingHandControls: canvas.dataset.rightMissingHandControls || "",
        poseTime: canvas.dataset.poseTime || "",
        boneSignature: canvas.dataset.boneSignature || "",
        targetBoneSignature: canvas.dataset.targetBoneSignature || "",
      });
      previous = new Uint8ClampedArray(pixels);
    }
    signer.currentTime = 0;
    signer.dispatchEvent(new CustomEvent("render$"));
    return {
      samples,
      uniqueFrames: new Set(samples.map((sample) => sample.hash)).size,
      minimumChangedPixels: Math.min(...samples.slice(1).map((sample) => sample.changedPixels)),
      maximumChangedPixels: Math.max(...samples.slice(1).map((sample) => sample.changedPixels)),
    };
  });
  if (!report.checks.motion || report.checks.motion.uniqueFrames < 4 || report.checks.motion.maximumChangedPixels < 500) {
    throw new Error(`Avatar did not visibly animate: ${JSON.stringify(report.checks.motion)}`);
  }
  const strongestHandFrame = report.checks.motion.samples.reduce((best, sample) =>
    sample.leftHandBones + sample.rightHandBones > best.leftHandBones + best.rightHandBones ? sample : best,
  report.checks.motion.samples[0]);
  if (strongestHandFrame.leftHandBones !== 20 || strongestHandFrame.rightHandBones !== 20) {
    throw new Error(`Live pose never drove every weighted finger control on both hands: ${JSON.stringify(strongestHandFrame)}`);
  }
  report.checks.motionScreenshots = [];
  for (const fraction of [0.08, 0.32, 0.56, 0.8]) {
    await renderer.evaluate((targetFraction) => {
      const signer = document.getElementById("signer");
      signer.currentTime = signer.duration * targetFraction;
      signer.dispatchEvent(new CustomEvent("render$"));
    }, fraction);
    const motionScreenshot = resolve(work, `avatar-motion-${runId}-${Math.round(fraction * 100)}.png`);
    await renderer.locator("#avatarCanvas").screenshot({ path: motionScreenshot });
    report.checks.motionScreenshots.push(motionScreenshot);
  }
  report.checks.poseSchema = await renderer.evaluate(async () => {
    const pose = await document.getElementById("signer").getPose();
    const person = pose?.body?.frames?.[0]?.people?.[0] || {};
    return (pose?.header?.components || []).map((component) => {
      const joints = person[component.name] || [];
      return {
        name: component.name,
        jointCount: joints.length,
        limbCount: component.limbs?.length || 0,
      };
    });
  });

  await page.click("#pslButton");
  const pslResponse = page.waitForResponse((response) =>
    response.url().includes("spoken_text_to_signed_pose") &&
    response.url().includes("signed=pks") &&
    response.url().includes("spoken=ur"),
  );
  await page.evaluate(() => window.postMessage({
    channel: "youtube-sign-live-v1",
    type: "caption",
    text: "سلام دنیا",
    sourceLanguage: "ur",
    videoTime: 2,
    videoId: "smoke",
  }, "*"));
  const pslNetworkResponse = await pslResponse;
  if (pslNetworkResponse.status() !== 200) throw new Error(`PSL pose request returned ${pslNetworkResponse.status()}`);
  await page.waitForFunction(() => document.getElementById("sourceBadge")?.textContent === "UR");
  await renderer.waitForFunction((previousDuration) => {
    const signer = document.getElementById("signer");
    return Number.isFinite(signer.duration) && signer.duration > 0 && signer.duration !== previousDuration;
  }, aslDuration, { timeout: 30_000 });
  report.checks.pslUrdu = {
    rendered: true,
    duration: await renderer.locator("#signer").evaluate((element) => element.duration),
  };

  const reportedPhraseResponse = page.waitForResponse((response) =>
    response.url().includes("spoken_text_to_signed_pose") &&
    response.url().includes("signed=pks") &&
    response.url().includes("Aunty"),
  );
  const previousDuration = report.checks.pslUrdu.duration;
  await page.evaluate(() => window.postMessage({
    channel: "youtube-sign-live-v1",
    type: "caption",
    text: "Aunty, you can look at me",
    sourceLanguage: "en",
    videoTime: 3,
    videoId: "reported-freeze-regression",
  }, "*"));
  const reportedNetworkResponse = await reportedPhraseResponse;
  if (reportedNetworkResponse.status() !== 200) {
    throw new Error(`Reported PSL phrase returned ${reportedNetworkResponse.status()}`);
  }
  await renderer.waitForFunction((oldDuration) => {
    const signer = document.getElementById("signer");
    return Number.isFinite(signer.duration) && signer.duration > 0 && signer.duration !== oldDuration;
  }, previousDuration, { timeout: 30_000 });
  report.checks.reportedFreezeRegression = await renderer.evaluate(async () => {
    const signer = document.getElementById("signer");
    const canvas = document.getElementById("avatarCanvas");
    const startTime = signer.currentTime;
    await new Promise((resolveSample) => setTimeout(resolveSample, 700));
    return {
      startTime,
      endTime: signer.currentTime,
      visibleHands: Number(canvas?.dataset.visibleHands || 0),
      trackedHands: Number(canvas?.dataset.trackedHands || 0),
      leftHandBones: Number(canvas?.dataset.leftHandBones || 0),
      rightHandBones: Number(canvas?.dataset.rightHandBones || 0),
      leftMissingHandControls: canvas?.dataset.leftMissingHandControls || "",
      rightMissingHandControls: canvas?.dataset.rightMissingHandControls || "",
    };
  });
  const regression = report.checks.reportedFreezeRegression;
  const completeTrackedHands = [regression.leftHandBones, regression.rightHandBones]
    .filter((count) => count === 20).length;
  const hasPartialHand = [regression.leftHandBones, regression.rightHandBones]
    .some((count) => count > 0 && count < 20);
  // A source pose may legitimately contain a one-handed sign. Require every
  // provided hand to be complete and the reported count to match it; never
  // manufacture a two-hand PASS when the pose only tracked one.
  if (regression.endTime - regression.startTime < 0.4 ||
      completeTrackedHands < 1 || hasPartialHand ||
      regression.visibleHands !== completeTrackedHands ||
      regression.trackedHands !== completeTrackedHands) {
    throw new Error(`Reported frozen/handless phrase regressed: ${JSON.stringify(report.checks.reportedFreezeRegression)}`);
  }
  await renderer.locator("#avatarCanvas").screenshot({ path: reportedPhraseScreenshot });
  report.checks.reportedFreezeRegression.screenshot = reportedPhraseScreenshot;

  report.checks.hindiApi = await page.evaluate(async () => {
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
  report.consoleErrors = consoleErrors.filter((message) =>
    !message.includes("favicon.ico") && !message.includes("Permissions policy violation"),
  );
  report.failedRequests = failedRequests;
  if (report.checks.avatarRenderer === "realistic" && report.avatarResponse?.status === 200) {
    report.failedRequests = failedRequests.filter((entry) => !entry.url.includes("/assets/avatar/signing-avatar-"));
  }
  report.poseResponses = poseResponses;
  await page.screenshot({ path: screenshot, fullPage: true });
  report.screenshot = screenshot;
  report.ok = report.checks.asl.rendered && report.checks.pslUrdu.rendered && report.consoleErrors.length === 0;
} catch (error) {
  try {
    const page = context?.pages?.().at(-1);
    const renderer = page?.frames?.().find((frame) => frame.url().includes("pose-sandbox.html"));
    report.failureState = renderer ? await renderer.evaluate(() => {
      const signer = document.getElementById("signer");
      const canvas = document.getElementById("avatarCanvas");
      const pixels = canvas?.getContext("2d", { willReadFrequently: true })
        ?.getImageData(0, 0, canvas.width, canvas.height).data;
      let colored = 0;
      for (let index = 0; pixels && index < pixels.length; index += 4) {
        if (Math.abs(pixels[index] - 7) + Math.abs(pixels[index + 1] - 19) + Math.abs(pixels[index + 2] - 31) > 80) colored += 1;
      }
      return {
        signerDuration: signer?.duration,
        signerCurrentTime: signer?.currentTime,
        signerSrc: signer?.src,
        renderer: canvas?.dataset?.avatarRenderer || "",
        model: canvas?.dataset?.avatarModel || "",
        modelBounds: canvas?.dataset?.avatarBounds || "",
        canvas: canvas ? { width: canvas.width, height: canvas.height, colored } : null,
        resources: performance.getEntriesByType("resource")
          .filter((entry) => entry.name.includes("/assets/avatar/signing-avatar-"))
          .map((entry) => ({
            name: entry.name,
            duration: entry.duration,
            transferSize: entry.transferSize,
            encodedBodySize: entry.encodedBodySize,
            decodedBodySize: entry.decodedBodySize,
          })),
      };
    }) : { rendererFrame: false };
    if (page) {
      const failureScreenshot = resolve(work, `viewer-smoke-failure-${runId}.png`);
      await page.screenshot({ path: failureScreenshot, fullPage: true });
      report.failureScreenshot = failureScreenshot;
    }
  } catch (diagnosticError) {
    report.failureState = { diagnosticError: diagnosticError?.stack || String(diagnosticError) };
  }
  report.ok = false;
  report.error = error?.stack || String(error);
  throw error;
} finally {
  await context?.close();
  await new Promise((resolveClosed) => server.close(resolveClosed));
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(JSON.stringify({ ...report, reportFile }, null, 2));
if (!report.ok) process.exitCode = 1;
