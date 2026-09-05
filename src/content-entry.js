import {
  DEFAULT_SETTINGS,
  isYouTubeWatchUrl,
  captionDelta,
  detectSpokenLanguage,
  normalizeWhitespace,
  settingSize,
  splitCaption,
} from "./core.mjs";
import {
  extractInitialPlayerResponse,
  findTranscriptEntryIndex,
  parseJson3Transcript,
  selectCaptionTrack,
  transcriptTrackUrl,
} from "./transcript.mjs";
import { overlayLayout } from "./overlay-layout.mjs";

const CHANNEL = "youtube-sign-live-v1";
const ROOT_ID = "youtube-sign-live-root";
const TOGGLE_ID = "youtube-sign-live-toggle";
const INTERNAL_CAPTION_STYLE_ID = "youtube-sign-live-internal-captions";

let settings = { ...DEFAULT_SETTINGS };
let root;
let iframe;
let toggle;
let captionObserver;
let captionTimer;
let retryTimer;
let noCaptionTimer;
let video;
let playerElement;
let playerResizeObserver;
let videoHandlers = [];
let started = false;
let lastObservedCaption = "";
let lastSubmittedCaption = "";
let lastAudioTranscript = "";
let lastCaptionAt = 0;
let currentCaption = "";
let currentLanguage = "en";
let navigationUrl = location.href;
let dragState = null;
let manuallyPositioned = false;
let captureGeneration = 0;
let captureSource = "none";
let transcriptEntries = [];
let transcriptTrack = null;
let transcriptIndex = -1;
let transcriptTimer = null;
let captureStatus = "Ready when you are";
let currentSourceLabel = "";
let automaticAudioArmed = false;
let automaticAudioEnabled = false;
let captionsEnabledInternally = false;
let captionButton = null;
let captionButtonHandler = null;

function postToViewer(type, payload = {}) {
  if (!iframe?.contentWindow) return;
  iframe.contentWindow.postMessage({ channel: CHANNEL, type, ...payload }, "*");
}

function setCaptureStatus(status) {
  captureStatus = status;
  postToViewer("capture-status", { status });
}

async function armAutomaticAudio(streamId) {
  if (!streamId) return false;
  try {
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "asr-start",
      streamId,
      standby: true,
    });
    automaticAudioArmed = Boolean(response?.ok);
    automaticAudioEnabled = false;
    if (automaticAudioArmed && started && captureSource === "captions" && !lastCaptionAt) {
      void setAutomaticAudioEnabled(true);
    }
    return automaticAudioArmed;
  } catch (error) {
    console.warn("Could not arm automatic speech recognition", error);
    return false;
  }
}

async function syncAutomaticAudioState() {
  try {
    const response = await chrome.runtime.sendMessage({ target: "background", type: "asr-query" });
    automaticAudioArmed = Boolean(response?.active);
    if (automaticAudioArmed && started && captureSource === "captions" && !lastCaptionAt) {
      void setAutomaticAudioEnabled(true);
    }
    return automaticAudioArmed;
  } catch {
    automaticAudioArmed = false;
    return false;
  }
}

async function setAutomaticAudioEnabled(enabled) {
  if (!automaticAudioArmed || automaticAudioEnabled === enabled) return;
  automaticAudioEnabled = enabled;
  try {
    await chrome.runtime.sendMessage({
      target: "background",
      type: enabled ? "asr-enable" : "asr-disable",
    });
  } catch (error) {
    automaticAudioEnabled = false;
    console.warn("Could not change automatic speech recognition", error);
  }
}

function stopAutomaticAudio() {
  if (!automaticAudioArmed) return;
  chrome.runtime.sendMessage({ target: "background", type: "asr-stop" }).catch(() => {});
  automaticAudioArmed = false;
  automaticAudioEnabled = false;
}

function removeInternalCaptionStyle() {
  document.getElementById(INTERNAL_CAPTION_STYLE_ID)?.remove();
}

