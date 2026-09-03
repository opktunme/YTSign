import test from "node:test";
import assert from "node:assert/strict";
import {
  extractInitialPlayerResponse,
  findTranscriptEntryIndex,
  parseJson3Transcript,
  selectCaptionTrack,
  transcriptTrackUrl,
} from "../src/transcript.mjs";

test("extracts a balanced player response containing braces inside strings", () => {
  const html = '<script>var ytInitialPlayerResponse = {"videoDetails":{"title":"A {useful} video"},"captions":{}};</script>';
  assert.equal(extractInitialPlayerResponse(html).videoDetails.title, "A {useful} video");
});

test("selects the default audio track and prefers human-authored captions", () => {
  const response = {
    captions: { playerCaptionsTracklistRenderer: {
      defaultAudioTrackIndex: 0,
      audioTracks: [{ captionTrackIndices: [0, 1] }],
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?a=1", languageCode: "ur", kind: "asr", name: { simpleText: "Urdu auto" } },
        { baseUrl: "https://www.youtube.com/api/timedtext?a=2", languageCode: "ur", name: { simpleText: "Urdu" } },
        { baseUrl: "https://www.youtube.com/api/timedtext?a=3", languageCode: "en", name: { simpleText: "English" } },
      ],
    } },
  };
  const track = selectCaptionTrack(response);
  assert.equal(track.languageCode, "ur");
  assert.equal(track.automatic, false);
  assert.match(track.baseUrl, /a=2/u);
});

test("parses timed JSON3 transcript events and locates playback entries", () => {
  const entries = parseJson3Transcript({ events: [
    { tStartMs: 1000, dDurationMs: 1400, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
    { tStartMs: 2600, dDurationMs: 1000, segs: [{ utf8: "Next line" }] },
  ] });
  assert.deepEqual(entries[0], { startMs: 1000, durationMs: 1400, endMs: 2400, text: "Hello world" });
  assert.equal(findTranscriptEntryIndex(entries, 1500), 0);
  assert.equal(findTranscriptEntryIndex(entries, 2700), 1);
  assert.equal(findTranscriptEntryIndex(entries, 5000), -1);
  assert.equal(new URL(transcriptTrackUrl("/api/timedtext?v=x")).searchParams.get("fmt"), "json3");
});

test("treats an empty YouTube timed-text response as unavailable", () => {
  assert.deepEqual(parseJson3Transcript(""), []);
  assert.deepEqual(parseJson3Transcript("not-json"), []);
});
