import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createRequire } from "node:module";

const root = resolve(import.meta.dirname, "..");
const recordDemo = process.argv.includes("--record-demo");
const parserModule = { exports: {} };
const parserBundle = await build({ stdin: { resolveDir: root, contents: 'export { Pose } from "pose-format";' },
  bundle: true, platform: "node", format: "cjs", write: false });
new Function("module", "exports", "require", parserBundle.outputFiles[0].text)(parserModule, parserModule.exports, createRequire(import.meta.url));
const { Pose } = parserModule.exports;
const run = resolve(root, "work", "avatar", "runtime-qa", new Date().toISOString().replace(/[:.]/gu, "-"));
await mkdir(run, { recursive: true });
const entry = await build({
  stdin: { resolveDir: root, contents: `
    import { fitPoseToViewport } from "./src/avatar-renderer.js";
    import { GltfAvatarRenderer } from "./src/gltf-avatar-renderer.js";
    import * as THREE from "three";
    globalThis.qa = { fitPoseToViewport, GltfAvatarRenderer, THREE };
  ` },
  bundle: true, format: "esm", platform: "browser", write: false,
});
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === "/") {
      res.setHeader("content-type", "text/html");
      res.end('<html><body style="margin:0;background:#07131f"><script type="module" src="/qa.js"></script></body></html>');
    } else if (pathname === "/qa.js") {
      res.setHeader("content-type", "text/javascript");
      res.end(entry.outputFiles[0].text);
    } else {
      // Bundling moves import.meta.url to /qa.js; map the avatar's relative URL.
      const relative = pathname.startsWith("/assets/avatar/") ? `src${pathname}` : pathname.slice(1);
      const path = resolve(root, decodeURIComponent(relative));
      if (!path.startsWith(root + sep)) throw new Error("outside project");
      res.setHeader("content-type", extname(path) === ".glb" ? "model/gltf-binary" : "application/octet-stream");
      res.end(await readFile(path));
    }
  } catch (error) { res.writeHead(404).end(String(error)); }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://127.0.0.1:${server.address().port}`;
