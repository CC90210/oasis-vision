import { describe, it, expect } from 'vitest';
import { parseExif, dmsToDecimal } from './exif';

/**
 * Builds a minimal but REAL little-endian JPEG/EXIF structure:
 * SOI, APP1 with "Exif\0\0", TIFF header, IFD0 with Make/Model and a
 * GPS IFD pointer. Testing the mapping, not the network.
 */
function buildJpegWithExif(opts: { gps?: boolean } = {}): ArrayBuffer {
  const withGps = opts.gps ?? true;
  const buf = new ArrayBuffer(600);
  const v = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let p = 0;

  v.setUint16(p, 0xffd8, false); p += 2;       // SOI
  v.setUint16(p, 0xffe1, false); p += 2;       // APP1
  v.setUint16(p, 560, false); p += 2;          // segment length
  bytes.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], p); p += 6;  // "Exif\0\0"

  const tiff = p;
  v.setUint16(tiff, 0x4949, false);            // little-endian
  v.setUint16(tiff + 2, 0x002a, true);         // TIFF magic
  v.setUint32(tiff + 4, 8, true);              // IFD0 at tiff+8

  const ifd0 = tiff + 8;
  const entries = withGps ? 3 : 2;
  v.setUint16(ifd0, entries, true);

  // Strings live past the IFD; 4-byte values sit inline.
  const strBase = 200;
  const writeAscii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(tiff + off + i, s.charCodeAt(i));
    v.setUint8(tiff + off + s.length, 0);
  };
  writeAscii(strBase, 'Canon');
  writeAscii(strBase + 16, 'EOS 5D Mark IV');

  const entry = (i: number, tag: number, type: number, count: number, value: number) => {
    const e = ifd0 + 2 + i * 12;
    v.setUint16(e, tag, true);
    v.setUint16(e + 2, type, true);
    v.setUint32(e + 4, count, true);
    v.setUint32(e + 8, value, true);
  };

  entry(0, 0x010f, 2, 6, strBase);            // Make = "Canon"
  entry(1, 0x0110, 2, 15, strBase + 16);      // Model

  if (withGps) {
    const gpsIfd = 300;
    entry(2, 0x8825, 4, 1, gpsIfd);           // GPS IFD pointer

    const g = tiff + gpsIfd;
    v.setUint16(g, 4, true);                  // 4 GPS entries
    const gEntry = (i: number, tag: number, type: number, count: number, value: number) => {
      const e = g + 2 + i * 12;
      v.setUint16(e, tag, true);
      v.setUint16(e + 2, type, true);
      v.setUint32(e + 4, count, true);
      v.setUint32(e + 8, value, true);
    };

    // Refs are 1-byte ASCII stored inline.
    const refN = g + 2 + 0 * 12 + 8;
    gEntry(0, 0x0001, 2, 2, 0); v.setUint8(refN, 'N'.charCodeAt(0)); v.setUint8(refN + 1, 0);

    // Latitude 45 deg 30' 0" N  -> 45.5
    const latOff = 400;
    v.setUint32(tiff + latOff, 45, true);      v.setUint32(tiff + latOff + 4, 1, true);
    v.setUint32(tiff + latOff + 8, 30, true);  v.setUint32(tiff + latOff + 12, 1, true);
    v.setUint32(tiff + latOff + 16, 0, true);  v.setUint32(tiff + latOff + 20, 1, true);
    gEntry(1, 0x0002, 5, 3, latOff);

    const refW = g + 2 + 2 * 12 + 8;
    gEntry(2, 0x0003, 2, 2, 0); v.setUint8(refW, 'W'.charCodeAt(0)); v.setUint8(refW + 1, 0);

    // Longitude 73 deg 34' 0" W -> -73.5666667
    const lngOff = 440;
    v.setUint32(tiff + lngOff, 73, true);      v.setUint32(tiff + lngOff + 4, 1, true);
    v.setUint32(tiff + lngOff + 8, 34, true);  v.setUint32(tiff + lngOff + 12, 1, true);
    v.setUint32(tiff + lngOff + 16, 0, true);  v.setUint32(tiff + lngOff + 20, 1, true);
    gEntry(3, 0x0004, 5, 3, lngOff);
  }

  return buf;
}

describe('dmsToDecimal', () => {
  it('converts DMS to signed decimal degrees', () => {
    expect(dmsToDecimal([45, 30, 0], 'N')).toBeCloseTo(45.5, 6);
    expect(dmsToDecimal([73, 34, 0], 'W')).toBeCloseTo(-73.5666667, 5);
  });

  it('applies the hemisphere ref, not the sign of the degrees', () => {
    expect(dmsToDecimal([45, 0, 0], 'S')).toBeCloseTo(-45, 6);
    expect(dmsToDecimal([-45, 0, 0], 'N')).toBeCloseTo(45, 6);
  });

  it('returns null for an unusable triple', () => {
    expect(dmsToDecimal([], 'N')).toBeNull();
    expect(dmsToDecimal([1, 2], 'N')).toBeNull();
    expect(dmsToDecimal([NaN, 0, 0], 'N')).toBeNull();
  });
});

describe('parseExif', () => {
  it('reads camera make and model from a real EXIF structure', () => {
    const r = parseExif(buildJpegWithExif());
    expect(r.hasExif).toBe(true);
    expect(r.make).toBe('Canon');
    expect(r.model).toBe('EOS 5D Mark IV');
  });

  it('extracts GPS as decimal degrees ready to plot', () => {
    const r = parseExif(buildJpegWithExif({ gps: true }));
    expect(r.gps).not.toBeNull();
    expect(r.gps!.lat).toBeCloseTo(45.5, 4);
    expect(r.gps!.lng).toBeCloseTo(-73.5666667, 4);
    expect(r.gps!.raw).toContain('N');
  });

  it('says so plainly when there is no GPS, instead of implying none exists', () => {
    const r = parseExif(buildJpegWithExif({ gps: false }));
    expect(r.gps).toBeNull();
    expect(r.notes.join(' ')).toMatch(/no GPS tags/i);
  });

  it('does not throw on a non-JPEG, and explains why it is empty', () => {
    const notJpeg = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).buffer;
    const r = parseExif(notJpeg);
    expect(r.hasExif).toBe(false);
    expect(r.notes.join(' ')).toMatch(/not a JPEG|stripped/i);
  });

  it('does not throw on a truncated file', () => {
    expect(() => parseExif(new ArrayBuffer(2))).not.toThrow();
    expect(() => parseExif(new ArrayBuffer(0))).not.toThrow();
  });
});
