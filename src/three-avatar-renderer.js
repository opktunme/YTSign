import * as THREE from "three";

const BACKGROUND = 0x07131f;
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [17, 0],
];

function valid(joint, confidence = 0.12) {
  return joint && Number.isFinite(joint.X) && Number.isFinite(joint.Y) &&
    Number.isFinite(joint.C) && joint.C > confidence;
}

function point(joint) {
  return { x: joint.X, y: joint.Y };
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

function componentKind(name) {
  const value = String(name || "").toLowerCase();
  if (value.includes("face")) return "face";
  if (value.includes("left") && value.includes("hand")) return "leftHand";
  if (value.includes("right") && value.includes("hand")) return "rightHand";
  if (value.includes("hand")) return "hand";
  if (value.includes("pose") || value.includes("body")) return "body";
  return "other";
}

function material(color, roughness = 0.66, metalness = 0) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    side: THREE.DoubleSide,
  });
}

export class ThreeAvatarRenderer {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(BACKGROUND, 1);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 1500);
    this.camera.position.set(0, 0, 650);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.HemisphereLight(0xffeadc, 0x17304a, 2.35));
    const key = new THREE.DirectionalLight(0xffdfc7, 3.8);
    key.position.set(-180, 260, 420);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x8cc8ff, 2.1);
    rim.position.set(240, 90, 180);
    this.scene.add(rim);

    this.materials = {
      skin: material(0xd99a72, 0.75),
      skinLight: material(0xefbd99, 0.68),
      jacket: material(0x3f7899, 0.7),
      jacketDark: material(0x244d69, 0.76),
      shirt: material(0xf3f7f8, 0.58),
      white: material(0xfffbf5, 0.44),
      iris: material(0x3b271e, 0.4),
      hair: material(0x211719, 0.9),
      lip: material(0x9a4f58, 0.65),
    };

    this.sphereGeometry = new THREE.SphereGeometry(1, 24, 18);
    this.segmentGeometry = new THREE.CylinderGeometry(1, 1, 1, 14, 1, false);
    this.torsoGeometry = new THREE.BufferGeometry();
    this.torsoGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    this.torsoGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.torso = new THREE.Mesh(this.torsoGeometry, this.materials.jacket);
    this.scene.add(this.torso);

    this.shirtGeometry = new THREE.BufferGeometry();
    this.shirtGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    this.shirtGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.shirt = new THREE.Mesh(this.shirtGeometry, this.materials.shirt);
    this.scene.add(this.shirt);

    this.dynamicMeshes = [this.torso, this.shirt];
    this.armSegments = Array.from({ length: 4 }, () => this.createSegment(this.materials.jacket));
    this.shoulderJoints = Array.from({ length: 4 }, () => this.createSphere(this.materials.jacket));
    this.handSegments = Array.from({ length: 42 }, () => this.createSegment(this.materials.skin));
    this.handJoints = Array.from({ length: 42 }, () => this.createSphere(this.materials.skin));
    this.palms = Array.from({ length: 2 }, () => this.createSphere(this.materials.skin));

    this.neck = this.createSphere(this.materials.skin);
    this.hair = this.createSphere(this.materials.hair);
    this.ears = Array.from({ length: 2 }, () => this.createSphere(this.materials.skin));
    this.face = this.createSphere(this.materials.skin);
    this.eyes = Array.from({ length: 2 }, () => this.createSphere(this.materials.white));
    this.irises = Array.from({ length: 2 }, () => this.createSphere(this.materials.iris));
    this.brows = Array.from({ length: 2 }, () => this.createSegment(this.materials.hair));
    this.nose = this.createSphere(this.materials.skinLight);
    this.mouth = this.createSegment(this.materials.lip);
    this.faceMeshes = [
      this.neck, this.hair, ...this.ears, this.face,
      ...this.eyes, ...this.irises, ...this.brows, this.nose, this.mouth,
    ];

    this.width = 1;
    this.height = 1;
    this.resize(1, 1);
  }

  createSphere(meshMaterial) {
    const mesh = new THREE.Mesh(this.sphereGeometry, meshMaterial);
    mesh.visible = false;
    this.scene.add(mesh);
    this.dynamicMeshes?.push(mesh);
    return mesh;
  }

  createSegment(meshMaterial) {
    const mesh = new THREE.Mesh(this.segmentGeometry, meshMaterial);
    mesh.visible = false;
    this.scene.add(mesh);
    this.dynamicMeshes?.push(mesh);
    return mesh;
  }

  resize(width, height) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.left = 0;
    this.camera.right = this.width;
    this.camera.top = this.height;
    this.camera.bottom = 0;
    // The orthographic planes already use viewport coordinates (0..width and
    // 0..height), so the camera must stay at the same XY origin. Translating
    // it to the viewport centre would offset every signer by half a canvas.
    this.camera.position.set(0, 0, 650);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  world(screenPoint, z = 0) {
    return new THREE.Vector3(screenPoint.x, this.height - screenPoint.y, z);
  }

  setSphere(mesh, screenPoint, radiusX, radiusY, radiusZ, z = 0) {
    const location = this.world(screenPoint, z);
    mesh.position.copy(location);
    mesh.scale.set(Math.max(0.2, radiusX), Math.max(0.2, radiusY), Math.max(0.2, radiusZ));
    mesh.visible = true;
  }

  setSegment(mesh, start, end, radius, z = 0) {
    if (!start || !end) return false;
    const a = this.world(start, z);
    const b = this.world(end, z);
    const direction = b.clone().sub(a);
    const length = direction.length();
    if (length < 0.25) return false;
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    mesh.scale.set(Math.max(0.35, radius), length, Math.max(0.35, radius));
    mesh.visible = true;
    return true;
  }

  setTorso(points, z = 0) {
    if (points.some((item) => !item)) return;
    const positions = this.torsoGeometry.attributes.position.array;
    for (let index = 0; index < 4; index += 1) {
      const world = this.world(points[index], z);
      positions[index * 3] = world.x;
      positions[index * 3 + 1] = world.y;
      positions[index * 3 + 2] = world.z;
    }
    this.torsoGeometry.attributes.position.needsUpdate = true;
    this.torsoGeometry.computeVertexNormals();
    this.torso.visible = true;
  }

  setShirt(points, z = 0) {
    if (points.some((item) => !item)) return;
    const positions = this.shirtGeometry.attributes.position.array;
    for (let index = 0; index < 4; index += 1) {
      const world = this.world(points[index], z);
      positions[index * 3] = world.x;
      positions[index * 3 + 1] = world.y;
      positions[index * 3 + 2] = world.z;
    }
    this.shirtGeometry.attributes.position.needsUpdate = true;
    this.shirtGeometry.computeVertexNormals();
    this.shirt.visible = true;
  }

  hideDynamicMeshes() {
    for (const mesh of this.dynamicMeshes) mesh.visible = false;
  }

  groupPerson(person, components) {
    const groups = { body: null, face: null, leftHand: null, rightHand: null, hand: null };
    for (const component of components) {
      const kind = componentKind(component.name);
      if (kind !== "other" && !groups[kind]) groups[kind] = person[component.name] || null;
    }
    return groups;
  }

  updateBody(body, scale) {
    const compact = body.length <= 10;
    const joint = (index, confidence = compact ? 0.05 : 0.12) => valid(body[index], confidence) ? point(body[index]) : null;
    const leftShoulder = joint(compact ? 1 : 11);
    const rightShoulder = joint(compact ? 0 : 12);
    const leftElbow = joint(compact ? 3 : 13);
    const rightElbow = joint(compact ? 2 : 14);
    let leftWrist = joint(compact ? 5 : 15, compact ? 0.01 : 0.05);
    let rightWrist = joint(compact ? 4 : 16, compact ? 0.01 : 0.05);
    let leftHip = joint(compact ? 7 : 23);
    let rightHip = joint(compact ? 6 : 24);
    if (!leftShoulder || !rightShoulder) return null;

    const shoulderWidth = distance(leftShoulder, rightShoulder);
    if (!leftHip || !rightHip) {
      const center = midpoint(leftShoulder, rightShoulder);
      leftHip = { x: center.x - shoulderWidth * 0.35, y: center.y + shoulderWidth * 0.98 };
      rightHip = { x: center.x + shoulderWidth * 0.35, y: center.y + shoulderWidth * 0.98 };
    }
    const estimateWrist = (shoulder, elbow) => shoulder && elbow ? {
      x: elbow.x + (elbow.x - shoulder.x) * 0.62,
      y: elbow.y + (elbow.y - shoulder.y) * 0.62,
    } : null;
    leftWrist ||= estimateWrist(leftShoulder, leftElbow);
    rightWrist ||= estimateWrist(rightShoulder, rightElbow);
    this.setTorso([leftShoulder, rightShoulder, rightHip, leftHip], 2);
    const shoulderCenter = midpoint(leftShoulder, rightShoulder);
    const hipCenter = midpoint(leftHip, rightHip);
    this.setShirt([
      { x: shoulderCenter.x - shoulderWidth * 0.18, y: shoulderCenter.y },
      { x: shoulderCenter.x + shoulderWidth * 0.18, y: shoulderCenter.y },
      { x: hipCenter.x + shoulderWidth * 0.11, y: hipCenter.y },
      { x: hipCenter.x - shoulderWidth * 0.11, y: hipCenter.y },
    ], 7);

    const armRadius = Math.max(3.6 * scale, shoulderWidth * 0.105);
    const segments = [
      [leftShoulder, leftElbow], [leftElbow, leftWrist],
      [rightShoulder, rightElbow], [rightElbow, rightWrist],
    ];
    segments.forEach(([a, b], index) => {
      if (this.setSegment(this.armSegments[index], a, b, armRadius * (index % 2 ? 0.78 : 1), 14)) {
        this.armSegments[index].material = index % 2 ? this.materials.jacketDark : this.materials.jacket;
      }
    });
    [leftShoulder, leftElbow, rightShoulder, rightElbow].forEach((location, index) => {
      if (location) this.setSphere(this.shoulderJoints[index], location, armRadius, armRadius, armRadius, 15);
    });

    const neckTop = { x: shoulderCenter.x, y: shoulderCenter.y - shoulderWidth * 0.23 };
    this.setSphere(
      this.neck,
      midpoint(shoulderCenter, neckTop),
      shoulderWidth * 0.09,
      shoulderWidth * 0.16,
      shoulderWidth * 0.075,
      9,
    );
    return {
      leftShoulder,
      rightShoulder,
      leftElbow,
      rightElbow,
      leftWrist,
      rightWrist,
      shoulderCenter,
      shoulderWidth,
      neckTop,
    };
  }

  updateFace(faceJoints, bodyInfo, scale) {
    const faceBounds = boundsOf(faceJoints, 0.16);
    let center;
    let radiusX;
    let radiusY;
    if (faceBounds) {
      center = { x: (faceBounds.minX + faceBounds.maxX) / 2, y: (faceBounds.minY + faceBounds.maxY) / 2 };
      radiusX = Math.max(6 * scale, (faceBounds.maxX - faceBounds.minX) * 0.54);
      radiusY = Math.max(8 * scale, (faceBounds.maxY - faceBounds.minY) * 0.58);
    } else if (bodyInfo) {
      radiusX = bodyInfo.shoulderWidth * 0.22;
      radiusY = radiusX * 1.28;
      center = { x: bodyInfo.shoulderCenter.x, y: bodyInfo.neckTop.y - radiusY * 0.75 };
    } else {
      return;
    }

    this.setSphere(this.hair, { x: center.x, y: center.y - radiusY * 0.78 }, radiusX * 1.05, radiusY * 0.48, radiusX * 0.62, 34);
    this.setSphere(this.ears[0], { x: center.x - radiusX * 1.02, y: center.y + radiusY * 0.04 }, radiusX * 0.16, radiusY * 0.28, radiusX * 0.13, 23);
    this.setSphere(this.ears[1], { x: center.x + radiusX * 1.02, y: center.y + radiusY * 0.04 }, radiusX * 0.16, radiusY * 0.28, radiusX * 0.13, 23);
    this.setSphere(this.face, center, radiusX, radiusY, radiusX * 0.57, 28);

    const eyes = [
      { x: center.x - radiusX * 0.34, y: center.y - radiusY * 0.12 },
      { x: center.x + radiusX * 0.34, y: center.y - radiusY * 0.12 },
    ];
    eyes.forEach((eye, index) => {
      this.setSphere(this.eyes[index], eye, radiusX * 0.13, radiusY * 0.075, radiusX * 0.045, 61);
      this.setSphere(this.irises[index], eye, radiusY * 0.04, radiusY * 0.04, radiusX * 0.024, 64);
      this.setSegment(this.brows[index],
        { x: eye.x - radiusX * 0.13, y: eye.y - radiusY * 0.17 },
        { x: eye.x + radiusX * 0.13, y: eye.y - radiusY * 0.19 },
        Math.max(0.65, scale * 0.8), 62);
    });
    this.setSphere(this.nose, { x: center.x, y: center.y + radiusY * 0.13 }, radiusX * 0.075, radiusY * 0.13, radiusX * 0.075, 64);
    this.setSegment(this.mouth,
      { x: center.x - radiusX * 0.16, y: center.y + radiusY * 0.4 },
      { x: center.x + radiusX * 0.16, y: center.y + radiusY * 0.4 },
      Math.max(0.75, scale), 65);
  }

  updateHand(hand, handIndex, scale) {
    if (!hand?.length || hand.filter((joint) => valid(joint)).length < 3) return false;
    const segmentOffset = handIndex * HAND_CONNECTIONS.length;
    HAND_CONNECTIONS.forEach(([from, to], connectionIndex) => {
      if (!valid(hand[from]) || !valid(hand[to])) return;
      const width = Math.max(1.05, scale * 2.15);
      this.setSegment(this.handSegments[segmentOffset + connectionIndex], point(hand[from]), point(hand[to]), width, 74);
    });
    const jointOffset = handIndex * 21;
    hand.slice(0, 21).forEach((joint, index) => {
      if (!valid(joint)) return;
      const radius = Math.max(0.95, scale * 1.72);
      this.setSphere(this.handJoints[jointOffset + index], point(joint), radius, radius, radius, 76);
    });
    const palmIndices = [0, 5, 9, 13, 17].filter((index) => valid(hand[index]));
    if (palmIndices.length >= 3) {
      const points = palmIndices.map((index) => point(hand[index]));
      const center = points.reduce((sum, item) => ({ x: sum.x + item.x, y: sum.y + item.y }), { x: 0, y: 0 });
      center.x /= points.length;
      center.y /= points.length;
      const bounds = points.reduce((value, item) => ({
        minX: Math.min(value.minX, item.x), maxX: Math.max(value.maxX, item.x),
        minY: Math.min(value.minY, item.y), maxY: Math.max(value.maxY, item.y),
      }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
      this.setSphere(this.palms[handIndex], center,
        Math.max(2.4, (bounds.maxX - bounds.minX) * 0.62),
        Math.max(3, (bounds.maxY - bounds.minY) * 0.64),
        Math.max(2, scale * 3), 72);
    }
    return true;
  }

  updateFallbackHand(wrist, elbow, handIndex, scale, shoulderWidth) {
    if (!wrist) return false;
    const length = Math.max(12 * scale, shoulderWidth * 0.15);
    let dx = wrist.x - (elbow?.x ?? wrist.x);
    let dy = wrist.y - (elbow?.y ?? wrist.y - 1);
    const magnitude = Math.hypot(dx, dy) || 1;
    dx /= magnitude;
    dy /= magnitude;
    const px = -dy;
    const py = dx;
    const palmCenter = { x: wrist.x + dx * length * 0.3, y: wrist.y + dy * length * 0.3 };
    this.setSphere(
      this.palms[handIndex],
      palmCenter,
      Math.max(5, shoulderWidth * 0.052),
      Math.max(6.8, shoulderWidth * 0.07),
      Math.max(3.2, shoulderWidth * 0.036),
      72,
    );
    const segmentOffset = handIndex * HAND_CONNECTIONS.length;
    const jointOffset = handIndex * 21;
    for (let finger = 0; finger < 5; finger += 1) {
      const spread = (finger - 2) * Math.max(2.3, shoulderWidth * 0.024);
      const base = {
        x: palmCenter.x + px * spread + dx * length * 0.3,
        y: palmCenter.y + py * spread + dy * length * 0.3,
      };
      const fingerLength = length * (0.78 - Math.abs(finger - 2) * 0.06);
      const tip = {
        x: base.x + dx * fingerLength + px * spread * 0.28,
        y: base.y + dy * fingerLength + py * spread * 0.28,
      };
      const fingerRadius = Math.max(1.25, shoulderWidth * 0.013);
      this.setSegment(this.handSegments[segmentOffset + finger], base, tip, fingerRadius, 74);
      this.setSphere(this.handJoints[jointOffset + finger], tip, fingerRadius, fingerRadius, fingerRadius, 76);
    }
    return true;
  }

  draw(person, components, scale = 1) {
    this.hideDynamicMeshes();
    const groups = this.groupPerson(person, components);
    const bodyInfo = this.updateBody(groups.body || [], scale);
    this.updateFace(groups.face || [], bodyInfo, scale);
    const wrists = [bodyInfo?.leftWrist, bodyInfo?.rightWrist];
    const assignments = [null, null];
    const candidates = [...new Set([groups.leftHand, groups.rightHand, groups.hand])]
      .filter((hand) => hand?.filter((joint) => valid(joint)).length >= 3 && valid(hand[0]));
    for (const hand of candidates) {
      const handWrist = point(hand[0]);
      let bestIndex = -1;
      let bestDistance = Infinity;
      for (let index = 0; index < wrists.length; index += 1) {
        if (assignments[index] || !wrists[index]) continue;
        const candidateDistance = distance(handWrist, wrists[index]);
        if (candidateDistance < bestDistance) {
          bestDistance = candidateDistance;
          bestIndex = index;
        }
      }
      if (bestIndex >= 0) assignments[bestIndex] = hand;
    }
    const leftHandVisible = this.updateHand(assignments[0], 0, scale) ||
      this.updateFallbackHand(bodyInfo?.leftWrist, bodyInfo?.leftElbow, 0, scale, bodyInfo?.shoulderWidth || 40);
    const rightHandVisible = this.updateHand(assignments[1], 1, scale) ||
      this.updateFallbackHand(bodyInfo?.rightWrist, bodyInfo?.rightElbow, 1, scale, bodyInfo?.shoulderWidth || 40);
    this.visibleHandCount = Number(Boolean(leftHandVisible)) + Number(Boolean(rightHandVisible));
    this.renderer.render(this.scene, this.camera);
    return true;
  }
}
