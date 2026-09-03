import { normalizeLanguageCode, normalizeWhitespace } from "./core.mjs";

function findJsonEnd(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

export function extractInitialPlayerResponse(html) {
  const source = String(html || "");
  const patterns = [
    /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/gu,
    /window\[\s*["']ytInitialPlayerResponse["']\s*\]\s*=\s*/gu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match) continue;
    const start = source.indexOf("{", match.index + match[0].length);
    if (start < 0) continue;
    const end = findJsonEnd(source, start);
    if (end < 0) continue;
    try {
      return JSON.parse(source.slice(start, end));
    } catch {}
  }
  return null;
}

function trackName(track) {
  return normalizeWhitespace(
    track?.name?.simpleText ||
    track?.name?.runs?.map((run) => run.text || "").join("") ||
    track?.languageCode ||
    "",
  );
}

export function selectCaptionTrack(playerResponse) {
  const renderer = playerResponse?.captions?.playerCaptionsTracklistRenderer;
  const tracks = Array.isArray(renderer?.captionTracks) ? renderer.captionTracks : [];
  if (!tracks.length) return null;

  const audioTracks = Array.isArray(renderer.audioTracks) ? renderer.audioTracks : [];
  const defaultAudioIndex = Number.isInteger(renderer.defaultAudioTrackIndex)
    ? renderer.defaultAudioTrackIndex
    : 0;
  const audioTrack = audioTracks[defaultAudioIndex] || audioTracks[0];
  const preferredIndexes = Array.isArray(audioTrack?.captionTrackIndices)
    ? audioTrack.captionTrackIndices.filter((index) => Number.isInteger(index) && tracks[index])
    : [];
  if (Number.isInteger(audioTrack?.defaultCaptionTrackIndex) && tracks[audioTrack.defaultCaptionTrackIndex]) {
    preferredIndexes.unshift(audioTrack.defaultCaptionTrackIndex);
  }

  const candidates = [...new Set(preferredIndexes)].map((index) => tracks[index]);
  const pool = candidates.length ? candidates : tracks;
  const track = pool.find((candidate) => candidate.kind !== "asr") || pool[0];
  if (!track?.baseUrl) return null;
  return {
    baseUrl: track.baseUrl,
    languageCode: normalizeLanguageCode(track.languageCode || "en"),
    name: trackName(track),
    automatic: track.kind === "asr",
    translatable: Boolean(track.isTranslatable),
  };
}

export function parseJson3Transcript(payload) {
  if (typeof payload === "string" && !payload.trim()) return [];
  let data;
  try {
    data = typeof payload === "string" ? JSON.parse(payload) : payload;
  } catch {
    return [];
  }
  const events = Array.isArray(data?.events) ? data.events : [];
  const entries = [];
  for (const event of events) {
    if (!Array.isArray(event?.segs) || !Number.isFinite(event.tStartMs)) continue;
    const text = normalizeWhitespace(event.segs.map((segment) => segment?.utf8 || "").join(""));
    if (!text || text === "[Music]" || text === "[Applause]") continue;
    const startMs = Math.max(0, Number(event.tStartMs));
    const durationMs = Math.max(250, Number(event.dDurationMs) || 3_000);
    const previous = entries.at(-1);
    if (previous && previous.startMs === startMs && previous.text === text) continue;
    entries.push({ startMs, durationMs, endMs: startMs + durationMs, text });
  }
  return entries;
}

export function findTranscriptEntryIndex(entries, timeMs) {
  if (!Array.isArray(entries) || !entries.length || !Number.isFinite(timeMs)) return -1;
  let low = 0;
  let high = entries.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (entries[middle].startMs <= timeMs + 120) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidate < 0) return -1;
  const entry = entries[candidate];
  return timeMs <= entry.endMs + 450 ? candidate : -1;
}

export function transcriptTrackUrl(baseUrl) {
  const url = new URL(baseUrl, "https://www.youtube.com");
  url.searchParams.set("fmt", "json3");
  return url.toString();
}
