import test from "node:test";
import assert from "node:assert/strict";
import {
  captionDelta,
  dedupeDoubledCaption,
  detectSpokenLanguage,
  poseEndpoint,
  splitCaption,
} from "../src/core.mjs";

test("detects English, Hindi, and Urdu caption scripts", () => {
  assert.equal(detectSpokenLanguage("How are you?"), "en");
  assert.equal(detectSpokenLanguage("आप कैसे हैं?"), "hi");
  assert.equal(detectSpokenLanguage("آپ کیسے ہیں؟"), "ur");
});

test("keeps an explicit Arabic hint for Arabic-script captions", () => {
  assert.equal(detectSpokenLanguage("كيف حالك؟", "ar"), "ar");
});

test("does not let a previous Hindi or Urdu hint misclassify English captions", () => {
  assert.equal(detectSpokenLanguage("Now back to English", "hi"), "en");
  assert.equal(detectSpokenLanguage("English auto-translation", "ur"), "en");
});

test("removes duplicated YouTube caption windows", () => {
  assert.equal(dedupeDoubledCaption("this is a caption this is a caption"), "this is a caption");
});

test("extracts only new rolling-caption words", () => {
  assert.equal(captionDelta("welcome to the channel", "the channel today we discuss AI"), "today we discuss AI");
  assert.equal(captionDelta("hello", "hello world"), "world");
});

test("splits long captions into bounded phrases", () => {
  const chunks = splitCaption("one two three four five six seven eight", 4);
  assert.deepEqual(chunks, ["one two three four", "five six seven eight"]);
});

test("builds encoded ASL and PSL pose endpoints", () => {
  const asl = new URL(poseEndpoint({ text: "hello world", spokenLanguage: "en-US", signedLanguage: "ase" }));
  const psl = new URL(poseEndpoint({ text: "آپ کیسے ہیں؟", spokenLanguage: "ur", signedLanguage: "pks" }));
  assert.equal(asl.searchParams.get("spoken"), "en");
  assert.equal(asl.searchParams.get("signed"), "ase");
  assert.equal(psl.searchParams.get("spoken"), "ur");
  assert.equal(psl.searchParams.get("signed"), "pks");
});
