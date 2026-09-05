import test from "node:test";
import assert from "node:assert/strict";
import { overlayLayout } from "../src/overlay-layout.mjs";

test("medium overlay fits the reported player without crossing its top", () => {
  const player = { left: 16, top: 68, right: 957.625, bottom: 597.65625 };
  const layout = overlayLayout({ player, viewport: { width: 1440, height: 900 },
    preset: { width: 380, height: 480 } });
  assert.equal(layout.width, 380);
  assert.equal(layout.height, 461.65625);
  assert.equal(layout.top, 82);
  assert.equal(layout.left, 563.625);
  assert.equal(layout.top + layout.height, player.bottom - 54);
});

test("a roomy player retains the full upper-body preset", () => {
  const layout = overlayLayout({ player: { left: 0, top: 0, right: 1920, bottom: 1080 },
    viewport: { width: 1920, height: 1080 }, preset: { width: 460, height: 560 } });
  assert.equal(layout.width, 460);
  assert.equal(layout.height, 560);
  assert.equal(layout.top + layout.height, 1026);
});

test("partially scrolled and narrow players fit the visible rectangle", () => {
  const layout = overlayLayout({ player: { left: -30, top: -150, right: 340, bottom: 360 },
    viewport: { width: 800, height: 600 }, preset: { width: 380, height: 480 } });
  assert.equal(layout.width, 312);
  assert.ok(layout.left >= 14);
  assert.ok(layout.top >= 14);
  assert.ok(layout.left + layout.width <= 326);
  assert.ok(layout.top + layout.height <= 346);
  assert.ok(layout.height >= 292);
});

test("viewport shrink keeps a manually dragged overlay accessible", () => {
  const layout = overlayLayout({ player: { left: 0, top: 60, right: 640, bottom: 420 },
    viewport: { width: 640, height: 480 }, preset: { width: 460, height: 560 },
    position: { left: 1100, top: 600 } });
  assert.ok(layout.left + layout.width <= 626);
  assert.ok(layout.top + layout.height <= 466);
  assert.ok(layout.height <= 332);
});