function enableCaptionDataSilently() {
  const button = document.querySelector(".ytp-subtitles-button");
  if (!button) return false;
  if (button.getAttribute("aria-pressed") === "true") return true;

  let style = document.getElementById(INTERNAL_CAPTION_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = INTERNAL_CAPTION_STYLE_ID;
    style.textContent = ".ytp-caption-window-container{opacity:0!important;pointer-events:none!important}";
    (document.head || document.documentElement).appendChild(style);
  }
  if (captionButton && captionButtonHandler) captionButton.removeEventListener("click", captionButtonHandler, true);
  captionButton = button;
  captionButtonHandler = (event) => {
    if (!event.isTrusted || !captionsEnabledInternally) return;
    captionsEnabledInternally = false;
    removeInternalCaptionStyle();
  };
  captionButton.addEventListener("click", captionButtonHandler, true);
  captionsEnabledInternally = true;
  button.click();
  return true;
}

function restoreCaptionState() {
  if (captionButton && captionButtonHandler) captionButton.removeEventListener("click", captionButtonHandler, true);
  if (captionsEnabledInternally && captionButton?.isConnected && captionButton.getAttribute("aria-pressed") === "true") {
    captionButton.click();
  }
  captionButton = null;
  captionButtonHandler = null;
  captionsEnabledInternally = false;
  removeInternalCaptionStyle();
}

function createOverlay() {
  const existing = document.getElementById(ROOT_ID);
  if (existing) {
    root = existing;
    iframe = existing.querySelector('iframe[title="YouTube sign-language translator"]');
    toggle = document.getElementById(TOGGLE_ID);
    return;
  }

  root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("data-youtube-sign-live", "true");
  Object.assign(root.style, {
    position: "fixed",
    right: "18px",
    bottom: "78px",
    zIndex: "2147483646",
    width: `${settingSize(settings.size).width}px`,
    height: `${settingSize(settings.size).height}px`,
    borderRadius: "22px",
    overflow: "hidden",
    boxShadow: "0 18px 40px rgba(0,0,0,.42)",
    transition: "opacity 160ms ease",
  });

  iframe = document.createElement("iframe");
  iframe.title = "YouTube sign-language translator";
  iframe.src = chrome.runtime.getURL("viewer.html");
  iframe.allow = "language-detector";
  Object.assign(iframe.style, {
    border: "0",
    width: "100%",
    height: "100%",
    display: "block",
    background: "transparent",
  });
  root.appendChild(iframe);

  toggle = document.createElement("button");
  toggle.id = TOGGLE_ID;
  toggle.type = "button";
  toggle.title = "Show sign-language translator";
  toggle.textContent = "🤟";
  Object.assign(toggle.style, {
    position: "fixed",
    right: "20px",
    bottom: "84px",
    zIndex: "2147483647",
    width: "48px",
    height: "48px",
    border: "1px solid rgba(255,255,255,.24)",
    borderRadius: "16px",
    background: "linear-gradient(145deg,#6d5dfc,#34d7b2)",
    boxShadow: "0 12px 28px rgba(0,0,0,.4)",
    color: "white",
    fontSize: "23px",
    cursor: "pointer",
    display: "none",
  });
  toggle.addEventListener("click", showOverlay);

  const target = document.fullscreenElement || document.body || document.documentElement;
  target.append(root, toggle);
}

function showOverlay() {
  if (!isYouTubeWatchUrl(location.href)) return;
  root.style.display = "block";
  toggle.style.display = "none";
  positionOverPlayer();
  postToViewer("visibility", { visible: true });
}

function hideOverlay() {
  root.style.display = "none";
  toggle.style.display = "block";
  postToViewer("visibility", { visible: false });
}

function applySize(size, persist = true) {
  settings.size = size;
  if (!positionOverPlayer()) {
    const preset = settingSize(size);
    root.style.width = `${Math.max(1, Math.min(preset.width, innerWidth - 28))}px`;
    root.style.height = `${Math.max(1, Math.min(preset.height, innerHeight - 28))}px`;
  }
  if (persist) chrome.storage.local.set({ youtubeSignSettings: settings });
}

