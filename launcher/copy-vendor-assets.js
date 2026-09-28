// Copies runtime files that ship inside npm packages but must be served as
// static URLs. Runs before every `npm run build` and `npm run dev` (the
// prebuild / predev hooks), so a fresh clone or `update.sh` never serves a
// page whose camera tracking 404s on its engine.
//
// MediaPipe Tasks (OASIS WIFI camera body tracking) loads its WebAssembly
// runtime from a URL at run time. The ~11 MB .wasm files are copied from
// node_modules rather than committed; public/mediapipe/wasm/ is gitignored.
// The pose model (public/mediapipe/pose_landmarker_lite.task) IS committed:
// it is not in the npm package, and fetching it at build time would make an
// offline build fail.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const dest = path.join(root, 'public', 'mediapipe', 'wasm');

if (!fs.existsSync(src)) {
  console.error(`[vendor] MISSING ${path.relative(root, src)} — run "npm install" first.`);
  process.exit(1);
}
fs.mkdirSync(dest, { recursive: true });
let n = 0;
for (const name of fs.readdirSync(src)) {
  fs.copyFileSync(path.join(src, name), path.join(dest, name));
  n++;
}
const model = path.join(root, 'public', 'mediapipe', 'pose_landmarker_lite.task');
if (!fs.existsSync(model)) {
  console.error(`[vendor] MISSING ${path.relative(root, model)} — it is committed; restore it from git.`);
  process.exit(1);
}
console.log(`[vendor] mediapipe: ${n} runtime files -> ${path.relative(root, dest)}`);
