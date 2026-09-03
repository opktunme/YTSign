import { ThreeAvatarRenderer } from "./three-avatar-renderer.js";

const BACKGROUND = "#07131f";
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [17, 0],
];

function valid(joint, confidence = 0.12) {
  return joint &&
    typeof joint.X === "number" && Number.isFinite(joint.X) &&
    typeof joint.Y === "number" && Number.isFinite(joint.Y) &&
    typeof joint.C === "number" && Number.isFinite(joint.C) &&
    joint.C > confidence;
}

function componentKind(name) {
  const value = String(name || "").toLowerCase();
  if (value.includes("face")) return "face";
  if (value.includes("left") && value.includes("hand")) return "leftHand";
  if (value.includes("right") && value.includes("hand")) return "rightHand";
  if (value.includes("hand")) return "hand";
  if (value.includes("pose") || value.includes("body")) return "body";
  return "other";
}

function point(joint) {
  return joint && { x: joint.X, y: joint.Y };
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function boundsOf(joints, confidence = 0.12) {
  const usable = joints.filter((joint) => valid(joint, confidence));
  if (!usable.length) return null;
  return usable.reduce((bounds, joint) => ({
    minX: Math.min(bounds.minX, joint.X),
    maxX: Math.max(bounds.maxX, joint.X),
    minY: Math.min(bounds.minY, joint.Y),
    maxY: Math.max(bounds.maxY, joint.Y),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
}

export function fitPoseToViewport(pose, width, height) {
  if (!pose?.body?.frames?.length || !pose?.header?.components?.length) return null;

  const originalWidth = typeof pose.header.width === "number" && Number.isFinite(pose.header.width) ? pose.header.width : 512;
  const originalHeight = typeof pose.header.height === "number" && Number.isFinite(pose.header.height) ? pose.header.height : 512;
  const points = [];
  for (let frameIndex = 0; frameIndex < pose.body.frames.length; frameIndex += 1) {
    const frame = pose.body.frames[frameIndex];
    const people = frame.people || [];
    for (let personIndex = 0; personIndex < people.length; personIndex += 1) {
      const person = people[personIndex];
      for (let componentIndex = 0; componentIndex < pose.header.components.length; componentIndex += 1) {
        const component = pose.header.components[componentIndex];
        const joints = person[component.name] || [];
        for (let jointIndex = 0; jointIndex < joints.length; jointIndex += 1) {
          const joint = joints[jointIndex];
          if (!valid(joint, 0.05)) continue;
          if (joint.X < -originalWidth || joint.X > originalWidth * 2) continue;
          if (joint.Y < -originalHeight || joint.Y > originalHeight * 2) continue;
          points.push(joint);
        }
      }
    }
  }
  if (points.length < 4) return null;

  const source = boundsOf(points, 0.05);
  // Leave enough room for the rendered limb thickness around landmark centers,
  // especially below lowered wrists in a short, wide YouTube overlay.
  const marginX = Math.max(18, width * 0.09);
  const marginTop = Math.max(14, height * 0.08);
  const marginBottom = Math.max(30, height * 0.15);
  const availableWidth = Math.max(1, width - marginX * 2);
  const availableHeight = Math.max(1, height - marginTop - marginBottom);
  const sourceWidth = Math.max(1, source.maxX - source.minX);
  const sourceHeight = Math.max(1, source.maxY - source.minY);
  const scale = Math.min(availableWidth / sourceWidth, availableHeight / sourceHeight);
  const drawnWidth = sourceWidth * scale;
  const drawnHeight = sourceHeight * scale;
  const offsetX = (width - drawnWidth) / 2 - source.minX * scale;
  const offsetY = marginTop + (availableHeight - drawnHeight) / 2 - source.minY * scale;

  const components = Array.from({ length: pose.header.components.length }, (_, componentIndex) => {
    const component = pose.header.components[componentIndex];
    return {
      name: component.name,
      limbs: Array.from(component.limbs || [], (limb) => ({ from: limb.from, to: limb.to })),
    };
  });
  const frames = new Array(pose.body.frames.length);
  for (let frameIndex = 0; frameIndex < pose.body.frames.length; frameIndex += 1) {
    const sourceFrame = pose.body.frames[frameIndex];
    const sourcePeople = sourceFrame.people || [];
    const people = new Array(sourcePeople.length);
    for (let personIndex = 0; personIndex < sourcePeople.length; personIndex += 1) {
      const sourcePerson = sourcePeople[personIndex];
      const person = {};
      for (let componentIndex = 0; componentIndex < components.length; componentIndex += 1) {
        const component = components[componentIndex];
        const sourceJoints = sourcePerson[component.name] || [];
        person[component.name] = Array.from({ length: sourceJoints.length }, (_, jointIndex) => {
          const joint = sourceJoints[jointIndex];
          if (!joint) return null;
          return {
            X: Number.isFinite(joint.X) ? joint.X * scale + offsetX : joint.X,
            Y: Number.isFinite(joint.Y) ? joint.Y * scale + offsetY : joint.Y,
            Z: Number.isFinite(joint.Z) ? joint.Z * scale : joint.Z,
            C: joint.C,
          };
        });
      }
      people[personIndex] = person;
    }
    frames[frameIndex] = { people };
  }

  const fit = { width, height, scale, source, marginX, marginTop, marginBottom };
  return {
    header: { width, height, components },
    body: { fps: Number(pose.body.fps) || 25, frames },
    __youtubeSignFit: fit,
  };
}

function roundedLine(context, a, b, width, color, outline = "") {
  if (!a || !b) return;
  context.save();
  context.lineCap = "round";
  context.lineJoin = "round";
  if (outline) {
    context.strokeStyle = outline;
    context.lineWidth = width + Math.max(1.5, width * 0.18);
    context.beginPath();
    context.moveTo(a.x, a.y);
    context.lineTo(b.x, b.y);
    context.stroke();
  }
  context.strokeStyle = color;
  context.lineWidth = width;
  context.beginPath();
  context.moveTo(a.x, a.y);
  context.lineTo(b.x, b.y);
  context.stroke();
  context.restore();
}

function polygon(context, points, fill, stroke = "", lineWidth = 1) {
  if (points.some((item) => !item)) return;
  context.save();
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  for (const item of points.slice(1)) context.lineTo(item.x, item.y);
  context.closePath();
  context.fillStyle = fill;
  context.fill();
  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = lineWidth;
    context.stroke();
  }
  context.restore();
}

function ellipse(context, center, radiusX, radiusY, fill, stroke = "", lineWidth = 1) {
  context.save();
  context.beginPath();
  context.ellipse(center.x, center.y, Math.max(1, radiusX), Math.max(1, radiusY), 0, 0, Math.PI * 2);
  context.fillStyle = fill;
  context.fill();
  if (stroke) {
    context.strokeStyle = stroke;
    context.lineWidth = lineWidth;
    context.stroke();
  }
  context.restore();
}

function verticalGradient(context, top, bottom, stops) {
  const gradient = context.createLinearGradient(0, top, 0, bottom);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  return gradient;
}

function fadeLowerFrame(context, width, height) {
  // The character is a full-body Meshy model, while signing needs a waist-up
  // crop. Fade the unused lower body before the canvas edge so the crop reads
  // as intentional and never looks like a clipped signer.
  const gradient = context.createLinearGradient(0, height * 0.84, 0, height);
  gradient.addColorStop(0, "rgba(7, 19, 31, 0)");
  gradient.addColorStop(0.72, "rgba(7, 19, 31, 0.92)");
  gradient.addColorStop(1, "rgba(7, 19, 31, 1)");
  context.fillStyle = gradient;
  context.fillRect(0, height * 0.84, width, height * 0.16);
}

function drawFace(context, face, body, scale) {
  const faceBounds = boundsOf(face, 0.16);
  const bodyNose = body?.length > 10 && valid(body[0]) ? point(body[0]) : null;
  let center;
  let radiusX;
  let radiusY;
  if (faceBounds) {
    center = { x: (faceBounds.minX + faceBounds.maxX) / 2, y: (faceBounds.minY + faceBounds.maxY) / 2 };
    radiusX = Math.max(6 * scale, (faceBounds.maxX - faceBounds.minX) * 0.54);
    radiusY = Math.max(8 * scale, (faceBounds.maxY - faceBounds.minY) * 0.58);
  } else if (bodyNose) {
    const shoulderWidth = valid(body?.[11]) && valid(body?.[12]) ? distance(point(body[11]), point(body[12])) : 36 * scale;
    radiusX = shoulderWidth * 0.22;
    radiusY = radiusX * 1.3;
    center = { x: bodyNose.x, y: bodyNose.y + radiusY * 0.12 };
  } else {
    return;
  }

  const skin = "#d9a17c";
  const skinLight = "#efc3a2";
  const outline = "#4d2b26";
  const skinGradient = context.createRadialGradient(
    center.x - radiusX * 0.3,
    center.y - radiusY * 0.35,
    Math.max(1, radiusX * 0.08),
    center.x,
    center.y,
    Math.max(radiusX, radiusY),
  );
  skinGradient.addColorStop(0, "#f3c5a3");
  skinGradient.addColorStop(0.7, skin);
  skinGradient.addColorStop(1, "#bd7a5d");
  ellipse(context, { x: center.x - radiusX * 1.01, y: center.y + radiusY * 0.03 }, radiusX * 0.13, radiusY * 0.24, skin, outline, Math.max(0.7, scale * 0.7));
  ellipse(context, { x: center.x + radiusX * 1.01, y: center.y + radiusY * 0.03 }, radiusX * 0.13, radiusY * 0.24, skin, outline, Math.max(0.7, scale * 0.7));
  ellipse(context, center, radiusX, radiusY, skinGradient, outline, Math.max(1, scale * 1.1));

  context.save();
  context.beginPath();
  context.ellipse(center.x, center.y - radiusY * 0.35, radiusX * 0.98, radiusY * 0.68, 0, Math.PI, Math.PI * 2);
  const hairGradient = verticalGradient(context, center.y - radiusY, center.y, [
    [0, "#171315"],
    [1, "#332528"],
  ]);
  context.fillStyle = hairGradient;
  context.fill();
  context.restore();

  // The translation service sends a compact 128-point facial mesh rather than
  // MediaPipe's full 468-point index layout, so fixed facial indices are not
  // portable. The live mesh still drives the head envelope; features remain
  // stable inside it instead of jumping to unrelated compact-mesh points.
  const leftEye = { x: center.x - radiusX * 0.34, y: center.y - radiusY * 0.12 };
  const rightEye = { x: center.x + radiusX * 0.34, y: center.y - radiusY * 0.12 };
  const eyeRadiusX = Math.max(1.4, radiusX * 0.11);
  const eyeRadiusY = Math.max(0.9, radiusY * 0.055);
  ellipse(context, leftEye, eyeRadiusX, eyeRadiusY, "#f4eee9", "#6d463b", Math.max(0.5, scale * 0.45));
  ellipse(context, rightEye, eyeRadiusX, eyeRadiusY, "#f4eee9", "#6d463b", Math.max(0.5, scale * 0.45));
  ellipse(context, leftEye, eyeRadiusY * 0.62, eyeRadiusY * 0.62, "#3d2c24");
  ellipse(context, rightEye, eyeRadiusY * 0.62, eyeRadiusY * 0.62, "#3d2c24");
  roundedLine(context,
    { x: leftEye.x - eyeRadiusX, y: leftEye.y - radiusY * 0.13 },
    { x: leftEye.x + eyeRadiusX, y: leftEye.y - radiusY * 0.15 },
    Math.max(0.8, scale * 0.85), "#4a2f2c");
  roundedLine(context,
    { x: rightEye.x - eyeRadiusX, y: rightEye.y - radiusY * 0.15 },
    { x: rightEye.x + eyeRadiusX, y: rightEye.y - radiusY * 0.13 },
    Math.max(0.8, scale * 0.85), "#4a2f2c");

  roundedLine(context,
    { x: center.x - radiusX * 0.02, y: center.y - radiusY * 0.02 },
    { x: center.x - radiusX * 0.08, y: center.y + radiusY * 0.19 },
    Math.max(0.65, scale * 0.62), "#b9755b");
  ellipse(context, { x: center.x, y: center.y + radiusY * 0.2 }, Math.max(0.8, radiusX * 0.045), Math.max(0.8, radiusX * 0.035), skinLight);

  const mouthY = center.y + radiusY * 0.38;
  roundedLine(context, { x: center.x - radiusX * 0.15, y: mouthY }, { x: center.x + radiusX * 0.15, y: mouthY }, Math.max(1, scale * 1.1), "#8e4050");
}

function drawHand(context, hand, scale) {
  if (!hand?.length || !valid(hand[0])) return;
  const skin = "#dda681";
  const outline = "#4d2b26";
  const fingerWidth = Math.max(2.2, scale * 3.2);
  for (const [from, to] of HAND_CONNECTIONS) {
    if (!valid(hand[from]) || !valid(hand[to])) continue;
    roundedLine(context, point(hand[from]), point(hand[to]), fingerWidth, skin, outline);
  }
  const palm = [0, 5, 9, 13, 17].filter((index) => valid(hand[index])).map((index) => point(hand[index]));
  if (palm.length >= 4) polygon(context, palm, skin, outline, Math.max(1, scale));
  for (const index of [4, 8, 12, 16, 20]) {
    if (valid(hand[index])) ellipse(context, point(hand[index]), fingerWidth * 0.46, fingerWidth * 0.46, skin, outline, Math.max(0.7, scale * 0.6));
  }
}

function drawHuman(context, person, components, scale) {
  const groups = { body: null, face: null, leftHand: null, rightHand: null, hand: null };
  for (const component of components) {
    const kind = componentKind(component.name);
    if (kind !== "other" && !groups[kind]) groups[kind] = person[component.name] || null;
  }
  const body = groups.body || [];
  const face = groups.face || [];
  const leftHand = groups.leftHand || groups.hand || [];
  const rightHand = groups.rightHand || [];
  const compact = body.length <= 10;
  const joint = (index) => valid(body[index], compact ? 0.05 : 0.12) ? point(body[index]) : null;
  // sign.mt pose output uses eight joints: R/L shoulders, R/L elbows,
  // R/L wrists, and R/L hips. Keep MediaPipe's 33-point layout as well.
  const neck = null;
  const leftShoulder = joint(compact ? 1 : 11);
  const rightShoulder = joint(compact ? 0 : 12);
  const leftElbow = joint(compact ? 3 : 13);
  const rightElbow = joint(compact ? 2 : 14);
  const leftWrist = joint(compact ? 5 : 15);
  const rightWrist = joint(compact ? 4 : 16);
  let leftHip = joint(compact ? 7 : 23);
  let rightHip = joint(compact ? 6 : 24);
  const shoulderWidth = leftShoulder && rightShoulder ? distance(leftShoulder, rightShoulder) : 45 * scale;
  const armWidth = Math.max(5, shoulderWidth * 0.12);
  const skin = "#d9a17c";
  const outline = "#15212c";
  const jacket = "#315b78";
  const jacketLight = "#467999";
  const shoulderTop = leftShoulder && rightShoulder ? Math.min(leftShoulder.y, rightShoulder.y) : 0;
  const torsoBottom = leftHip && rightHip ? Math.max(leftHip.y, rightHip.y) : shoulderTop + shoulderWidth;
  const jacketGradient = verticalGradient(context, shoulderTop, torsoBottom, [
    [0, "#477b99"],
    [0.5, jacket],
    [1, "#24475f"],
  ]);
  const shirtGradient = verticalGradient(context, shoulderTop, torsoBottom, [
    [0, "#f6f8fa"],
    [1, "#cbd8e1"],
  ]);

  if (compact && leftShoulder && rightShoulder && (!leftHip || !rightHip)) {
    const shoulderCenter = midpoint(leftShoulder, rightShoulder);
    const torsoLength = shoulderWidth * 0.95;
    leftHip ||= { x: shoulderCenter.x - shoulderWidth * 0.34, y: shoulderCenter.y + torsoLength };
    rightHip ||= { x: shoulderCenter.x + shoulderWidth * 0.34, y: shoulderCenter.y + torsoLength };
  }

  if (leftShoulder && rightShoulder && leftHip && rightHip) {
    polygon(context, [leftShoulder, rightShoulder, rightHip, leftHip], jacketGradient, outline, Math.max(1, scale));
    const shoulderCenter = midpoint(leftShoulder, rightShoulder);
    const hipCenter = midpoint(leftHip, rightHip);
    const shirtWidth = shoulderWidth * 0.2;
    polygon(context, [
      { x: shoulderCenter.x - shirtWidth, y: shoulderCenter.y },
      { x: shoulderCenter.x + shirtWidth, y: shoulderCenter.y },
      { x: hipCenter.x + shirtWidth * 0.48, y: hipCenter.y },
      { x: hipCenter.x - shirtWidth * 0.48, y: hipCenter.y },
    ], shirtGradient);
    roundedLine(context, leftShoulder, leftHip, Math.max(1, scale * 1.4), jacketLight);
    roundedLine(context, rightShoulder, rightHip, Math.max(1, scale * 1.4), jacketLight);
  }

  if (leftShoulder && leftElbow) roundedLine(context, leftShoulder, leftElbow, armWidth * 1.2, jacketGradient, outline);
  if (rightShoulder && rightElbow) roundedLine(context, rightShoulder, rightElbow, armWidth * 1.2, jacketGradient, outline);
  if (leftElbow && leftWrist) roundedLine(context, leftElbow, leftWrist, armWidth * 0.82, skin, outline);
  if (rightElbow && rightWrist) roundedLine(context, rightElbow, rightWrist, armWidth * 0.82, skin, outline);

  if (leftShoulder && rightShoulder) {
    const center = midpoint(leftShoulder, rightShoulder);
    const neckTop = neck || { x: center.x, y: center.y - shoulderWidth * 0.16 };
    roundedLine(context, center, neckTop, Math.max(5, shoulderWidth * 0.16), skin, outline);
  }
  drawFace(context, face, body, scale);
  drawHand(context, leftHand, scale);
  drawHand(context, rightHand, scale);
}

function drawSkeleton(context, person, components, scale) {
  for (const component of components) {
    const joints = person[component.name] || [];
    for (const limb of component.limbs || []) {
      const from = joints[limb.from];
      const to = joints[limb.to];
      if (!valid(from) || !valid(to)) continue;
      roundedLine(context, point(from), point(to), Math.max(1.2, scale * 1.35), "#ff4052");
    }
    for (const joint of joints) {
      if (!valid(joint)) continue;
      ellipse(context, point(joint), Math.max(0.8, scale), Math.max(0.8, scale), "#ff5b68");
    }
  }
}

export class SigningAvatarRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: false });
    this.pose = null;
    this.mode = "avatar";
    this.threeAvatar = new ThreeAvatarRenderer();
    this.lastTime = 0;
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.canvas.dataset.avatarRenderer = "procedural-3d";
    this.clear();
  }

  resize(viewport = null) {
    // Chromium can temporarily report a stale, very wide innerWidth for a
    // nested extension iframe while the YouTube overlay is being resized.
    // The frame element lives on the same extension origin and reflects the
    // actual visible stage, so use its box as the source of truth.
    const frameRect = window.frameElement?.getBoundingClientRect?.();
    const width = Math.max(1, Math.round(Number(viewport?.width) || frameRect?.width || document.documentElement.clientWidth || window.innerWidth));
    const height = Math.max(1, Math.round(Number(viewport?.height) || frameRect?.height || document.documentElement.clientHeight || window.innerHeight));
    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.threeAvatar.resize(width, height);
    return { width, height };
  }

  setPose(pose) {
    this.pose = pose;
  }

  setMode(mode = "avatar") {
    this.mode = mode === "skeleton" ? "skeleton" : "avatar";
    this.canvas.dataset.avatarRenderer = this.mode === "avatar" ? "procedural-3d" : "classic";
    this.draw(this.lastTime);
  }

  clear() {
    this.context.fillStyle = BACKGROUND;
    this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
  }

  draw(time = 0) {
    this.lastTime = typeof time === "number" && Number.isFinite(time) ? time : 0;
    this.clear();
    if (!this.pose?.body?.frames?.length) return;
    const frameIndex = Math.min(
      this.pose.body.frames.length - 1,
      Math.max(0, Math.floor(this.lastTime * this.pose.body.fps)),
    );
    const frame = this.pose.body.frames[frameIndex];
    const fitScale = this.pose.__youtubeSignFit?.scale || 1;
    const people = frame.people || [];
    for (let personIndex = 0; personIndex < people.length; personIndex += 1) {
      const person = people[personIndex];
      if (this.mode === "avatar") {
        this.threeAvatar.draw(person, this.pose.header.components, fitScale);
        this.canvas.dataset.visibleHands = String(this.threeAvatar.visibleHandCount || 0);
        this.context.drawImage(this.threeAvatar.canvas, 0, 0, this.canvas.width, this.canvas.height);
      } else {
        drawSkeleton(this.context, person, this.pose.header.components, fitScale);
      }
    }
  }
}
