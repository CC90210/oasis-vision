// Copies the assets Next.js standalone output does NOT bundle itself.
// Next docs: you must manually copy `public/` and `.next/static` next to server.js.
// Without this the app boots but every stylesheet, chunk and icon 404s.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const standalone = path.join(root, '.next', 'standalone');

if (!fs.existsSync(path.join(standalone, 'server.js'))) {
  console.error('[sync] .next/standalone/server.js missing - run "npm run build" first.');
  process.exit(1);
}

function copyDir(src, dest, label) {
  if (!fs.existsSync(src)) {
    console.error(`[sync] MISSING source: ${src}`);
    process.exit(1);
  }
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  let n = 0;
  (function count(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) count(path.join(d, e.name)); else n++;
    }
  })(dest);
  console.log(`[sync] ${label}: ${n} files -> ${path.relative(root, dest)}`);
}

copyDir(path.join(root, 'public'), path.join(standalone, 'public'), 'public');
copyDir(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'), 'static');

// Server-side env. Next's standalone server calls loadEnvConfig against its OWN
// directory, not the project root, so a key that works under `next dev` is
// simply absent once launched — the voice read-out would report "not
// configured" on the built app while testing fine in development. Copied, never
// read: only the filename and byte count are logged.
for (const name of ['.env.local', '.env.production.local', '.env']) {
  const src = path.join(root, name);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(standalone, name);
  fs.copyFileSync(src, dest);
  console.log(`[sync] env: ${name} (${fs.statSync(dest).size} bytes) -> standalone/`);
}

console.log('[sync] standalone bundle is complete and runnable.');
