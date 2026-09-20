import { describe, it, expect } from 'vitest';
import { parseExif } from './exif';

/**
 * Hostile-input regressions.
 *
 * Every case here came out of an adversarial review of this parser. It
 * reads attacker-controlled bytes, so "it did not crash on my holiday
 * photo" is not evidence of anything.
 */

/** Minimal little-endian JPEG/EXIF with one IFD0 entry under our control. */
function craft(opts: {
  size?: number;
  tag: number;
  type: number;
  count: number;
  value: number;
  fill?: number;
}): ArrayBuffer {
  const size = opts.size ?? 4096;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  const b = new Uint8Array(buf);
  if (opts.fill !== undefined) b.fill(opts.fill);

  let p = 0;
  v.setUint16(p, 0xffd8, false); p += 2;          // SOI
  v.setUint16(p, 0xffe1, false); p += 2;          // APP1
  v.setUint16(p, size - 6, false); p += 2;        // length
  b.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], p); p += 6;

  const tiff = p;
  v.setUint16(tiff, 0x4949, false);               // little-endian
  v.setUint16(tiff + 2, 0x002a, true);            // TIFF magic
  v.setUint32(tiff + 4, 8, true);                 // IFD0 offset

  const ifd0 = tiff + 8;
  v.setUint16(ifd0, 1, true);                     // one entry
  const e = ifd0 + 2;
  v.setUint16(e, opts.tag, true);
  v.setUint16(e + 2, opts.type, true);
  v.setUint32(e + 4, opts.count, true);
  v.setUint32(e + 8, opts.value, true);
  return buf;
}

describe('parseExif — hostile input', () => {
  it('does not throw on truncated files of any length', () => {
    for (let n = 0; n <= 24; n++) {
      const buf = new ArrayBuffer(n);
      const v = new DataView(buf);
      if (n >= 2) v.setUint16(0, 0xffd8, false);
      if (n >= 4) v.setUint16(2, 0xffe1, false);
      if (n >= 6) v.setUint16(4, 0xffff, false);   // length far past the end
      expect(() => parseExif(buf), `${n} bytes`).not.toThrow();
    }
  });

  it('caps a huge ASCII tag instead of echoing it back', () => {
    // A 200 KB file declaring a ~200 KB Make string used to produce a
    // ~400 KB JSON response. At the 25 MB upload limit that is ~50 MB.
    const size = 200_000;
    const buf = craft({ size, tag: 0x010f, type: 2, count: size - 200, value: 100, fill: 0x41 });
    const r = parseExif(buf);
    expect(r.make!.length).toBeLessThan(5000);
    expect(r.make).toMatch(/truncated from \d+ bytes/);
    expect(JSON.stringify(r).length).toBeLessThan(20_000);
  });

  it('terminates on a self-referencing ExifIFD pointer', () => {
    // Tag 0x8769 pointing back at IFD0 would loop a naive walker.
    const buf = craft({ tag: 0x8769, type: 4, count: 1, value: 8 });
    const t0 = Date.now();
    expect(() => parseExif(buf)).not.toThrow();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('rejects an absurd component count rather than allocating for it', () => {
    const buf = craft({ tag: 0x010f, type: 2, count: 0xffffffff, value: 100 });
    expect(() => parseExif(buf)).not.toThrow();
    const r = parseExif(buf);
    // The value runs past the buffer, so it must be dropped entirely.
    expect(r.make).toBeNull();
  });

  it('ignores an entry whose value offset points outside the file', () => {
    const buf = craft({ tag: 0x010f, type: 2, count: 64, value: 999_999 });
    const r = parseExif(buf);
    expect(r.make).toBeNull();
    expect(r.hasExif).toBe(false);
  });

  it('survives a GPS IFD pointer into the middle of nowhere', () => {
    const buf = craft({ tag: 0x8825, type: 4, count: 1, value: 3500 });
    expect(() => parseExif(buf)).not.toThrow();
    expect(parseExif(buf).gps).toBeNull();
  });
});