const context = await chromium.launchPersistentContext(resolve(run, "browser"), {
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true, viewport: { width: 640, height: 520 },
  args: ["--disable-sync", "--no-first-run"],
});
const report = { run, poses: [], errors: [] };
try {
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(String(error)));
  await page.goto(base);
  await page.waitForFunction(() => globalThis.qa);
  await page.evaluate(async () => {
    const avatar = new qa.GltfAvatarRenderer();
    avatar.resize(640, 520);
    await avatar.loadPromise;
    if (!avatar.ready) throw new Error("Avatar failed to load for geometry QA");
    document.body.append(avatar.canvas);
    globalThis.avatar = avatar;
    globalThis.measureHandEnvelope = () => {
      const hands = [];
      avatar.root.updateMatrixWorld(true);
      avatar.camera.updateMatrixWorld(true);
      avatar.root.traverse((mesh) => {
        if (!mesh.isSkinnedMesh || !mesh.name.startsWith("YTSign_PSL_Hand_")) return;
        mesh.skeleton.update();
        const point = new qa.THREE.Vector3();
        const projected = new qa.THREE.Box3();
        let nonfinite = 0;
        const count = mesh.geometry.attributes.position.count;
        for (let index = 0; index < count; index += 1) {
          mesh.getVertexPosition(index, point).applyMatrix4(mesh.matrixWorld).project(avatar.camera);
          if (![point.x, point.y, point.z].every(Number.isFinite)) nonfinite += 1;
          else projected.expandByPoint(point);
        }
        const inside = !projected.isEmpty() && !nonfinite &&
          projected.min.x >= -1 && projected.max.x <= 1 &&
          projected.min.y >= -1 && projected.max.y <= 1 &&
          projected.min.z >= -1 && projected.max.z <= 1;
        hands.push({ mesh: mesh.name, vertices: count, nonfinite, inside,
          min: projected.min.toArray(), max: projected.max.toArray() });
      });
      if (hands.length < 2) throw new Error("Both anatomical hand surfaces must be measured");
      return hands;
    };
  });
  for (const [name, phrase, language] of [["hello-asl", null, "ase"], ["salam-psl", null, "pks"], ["aunty-psl", "Aunty, you can look at me", "pks"]]) {
    const path = resolve(root, "work", "avatar", "poses", `${name}.pose`);
    if (!await stat(path).catch(() => null)) {
      if (!phrase) throw new Error(`Missing fixture ${path}`);
      const url = new URL("https://us-central1-sign-mt.cloudfunctions.net/spoken_text_to_signed_pose");
      url.search = new URLSearchParams({ text: phrase, spoken: "en", signed: language });
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Fixture download ${response.status}`);
      await writeFile(path, Buffer.from(await response.arrayBuffer()));
    }
    const parsed = Pose.from(await readFile(path));
    const serialized = { header: parsed.header, body: { fps: parsed.body.fps,
      frames: Array.from({ length: parsed.body.frames.length }, (_, index) => parsed.body.frames[index]) } };
    const details = await page.evaluate(async (pose) => {
      globalThis.sourcePose = pose;
      globalThis.fittedPose = qa.fitPoseToViewport(pose, 640, 520);
      return { header: pose.header, frames: pose.body.frames.length };
    }, serialized);
    const result = { name, ...details, frames: [] };
    for (const fraction of [0.08, 0.24, 0.32, 0.4, 0.56, 0.8]) {
      const data = await page.evaluate((fraction) => {
        const frame = Math.floor((fittedPose.body.frames.length - 1) * fraction);
        const person = fittedPose.body.frames[frame].people[0];
        avatar.resetSmoothing();
        avatar.draw(person, fittedPose.header.components, frame / fittedPose.body.fps);
        const vec = (bone) => bone.getWorldPosition(new qa.THREE.Vector3()).toArray();
        const bones = Object.fromEntries([...avatar.bones].map(([name, bone]) => [name, {
          position: vec(bone), local: bone.position.toArray(), quaternion: bone.quaternion.toArray(),
        }]));
        return { fraction, frame, person, bones, counts: avatar.handDriveCounts,
          handSurfaces: measureHandEnvelope(),
          camera: { left: avatar.camera.left, right: avatar.camera.right, top: avatar.camera.top,
            bottom: avatar.camera.bottom, position: avatar.camera.position.toArray() },
          bounds: { min: avatar.modelBounds.min.toArray(), max: avatar.modelBounds.max.toArray() } };
      }, fraction);
      const screenshot = resolve(run, `${name}-${Math.round(fraction * 100)}.png`);
      await page.locator("canvas").screenshot({ path: screenshot });
      result.frames.push({ ...data, screenshot });
      if ((name === "aunty-psl" && fraction === 0.08) || (name === "hello-asl" && fraction === 0.32)) {
        const closeup = await page.evaluate(() => {
          const bounds = new qa.THREE.Box3();
          for (const [name, bone] of avatar.bones) if (name.startsWith("RightHand"))
            bounds.expandByPoint(bone.getWorldPosition(new qa.THREE.Vector3()));
          bounds.expandByScalar(0.016);
          const center = bounds.getCenter(new qa.THREE.Vector3());
          const size = bounds.getSize(new qa.THREE.Vector3());
          const half = Math.max(size.x, size.y, size.z) * 0.65;
          avatar.camera.left = -half * 640 / 520; avatar.camera.right = half * 640 / 520;
          avatar.camera.top = half; avatar.camera.bottom = -half;
          avatar.camera.position.set(center.x, center.y, center.z + 2);
          avatar.camera.lookAt(center); avatar.camera.updateProjectionMatrix();
          avatar.renderer.render(avatar.scene, avatar.camera);
          const restAngles = Object.fromEntries([...avatar.rest].filter(([name]) => name.startsWith("RightHand"))
            .map(([name, rest]) => [name, { restQuaternion: rest.quaternion.toArray(),
              deltaDegrees: rest.quaternion.angleTo(avatar.bones.get(name).quaternion) * 180 / Math.PI }]));
          return { restAngles, bounds: { min: bounds.min.toArray(), max: bounds.max.toArray() } };
        });
        await page.locator("canvas").screenshot({ path: resolve(run, `${name}-hand-detail.png`) });
        result.handDetail = closeup;
        await page.evaluate(() => avatar.configureCamera());
      }
    }
    // Inspect the real deformed surfaces over every source frame, not merely
    // tracked-landmark counts or an undeformed mesh bounding box. This checks
    // camera containment only: it cannot establish occlusion or intelligibility.
    result.timelineEnvelope = await page.evaluate(() => {
      const failures = [];
      let samples = 0;
      for (let frame = 0; frame < fittedPose.body.frames.length; frame += 1) {
        avatar.resetBones(); avatar.driven.clear();
        const groups = avatar.groupPerson(fittedPose.body.frames[frame].people[0], fittedPose.header.components);
        const body = avatar.updateBody(groups.body || []);
        const hands = avatar.matchHands(groups, body);
        avatar.updateHand(hands.Left || [], "Left"); avatar.updateHand(hands.Right || [], "Right");
        const measured = measureHandEnvelope();
        samples += 1;
        if (measured.some((hand) => !hand.inside)) failures.push({ frame, hands: measured });
      }
      return { samples, failures, pass: failures.length === 0 };
    });
    if (recordDemo && language === "pks") {
      const recording = await page.evaluate(async (label) => {
        avatar.configureCamera(); avatar.resetSmoothing();
        const canvas = document.createElement("canvas");
        canvas.width = 640; canvas.height = 640;
        const ctx = canvas.getContext("2d");
        const stream = canvas.captureStream(25);
        const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
          .find((value) => MediaRecorder.isTypeSupported(value));
        const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4_000_000 });
        const chunks = [];
        recorder.ondataavailable = ({ data }) => { if (data.size) chunks.push(data); };
        const finished = new Promise((resolve) => { recorder.onstop = resolve; });
        const duration = fittedPose.body.frames.length / fittedPose.body.fps;
        const start = performance.now();
        recorder.start();
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Demo recording timed out")), (duration + 20) * 1000);
          const tick = (now) => {
            try {
            const elapsed = Math.max(0, (now - start) / 1000);
            const frame = Math.min(fittedPose.body.frames.length - 1, Math.floor(elapsed * fittedPose.body.fps));
            avatar.draw(fittedPose.body.frames[frame].people[0], fittedPose.header.components, elapsed);
            ctx.fillStyle = "#07131f"; ctx.fillRect(0, 0, 640, 640);
            ctx.fillStyle = "#4be0c4"; ctx.font = "bold 22px sans-serif";
            ctx.fillText("YTSign · Pakistan (PSL)", 24, 32);
            ctx.fillStyle = "#ffffff"; ctx.font = "17px sans-serif"; ctx.fillText(label, 24, 62);
            ctx.drawImage(avatar.canvas, 0, 78, 640, 520);
            ctx.fillStyle = "#a1b6c7"; ctx.font = "14px sans-serif";
            ctx.fillText("Prototype · PSL accuracy awaiting fluent signer review", 24, 624);
            if (elapsed < duration) requestAnimationFrame(tick);
            else { clearTimeout(timeout); resolve(); }
            } catch (error) { clearTimeout(timeout); reject(error); }
          };
          requestAnimationFrame(tick);
        });
        recorder.stop(); await finished; stream.getTracks().forEach((track) => track.stop());
        const bytes = new Uint8Array(await new Blob(chunks, { type }).arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192)
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return { base64: btoa(binary), duration, type };
      }, name === "salam-psl" ? "Greeting sample" : phrase);
      const video = resolve(run, `${name}-demo.webm`);
      await writeFile(video, Buffer.from(recording.base64, "base64"));
      result.demo = { path: video, duration: recording.duration, type: recording.type };
    }
    report.poses.push(result);
  }
  report.framingPass = report.poses.every((pose) => pose.timelineEnvelope.pass) && report.errors.length === 0;
  if (!report.framingPass) process.exitCode = 1;
  await writeFile(resolve(run, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ run, errors: report.errors, framingPass: report.framingPass,
    poses: report.poses.map(p => ({ name: p.name, frames: p.frames.length, envelope: p.timelineEnvelope })) }));
} finally { await context.close(); await new Promise(done => server.close(done)); }