function positionOverPlayer() {
  if (!root || !toggle || !playerElement) return false;
  const rect = playerElement.getBoundingClientRect();
  const current = root.getBoundingClientRect();
  const layout = overlayLayout({
    player: rect,
    viewport: { width: innerWidth, height: innerHeight },
    preset: settingSize(settings.size),
    position: manuallyPositioned ? {
      left: Number.parseFloat(root.style.left) || current.left,
      top: Number.parseFloat(root.style.top) || current.top,
    } : null,
  });
  if (!layout) return false;
  // Calculate the anchor from the fitted target size, never offsetWidth from
  // a previous size or a hidden/minimized overlay.
  root.style.width = `${layout.width}px`;
  root.style.height = `${layout.height}px`;
  root.style.left = `${layout.left}px`;
  root.style.top = `${layout.top}px`;
  root.style.right = "auto";
  root.style.bottom = "auto";

  toggle.style.left = `${layout.toggleLeft}px`;
  toggle.style.top = `${layout.toggleTop}px`;
  toggle.style.right = "auto";
  toggle.style.bottom = "auto";
  return true;
}

function beginDrag(message) {
  const rect = root.getBoundingClientRect();
  dragState = {
    startScreenX: message.screenX,
    startScreenY: message.screenY,
    left: rect.left,
    top: rect.top,
  };
  manuallyPositioned = true;
  root.style.right = "auto";
  root.style.bottom = "auto";
}

function moveDrag(message) {
  if (!dragState) return;
  const maxLeft = Math.max(0, innerWidth - root.offsetWidth);
  const maxTop = Math.max(0, innerHeight - root.offsetHeight);
  const left = Math.min(maxLeft, Math.max(0, dragState.left + message.screenX - dragState.startScreenX));
  const top = Math.min(maxTop, Math.max(0, dragState.top + message.screenY - dragState.startScreenY));
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
}

function endDrag() {
  dragState = null;
}

function onViewerMessage(event) {
  if (!iframe || event.source !== iframe.contentWindow || event.data?.channel !== CHANNEL) return;
  const message = event.data;

  if (message.type === "viewer-ready") {
    postToViewer("settings", { settings, caption: currentCaption, sourceLanguage: currentLanguage });
    setCaptureStatus(captureStatus);
    if (started && currentCaption) {
      const sourceLabel = currentSourceLabel || (captureSource === "transcript" ? "TR" : "CC");
      postToViewer("caption-preview", {
        text: currentCaption,
        sourceLanguage: currentLanguage,
        sourceLabel,
      });
      submitCaption(currentCaption, true, { sourceLanguage: currentLanguage, sourceLabel });
    }
    return;
  }
  if (message.type === "start") {
    started = true;
    settings.enabled = true;
    chrome.storage.local.set({ youtubeSignSettings: settings });
    if (message.audioStreamId) void armAutomaticAudio(message.audioStreamId);
    void startCaptionCapture();
    if (currentCaption) submitCaption(currentCaption, true);
    return;
  }
  if (message.type === "stop") {
    started = false;
    settings.enabled = false;
    chrome.storage.local.set({ youtubeSignSettings: settings });
    stopCaptureFlow();
    stopAutomaticAudio();
    captureStatus = "Stopped";
    return;
  }
  if (message.type === "language") {
    settings.signedLanguage = message.signedLanguage === "pks" ? "pks" : "ase";
    chrome.storage.local.set({ youtubeSignSettings: settings });
    postToViewer("clear");
    if (started && currentCaption) submitCaption(currentCaption, true);
    return;
  }
  if (message.type === "minimize" || message.type === "close") {
    hideOverlay();
    return;
  }
  if (message.type === "resize") {
    applySize(message.size);
    return;
  }
  if (message.type === "drag-start") beginDrag(message);
  if (message.type === "drag-move") moveDrag(message);
  if (message.type === "drag-end") endDrag();
}

function readCaptionText() {
  const nodes = document.querySelectorAll(".ytp-caption-segment");
  if (!nodes.length) return "";
  return normalizeWhitespace(Array.from(nodes, (node) => node.textContent || "").join(" "));
}

function submitCaption(rawCaption, force = false, metadata = {}) {
  const caption = normalizeWhitespace(rawCaption);
  if (!caption || (!started && !force)) return;

  const delta = force ? caption : captionDelta(lastSubmittedCaption, caption);
  if (!delta) return;
  lastSubmittedCaption = caption;

  const sourceLanguage = metadata.sourceLanguage || detectSpokenLanguage(delta, currentLanguage);
  currentLanguage = sourceLanguage;
  if (metadata.sourceLabel) currentSourceLabel = metadata.sourceLabel;
  for (const chunk of splitCaption(delta)) {
    if (chunk.length < 2) continue;
    postToViewer("caption", {
      text: chunk,
      sourceLanguage,
      sourceLabel: metadata.sourceLabel,
      videoTime: video?.currentTime || 0,
      videoId: new URL(location.href).searchParams.get("v") || "",
    });
  }
}

