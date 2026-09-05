import test from "node:test";
import assert from "node:assert/strict";
import { fitPoseToViewport } from "../src/avatar-renderer.js";

test("fits a complete animation envelope inside the avatar viewport", () => {
  const pose = {
    header: {
      width: 512,
      height: 512,
      components: [{ name: "POSE_LANDMARKS" }, { name: "LEFT_HAND_LANDMARKS" }],
    },
    body: {
      fps: 25,
      frames: [
        { people: [{
          POSE_LANDMARKS: [
            { X: 180, Y: 40, Z: 0, C: 1 },
            { X: 340, Y: 620, Z: 0, C: 1 },
          ],
          LEFT_HAND_LANDMARKS: [{ X: -70, Y: 260, Z: 0, C: 1 }],
        }] },
        { people: [{
          POSE_LANDMARKS: [
            { X: 220, Y: 55, Z: 0, C: 1 },
            { X: 330, Y: 610, Z: 0, C: 1 },
          ],
          LEFT_HAND_LANDMARKS: [{ X: 710, Y: 210, Z: 0, C: 1 }],
        }] },
      ],
    },
  };

  const fittedPose = fitPoseToViewport(pose, 270, 207);
  assert.ok(fittedPose.__youtubeSignFit.scale > 0);
  assert.equal(fittedPose.header.width, 270);
  assert.equal(fittedPose.header.height, 207);
  assert.equal(pose.header.width, 512, "source pose remains unchanged");

  for (const frame of fittedPose.body.frames) {
    for (const person of frame.people) {
      for (const joints of Object.values(person)) {
        for (const joint of joints) {
          assert.ok(joint.X >= 0 && joint.X <= 270, `x=${joint.X}`);
          assert.ok(joint.Y >= 0 && joint.Y <= 207, `y=${joint.Y}`);
        }
      }
    }
  }
});

test("converts normalized hand depth to the fitted X/Y scale", () => {
  const pose = {
    header: {
      width: 512,
      height: 512,
      depth: 1,
      components: [
        { name: "POSE_LANDMARKS" },
        { name: "LEFT_HAND_LANDMARKS" },
      ],
    },
    body: {
      fps: 25,
      frames: [{ people: [{
        POSE_LANDMARKS: [
          { X: 160, Y: 120, Z: 0.5, C: 1 },
          { X: 350, Y: 430, Z: 0.5, C: 1 },
        ],
        LEFT_HAND_LANDMARKS: [
          { X: 210, Y: 240, Z: 0.5, C: 1 },
          { X: 230, Y: 220, Z: 0.6, C: 1 },
        ],
      }] }],
    },
  };

  const fitted = fitPoseToViewport(pose, 270, 207);
  const hand = fitted.body.frames[0].people[0].LEFT_HAND_LANDMARKS;
  const expected = 0.1 * 512 * fitted.__youtubeSignFit.scale;
  assert.ok(Math.abs(hand[0].Z) < 1e-9);
  assert.ok(Math.abs(hand[1].Z - expected) < 1e-9);
  assert.equal(pose.body.frames[0].people[0].LEFT_HAND_LANDMARKS[1].Z, 0.6);
});
