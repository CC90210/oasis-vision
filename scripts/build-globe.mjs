#!/usr/bin/env node
/**
 * Builds the vendored God's Eye View client into public/globe/.
 *
 * The build is NOT part of `npm run build`. OASIS must build on a machine that
 * has never seen the vendored source, so the output is committed and this
 * script only runs when the globe needs regenerating.
 *
 * Usage: node scripts/build-globe.mjs [--source <path>]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OASIS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = 'C:/Users/echel/JARVIS/_ingested/gods-eye-view';

const argIndex = process.argv.indexOf('--source');
const source = argIndex === -1 ? DEFAULT_SOURCE : process.argv[argIndex + 1];
const outDir = join(OASIS_ROOT, 'public', 'globe');

if (!existsSync(join(source, 'package.json'))) {
  console.error(`[build-globe] no client source at ${source}`);
  process.exit(1);
}
if (!existsSync(join(source, 'node_modules'))) {
  console.error(`[build-globe] run "npm ci" in ${source} first`);
  process.exit(1);
}

console.log(`[build-globe] building ${source} -> ${outDir}`);
rmSync(outDir, { recursive: true, force: true });

// argv array, never a shell string. On Windows, spawning `npx.cmd` (or any
// .cmd/.bat) directly via execFileSync throws EINVAL — Node hardened against
// implicit batch-file execution on Windows (the CVE-2024-27980 fix), and that
// restriction is present across current Node versions, not tied to this
// project's engine floor. Spawn node.exe against vite's real JS entry point
// instead: same argv discipline, no shell, no .cmd involved.
const viteBin = join(source, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(viteBin)) {
  console.error(`[build-globe] vite bin not found at ${viteBin}`);
  process.exit(1);
}
execFileSync(
  process.execPath,
  [viteBin, 'build', '--base', '/globe/', '--outDir', outDir, '--emptyOutDir'],
  { cwd: source, stdio: 'inherit' },
);

// vite-plugin-cesium computes CESIUM_BASE_URL correctly for the HTML
// (`/globe/cesium/...`, matching index.html's <link>/<script> tags), but its
// closeBundle() copy step re-joins that same base-prefixed value onto outDir
// when writing Cesium's static assets to disk. Since outDir here already IS
// the /globe/ subpath's serving directory, that doubles the segment: files
// land at <outDir>/globe/cesium/... instead of <outDir>/cesium/... where
// index.html actually asks for them. This is the plugin's own path
// arithmetic, entirely downstream of Cesium tolerating a subpath base — fix
// it here, in our own build script, never by patching node_modules (a
// node_modules patch is invisible to review, unreproducible on a fresh
// install, and silently lost).
const CESIUM_URL_SEGMENT = 'cesium'; // vite-plugin-cesium's default cesiumBaseUrl
const BASE_SEGMENT = 'globe'; // matches the --base /globe/ passed above
const doubledCesium = join(outDir, BASE_SEGMENT, CESIUM_URL_SEGMENT);
const correctCesium = join(outDir, CESIUM_URL_SEGMENT);

if (existsSync(doubledCesium)) {
  rmSync(correctCesium, { recursive: true, force: true });
  renameSync(doubledCesium, correctCesium);
  const huskDir = join(outDir, BASE_SEGMENT);
  const remaining = existsSync(huskDir) ? readdirSync(huskDir) : [];
  if (remaining.length === 0) {
    rmSync(huskDir, { recursive: true, force: true });
  } else {
    console.warn(`[build-globe] ${huskDir} left in place — not empty after moving cesium/: ${remaining.join(', ')}`);
  }
  console.log(`[build-globe] normalised vite-plugin-cesium's doubled path: ${doubledCesium} -> ${correctCesium}`);
} else if (existsSync(correctCesium)) {
  console.log(`[build-globe] no doubled path at ${doubledCesium}, and ${correctCesium} is already populated — vite-plugin-cesium may have fixed this upstream. Consider deleting this normalisation shim.`);
} else {
  console.error(`[build-globe] NEITHER ${doubledCesium} NOR ${correctCesium} exist after the vite build.`);
  console.error('[build-globe] Refusing to report success and ship an empty (or missing) Cesium asset directory.');
  process.exit(1);
}

// Positive verification: assert the exact files the browser requests exist,
// not just that some directory got moved somewhere plausible.
const mustExist = [
  join(correctCesium, 'Cesium.js'),
  join(correctCesium, 'Widgets', 'widgets.css'),
];
const missing = mustExist.filter((f) => !existsSync(f));
if (missing.length > 0) {
  console.error('[build-globe] expected Cesium asset(s) missing after normalisation:');
  for (const f of missing) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('[build-globe] verified Cesium.js and Widgets/widgets.css exist at the paths index.html requests.');

let files = 0;
let bytes = 0;
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else { files++; bytes += statSync(p).size; }
  }
})(outDir);

const mb = (bytes / 1024 / 1024).toFixed(1);
console.log(`[build-globe] ${files} files, ${mb} MB -> public/globe`);

// A decision gate, not a failure: committing thousands of Cesium assets into
// CC's repo is a choice someone should make on purpose.
if (files > 2000 || bytes > 25 * 1024 * 1024) {
  console.warn(`[build-globe] OUTPUT IS LARGE (${files} files, ${mb} MB).`);
  console.warn('[build-globe] Decide deliberately whether to commit it or gitignore it');
  console.warn('[build-globe] and document this script as a required setup step.');
}
