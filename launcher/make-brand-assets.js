/**
 * Generates OASIS VISION brand assets from the real OASIS AI artwork.
 *
 * Source art is a glowing cyan circuit-tree on a near-black starfield, saved as
 * JPEG - so it has no alpha channel and cannot sit on the app's own background
 * without a black box around it. Rather than hand-cutting a mask, alpha is
 * derived from luminance: the art is glow on black, so brightness IS opacity.
 * That keeps the glow falloff intact and composites correctly on any dark
 * surface, which a hard-edged cutout would not.
 *
 * Run:  node launcher/make-brand-assets.js
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const TREE_SRC = 'C:/Users/User/APPS/oasis-command-center/public/oasis-logo.jpg';   // tree, no wordmark
const MARK_SRC = 'C:/Users/User/APPS/oasis-ai-platform/public/images/logo-icon.jpg'; // tree + OASIS AI wordmark

for (const p of [TREE_SRC, MARK_SRC]) {
  if (!fs.existsSync(p)) { console.error(`[brand] source art missing: ${p}`); process.exit(1); }
}

/** Bounding box of everything brighter than `thresh`, so the tree can be cropped from its field. */
async function brightBounds(file, thresh = 42) {
  const img = sharp(file);
  const { width, height } = await img.metadata();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let minX = width, minY = height, maxX = 0, maxY = 0, found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * ch;
      // Rec.601 luma - the tree is cyan, so weight G and B properly rather than averaging.
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (lum > thresh) {
        found = true;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (!found) throw new Error(`no pixels above ${thresh} in ${file}`);
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1, imgW: width, imgH: height };
}

/**
 * Luminance -> alpha, with the glow lifted so faint outer haze does not vanish
 * and the starfield does not survive as speckle.
 */
async function keyToAlpha(input, size) {
  const { data, info } = await sharp(input).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
    .raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let p = 0, q = 0; p < data.length; p += ch, q += 4) {
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    // Floor kills the starfield; gamma < 1 lifts the glow so it does not clip to nothing.
    // The starfield sits around luma 40-80; the tree's own glow starts well
    // above that. A floor of 26 let every star through as speckle.
    let a = lum <= 62 ? 0 : Math.min(1, (lum - 62) / 130);
    a = Math.pow(a, 0.78);
    // Re-saturate toward the mark's cyan: dividing by alpha recovers the
    // un-premultiplied colour, so the tree keeps its hue instead of going white.
    const boost = a > 0.04 ? Math.min(1 / a, 2.6) : 1;
    out[q]     = Math.min(255, r * boost);
    out[q + 1] = Math.min(255, g * boost);
    out[q + 2] = Math.min(255, b * boost);
    out[q + 3] = Math.round(a * 255);
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

(async () => {
  // ── 1. Transparent tree for the header and boot splash ──
  // A low threshold finds the starfield, not the subject: at 40 the box came
  // back 673x994 (essentially the whole frame) and the square crop sliced the
  // tree's roots off. The tree's own glow is far brighter than any star.
  const tb = await brightBounds(TREE_SRC, 120);
  const pad = Math.round(Math.max(tb.width, tb.height) * 0.08);
  const side = Math.min(
    Math.max(tb.width, tb.height) + pad * 2,
    tb.imgW,
    tb.imgH,
  );
  const cx = tb.left + tb.width / 2, cy = tb.top + tb.height / 2;
  const sq = {
    left: Math.max(0, Math.min(Math.round(cx - side / 2), tb.imgW - side)),
    top: Math.max(0, Math.min(Math.round(cy - side / 2), tb.imgH - side)),
    width: side,
    height: side,
  };
  console.log('[brand] tree bounds', `${tb.width}x${tb.height} @ ${tb.left},${tb.top}`, '-> square crop', sq);

  const cropped = await sharp(TREE_SRC).extract(sq).toBuffer();
  for (const s of [512, 256, 128, 64]) {
    const png = await keyToAlpha(cropped, s);
    fs.writeFileSync(path.join(PUB, `oasis-tree-${s}.png`), png);
    console.log(`[brand] public/oasis-tree-${s}.png  ${(png.length / 1024).toFixed(1)} KB`);
  }

  // ── 2. Square app icon: the tree only. The wordmark is illegible below ~96px,
  //       and an icon has to stay recognisable in a 16px favicon and a taskbar. ──
  const iconPng = await sharp(await keyToAlpha(cropped, 1024))
    .flatten({ background: { r: 6, g: 10, b: 22 } })   // OASIS deep-navy ground
    .png().toBuffer();
  fs.writeFileSync(path.join(PUB, 'oasis-icon.png'), iconPng);
  console.log(`[brand] public/oasis-icon.png  ${(iconPng.length / 1024).toFixed(1)} KB`);

  for (const s of [512, 192, 180, 32, 16]) {
    const b = await sharp(iconPng).resize(s, s).png().toBuffer();
    const name = s === 180 ? 'apple-touch-icon.png'
      : s === 32 ? 'favicon-32x32.png'
      : s === 16 ? 'favicon-16x16.png'
      : `android-chrome-${s}x${s}.png`;
    fs.writeFileSync(path.join(PUB, name), b);
    console.log(`[brand] public/${name}`);
  }
  // icon-192 is referenced by the manifests as the maskable variant.
  fs.writeFileSync(path.join(PUB, 'icon-192.png'), await sharp(iconPng).resize(192, 192).png().toBuffer());
  console.log('[brand] public/icon-192.png');

  // ── 3. Full mark with wordmark, for the docs page / OG card ──
  const og = await sharp(MARK_SRC).resize(1200, 630, { fit: 'contain', background: { r: 6, g: 10, b: 22 } }).png().toBuffer();
  fs.writeFileSync(path.join(PUB, 'og-image.png'), og);
  console.log(`[brand] public/og-image.png  ${(og.length / 1024).toFixed(1)} KB`);

  console.log('[brand] done.');
})().catch(e => { console.error('[brand] FAILED', e); process.exit(1); });
