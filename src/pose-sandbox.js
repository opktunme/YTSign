import { fitPoseToViewport, SigningAvatarRenderer } from "./avatar-renderer.js";

const CHANNEL = "youtube-sign-live-v1";
const signer = document.getElementById("signer");
const avatar = new SigningAvatarRenderer(document.getElementById("avatarCanvas"));
const signerReady = customElements.whenDefined("pose-viewer");
let objectUrl = "";
let appearance = "avatar";
let parentPaused = false;
let resizeTimer = null;
let viewport = null;
let lastPaintedTime = -1;
let animationTime = 0;
let animationDuration = 0;
let animationPlaying = false;
let animationPlaybackRate = 1;
let lastAnimationTick = 0;
let endedPosted = false;

function post(type, payload = {}) {
  parent.postMessage({ channel: CHANNEL, type, ...payload }, "*");
}

function clearPose() {
  signer.pause?.();
  signer.src = "";
  avatar.setPose(null);
  avatar.clear();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = "";
  lastPaintedTime = -1;
  animationTime = 0;
  animationDuration = 0;
  animationPlaying = false;
  lastAnimationTick = 0;
  endedPosted = false;
}

function paintCurrentPose(force = false) {
  const currentTime = Number(animationTime);
  if (!Number.isFinite(currentTime)) return;
  const fps = Number(avatar.pose?.body?.fps) || 25;
  const frameStep = 1 / Math.max(1, fps);
  const wrapped = currentTime + frameStep * 0.5 < lastPaintedTime;
  if (force || wrapped || lastPaintedTime < 0 || currentTime - lastPaintedTime >= frameStep * 0.8) {
    avatar.draw(currentTime);
    lastPaintedTime = currentTime;
  }
}

function finishAnimation() {
  if (endedPosted) return;
  endedPosted = true;
  animationPlaying = false;
  post("renderer-ended");
}

function animationFrameLoop(now) {
  // Drive signing from our own monotonic clock. pose-viewer's media-like
  // playback can remain at currentTime=0 in a throttled sandboxed extension
  // iframe even though its parser and pose data are ready.
  if (avatar.pose && animationPlaying && !parentPaused) {
    if (!lastAnimationTick) lastAnimationTick = now;
    const elapsed = Math.min(0.12, Math.max(0, (now - lastAnimationTick) / 1000));
    lastAnimationTick = now;
    animationTime = Math.min(animationDuration, animationTime + elapsed * animationPlaybackRate);
    signer.currentTime = animationTime;
    paintCurrentPose(false);
    if (animationDuration > 0 && animationTime >= animationDuration) finishAnimation();
  } else {
    lastAnimationTick = now;
  }
  requestAnimationFrame(animationFrameLoop);
}

function setRendererDimensions() {
  const { width, height } = avatar.resize(viewport);
  signer.width = `${width}px`;
  signer.height = `${height}px`;
}

async function reloadPoseForSize() {
  if (!objectUrl) {
    setRendererDimensions();
    avatar.clear();
    return;
  }
  await signer.pause?.();
  signer.src = "";
  avatar.setPose(null);
  setRendererDimensions();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  signer.src = objectUrl;
}

window.addEventListener("message", async (event) => {
  if (event.source !== parent || event.data?.channel !== CHANNEL) return;
  const message = event.data;
  let viewportChanged = false;
  if (Number(message.viewport?.width) > 0 && Number(message.viewport?.height) > 0) {
    const nextViewport = { width: Number(message.viewport.width), height: Number(message.viewport.height) };
    viewportChanged = !viewport || viewport.width !== nextViewport.width || viewport.height !== nextViewport.height;
    viewport = nextViewport;
  }
  if (message.type === "renderer-pose") {
    await signerReady;
    await signer.componentOnReady?.();
    appearance = "avatar";
    avatar.setMode(appearance);
    clearPose();
    objectUrl = URL.createObjectURL(new Blob([message.buffer], { type: "application/pose" }));
    animationPlaybackRate = Number(message.playbackRate) || 1;
    signer.playbackRate = animationPlaybackRate;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    setRendererDimensions();
    signer.src = objectUrl;
  }
  if (message.type === "renderer-clear") clearPose();
  if (message.type === "renderer-pause") {
    parentPaused = true;
    animationPlaying = false;
  }
  if (message.type === "renderer-play") {
    parentPaused = false;
    animationPlaying = Boolean(avatar.pose) && animationTime < animationDuration;
    lastAnimationTick = performance.now();
  }
  if (message.type === "renderer-rate") {
    animationPlaybackRate = Number(message.playbackRate) || 1;
    signer.playbackRate = animationPlaybackRate;
  }
  if (message.type === "renderer-mode") {
    appearance = "avatar";
    avatar.setMode(appearance);
  }
  if (message.type === "renderer-size" && viewportChanged) await reloadPoseForSize();
});

signer.addEventListener("ended$", finishAnimation);
signer.addEventListener("loadedmetadata$", async () => {
  try {
    const pose = await signer.getPose();
    const { width, height } = avatar.resize(viewport);
    const fittedPose = fitPoseToViewport(pose, width, height);
    if (!fittedPose) throw new Error("The pose did not contain renderable landmarks");
    avatar.setPose(fittedPose);
    avatar.setMode(appearance);
    animationDuration = fittedPose.body.frames.length / Math.max(1, Number(fittedPose.body.fps) || 25);
    animationTime = 0;
    animationPlaying = !parentPaused;
    endedPosted = false;
    lastAnimationTick = performance.now();
    signer.currentTime = 0;
    paintCurrentPose(true);
    post("renderer-first", { duration: animationDuration });
  } catch (error) {
    console.error("Signing avatar setup failed", error?.stack || error);
  }
});
signer.addEventListener("render$", () => {
  const requestedTime = Number(signer.currentTime);
  if (Number.isFinite(requestedTime) && Math.abs(requestedTime - animationTime) > 0.001) {
    animationTime = Math.min(animationDuration || requestedTime, Math.max(0, requestedTime));
  }
  paintCurrentPose(true);
});
signerReady.then(async () => {
  await signer.componentOnReady?.();
  setRendererDimensions();
  post("renderer-ready");
  requestAnimationFrame(animationFrameLoop);
});

window.addEventListener("resize", () => {
  if (viewport) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(reloadPoseForSize, 140);
});