function flushCaption() {
  if (captureSource === "transcript") return;
  const caption = readCaptionText();
  if (!caption || caption === lastObservedCaption) return;
  lastObservedCaption = caption;
  lastCaptionAt = Date.now();
  currentCaption = caption;
  currentLanguage = detectSpokenLanguage(caption, currentLanguage);
  currentSourceLabel = "CC";
  void setAutomaticAudioEnabled(false);
  postToViewer("caption-preview", { text: caption, sourceLanguage: currentLanguage });
  captureSource = "captions";
  submitCaption(caption, false, { sourceLabel: "CC" });
}

function scheduleCaptionFlush() {
  clearTimeout(captionTimer);
  captionTimer = setTimeout(flushCaption, 620);
}

function removeVideoHandlers() {
  for (const [element, event, handler] of videoHandlers) element.removeEventListener(event, handler);
  videoHandlers = [];
}

function addVideoHandler(element, event, handler) {
  element.addEventListener(event, handler);
  videoHandlers.push([element, event, handler]);
}

function attachVideo() {
  const nextVideo = document.querySelector("#movie_player video") || document.querySelector("video");
  if (!nextVideo || nextVideo === video) return;
  removeVideoHandlers();
  video = nextVideo;
  addVideoHandler(video, "pause", () => postToViewer("video-pause"));
  addVideoHandler(video, "play", () => {
    postToViewer("video-play", { playbackRate: video.playbackRate });
    syncTranscriptToVideo(true);
  });
  addVideoHandler(video, "ratechange", () => postToViewer("video-rate", { playbackRate: video.playbackRate }));
  addVideoHandler(video, "seeking", () => {
    lastSubmittedCaption = "";
    lastObservedCaption = "";
    postToViewer("clear");
    transcriptIndex = -1;
    setTimeout(() => syncTranscriptToVideo(true), 80);
  });
  addVideoHandler(video, "loadedmetadata", () => syncTranscriptToVideo(true));
}

function connectCaptionObserver() {
  const player = document.querySelector("#movie_player");
  if (!player) return false;
  captionObserver?.disconnect();
  playerResizeObserver?.disconnect();
  playerElement = player;
  playerResizeObserver = new ResizeObserver(() => {
    positionOverPlayer();
  });
  playerResizeObserver.observe(player);
  captionObserver = new MutationObserver(() => {
    attachVideo();
    scheduleCaptionFlush();
  });
  captionObserver.observe(player, { childList: true, subtree: true, characterData: true });
  attachVideo();
  positionOverPlayer();
  return true;
}

async function waitForPlayer(generation) {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (generation !== captureGeneration || !started) return false;
    if (connectCaptionObserver()) {
      attachVideo();
      if (video) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(900, 180 + attempt * 35)));
  }
  return false;
}

