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
  const vector = new THREE.Vector3(
    to.X - from.X,
    -(to.Y - from.Y),
    -(Number(to.Z) - Number(from.Z)) * 0.75,
  );
  return vector.lengthSq() > 0.00001 ? vector.normalize() : null;
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
    this.ready = false;
    this.failed = false;
    this.loadPromise = this.load();
    this.resize(1, 1);
  }

  async load() {
    try {
      const source = new URL("./assets/avatar/signing-avatar.glb", import.meta.url);
      const gltf = await new GLTFLoader().loadAsync(source.href);
      this.root = gltf.scene;
      this.root.traverse((node) => {
        node.frustumCulled = false;
        if (node.isBone) this.bones.set(node.name, node);
        if (node.isMesh) {
          node.castShadow = false;
          node.receiveShadow = false;
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          for (const material of materials) {
            if (!material) continue;
            // Meshy's remeshed GLB contains small regions with inconsistent
            // triangle winding. Rendering both sides keeps the character
            // intact in Chromium without changing the authored geometry.
            material.side = THREE.DoubleSide;
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
    const fingers = ["LeftHandIndex1", "LeftHandIndex2", "LeftHandIndex3", "RightHandIndex1", "RightHandIndex2", "RightHandIndex3"];
    return [...body, ...fingers].every((name) => this.bones.has(name));
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
    // Frame from just below the hips through the top of the head. Horizontal
    // padding is based on body height, not the rest-pose hand bounds, so signs
    // with fully extended arms remain visible inside a narrow YouTube overlay.
    const bottom = this.modelBounds.min.y + size.y * 0.18;
    const top = this.modelBounds.max.y + size.y * 0.06;
    const cameraY = (bottom + top) / 2;
    const halfHeight = Math.max(0.01, (top - bottom) / 2);
    const halfWidth = Math.max(size.y * 0.5, size.x * 1.08, halfHeight * aspect);
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
    if (!body?.length) return;
    const compact = body.length <= 10;
    const leftShoulder = body[compact ? 0 : 11];
    const rightShoulder = body[compact ? 1 : 12];
    const leftElbow = body[compact ? 2 : 13];
    const rightElbow = body[compact ? 3 : 14];
    const leftWrist = body[compact ? 4 : 15];
    const rightWrist = body[compact ? 5 : 16];
    this.alignBone("LeftArm", "LeftForeArm", direction(leftShoulder, leftElbow));
    this.alignBone("LeftForeArm", "LeftHand", direction(leftElbow, leftWrist));
    this.alignBone("RightArm", "RightForeArm", direction(rightShoulder, rightElbow));
    this.alignBone("RightForeArm", "RightHand", direction(rightElbow, rightWrist));
  }

  updateHand(hand, side) {
    if (!hand?.length || !valid(hand[0])) return;
    this.alignBone(`${side}Hand`, `${side}HandMiddle1`, direction(hand[0], hand[9]));
    for (const finger of FINGERS) {
      const joints = HAND_JOINTS[finger];
      for (let index = 0; index < 3; index += 1) {
        const bone = `${side}Hand${finger}${index + 1}`;
        const child = index === 2 ? `${side}Hand${finger}End` : `${side}Hand${finger}${index + 2}`;
        this.alignBone(bone, child, direction(hand[joints[index]], hand[joints[index + 1]]));
      }
    }
  }

  draw(person, components) {
    if (!this.ready || !this.root) return false;
    this.resetBones();
    const groups = this.groupPerson(person, components);
    this.updateBody(groups.body || []);
    this.updateHand(groups.leftHand || groups.hand || [], "Left");
    this.updateHand(groups.rightHand || [], "Right");
    this.root.updateMatrixWorld(true);
    this.renderer.render(this.scene, this.camera);
    return true;
  }
}
