import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("bundled avatar is a self-contained GLB with complete skinned hands", async () => {
  const manifest = JSON.parse(await readFile(new URL("../src/manifest.json", import.meta.url), "utf8"));
  const assets = manifest.web_accessible_resources.flatMap((entry) => entry.resources)
    .filter((name) => name.endsWith(".glb"));
  assert.equal(assets.length, 1, "only the selected runtime avatar is exposed");
  const renderer = await readFile(new URL("../src/gltf-avatar-renderer.js", import.meta.url), "utf8");
  const build = await readFile(new URL("../scripts/build.mjs", import.meta.url), "utf8");
  assert.ok(renderer.includes(`./${assets[0]}`), "renderer URL must match the manifest asset");
  assert.ok(build.includes(assets[0].split("/").at(-1)), "build must copy the selected avatar");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(manifest.version, pkg.version, "extension and package versions must match");
  const buffer = await readFile(new URL(`../src/${assets[0]}`, import.meta.url));
  assert.equal(buffer.toString("ascii", 0, 4), "glTF");
  assert.equal(buffer.readUInt32LE(4), 2);
  assert.equal(buffer.readUInt32LE(8), buffer.length);
  assert.ok(buffer.length < 60 * 1024 * 1024, "runtime asset must remain within the browser download budget");
  const gltf = JSON.parse(buffer.subarray(20, 20 + buffer.readUInt32LE(12)).toString());
  const names = new Set(gltf.nodes.map((node) => node.name));
  for (const side of ["Left", "Right"]) {
    for (const part of ["Arm", "ForeArm", "Hand"]) assert.ok(names.has(`${side}${part}`));
    for (const finger of ["Thumb", "Index", "Middle", "Ring", "Pinky"]) {
      for (const joint of [1, 2, 3, "End"]) assert.ok(names.has(`${side}Hand${finger}${joint}`));
      if (finger !== "Thumb") assert.ok(names.has(`${side}Hand${finger}Meta`));
    }
  }
  for (const side of ["L", "R"]) {
    const hand = gltf.nodes.find((node) => node.name === `YTSign_PSL_Hand_${side}`);
    assert.ok(hand && Number.isInteger(hand.skin), `${side} hand must be attached to a skin`);
    assert.ok(gltf.skins[hand.skin].joints.length >= 48);
    for (const primitive of gltf.meshes[hand.mesh].primitives) {
      for (const attribute of ["POSITION", "NORMAL", "JOINTS_0", "WEIGHTS_0"])
        assert.ok(Number.isInteger(primitive.attributes[attribute]), `${side} hand needs ${attribute}`);
    }
  }
  for (const item of [...(gltf.images || []), ...(gltf.buffers || [])])
    assert.ok(!item.uri || item.uri.startsWith("data:"), "avatar must not depend on remote assets");
});
