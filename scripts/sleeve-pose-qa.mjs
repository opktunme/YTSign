// Compare body skinning with identical captured runtime bone transforms.
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [reportArg, ...modelArgs] = process.argv.slice(2);
if (!reportArg || !modelArgs.length) throw new Error("Expected runtime report then one or more GLB paths");
const source = JSON.parse(await readFile(resolve(root, reportArg), "utf8"));
const frames = [["neutral", null], ...[["aunty-psl", .08], ["salam-psl", .4]].map(([name, fraction]) =>
  [`${name}-${Math.round(fraction * 100)}`, source.poses.find(p => p.name === name).frames.find(f => f.fraction === fraction)])];
const run = resolve(root, "work/avatar/sleeve-qa", new Date().toISOString().replace(/[:.]/gu, "-"));
await mkdir(run, { recursive: true });
const entry = await build({ stdin: { resolveDir: root, contents:
  'import {GltfAvatarRenderer} from "./src/gltf-avatar-renderer.js";import * as THREE from "three";globalThis.qa={GltfAvatarRenderer,THREE};' },
  bundle: true, format: "esm", platform: "browser", write: false });
let model;
const server = createServer(async (req, res) => {
  try {
    if (req.url === "/") res.setHeader("content-type", "text/html"), res.end('<body style="margin:0"><script type="module" src="/qa.js"></script>');
    else if (req.url === "/qa.js") res.setHeader("content-type", "text/javascript"), res.end(entry.outputFiles[0].text);
    else if (req.url.endsWith(".glb")) res.setHeader("content-type", "model/gltf-binary"), res.end(await readFile(model));
    else res.writeHead(404).end();
  } catch (error) { res.writeHead(500).end(String(error)); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const context = await chromium.launchPersistentContext(resolve(run, "browser"), {
  executablePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  headless: true, viewport: { width: 640, height: 520 }, args: ["--disable-sync", "--no-first-run"],
});
const results = [];
try {
  for (const [variant, modelArg] of modelArgs.entries()) {
    model = resolve(root, modelArg);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => globalThis.qa);
    await page.evaluate(async () => {
      const avatar = new qa.GltfAvatarRenderer(); avatar.resize(640, 520); await avatar.loadPromise;
      if (!avatar.ready) throw new Error("model unavailable");
      document.body.append(avatar.canvas); globalThis.avatar = avatar;
    });
    for (const [name, frame] of frames) {
      const metrics = await page.evaluate(frame => {
        avatar.resetBones();
        const restPositions = new Map();
        const meshNames = [];
        avatar.root.traverse(mesh => {
          if (!mesh.isSkinnedMesh) return;
          meshNames.push(mesh.name);
          if (!mesh.name.startsWith("YTSign_PSL_Signer_Body")) return;
          mesh.skeleton.update();
          restPositions.set(mesh, Array.from({length:mesh.geometry.attributes.position.count}, (_, i) =>
            mesh.getVertexPosition(i,new qa.THREE.Vector3()).applyMatrix4(mesh.matrixWorld)));
        });
        if (frame) for (const [name, transform] of Object.entries(frame.bones)) {
          const bone = avatar.bones.get(name); if (bone) bone.quaternion.fromArray(transform.quaternion);
        }
        avatar.root.updateMatrixWorld(true);
        avatar.configureCamera(); avatar.renderer.render(avatar.scene, avatar.camera);
        const worst = [];
        avatar.root.traverse(mesh => {
          if (!mesh.isSkinnedMesh || !mesh.name.startsWith("YTSign_PSL_Signer_Body")) return;
          mesh.skeleton.update();
          const pos = mesh.geometry.attributes.position, idx = mesh.geometry.index;
          const rest = restPositions.get(mesh);
          const posed = Array.from({length:pos.count}, (_, i) => mesh.getVertexPosition(i,new qa.THREE.Vector3()).applyMatrix4(mesh.matrixWorld));
          for(let i=0;i<(idx?.count||pos.count);i+=3) for(let j=0;j<3;j++) {
            const a=idx?idx.getX(i+j):i+j,b=idx?idx.getX(i+(j+1)%3):i+(j+1)%3;
            const baseline=rest[a].distanceTo(rest[b]), length=posed[a].distanceTo(posed[b]);
            if(baseline<.0001 || length<.03 || rest[a].y<.85 || rest[a].y>1.4) continue;
            const ratio=length/baseline;
            if(ratio<4) continue;
            worst.push({ratio,length,rest:[rest[a].toArray(),rest[b].toArray()],posed:[posed[a].toArray(),posed[b].toArray()]});
          }
        });
        worst.sort((a,b)=>b.ratio-a.ratio);
        return { meshNames, stretchedEdges:worst.length, worst:worst.slice(0,16) };
      }, frame);
      const path=resolve(run, `${variant}-${name}.png`);
      await page.locator("canvas").screenshot({path});
      results.push({model,name,path,...metrics});
    }
    await page.close();
  }
} finally { await context.close(); await new Promise(done=>server.close(done)); }
await writeFile(resolve(run,"report.json"),JSON.stringify(results,null,2));
console.log(JSON.stringify({run,results:results.map(({model,name,stretchedEdges})=>({model,name,stretchedEdges}))}));