async function loadTranscript(generation) {
  const videoId = new URL(location.href).searchParams.get("v") || "";
  if (!videoId) return false;
  let playerResponse = null;
  for (let attempt = 0; attempt < 3 && !playerResponse; attempt += 1) {
    if (generation !== captureGeneration || !started) return false;
    const watchUrl = new URL("/watch", location.origin);
    watchUrl.searchParams.set("v", videoId);
    watchUrl.searchParams.set("hl", "en");
    const response = await fetch(watchUrl, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`YouTube transcript page returned ${response.status}`);
    playerResponse = extractInitialPlayerResponse(await response.text());
    if (!playerResponse) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const track = selectCaptionTrack(playerResponse);
  if (!track || generation !== captureGeneration) return false;
  const response = await fetch(transcriptTrackUrl(track.baseUrl), {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`YouTube transcript returned ${response.status}`);
  const entries = parseJson3Transcript(await response.text());
  if (!entries.length || generation !== captureGeneration) return false;

  transcriptEntries = entries;
  transcriptTrack = track;
  transcriptIndex = -1;
  captureSource = "transcript";
  void setAutomaticAudioEnabled(false);
  currentLanguage = track.languageCode;
  clearInterval(transcriptTimer);
  transcriptTimer = setInterval(syncTranscriptToVideo, 180);
  setCaptureStatus("Translation ready");
  syncTranscriptToVideo(true);
  return true;
}

function syncTranscriptToVideo(force = false) {
  if (!started || captureSource !== "transcript" || !video || !transcriptEntries.length) return;
  const index = findTranscriptEntryIndex(transcriptEntries, video.currentTime * 1000);
  if (index < 0 || (!force && index === transcriptIndex)) return;
  transcriptIndex = index;
  const entry = transcriptEntries[index];
  const sourceLabel = transcriptTrack.automatic ? "AUTO" : "TR";
  currentCaption = entry.text;
  currentLanguage = transcriptTrack.languageCode;
  currentSourceLabel = sourceLabel;
  lastCaptionAt = Date.now();
  postToViewer("caption-preview", {
    text: entry.text,
    sourceLanguage: currentLanguage,
    sourceLabel,
  });
  submitCaption(entry.text, true, {
    sourceLanguage: currentLanguage,
    sourceLabel,
  });
}

async function startCaptionCapture() {
  if (!started || !isYouTubeWatchUrl(location.href)) return;
  const generation = ++captureGeneration;
  createOverlay();
  clearTimeout(noCaptionTimer);
  clearInterval(transcriptTimer);
  transcriptEntries = [];
  transcriptTrack = null;
  transcriptIndex = -1;
  captureSource = "loading";
  setCaptureStatus("Preparing video translation");
  void syncAutomaticAudioState();

  const playerReady = await waitForPlayer(generation);
  if (!playerReady || generation !== captureGeneration) {
    if (started && generation === captureGeneration) {
      captureSource = "none";
      setCaptureStatus("Waiting for the YouTube player · retrying automatically");
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => startCaptionCapture(), 1_200);
    }
    return;
  }

  try {
    if (await loadTranscript(generation)) return;
  } catch (error) {
    console.warn("YouTube transcript unavailable", error);
  }
  if (generation !== captureGeneration || !started) return;
  captureSource = "captions";
  enableCaptionDataSilently();
  setCaptureStatus("Listening for video speech");
  scheduleTranscriptRetry(generation);
  noCaptionTimer = setTimeout(() => {
    if (started && captureSource === "captions" && !lastCaptionAt) {
      if (automaticAudioArmed) {
        setCaptureStatus("Listening for video speech");
        void setAutomaticAudioEnabled(true);
      } else {
        setCaptureStatus("Open the extension once to enable this video");
      }
    }
  }, 1_200);
}

function scheduleTranscriptRetry(generation, delay = 2_500) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    if (!started || generation !== captureGeneration || captureSource === "transcript") return;
    try {
      if (await loadTranscript(generation)) return;
    } catch (error) {
      console.warn("YouTube transcript retry unavailable", error);
    }
    if (started && generation === captureGeneration && captureSource !== "transcript") {
      scheduleTranscriptRetry(generation, Math.min(12_000, Math.round(delay * 1.6)));
    }
  }, delay);
}

function stopCaptureFlow() {
  captureGeneration += 1;
  clearTimeout(captionTimer);
  clearTimeout(retryTimer);
  clearTimeout(noCaptionTimer);
  clearInterval(transcriptTimer);
  captionObserver?.disconnect();
  captionObserver = null;
  captureSource = "none";
  transcriptEntries = [];
  transcriptTrack = null;
  transcriptIndex = -1;
  restoreCaptionState();
}

