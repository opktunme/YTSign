const CHANNEL = "youtube-sign-live-v1";
const MAX_QUEUE = 4;
const MAX_CACHE = 30;

const rendererFrame = document.getElementById("rendererFrame");
const idle = document.getElementById("idle");
const idleTitle = idle.querySelector("strong");
const idleMessage = idle.querySelector("span:last-child");
const busy = document.getElementById("busy");
const queueBadge = document.getElementById("queueBadge");
const statusEl = document.getElementById("status");
const captionEl = document.getElementById("caption");
const glossEl = document.getElementById("gloss");
const sourceBadge = document.getElementById("sourceBadge");
const languageLabel = document.getElementById("languageLabel");
const languageOptions = Array.from(document.querySelectorAll(".language-option"));
const startButton = document.getElementById("startButton");
const liveDot = document.getElementById("liveDot");
const sizeButton = document.getElementById("sizeButton");
const dragHandle = document.getElementById("dragHandle");

let started = false;
let paused = false;
let signedLanguage = "pks";
let appearance = "avatar";
let sourceLanguage = "en";
let latestCaption = "";
let current = null;
let queue = [];
let cache = new Map();
let requestSerial = 0;
let generation = 0;
let basePlaybackRate = 1;
let sizeIndex = 1;
const sizes = ["small", "medium", "large"];

for (const control of document.querySelectorAll('[role="button"]')) {
  control.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    control.click();
  });
}

function post(type, payload = {}) {
  parent.postMessage({ channel: CHANNEL, type, ...payload }, "*");
}

function rendererViewport() {
  // The sandbox's intrinsic canvas can temporarily inflate the iframe itself.
  // Its stage container remains the authoritative clipped viewport and avoids
  // a resize feedback loop (270px -> 512px -> 1885px).
  const rect = rendererFrame.parentElement.getBoundingClientRect();
  const maxWidth = Math.max(1, document.documentElement.clientWidth - 24);
  return { width: Math.round(Math.min(rect.width, maxWidth)), height: Math.round(rect.height) };
}

function postRenderer(type, payload = {}) {
  rendererFrame.contentWindow?.postMessage({
    channel: CHANNEL,
    type,
    viewport: rendererViewport(),
    ...payload,
  }, "*");
}

function normalize(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function setStatus(value) {
  statusEl.textContent = value;
}

function setIdleState(active) {
  idleTitle.textContent = active ? "Preparing signer" : "Ready when you are";
  idleMessage.textContent = active ? "Following the video automatically…" : "Press Start to translate this video.";
}

function updateQueueBadge() {
  queueBadge.hidden = queue.length === 0;
  queueBadge.textContent = queue.length ? `${queue.length} queued` : "";
}

function updateControls() {
  startButton.querySelector("span").textContent = started ? "Stop" : "Start";
  startButton.classList.toggle("stop", started);
  liveDot.classList.toggle("live", started);
  languageLabel.textContent = signedLanguage === "pks" ? "Pakistan (PSL)" : "Global (ASL)";
  for (const option of languageOptions) {
    const selected = option.dataset.language === signedLanguage;
    option.classList.toggle("active", selected);
    option.setAttribute("aria-pressed", String(selected));
  }
}

function buildEndpoint(text, spoken, signed) {
  const url = new URL("https://us-central1-sign-mt.cloudfunctions.net/spoken_text_to_signed_pose");
  url.searchParams.set("text", normalize(text));
  url.searchParams.set("spoken", spoken);
  url.searchParams.set("signed", signed);
  return url.toString();
}

async function prepareInput(job) {
  return { text: job.text, spokenLanguage: job.sourceLanguage || "en" };
}

function touchCache(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_CACHE) {
    const [oldestKey] = cache.entries().next().value;
    cache.delete(oldestKey);
  }
}

