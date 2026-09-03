import { getTranscriber, transcribeAudio } from "./asr-engine.js";

const SEGMENT_SECONDS = 8;
const MIN_SECONDS = 2.5;
const SILENCE_RMS = 0.003;

let stream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let silentGain = null;
let chunks = [];
let sampleCount = 0;
let processing = false;
let activeTabId = null;
let lastProgress = "";
let recognitionEnabled = false;
let recognitionGeneration = 0;
let recognitionRequested = false;

function post(type, payload = {}) {
  chrome.runtime.sendMessage({ target: "background", type, tabId: activeTabId, ...payload }).catch(() => {});
}

function postStatus(status, active = true) {
  if (status === lastProgress) return;
  lastProgress = status;
  post("asr-status", { status, active });
}

function flattenChunks() {
  const output = new Float32Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  chunks = [];
  sampleCount = 0;
  return output;
}

function rms(samples) {
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
  return Math.sqrt(sum / Math.max(1, samples.length));
}

async function processAudio() {
  if (processing || !audioContext || sampleCount < audioContext.sampleRate * MIN_SECONDS) return;
  processing = true;
  const samples = flattenChunks();
  try {
    if (rms(samples) < SILENCE_RMS) {
      postStatus("Listening for video speech");
      return;
    }
    postStatus("Recognizing video speech");
    const text = await transcribeAudio(samples, { translateToEnglish: true });
    if (!recognitionEnabled) return;
    if (text) {
      post("asr-transcript", {
        text,
        sourceLanguage: "en",
        sourceLabel: "AI",
        status: "Signing recognized video speech",
        active: true,
      });
    } else {
      postStatus("Listening for video speech");
    }
  } catch (error) {
    console.error("Local audio transcription failed", error);
    postStatus(`Speech recognition unavailable · ${error?.message || error}`, false);
  } finally {
    processing = false;
    if (recognitionEnabled && audioContext && sampleCount >= audioContext.sampleRate * MIN_SECONDS) processAudio();
  }
}

async function stopCapture(status = "Speech recognition stopped") {
  processorNode?.disconnect();
  sourceNode?.disconnect();
  silentGain?.disconnect();
  stream?.getTracks().forEach((track) => track.stop());
  if (audioContext && audioContext.state !== "closed") await audioContext.close();
  stream = null;
  audioContext = null;
  sourceNode = null;
  processorNode = null;
  silentGain = null;
  chunks = [];
  sampleCount = 0;
  processing = false;
  recognitionEnabled = false;
  recognitionGeneration += 1;
  postStatus(status, false);
}

async function startCapture(message) {
  await stopCapture("Switching audio capture");
  activeTabId = message.tabId;
  lastProgress = "";
  postStatus("Preparing video speech recognition");
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: message.streamId,
      },
    },
    video: false,
  });
  stream.getAudioTracks()[0]?.addEventListener("ended", () => stopCapture("Tab audio capture ended"));

  audioContext = new AudioContext({ sampleRate: 16_000 });
  sourceNode = audioContext.createMediaStreamSource(stream);
  sourceNode.connect(audioContext.destination);

  postStatus("Checking for transcript or speech data");
  if (recognitionRequested) await enableRecognition();
}

async function enableRecognition() {
  if (!audioContext || recognitionEnabled) return;
  recognitionEnabled = true;
  const generation = ++recognitionGeneration;

  postStatus("Preparing speech recognition · first use may take a minute");
  await getTranscriber((status) => postStatus(status));

  if (!audioContext || !recognitionEnabled || generation !== recognitionGeneration) return;

  processorNode = audioContext.createScriptProcessor(4096, 1, 1);
  silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  sourceNode.connect(processorNode);
  processorNode.connect(silentGain);
  silentGain.connect(audioContext.destination);
  processorNode.onaudioprocess = (event) => {
    const copy = new Float32Array(event.inputBuffer.getChannelData(0));
    chunks.push(copy);
    sampleCount += copy.length;
    if (sampleCount >= audioContext.sampleRate * SEGMENT_SECONDS) processAudio();
  };
  await audioContext.resume();
  postStatus("Listening for video speech");
}

function disableRecognition() {
  recognitionEnabled = false;
  recognitionGeneration += 1;
  processorNode?.disconnect();
  silentGain?.disconnect();
  processorNode = null;
  silentGain = null;
  chunks = [];
  sampleCount = 0;
  processing = false;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== "offscreen") return;
  if (message.type === "asr-start") {
    recognitionRequested = !message.standby;
    startCapture(message).catch((error) => {
      console.error("Could not start tab audio capture", error);
      postStatus(`Could not start speech recognition · ${error?.message || error}`, false);
    });
  }
  if (message.type === "asr-enable" && (!message.tabId || message.tabId === activeTabId)) {
    recognitionRequested = true;
    enableRecognition().catch((error) => {
      console.error("Could not enable speech recognition", error);
      postStatus(`Could not recognize video speech · ${error?.message || error}`, false);
    });
  }
  if (message.type === "asr-enable" && message.tabId && message.tabId !== activeTabId) recognitionRequested = true;
  if (message.type === "asr-disable" && (!message.tabId || message.tabId === activeTabId)) {
    recognitionRequested = false;
    disableRecognition();
  }
  if (message.type === "asr-stop") {
    recognitionRequested = false;
    stopCapture();
  }
});