function resetForNavigation() {
  restoreCaptionState();
  clearTimeout(captionTimer);
  clearTimeout(retryTimer);
  clearTimeout(noCaptionTimer);
  clearInterval(transcriptTimer);
  captureGeneration += 1;
  captionObserver?.disconnect();
  playerResizeObserver?.disconnect();
  captionObserver = null;
  playerResizeObserver = null;
  playerElement = null;
  removeVideoHandlers();
  video = null;
  lastObservedCaption = "";
  lastSubmittedCaption = "";
  lastAudioTranscript = "";
  lastCaptionAt = 0;
  currentCaption = "";
  currentLanguage = "en";
  currentSourceLabel = "";
  captureSource = "none";
  transcriptEntries = [];
  transcriptTrack = null;
  transcriptIndex = -1;
  manuallyPositioned = false;
  postToViewer("clear");
  if (!isYouTubeWatchUrl(location.href)) {
    if (root) root.style.display = "none";
    if (toggle) toggle.style.display = "none";
    void setAutomaticAudioEnabled(false);
    return;
  }
  createOverlay();
  root.style.display = "block";
  toggle.style.display = "none";
  applySize(settings.size, false);
  postToViewer("settings", { settings, caption: "", sourceLanguage: "en" });
  if (started) setTimeout(() => startCaptionCapture(), 450);
}

function checkNavigation() {
  if (location.href === navigationUrl) return;
  navigationUrl = location.href;
  resetForNavigation();
}

function moveIntoFullscreen() {
  const target = document.fullscreenElement || document.body;
  if (!target || !root || !toggle) return;
  target.append(root, toggle);
  manuallyPositioned = false;
  requestAnimationFrame(positionOverPlayer);
}

window.addEventListener("message", onViewerMessage);
document.addEventListener("fullscreenchange", moveIntoFullscreen);
document.addEventListener("yt-navigate-finish", checkNavigation);
window.addEventListener("popstate", checkNavigation);
window.addEventListener("resize", () => {
  positionOverPlayer();
});
window.addEventListener("scroll", () => {
  if (!manuallyPositioned) positionOverPlayer();
}, { passive: true });
setInterval(checkNavigation, 900);

chrome.storage.local.get("youtubeSignSettings", (stored) => {
  const savedSettings = stored.youtubeSignSettings || {};
  settings = savedSettings.settingsVersion === DEFAULT_SETTINGS.settingsVersion
    ? { ...DEFAULT_SETTINGS, ...savedSettings }
    : { ...DEFAULT_SETTINGS, ...savedSettings, signedLanguage: "pks", enabled: false, settingsVersion: DEFAULT_SETTINGS.settingsVersion };
  if (savedSettings.settingsVersion !== DEFAULT_SETTINGS.settingsVersion) {
    chrome.storage.local.set({ youtubeSignSettings: settings });
  }
  started = Boolean(settings.enabled);
  if (isYouTubeWatchUrl(location.href)) {
    createOverlay();
    applySize(settings.size, false);
  }
  postToViewer("settings", { settings, caption: currentCaption, sourceLanguage: currentLanguage });
  if (started) void startCaptionCapture();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.youtubeSignSettings?.newValue) return;
  const wasStarted = started;
  settings = { ...settings, ...changes.youtubeSignSettings.newValue };
  started = Boolean(settings.enabled);
  if (root) applySize(settings.size, false);
  postToViewer("settings", { settings, caption: currentCaption, sourceLanguage: currentLanguage });
  if (started && !wasStarted) void startCaptionCapture();
  if (!started && wasStarted) stopCaptureFlow();
});

chrome.runtime.onMessage.addListener((message) => {
  if (!started || !isYouTubeWatchUrl(location.href)) return;
  if (message?.type === "asr-status") {
    setCaptureStatus(message.status);
    return;
  }
  if (message?.type !== "asr-transcript") return;
  if (captureSource === "transcript" || Date.now() - lastCaptionAt < 8_000) {
    if (captureSource === "transcript") void setAutomaticAudioEnabled(false);
    return;
  }

  const text = normalizeWhitespace(message.text);
  const delta = captionDelta(lastAudioTranscript, text);
  lastAudioTranscript = text;
  if (!delta) return;
  currentCaption = text;
  currentLanguage = "en";
  currentSourceLabel = "AI";
  postToViewer("caption-preview", { text, sourceLanguage: "en", sourceLabel: "AI" });
  for (const chunk of splitCaption(delta)) {
    if (chunk.length < 2) continue;
    postToViewer("caption", {
      text: chunk,
      sourceLanguage: "en",
      sourceLabel: "AI",
      videoTime: video?.currentTime || 0,
      videoId: new URL(location.href).searchParams.get("v") || "",
    });
  }
});