async function fetchPose(job) {
  const prepared = await prepareInput(job);
  const key = `${signedLanguage}|${prepared.spokenLanguage}|${prepared.text.toLocaleLowerCase()}`;
  if (cache.has(key)) {
    const value = cache.get(key);
    touchCache(key, value);
    return value;
  }

  const response = await fetch(buildEndpoint(prepared.text, prepared.spokenLanguage, signedLanguage), {
    method: "GET",
    cache: "force-cache",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) throw new Error(`Pose service returned ${response.status}`);
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/pose")) throw new Error("Pose service returned an unexpected format");

  const buffer = await response.arrayBuffer();
  const result = {
    buffer,
    glosses: response.headers.get("x-glosses") || "",
    translatedText: prepared.text,
    translatedFrom: prepared.translatedFrom,
  };
  touchCache(key, result);
  return result;
}

function effectivePlaybackRate() {
  return Math.min(1.8, Math.max(0.65, basePlaybackRate * (1 + queue.length * 0.12)));
}

async function playEntry(entry) {
  busy.hidden = false;
  setStatus("Generating sign pose");
  const result = await entry.promise;
  if (entry.generation !== generation || !started) {
    busy.hidden = true;
    return false;
  }

  idle.hidden = true;
  captionEl.textContent = entry.job.text;
  sourceBadge.textContent = entry.job.sourceLanguage.toUpperCase();
  glossEl.textContent = result.glosses ? `Gloss: ${result.glosses}` : "";
  postRenderer("renderer-pose", {
    buffer: result.buffer,
    playbackRate: effectivePlaybackRate(),
    appearance,
  });
  busy.hidden = true;
  setStatus("Signing video");
  return true;
}

async function pump() {
  if (!started || paused || current || !queue.length) return;
  const entry = queue.shift();
  updateQueueBadge();
  current = entry;
  try {
    const playing = await playEntry(entry);
    if (!playing) {
      current = null;
      pump();
    }
  } catch (error) {
    console.error("YTSign pose error", error);
    busy.hidden = true;
    setStatus(error?.message || "Translation failed");
    current = null;
    pump();
  }
}

function enqueue(job) {
  if (!started || !job.text) return;
  const duplicate = current?.job.text === job.text || queue.some((entry) => entry.job.text === job.text);
  if (duplicate) return;

  const entry = {
    id: ++requestSerial,
    generation,
    job,
    promise: null,
  };
  entry.promise = fetchPose(job);
  queue.push(entry);
  while (queue.length > MAX_QUEUE) {
    const dropped = queue.shift();
    dropped?.promise.catch(() => {});
  }
  updateQueueBadge();
  pump();
}

function clearQueue() {
  generation += 1;
  queue = [];
  current = null;
  updateQueueBadge();
  postRenderer("renderer-clear");
  busy.hidden = true;
  glossEl.textContent = "";
  if (started) setStatus("Waiting for the next caption");
}

function onRendererEnded() {
  current = null;
  setStatus(queue.length ? "Loading next phrase" : "Caught up · following the video");
  pump();
}

function onRendererFirst(message) {
  rendererFrame.dataset.duration = String(Number(message.duration) || 0);
  busy.hidden = true;
  setStatus("Signing video");
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.channel !== CHANNEL) return;

  if (event.source === rendererFrame.contentWindow) {
    if (message.type === "renderer-ended") onRendererEnded();
    if (message.type === "renderer-first") onRendererFirst(message);
    if (message.type === "renderer-ready") postRenderer("renderer-size");
    return;
  }
  if (event.source !== parent) return;

  if (message.type === "settings") {
    const next = message.settings || {};
    signedLanguage = next.signedLanguage === "pks" ? "pks" : "ase";
    appearance = "avatar";
    started = Boolean(next.enabled);
    sizeIndex = Math.max(0, sizes.indexOf(next.size || "medium"));
    latestCaption = normalize(message.caption || latestCaption);
    sourceLanguage = message.sourceLanguage || sourceLanguage;
    updateControls();
    setIdleState(started);
    if (!started) idle.hidden = false;
    postRenderer("renderer-mode", { appearance });
    if (started) setStatus("Preparing video translation");
    return;
  }
  if (message.type === "caption-preview") {
    latestCaption = normalize(message.text);
    sourceLanguage = message.sourceLanguage || "en";
    captionEl.textContent = latestCaption || "YouTube captions will appear here.";
    sourceBadge.textContent = sourceLanguage.toUpperCase();
    return;
  }
  if (message.type === "caption") {
    latestCaption = normalize(message.text);
    sourceLanguage = message.sourceLanguage || "en";
    captionEl.textContent = latestCaption;
    sourceBadge.textContent = sourceLanguage.toUpperCase();
    enqueue({
      text: latestCaption,
      sourceLanguage,
      sourceLabel: message.sourceLabel,
      videoTime: message.videoTime,
      videoId: message.videoId,
    });
    return;
  }
  if (message.type === "capture-status") setStatus(message.status);
  if (message.type === "clear") clearQueue();
  if (message.type === "video-pause") {
    paused = true;
    postRenderer("renderer-pause");
    setStatus("Video paused");
  }
  if (message.type === "video-play") {
    paused = false;
    basePlaybackRate = Number(message.playbackRate) || 1;
    if (current) postRenderer("renderer-play"); else pump();
  }
  if (message.type === "video-rate") {
    basePlaybackRate = Number(message.playbackRate) || 1;
    postRenderer("renderer-rate", { playbackRate: effectivePlaybackRate() });
  }
});

new ResizeObserver(() => postRenderer("renderer-size")).observe(rendererFrame);

startButton.addEventListener("click", async () => {
  if (started) {
    started = false;
    clearQueue();
    idle.hidden = false;
    setIdleState(false);
    setStatus("Stopped");
    post("stop");
  } else {
    let audioStreamId = "";
    try {
      // Capture permission is tied to a direct user gesture in Chromium. Arm
      // it from the same Start click so speech recognition can take over later
      // without presenting a second control or asking the user to intervene.
      if (globalThis.chrome?.tabCapture?.getMediaStreamId) {
        audioStreamId = await chrome.tabCapture.getMediaStreamId();
      }
    } catch (error) {
      console.warn("Automatic speech-recognition capture could not be armed", error);
    }
    started = true;
    idle.hidden = false;
    setIdleState(true);
    setStatus("Preparing video translation");
    post("start", { audioStreamId });
  }
  updateControls();
});

for (const option of languageOptions) {
  option.addEventListener("click", () => {
    signedLanguage = option.dataset.language === "pks" ? "pks" : "ase";
    clearQueue();
    updateControls();
    post("language", { signedLanguage });
  });
}

document.getElementById("minimizeButton").addEventListener("click", () => post("minimize"));
document.getElementById("closeButton").addEventListener("click", () => post("close"));
sizeButton.addEventListener("click", () => {
  sizeIndex = (sizeIndex + 1) % sizes.length;
  post("resize", { size: sizes[sizeIndex] });
});

let dragging = false;
dragHandle.addEventListener("pointerdown", (event) => {
  if (event.target.closest("[data-no-drag]")) return;
  dragging = true;
  dragHandle.setPointerCapture(event.pointerId);
  post("drag-start", { screenX: event.screenX, screenY: event.screenY });
});
dragHandle.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  post("drag-move", { screenX: event.screenX, screenY: event.screenY });
});
function stopDragging() {
  if (!dragging) return;
  dragging = false;
  post("drag-end");
}
dragHandle.addEventListener("pointerup", stopDragging);
dragHandle.addEventListener("pointercancel", stopDragging);

updateControls();
post("viewer-ready");
