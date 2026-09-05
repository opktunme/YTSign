import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const BACKGROUND = 0x07131f;
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
const HAND_JOINTS = {
  Thumb: [1, 2, 3, 4],
  Index: [5, 6, 7, 8],
  Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16],
  Pinky: [17, 18, 19, 20],
};
const METACARPAL_JOINTS = { Index: 5, Middle: 9, Ring: 13, Pinky: 17 };

function valid(joint, confidence = 0.12) {
  return joint && Number.isFinite(joint.X) && Number.isFinite(joint.Y) &&
    Number.isFinite(joint.C) && joint.C > confidence;
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

function direction(from, to) {
  if (!valid(from) || !valid(to)) return null;
  const fromZ = Number.isFinite(Number(from.Z)) ? Number(from.Z) : 0;
  const toZ = Number.isFinite(Number(to.Z)) ? Number(to.Z) : 0;
  const vector = new THREE.Vector3(
    to.X - from.X,
    -(to.Y - from.Y),
    -(toZ - fromZ) * 0.75,
  );
  return vector.lengthSq() > 0.00001 ? vector.normalize() : null;
}

function signingSpaceDirection(from, to, minimumCameraDepth = 0) {
  const vector = direction(from, to);
  if (!vector) return null;
  // The generated avatar's forearms share the torso material and depth buffer.
  // A nearly planar source pose can therefore put a correctly tracked arm
  // inside the chest, producing a sleeve stump or a floating hand. Keep valid
  // source depth, but place ambiguous arm chains slightly toward the camera so
  // the signing space remains readable at overlay scale.
  vector.z = Math.max(vector.z, minimumCameraDepth);
  return vector.normalize();
}

function jointInRect(joint, rect) {
  return valid(joint) && joint.X >= rect.left && joint.X <= rect.right &&
    joint.Y >= rect.top && joint.Y <= rect.bottom;
}

function segmentIntersectsRect(from, to, rect) {
  if (!valid(from) || !valid(to)) return false;
  if (jointInRect(from, rect) || jointInRect(to, rect)) return true;
  // Sample the tracked forearm rather than relying on one endpoint. This is
  // deliberately conservative: the signer is small in the YouTube overlay,
  // so even a brief torso crossing needs the arm brought into the foreground.
  for (let step = 1; step < 8; step += 1) {
    const amount = step / 8;
    const point = {
      X: from.X + (to.X - from.X) * amount,
      Y: from.Y + (to.Y - from.Y) * amount,
      C: Math.min(from.C, to.C),
    };
    if (jointInRect(point, rect)) return true;
  }
  return false;
}

function basis(forward, across, previousNormal = null) {
  if (!forward || !across) return null;
  const y = forward.clone().normalize();
  const acrossUnit = across.clone().normalize();
  const x = acrossUnit.sub(y.clone().multiplyScalar(acrossUnit.dot(y)));
  let z;
  if (x.lengthSq() < 0.0064) {
    if (!previousNormal) return null;
    z = previousNormal.clone().sub(y.clone().multiplyScalar(previousNormal.dot(y)));
    if (z.lengthSq() < 0.0064) return null;
    z.normalize();
    x.copy(y).cross(z).normalize();
  } else {
    x.normalize();
    z = x.clone().cross(y);
    if (z.lengthSq() < 0.00001) return null;
    z.normalize();
    x.copy(y).cross(z).normalize();
  }
  // Index/pinky identities define the sign of this frame. A palm can turn
  // through 180 degrees during a sign; continuity cannot override handedness.
  return { x, y, z };
}

function signedHingeAngle(from, to, hinge) {
  if (!from || !to || !hinge || hinge.lengthSq() < 0.00001) return null;
  const axis = hinge.clone().normalize();
  const start = from.clone().addScaledVector(axis, -from.dot(axis));
  const finish = to.clone().addScaledVector(axis, -to.dot(axis));
  if (start.lengthSq() < 0.00001 || finish.lengthSq() < 0.00001) return null;
  start.normalize();
  finish.normalize();
  return Math.atan2(start.clone().cross(finish).dot(axis), start.dot(finish));
}

function wrapRadians(value) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function screenDistance(left, right) {
  if (!valid(left, 0.01) || !valid(right, 0.01)) return Infinity;
  return Math.hypot(left.X - right.X, left.Y - right.Y);
}

function averageJoint(joints) {
  const usable = joints.filter((joint) => valid(joint));
  if (!usable.length) return null;
  const total = usable.reduce((sum, joint) => ({
    X: sum.X + joint.X,
    Y: sum.Y + joint.Y,
    Z: sum.Z + (Number.isFinite(Number(joint.Z)) ? Number(joint.Z) : 0),
  }), { X: 0, Y: 0, Z: 0 });
  return {
    X: total.X / usable.length,
    Y: total.Y / usable.length,
    Z: total.Z / usable.length,
    C: Math.min(...usable.map((joint) => Number(joint.C))),
  };
}

export class GltfAvatarRenderer {
  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.setAttribute("aria-hidden", "true");
    this.canvas.dataset.avatarModel = "loading";
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
    this.renderer.toneMappingExposure = 1.12;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BACKGROUND);
    this.camera = new THREE.OrthographicCamera(-0.8, 0.8, 1.85, 0.5, 0.01, 20);
    this.camera.position.set(0, 1.19, 4);
    this.camera.lookAt(0, 1.19, 0);

    this.scene.add(new THREE.HemisphereLight(0xffeadc, 0x17304a, 2.25));
    const key = new THREE.DirectionalLight(0xffdcc3, 3.25);
    key.position.set(-2.4, 4.2, 4.8);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8fcaff, 1.45);
    fill.position.set(2.8, 2.0, 3.2);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 1.15);
    rim.position.set(0.4, 3.8, -3.2);
    this.scene.add(rim);

    this.width = 1;
    this.height = 1;
    this.modelBounds = null;
    this.root = null;
    this.bones = new Map();
    this.rest = new Map();
    this.previous = new Map();
    this.palmNormals = new Map();
    this.handDriveCounts = { Left: 0, Right: 0 };
    this.missingHandControls = { Left: [], Right: [] };
    this.fingerRest = new Map();
    this.palmNormalSigns = { Left: -1, Right: 1 };
    this.driven = new Set();
    this.metacarpalRest = new Map();
    this.thumbRest = new Map();
    this.lastFrameAt = 0;
    this.lastPoseTime = null;
    this.visibleHandCount = 0;
    this.ready = false;
    this.failed = false;
    this.loadPromise = this.load();
    this.resize(1, 1);
  }

  async load() {
    try {
      const source = new URL("./assets/avatar/signing-avatar-v6q3.glb", import.meta.url);
      const gltf = await new GLTFLoader().loadAsync(source.href);
      this.root = gltf.scene;
      this.root.traverse((node) => {
        node.frustumCulled = false;
        if (node.isBone) this.bones.set(node.name, node);
        if (node.isMesh) {
          // The small add-on nail plates are cosmetic meshes, not part of the
          // anatomical hand surface. Under a tightly curled tracked pose they
          // can cross the fingertip and appear as false holes/disks through the
          // palm. The hand texture already carries a natural nail treatment,
          // so omit the plates from the real-time signing surface.
          if (node.name.startsWith("YTSign_Nail_")) node.visible = false;
          node.castShadow = false;
          node.receiveShadow = false;
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          const handSurface = node.name.startsWith("YTSign_PSL_Hand_");
          const nailSurface = node.name.startsWith("YTSign_Nail_");
          for (const material of materials) {
            if (!material) continue;
            // Meshy's remeshed GLB contains small regions with inconsistent
            // triangle winding. Rendering both sides keeps the character
            // intact in Chromium without changing the authored geometry.
            // Hands and nail plates are known-manifold signing surfaces. Keep
            // their authored front faces so a folded backface cannot masquerade
            // as another finger or nail during a sign.
            const nailMaterial = material.name.startsWith("YTSign_Nail_Material");
            // The continuous hand skin occasionally develops a few locally
            // inverted triangles at an extreme curl under linear skinning.
            // It is still a closed, manifold surface; render both sides so a
            // transient winding flip cannot punch a visual hole. Decorative
            // nail plates remain hidden and front-only.
            const handMaterial = material.name.startsWith("YTSign_Hybrid_Hand_Skin_");
            if (handSurface || handMaterial) {
              // The hand material was accidentally exported as alpha BLEND.
              // WebGL then depth-sorted triangles inside one skinned hand and
              // exposed star-shaped gaps at finger contacts. Skin is opaque.
              material.transparent = false;
              material.opacity = 1;
              material.alphaTest = 0;
              material.depthTest = true;
              material.depthWrite = true;
              material.blending = THREE.NoBlending;
              material.premultipliedAlpha = false;
            }
            material.side = nailSurface || nailMaterial
              ? THREE.FrontSide
              : THREE.DoubleSide;
            material.needsUpdate = true;
          }
        }
      });
      for (const [name, bone] of this.bones) {
        this.rest.set(name, {
          position: bone.position.clone(),
          quaternion: bone.quaternion.clone(),
          scale: bone.scale.clone(),
        });
      }
      this.scene.add(this.root);
      this.root.updateMatrixWorld(true);
      this.captureFingerRest();
      this.modelBounds = new THREE.Box3().setFromObject(this.root);
      const boundsSize = this.modelBounds.getSize(new THREE.Vector3());
      this.canvas.dataset.avatarBounds = [boundsSize.x, boundsSize.y, boundsSize.z]
        .map((value) => value.toFixed(4)).join(",");
      this.configureCamera();
      this.ready = this.requiredBonesPresent();
      if (!this.ready) throw new Error("The signing avatar is missing required arm or finger bones");
      this.canvas.dataset.avatarModel = "ready";
    } catch (error) {
      this.failed = true;
      this.canvas.dataset.avatarModel = "failed";
      console.warn("Realistic avatar unavailable; retaining the procedural fallback.", error);
    }
  }

  requiredBonesPresent() {
    const body = ["LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand"];
    const hands = [];
    for (const side of ["Left", "Right"]) {
      for (const finger of ["Index", "Middle", "Ring", "Pinky"]) {
        hands.push(`${side}Hand${finger}Meta`);
      }
      for (const finger of FINGERS) {
        hands.push(
          `${side}Hand${finger}1`,
          `${side}Hand${finger}2`,
          `${side}Hand${finger}3`,
          `${side}Hand${finger}End`,
        );
      }
    }
    return [...body, ...hands].every((name) => this.bones.has(name));
  }

  resetSmoothing() {
    this.previous.clear();
    this.palmNormals.clear();
    this.lastFrameAt = 0;
    this.lastPoseTime = null;
  }

  resize(width, height) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.renderer.setPixelRatio(Math.min(1.35, globalThis.devicePixelRatio || 1));
    this.renderer.setSize(this.width, this.height, false);
    this.configureCamera();
  }

  configureCamera() {
    if (!this.modelBounds || this.modelBounds.isEmpty()) return;
    const aspect = this.width / this.height;
    const size = this.modelBounds.getSize(new THREE.Vector3());
    const center = this.modelBounds.getCenter(new THREE.Vector3());
    // This is a signing interpreter, not a full-body character shot. Frame the
    // head, shoulders, hands, and waist at useful scale; the legs are
    // intentionally cropped. Preserve enough horizontal room for the normal
    // signing envelope and expand vertically when the host canvas is narrow.
    const bottom = this.modelBounds.min.y + size.y * 0.42;
    const top = this.modelBounds.max.y + size.y * 0.03;
    const cameraY = (bottom + top) / 2;
    const contentHalfHeight = Math.max(0.01, (top - bottom) / 2);
    const halfWidth = Math.max(size.y * 0.39, size.x * 0.82, contentHalfHeight * aspect);
    const halfHeight = Math.max(contentHalfHeight, halfWidth / Math.max(aspect, 0.01));
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    // Orthographic frustum coordinates are camera-local; the camera position
    // already carries the world-space vertical offset.
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    const distance = Math.max(size.x, size.y, size.z, 1) * 3;
    this.camera.near = Math.max(0.001, distance / 1000);
    this.camera.far = distance * 4;
    this.camera.position.set(center.x, cameraY, center.z + distance);
    this.camera.lookAt(center.x, cameraY, center.z);
    this.camera.updateProjectionMatrix();
  }

  resetBones() {
    for (const [name, transform] of this.rest) {
      const bone = this.bones.get(name);
      bone.position.copy(transform.position);
      bone.quaternion.copy(transform.quaternion);
      bone.scale.copy(transform.scale);
    }
    this.root.updateMatrixWorld(true);
  }

  captureFingerRest() {
    const position = (name) => this.bones.get(name)?.getWorldPosition(new THREE.Vector3());
    for (const side of ["Left", "Right"]) {
      const wrist = position(`${side}Hand`);
      const middle = position(`${side}HandMiddle1`);
      const index = position(`${side}HandIndex1`);
      const pinky = position(`${side}HandPinky1`);
      if (!wrist || !middle || !index || !pinky) continue;
      const frame = basis(middle.clone().sub(wrist), index.clone().sub(pinky));
      if (!frame) continue;
      const sign = frame.z.z < 0 ? -1 : 1;
      this.palmNormalSigns[side] = sign;
      const normal = frame.z.clone().multiplyScalar(sign);
      const palmForward = middle.clone().sub(wrist).normalize();
      for (const finger of ["Index", "Middle", "Ring", "Pinky"]) {
        const name = `${side}Hand${finger}Meta`;
        const bone = this.bones.get(name);
        const ray = position(`${side}Hand${finger}1`).clone().sub(wrist).normalize();
        const angle = signedHingeAngle(palmForward, ray, normal);
        const inverse = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
        this.metacarpalRest.set(name, {
          axis: normal.clone().applyQuaternion(inverse).normalize(),
          angle: angle ?? 0,
        });
      }
      for (const finger of ["Index", "Middle", "Ring", "Pinky"]) {
        const names = [1, 2, 3].map((joint) => `${side}Hand${finger}${joint}`);
        const points = [wrist, ...names.map(position), position(`${side}Hand${finger}End`)];
        const base = points[1].clone().sub(points[0]).normalize();
        const hinge = base.clone().cross(normal).normalize();
        for (let joint = 0; joint < 3; joint += 1) {
          const bone = this.bones.get(names[joint]);
          const previous = points[joint + 1].clone().sub(points[joint]).normalize();
          const forward = points[joint + 2].clone().sub(points[joint + 1]).normalize();
          const inverse = bone.getWorldQuaternion(new THREE.Quaternion()).invert();
          const bend = signedHingeAngle(previous, forward, hinge) ?? 0;
          this.fingerRest.set(names[joint], {
            axis: hinge.clone().applyQuaternion(inverse).normalize(),
            bend,
          });
        }
      }

      const thumbNames = [1, 2, 3].map((joint) => `${side}HandThumb${joint}`);
      const thumbPoints = thumbNames.map(position);
      thumbPoints.push(position(`${side}HandThumbEnd`));
      const thumbBase = this.bones.get(thumbNames[0]);
      const thumbBaseInverse = thumbBase.getWorldQuaternion(new THREE.Quaternion()).invert();
      const thumbMcp = this.bones.get(thumbNames[1]);
      const thumbFlexAxis = new THREE.Vector3(1, 0, 0)
        .applyQuaternion(thumbMcp.getWorldQuaternion(new THREE.Quaternion())).normalize();
      this.thumbRest.set(thumbNames[0], {
        forward: thumbPoints[1].clone().sub(thumbPoints[0]).normalize()
          .applyQuaternion(thumbBaseInverse).normalize(),
        hinge: thumbFlexAxis.applyQuaternion(thumbBaseInverse).normalize(),
      });
      for (let joint = 1; joint < 3; joint += 1) {
        const name = thumbNames[joint];
        const bone = this.bones.get(name);
        const axisWorld = new THREE.Vector3(1, 0, 0)
          .applyQuaternion(bone.getWorldQuaternion(new THREE.Quaternion())).normalize();
        const previous = thumbPoints[joint].clone().sub(thumbPoints[joint - 1]).normalize();
        const forward = thumbPoints[joint + 1].clone().sub(thumbPoints[joint]).normalize();
        this.thumbRest.set(name, {
          axis: new THREE.Vector3(1, 0, 0),
          bend: signedHingeAngle(previous, forward, axisWorld) ?? 0,
          angle: previous.angleTo(forward),
        });
      }
    }
  }

  articulateMetacarpal(hand, side, finger, palmForward, palmNormal) {
    const landmark = METACARPAL_JOINTS[finger];
    const name = `${side}Hand${finger}Meta`;
    const bone = this.bones.get(name);
    const rest = this.metacarpalRest.get(name);
    const ray = direction(hand[0], hand[landmark]);
    if (!bone || !rest || !ray || !palmForward || !palmNormal) return 0;
    const targetAngle = signedHingeAngle(palmForward, ray, palmNormal);
    if (targetAngle === null) return 0;
    const delta = THREE.MathUtils.clamp(
      wrapRadians(targetAngle - rest.angle),
      -18 * Math.PI / 180,
      18 * Math.PI / 180,
    );
    bone.quaternion.copy(this.rest.get(name).quaternion).multiply(
      new THREE.Quaternion().setFromAxisAngle(rest.axis, delta),
    );
    this.driven.add(name);
    return 1;
  }

  articulateFinger(hand, side, finger, normal) {
    const joints = HAND_JOINTS[finger];
    const base = direction(hand[0], hand[joints[0]]);
    if (!base || !normal) return 0;
    const hinge = base.clone().cross(normal).normalize();
    let count = 0;
    for (let joint = 0; joint < 3; joint += 1) {
      const name = `${side}Hand${finger}${joint + 1}`;
      const previous = joint === 0 ? base : direction(hand[joints[joint - 1]], hand[joints[joint]]);
      const forward = direction(hand[joints[joint]], hand[joints[joint + 1]]);
      const rest = this.fingerRest.get(name);
      const bone = this.bones.get(name);
      if (!previous || !forward || !rest || !bone) continue;
      const bend = signedHingeAngle(previous, forward, hinge);
      if (bend === null) continue;
      // Tracking noise can produce 120+ degree MCP bends or sideways PIP
      // rotations. The anatomical rig has a hinge at each phalanx. Retarget
      // the observed bend onto that hinge, preserving distinct MCP/PIP/DIP
      // motion while keeping fingertips from folding through the palm.
      const limits = joint === 0 ? [-10, 95] : joint === 1 ? [-5, 110] : [-5, 85];
      const delta = THREE.MathUtils.clamp(
        wrapRadians(bend - rest.bend),
        limits[0] * Math.PI / 180,
        limits[1] * Math.PI / 180,
      );
      bone.quaternion.copy(this.rest.get(name).quaternion).multiply(
        new THREE.Quaternion().setFromAxisAngle(rest.axis, delta),
      );
      this.driven.add(name);
      count += 1;
    }
    this.root.updateMatrixWorld(true);
    return count;
  }

  fitThumbBaseDelta(restForward, restHinge, targetForward, targetHinge) {
    // A direction by itself leaves roll around the thumb ray unconstrained.
    // That ambiguity was enough to put a correctly aimed thumb *surface*
    // through the palm. The CMC is a saddle joint, so fit both its first ray
    // and the positive MCP-flexion plane, then decompose the result into the
    // donor rig's authored local XYZ controls (flex, roll, opposition).
    const restFrame = basis(restForward, restHinge);
    const targetFrame = basis(targetForward, targetHinge);
    if (restFrame && targetFrame) {
      const restMatrix = new THREE.Matrix4().makeBasis(
        restFrame.x, restFrame.y, restFrame.z,
      );
      const targetMatrix = new THREE.Matrix4().makeBasis(
        targetFrame.x, targetFrame.y, targetFrame.z,
      );
      const restQuaternion = new THREE.Quaternion().setFromRotationMatrix(restMatrix);
      const targetQuaternion = new THREE.Quaternion().setFromRotationMatrix(targetMatrix);
      const delta = targetQuaternion.multiply(restQuaternion.invert());
      const euler = new THREE.Euler().setFromQuaternion(delta, "XYZ");
      // These are the largest combined CMC ranges exercised cleanly by the
      // donor's authored C/O/fist calibration poses. Wider combinations may
      // aim the bone a few degrees closer to noisy landmarks, but tear the
      // thumb web under browser-compatible linear skinning.
      euler.x = THREE.MathUtils.clamp(euler.x, -12 * Math.PI / 180, 24 * Math.PI / 180);
      euler.y = THREE.MathUtils.clamp(euler.y, -12 * Math.PI / 180, 12 * Math.PI / 180);
      euler.z = THREE.MathUtils.clamp(euler.z, -42 * Math.PI / 180, 42 * Math.PI / 180);
      return new THREE.Quaternion().setFromEuler(euler);
    }

    // Nearly straight or briefly noisy thumb landmarks do not define a stable
    // flexion plane. Fall back to a bounded two-axis ray fit and retain zero
    // roll rather than inventing axial rotation.
    const candidate = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const euler = new THREE.Euler(0, 0, 0, "XYZ");
    let best = { flex: 0, spread: 0, score: -Infinity };
    const search = (flexMinimum, flexMaximum, spreadMinimum, spreadMaximum, step) => {
      for (let flex = flexMinimum; flex <= flexMaximum + step * 0.25; flex += step) {
        for (let spread = spreadMinimum; spread <= spreadMaximum + step * 0.25; spread += step) {
          euler.set(flex * Math.PI / 180, 0, spread * Math.PI / 180, "XYZ");
          quaternion.setFromEuler(euler);
          candidate.copy(restForward).applyQuaternion(quaternion).normalize();
          const score = candidate.dot(targetForward);
          if (score > best.score) best = { flex, spread, score };
        }
      }
    };
    search(-12, 24, -42, 42, 4);
    search(best.flex - 5, best.flex + 5, best.spread - 5, best.spread + 5, 1);
    search(best.flex - 1, best.flex + 1, best.spread - 1, best.spread + 1, 0.25);
    euler.set(best.flex * Math.PI / 180, 0, best.spread * Math.PI / 180, "XYZ");
    return quaternion.setFromEuler(euler).clone();
  }

  articulateThumb(hand, side) {
    const names = [1, 2, 3].map((joint) => `${side}HandThumb${joint}`);
    const base = this.bones.get(names[0]);
    const baseRest = this.thumbRest.get(names[0]);
    const firstTarget = direction(hand[1], hand[2]);
    const secondTarget = direction(hand[2], hand[3]);
    if (!base || !baseRest || !firstTarget) return 0;

    this.root.updateMatrixWorld(true);
    const inverseWorld = base.getWorldQuaternion(new THREE.Quaternion()).invert();
    const targetLocal = firstTarget.clone().applyQuaternion(inverseWorld).normalize();
    let targetHingeLocal = null;
    if (secondTarget) {
      const targetHinge = firstTarget.clone().cross(secondTarget);
      // Plane estimates below about five degrees are dominated by landmark
      // noise, so let the direction-only fallback handle those frames.
      if (targetHinge.lengthSq() > 0.0076) {
        targetHingeLocal = targetHinge.normalize().applyQuaternion(inverseWorld).normalize();
      }
    }
    const baseDelta = this.fitThumbBaseDelta(
      baseRest.forward,
      baseRest.hinge,
      targetLocal,
      targetHingeLocal,
    );
    base.quaternion.copy(this.rest.get(names[0]).quaternion).multiply(baseDelta);
    this.driven.add(names[0]);
    this.root.updateMatrixWorld(true);

    let count = 1;
    for (let joint = 1; joint < 3; joint += 1) {
      const name = names[joint];
      const bone = this.bones.get(name);
      const rest = this.thumbRest.get(name);
      const previous = direction(hand[joint], hand[joint + 1]);
      const forward = direction(hand[joint + 1], hand[joint + 2]);
      if (!bone || !rest || !previous || !forward) continue;
      const bend = previous.angleTo(forward);
      // The exported LBS skin is verified through 38-40 degrees at these
      // joints; larger independent bends can make the distal thumb cross the
      // web even though the source landmark angle itself remains valid.
      const limits = joint === 1 ? [-5, 38] : [-5, 40];
      const delta = THREE.MathUtils.clamp(
        bend - rest.angle,
        limits[0] * Math.PI / 180,
        limits[1] * Math.PI / 180,
      );
      bone.quaternion.copy(this.rest.get(name).quaternion).multiply(
        new THREE.Quaternion().setFromAxisAngle(rest.axis, delta),
      );
      this.driven.add(name);
      this.root.updateMatrixWorld(true);
      count += 1;
    }
    return count;
  }

  alignBone(boneName, childName, targetDirection) {
    if (!targetDirection) return false;
    const bone = this.bones.get(boneName);
    const child = this.bones.get(childName);
    if (!bone || !child) return false;

    this.root.updateMatrixWorld(true);
    const start = bone.getWorldPosition(new THREE.Vector3());
    const finish = child.getWorldPosition(new THREE.Vector3());
    const currentDirection = finish.sub(start).normalize();
    if (currentDirection.lengthSq() < 0.00001) return false;

    const currentWorld = bone.getWorldQuaternion(new THREE.Quaternion());
    const delta = new THREE.Quaternion().setFromUnitVectors(currentDirection, targetDirection);
    const desiredWorld = delta.multiply(currentWorld);
    const parentWorld = bone.parent?.getWorldQuaternion(new THREE.Quaternion()) || new THREE.Quaternion();
    bone.quaternion.copy(parentWorld.invert().multiply(desiredWorld));
    this.driven.add(boneName);
    this.root.updateMatrixWorld(true);
    return true;
  }

  alignBoneFrame(boneName, forwardChildName, acrossFromName, acrossToName, targetForward, targetAcross, frameKey = boneName) {
    if (!targetForward || !targetAcross) return false;
    const bone = this.bones.get(boneName);
    const forwardChild = this.bones.get(forwardChildName);
    const acrossFrom = this.bones.get(acrossFromName);
    const acrossTo = this.bones.get(acrossToName);
    if (!bone || !forwardChild || !acrossFrom || !acrossTo) return false;

    this.root.updateMatrixWorld(true);
    const origin = bone.getWorldPosition(new THREE.Vector3());
    const currentForward = forwardChild.getWorldPosition(new THREE.Vector3()).sub(origin);
    const currentAcross = acrossTo.getWorldPosition(new THREE.Vector3())
      .sub(acrossFrom.getWorldPosition(new THREE.Vector3()));
    const currentBasis = basis(currentForward, currentAcross);
    const targetBasis = basis(targetForward, targetAcross, this.palmNormals.get(frameKey));
    if (!currentBasis || !targetBasis) return false;
    this.palmNormals.set(frameKey, targetBasis.z.clone());

    const currentFrame = new THREE.Matrix4().makeBasis(
      currentBasis.x,
      currentBasis.y,
      currentBasis.z,
    );
    const targetFrame = new THREE.Matrix4().makeBasis(
      targetBasis.x,
      targetBasis.y,
      targetBasis.z,
    );
    const currentFrameQuaternion = new THREE.Quaternion().setFromRotationMatrix(currentFrame);
    const targetFrameQuaternion = new THREE.Quaternion().setFromRotationMatrix(targetFrame);
    const delta = targetFrameQuaternion.multiply(currentFrameQuaternion.invert());
    const currentWorld = bone.getWorldQuaternion(new THREE.Quaternion());
    const desiredWorld = delta.multiply(currentWorld);
    const parentWorld = bone.parent?.getWorldQuaternion(new THREE.Quaternion()) || new THREE.Quaternion();
    bone.quaternion.copy(parentWorld.invert().multiply(desiredWorld));
    this.driven.add(boneName);
    this.root.updateMatrixWorld(true);
    return true;
  }

  groupPerson(person, components) {
    const groups = { body: null, face: null, leftHand: null, rightHand: null, hand: null };
    for (const component of components) {
      const kind = componentKind(component.name);
      if (kind !== "other" && !groups[kind]) groups[kind] = person[component.name] || null;
    }
    return groups;
  }

  updateBody(body) {
    if (!body?.length) return null;
    const compact = body.length <= 10;
    // sign.mt's compact body order is L/R shoulder, L/R elbow, L/R wrist,
    // L/R hip. MediaPipe's full body layout uses the familiar L/R indices.
    const leftShoulder = body[compact ? 0 : 11];
    const rightShoulder = body[compact ? 1 : 12];
    const leftElbow = body[compact ? 2 : 13];
    const rightElbow = body[compact ? 3 : 14];
    const leftWrist = body[compact ? 4 : 15];
    const rightWrist = body[compact ? 5 : 16];
    const leftHip = body[compact ? 6 : 23];
    const rightHip = body[compact ? 7 : 24];
    const shouldersValid = valid(leftShoulder) && valid(rightShoulder);
    const shoulderSpan = shouldersValid
      ? Math.max(1, Math.abs(rightShoulder.X - leftShoulder.X))
      : 120;
    const shoulderY = shouldersValid ? (leftShoulder.Y + rightShoulder.Y) / 2 : 240;
    const hipsValid = valid(leftHip) && valid(rightHip);
    const hipY = hipsValid ? (leftHip.Y + rightHip.Y) / 2 : shoulderY + shoulderSpan * 1.75;
    const torsoRect = {
      left: Math.min(leftShoulder?.X ?? Infinity, rightShoulder?.X ?? Infinity,
        leftHip?.X ?? Infinity, rightHip?.X ?? Infinity) - shoulderSpan * 0.12,
      right: Math.max(leftShoulder?.X ?? -Infinity, rightShoulder?.X ?? -Infinity,
        leftHip?.X ?? -Infinity, rightHip?.X ?? -Infinity) + shoulderSpan * 0.12,
      // Include the near-face signing zone: a forearm travelling from the torso
      // toward the cheek must remain visibly connected to its sleeve.
      top: shoulderY - shoulderSpan * 1.10,
      bottom: hipY + shoulderSpan * 0.08,
    };
    const updateArm = (side, shoulder, elbow, wrist) => {
      const crossesTorso = shouldersValid && segmentIntersectsRect(elbow, wrist, torsoRect);
      // These values yield roughly 10-12 cm of elbow clearance and 18-20 cm at
      // the wrist on this rig. Away from the torso we preserve captured depth.
      const upper = signingSpaceDirection(shoulder, elbow, crossesTorso ? 0.46 : 0.05);
      const lower = signingSpaceDirection(elbow, wrist, crossesTorso ? 0.88 : 0.10);
      // Never rotate only half of a kinematic chain. Low-confidence wrists are
      // common in generated pose streams; moving the upper arm while leaving
      // the forearm at rest is what creates the apparent amputated silhouette.
      if (!upper || !lower) return;
      this.alignBone(`${side}Arm`, `${side}ForeArm`, upper);
      this.alignBone(`${side}ForeArm`, `${side}Hand`, lower);
    };
    updateArm("Left", leftShoulder, leftElbow, leftWrist);
    updateArm("Right", rightShoulder, rightElbow, rightWrist);
    return { leftWrist, rightWrist };
  }

  matchHands(groups, bodyInfo) {
    const usable = (hand) => hand?.filter((joint) => valid(joint)).length >= 4 && valid(hand[0]);
    const assignments = {
      Left: usable(groups.leftHand) ? groups.leftHand : null,
      Right: usable(groups.rightHand) ? groups.rightHand : null,
    };
    // Explicit LEFT/RIGHT component identities are semantic and remain stable
    // when hands cross. Only an unlabeled generic hand uses wrist proximity.
    if (!usable(groups.hand) || groups.hand === assignments.Left || groups.hand === assignments.Right) {
      return assignments;
    }
    const wrists = { Left: bodyInfo?.leftWrist, Right: bodyInfo?.rightWrist };
    let bestSide = null;
    let bestDistance = Infinity;
    for (const side of ["Left", "Right"]) {
      if (assignments[side]) continue;
      const candidateDistance = screenDistance(groups.hand[0], wrists[side]);
      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        bestSide = side;
      }
    }
    assignments[bestSide || "Left"] = groups.hand;
    return assignments;
  }

  updateHand(hand, side) {
    this.handDriveCounts[side] = 0;
    this.missingHandControls[side] = [];
    if (!hand?.length || !valid(hand[0])) return false;
    let aligned = 0;
    const palmCenter = averageJoint([hand[5], hand[9], hand[13], hand[17]]);
    const wristToMiddle = direction(hand[0], palmCenter);
    const pinkyToIndex = direction(hand[17], hand[5]);
    if (pinkyToIndex && this.driven.has(`${side}ForeArm`)) {
      this.twistForearm(side, pinkyToIndex);
    }
    const palmAligned = this.alignBoneFrame(
      `${side}Hand`,
      `${side}HandMiddle1`,
      `${side}HandPinky1`,
      `${side}HandIndex1`,
      wristToMiddle,
      pinkyToIndex,
      side,
    );
    aligned += Number(palmAligned);
    if (!palmAligned) this.missingHandControls[side].push(`${side}Hand`);
    const palmNormal = this.palmNormals.get(side)?.clone().multiplyScalar(this.palmNormalSigns[side]);
    for (const finger of Object.keys(METACARPAL_JOINTS)) {
      const bone = `${side}Hand${finger}Meta`;
      const didAlign = this.articulateMetacarpal(
        hand, side, finger, wristToMiddle, palmNormal,
      );
      aligned += didAlign;
      if (!didAlign) this.missingHandControls[side].push(bone);
    }
    for (const finger of FINGERS) {
      if (finger !== "Thumb") {
        aligned += this.articulateFinger(hand, side, finger, palmNormal);
        for (let joint = 1; joint <= 3; joint += 1) {
          const name = `${side}Hand${finger}${joint}`;
          if (!this.driven.has(name)) this.missingHandControls[side].push(name);
        }
        continue;
      }
      const thumbAligned = this.articulateThumb(hand, side);
      aligned += thumbAligned;
      for (let joint = 1; joint <= 3; joint += 1) {
        const name = `${side}HandThumb${joint}`;
        if (!this.driven.has(name)) this.missingHandControls[side].push(name);
      }
    }
    this.handDriveCounts[side] = aligned;
    return aligned === 20;
  }

  twistForearm(side, targetAcross) {
    const forearm = this.bones.get(`${side}ForeArm`);
    const hand = this.bones.get(`${side}Hand`);
    const index = this.bones.get(`${side}HandIndex1`);
    const pinky = this.bones.get(`${side}HandPinky1`);
    if (!forearm || !hand || !index || !pinky) return;
    const axis = hand.getWorldPosition(new THREE.Vector3())
      .sub(forearm.getWorldPosition(new THREE.Vector3())).normalize();
    const across = index.getWorldPosition(new THREE.Vector3())
      .sub(pinky.getWorldPosition(new THREE.Vector3()));
    across.addScaledVector(axis, -across.dot(axis));
    const target = targetAcross.clone().addScaledVector(axis, -targetAcross.dot(axis));
    if (across.lengthSq() < 1e-6 || target.lengthSq() < 0.005) return;
    across.normalize(); target.normalize();
    const angle = Math.atan2(axis.dot(across.clone().cross(target)), across.dot(target));
    // Pronation belongs to the forearm. Placing the entire turn in the wrist
    // folds the wrist-weighted palm against the forearm-weighted skin.
    const desired = new THREE.Quaternion().setFromAxisAngle(axis, angle)
      .multiply(forearm.getWorldQuaternion(new THREE.Quaternion()));
    const parent = forearm.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    forearm.quaternion.copy(parent.multiply(desired));
    this.root.updateMatrixWorld(true);
  }

  applyTemporalSmoothing(poseTime) {
    const now = performance.now();
    const elapsed = this.lastFrameAt ? Math.min(0.2, Math.max(0, (now - this.lastFrameAt) / 1000)) : 1;
    const validPoseTime = Number.isFinite(poseTime);
    const poseJump = validPoseTime && this.lastPoseTime !== null
      ? Math.abs(poseTime - this.lastPoseTime)
      : 0;
    // Normal 25 fps playback is filtered. Scrubbing, test seeks, phrase
    // changes, and throttling gaps must land immediately on the requested
    // handshape instead of asymptotically approaching it.
    const discontinuity = !this.lastFrameAt || elapsed > 0.16 || poseJump > 0.12;
    const alpha = discontinuity ? 1 : 1 - Math.exp(-elapsed * 28);
    const currentPoseTime = validPoseTime ? poseTime : (this.lastPoseTime ?? 0) + elapsed;
    for (const [name, previous] of this.previous) {
      const bone = this.bones.get(name);
      if (!bone) continue;
      if (this.driven.has(name)) {
        const target = bone.quaternion.clone();
        bone.quaternion.copy(previous.quaternion).slerp(target, alpha);
      } else {
        const age = Math.max(0, currentPoseTime - previous.lastSeenPoseTime);
        const rest = this.rest.get(name)?.quaternion;
        if (age <= 0.08 || !rest) {
          // Bridge one or two low-confidence source frames without popping.
          bone.quaternion.copy(previous.quaternion);
        } else if (age >= 0.35) {
          // A missing hand is no longer signing: release it instead of
          // freezing the previous lexical handshape indefinitely.
          bone.quaternion.copy(rest);
          this.previous.delete(name);
        } else {
          const release = 1 - Math.exp(-(age - 0.08) * 14);
          bone.quaternion.copy(previous.quaternion).slerp(rest, release);
          this.previous.set(name, {
            quaternion: bone.quaternion.clone(),
            lastSeenPoseTime: previous.lastSeenPoseTime,
          });
        }
      }
    }
    this.root.updateMatrixWorld(true);
    for (const name of this.driven) {
      const bone = this.bones.get(name);
      if (bone) this.previous.set(name, {
        quaternion: bone.quaternion.clone(),
        lastSeenPoseTime: currentPoseTime,
      });
    }
    this.lastFrameAt = now;
    if (validPoseTime) this.lastPoseTime = poseTime;
  }

  draw(person, components, poseTime = null) {
    if (!this.ready || !this.root) return false;
    this.resetBones();
    this.driven.clear();
    const groups = this.groupPerson(person, components);
    const bodyInfo = this.updateBody(groups.body || []);
    const hands = this.matchHands(groups, bodyInfo);
    const leftVisible = this.updateHand(hands.Left || [], "Left");
    const rightVisible = this.updateHand(hands.Right || [], "Right");
    this.trackedHandCount = Number(leftVisible) + Number(rightVisible);
    // The anatomical meshes are always present even when a source frame has
    // low-confidence landmarks for only one hand. Missing tracking holds the
    // last reliable pose (or neutral), so neither hand disappears.
    this.visibleHandCount = this.trackedHandCount;
    const signatureBones = [
      "LeftArm", "LeftForeArm", "LeftHand", "LeftHandThumb1", "LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3",
      "RightArm", "RightForeArm", "RightHand", "RightHandThumb1", "RightHandIndex1", "RightHandIndex2", "RightHandIndex3",
    ];
    const signature = () => signatureBones.map((name) => {
      const quaternion = this.bones.get(name)?.quaternion;
      return quaternion ? [quaternion.x, quaternion.y, quaternion.z, quaternion.w]
        .map((value) => value.toFixed(3)).join(",") : "missing";
    }).join("|");
    this.canvas.dataset.targetBoneSignature = signature();
    this.canvas.dataset.poseTime = Number.isFinite(poseTime) ? poseTime.toFixed(4) : "";
    this.applyTemporalSmoothing(poseTime);
    this.root.updateMatrixWorld(true);
    this.canvas.dataset.drivenBones = String(this.driven.size);
    this.canvas.dataset.trackedHands = String(this.trackedHandCount);
    this.canvas.dataset.leftHandBones = String(this.handDriveCounts.Left);
    this.canvas.dataset.rightHandBones = String(this.handDriveCounts.Right);
    this.canvas.dataset.leftMissingHandControls = this.missingHandControls.Left.join(",");
    this.canvas.dataset.rightMissingHandControls = this.missingHandControls.Right.join(",");
    this.canvas.dataset.boneSignature = signature();
    this.renderer.render(this.scene, this.camera);
    return true;
  }
}

// The renderer lives inside a sandboxed extension frame. Exposing only a
// factory (not user data or extension APIs) lets the browser smoke test create
// an independent rig and prove every finger control without racing playback.
globalThis.__ytsignCreateGltfAvatarRenderer = () => new GltfAvatarRenderer();
