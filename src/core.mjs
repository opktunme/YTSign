export const DEFAULT_SETTINGS = Object.freeze({
  signedLanguage: "pks",
  enabled: false,
  size: "medium",
  appearance: "avatar",
  settingsVersion: 5,
});

export const SIZE_PRESETS = Object.freeze({
  small: { width: 320, height: 420 },
  medium: { width: 380, height: 480 },
  large: { width: 460, height: 560 },
});

export function normalizeWhitespace(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function normalizeLanguageCode(code) {
  const base = normalizeWhitespace(code).toLowerCase().split(/[-_]/u)[0];
  const aliases = {
    "en-us": "en",
    "en-gb": "en",
    hindi: "hi",
    urdu: "ur",
  };
  return aliases[base] || base || "en";
}

export function detectSpokenLanguage(text, hint = "") {
  const normalizedHint = normalizeLanguageCode(hint);
  const value = normalizeWhitespace(text);

  if (/\p{Script=Devanagari}/u.test(value)) return "hi";
  if (/\p{Script=Arabic}/u.test(value)) {
    return ["ur", "ar", "fa", "ps", "sd"].includes(normalizedHint)
      ? normalizedHint
      : "ur";
  }
  if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(value)) {
    return normalizedHint === "ja" ? "ja" : "zh";
  }
  if (/[A-Za-z]/u.test(value)) return "en";
  return normalizedHint && normalizedHint !== "und" ? normalizedHint : "en";
}

export function dedupeDoubledCaption(value) {
  const text = normalizeWhitespace(value);
  if (text.length < 18) return text;

  const compact = (part) => part.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  const middle = Math.floor(text.length / 2);
  for (let split = Math.max(8, middle - 14); split <= Math.min(text.length - 8, middle + 14); split += 1) {
    if (compact(text.slice(0, split)) === compact(text.slice(split))) {
      return normalizeWhitespace(text.slice(split));
    }
  }
  return text;
}

function comparableWord(value) {
  return String(value).toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

export function captionDelta(previous, current) {
  const prev = normalizeWhitespace(previous);
  const next = dedupeDoubledCaption(current);
  if (!next || next === prev) return "";
  if (!prev) return next;

  const prevWords = prev.split(" ");
  const nextWords = next.split(" ");
  const maxOverlap = Math.min(prevWords.length, nextWords.length);

  for (let count = maxOverlap; count > 0; count -= 1) {
    const prevTail = prevWords.slice(-count).map(comparableWord).join(" ");
    const nextHead = nextWords.slice(0, count).map(comparableWord).join(" ");
    if (prevTail && prevTail === nextHead) {
      return normalizeWhitespace(nextWords.slice(count).join(" "));
    }
  }

  if (next.toLocaleLowerCase().startsWith(prev.toLocaleLowerCase())) {
    return normalizeWhitespace(next.slice(prev.length));
  }
  return next;
}

export function splitCaption(value, maxWords = 14) {
  const text = normalizeWhitespace(value);
  if (!text) return [];

  const words = text.split(" ");
  const chunks = [];
  let current = [];

  for (const word of words) {
    current.push(word);
    const boundary = /[.!?\u061F\u06D4]$/u.test(word);
    if (current.length >= maxWords || (boundary && current.length >= 3)) {
      chunks.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) chunks.push(current.join(" "));
  return chunks;
}

export function poseEndpoint({ text, spokenLanguage, signedLanguage }) {
  const url = new URL("https://us-central1-sign-mt.cloudfunctions.net/spoken_text_to_signed_pose");
  url.searchParams.set("text", normalizeWhitespace(text));
  url.searchParams.set("spoken", normalizeLanguageCode(spokenLanguage));
  url.searchParams.set("signed", signedLanguage === "pks" ? "pks" : "ase");
  return url.toString();
}

export function settingSize(size) {
  return SIZE_PRESETS[size] || SIZE_PRESETS.medium;
}
export function isYouTubeWatchUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["www.youtube.com", "youtube.com"].includes(url.hostname) &&
      url.pathname === "/watch" && Boolean(url.searchParams.get("v"));
  } catch { return false; }
}
