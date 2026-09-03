import { env, pipeline } from "./vendor/transformers/transformers.min.js";

const MODEL_ID = "onnx-community/whisper-tiny";
let transcriberPromise = null;

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL("./vendor/transformers/", import.meta.url).href;
env.backends.onnx.wasm.numThreads = 1;

function progressMessage(item) {
  if (!item) return "Loading local speech model";
  const name = item.file ? item.file.split("/").pop() : "model";
  if (item.status === "progress" && Number.isFinite(item.progress)) {
    return `Speech model · ${name} · ${Math.round(item.progress)}%`;
  }
  if (item.status === "ready") return "Speech model ready";
  return `Speech model · ${item.status || "loading"}`;
}

async function createTranscriber(onProgress) {
  let previousProgress = "";
  const progress_callback = (item) => {
    const message = progressMessage(item);
    if (message === previousProgress) return;
    previousProgress = message;
    onProgress?.(message, item);
  };
  if ("gpu" in navigator) {
    try {
      onProgress?.("Loading speech recognition on WebGPU");
      return await pipeline("automatic-speech-recognition", MODEL_ID, {
        device: "webgpu",
        dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
        progress_callback,
      });
    } catch (error) {
      console.warn("WebGPU Whisper unavailable; using WASM", error);
      onProgress?.("Loading CPU speech recognition");
    }
  }
  return pipeline("automatic-speech-recognition", MODEL_ID, {
    device: "wasm",
    dtype: "q8",
    progress_callback,
  });
}

export async function getTranscriber(onProgress) {
  if (!transcriberPromise) transcriberPromise = createTranscriber(onProgress);
  try {
    return await transcriberPromise;
  } catch (error) {
    transcriberPromise = null;
    throw error;
  }
}

export async function transcribeAudio(audio, { onProgress, translateToEnglish = true } = {}) {
  const transcriber = await getTranscriber(onProgress);
  const result = await transcriber(audio, {
    task: translateToEnglish ? "translate" : "transcribe",
    chunk_length_s: 12,
    stride_length_s: 1,
  });
  return String(result?.text || "").replace(/\s+/gu, " ").trim();
}

export { MODEL_ID };
