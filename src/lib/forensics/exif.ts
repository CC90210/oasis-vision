/**
 * ═══════════════════════════════════════════════════════════════
 *  OASIS VISION — JPEG/TIFF EXIF reader
 *
 *  Written from the EXIF spec rather than taken from any existing
 *  tool: the obvious reference implementation for this capability
 *  (6abd/horus) is GPL-3.0, and this repo ships as an MIT-derived
 *  desktop app. See docs/recon-expansion/PLAN.md section 3.
 *
 *  Scope is deliberately narrow — the tags that matter to an
 *  investigation and nothing else:
 *    GPS position, capture timestamps, camera make/model/serial,
 *    software, and the artist/copyright strings people forget are
 *    embedded.
 *
 *  GPS is the reason this lives in OASIS VISION at all: a coordinate
 *  in an image header is a map pin, and this console already renders
 *  a globe.
 * ═══════════════════════════════════════════════════════════════
 */

export interface ExifGps {
  lat: number;
  lng: number;
  altitude: number | null;
  /** Raw DMS as recorded, for the analyst to verify against the pin. */
  raw: string;
}

export interface ExifResult {
  hasExif: boolean;
  gps: ExifGps | null;
  make: string | null;
  model: string | null;
  lensModel: string | null;
  serial: string | null;
  software: string | null;
  artist: string | null;
  copyright: string | null;
  dateTimeOriginal: string | null;
  dateTimeDigitized: string | null;
  orientation: number | null;
  /** Every tag we decoded, for the raw view. */
  tags: Record<string, string | number>;
  /** Why the result is what it is, especially when it is empty. */
  notes: string[];
}

/** EXIF tag ids we care about, IFD0 + ExifIFD. */
const TAGS: Record<number, string> = {
  0x010f: 'Make',
  0x0110: 'Model',
  0x0112: 'Orientation',
  0x0131: 'Software',
  0x013b: 'Artist',
  0x8298: 'Copyright',
  0x9003: 'DateTimeOriginal',
  0x9004: 'DateTimeDigitized',
  0x0132: 'DateTime',
  0xa434: 'LensModel',
  0xa431: 'BodySerialNumber',
  0xc62f: 'CameraSerialNumber',
};

const GPS_TAGS: Record<number, string> = {
  0x0000: 'GPSVersionID',
  0x0001: 'GPSLatitudeRef',
  0x0002: 'GPSLatitude',
  0x0003: 'GPSLongitudeRef',
  0x0004: 'GPSLongitude',
  0x0005: 'GPSAltitudeRef',
  0x0006: 'GPSAltitude',
  0x0007: 'GPSTimeStamp',
  0x001d: 'GPSDateStamp',
};

/** Bytes per component, indexed by EXIF type code. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

/**
 * Longest ASCII tag we will read. Real camera strings are tens of
 * bytes; the cap exists so a crafted `count` cannot turn a large upload
 * into a response several times its size.
 */
const MAX_ASCII_TAG = 4096;

interface Reader {
  u16(o: number): number;
  u32(o: number): number;
  i32(o: number): number;
}

function readerFor(view: DataView, little: boolean): Reader {
  return {
    u16: (o) => view.getUint16(o, little),
    u32: (o) => view.getUint32(o, little),
    i32: (o) => view.getInt32(o, little),
  };
}

/** Locate the EXIF APP1 payload inside a JPEG. Returns its offset. */
function findApp1(view: DataView): number | null {
  if (view.byteLength < 4) return null;
  if (view.getUint16(0, false) !== 0xffd8) return null; // not a JPEG

  let offset = 2;
  while (offset + 4 <= view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return null;
    const marker = view.getUint8(offset + 1);
    const size = view.getUint16(offset + 2, false);
    if (marker === 0xe1) {
      // "Exif\0\0"
      if (offset + 10 <= view.byteLength && view.getUint32(offset + 4, false) === 0x45786966) {
        return offset + 10;
      }
    }
    // 0xDA = start of scan; EXIF never appears after it.
    if (marker === 0xda) return null;
    offset += 2 + size;
  }
  return null;
}

function readValue(
  view: DataView,
  r: Reader,
  entry: number,
  tiffStart: number,
): string | number | number[] | null {
  const type = r.u16(entry + 2);
  const count = r.u32(entry + 4);
  const size = TYPE_SIZE[type];
  if (!size) return null;

  const total = size * count;
  // Values of 4 bytes or fewer are stored inline in the entry.
  const valueOffset = total <= 4 ? entry + 8 : tiffStart + r.u32(entry + 8);
  if (valueOffset < 0 || valueOffset + total > view.byteLength) return null;

  switch (type) {
    case 2: {
      // ASCII, NUL-terminated.
      //
      // Capped. `count` is attacker-controlled and bounded only by the
      // file, so a 25 MB upload declaring one enormous ASCII tag
      // produced a ~25M-character string and a ~50 MB JSON response —
      // measured at 200 KB in and 400 KB out, which scales linearly.
      // No real EXIF string is anywhere near this; anything longer is
      // malformed or hostile, and is truncated rather than echoed.
      const limit = Math.min(count, MAX_ASCII_TAG);
      let s = '';
      for (let i = 0; i < limit; i++) {
        const c = view.getUint8(valueOffset + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return count > MAX_ASCII_TAG ? `${s.trim()}… [truncated from ${count} bytes]` : s.trim();
    }
    case 1:
    case 7:
      return view.getUint8(valueOffset);
    case 3:
      return r.u16(valueOffset);
    case 4:
      return r.u32(valueOffset);
    case 5:
    case 10: {
      // (Un)signed rational: numerator/denominator pairs.
      const out: number[] = [];
      for (let i = 0; i < count; i++) {
        const n = type === 5 ? r.u32(valueOffset + i * 8) : r.i32(valueOffset + i * 8);
        const d = type === 5 ? r.u32(valueOffset + i * 8 + 4) : r.i32(valueOffset + i * 8 + 4);
        out.push(d === 0 ? 0 : n / d);
      }
      return count === 1 ? out[0] : out;
    }
    case 9:
      return r.i32(valueOffset);
    default:
      return null;
  }
}

/** DMS triple + hemisphere ref to signed decimal degrees. */
export function dmsToDecimal(dms: number[], ref: string): number | null {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  const [d, m, s] = dms;
  if (![d, m, s].every((n) => Number.isFinite(n))) return null;
  let dec = Math.abs(d) + m / 60 + s / 3600;
  const r = (ref || '').toUpperCase();
  if (r === 'S' || r === 'W') dec = -dec;
  return Number(dec.toFixed(7));
}

function empty(notes: string[]): ExifResult {
  return {
    hasExif: false,
    gps: null,
    make: null,
    model: null,
    lensModel: null,
    serial: null,
    software: null,
    artist: null,
    copyright: null,
    dateTimeOriginal: null,
    dateTimeDigitized: null,
    orientation: null,
    tags: {},
    notes,
  };
}

/**
 * Parse EXIF from a JPEG buffer.
 *
 * Never throws: a corrupt header returns an empty result carrying the
 * reason in `notes`, because an investigation tool that crashes on a
 * malformed input is worse than one that says what it could not read.
 */
export function parseExif(buffer: ArrayBuffer): ExifResult {
  const view = new DataView(buffer);

  let tiffStart: number | null;
  try {
    tiffStart = findApp1(view);
  } catch {
    return empty(['Image header could not be read; it may be truncated.']);
  }

  if (tiffStart === null) {
    return empty([
      'No EXIF APP1 segment found. The file is not a JPEG, or its metadata was stripped — ' +
      'most social platforms remove EXIF on upload.',
    ]);
  }

  const byteOrder = view.getUint16(tiffStart, false);
  if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) {
    return empty(['EXIF segment present but its byte-order mark is invalid.']);
  }
  const little = byteOrder === 0x4949;
  const r = readerFor(view, little);

  if (r.u16(tiffStart + 2) !== 0x002a) {
    return empty(['EXIF segment present but the TIFF magic number is wrong.']);
  }

  const tags: Record<string, string | number> = {};
  const notes: string[] = [];
  let gps: ExifGps | null = null;

  const readIfd = (ifdOffset: number, map: Record<number, string>, into: Record<string, unknown>) => {
    if (ifdOffset + 2 > view.byteLength) return;
    const count = r.u16(ifdOffset);
    // A corrupt count can be enormous; cap it rather than walking off.
    const safe = Math.min(count, 512);
    for (let i = 0; i < safe; i++) {
      const entry = ifdOffset + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      const tag = r.u16(entry);
      const name = map[tag];
      if (!name) continue;
      const value = readValue(view, r, entry, tiffStart!);
      if (value !== null && value !== '') into[name] = value as never;
    }
  };

  try {
    const ifd0 = tiffStart + r.u32(tiffStart + 4);
    const raw0: Record<string, unknown> = {};
    readIfd(ifd0, TAGS, raw0);

    // ExifIFD and GPSIFD are pointers held in IFD0.
    const count0 = r.u16(ifd0);
    for (let i = 0; i < Math.min(count0, 512); i++) {
      const entry = ifd0 + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      const tag = r.u16(entry);
      if (tag === 0x8769) {
        readIfd(tiffStart + r.u32(entry + 8), TAGS, raw0);
      } else if (tag === 0x8825) {
        const rawGps: Record<string, unknown> = {};
        readIfd(tiffStart + r.u32(entry + 8), GPS_TAGS, rawGps);

        const latArr = rawGps.GPSLatitude as number[] | undefined;
        const lngArr = rawGps.GPSLongitude as number[] | undefined;
        const latRef = (rawGps.GPSLatitudeRef as string) || 'N';
        const lngRef = (rawGps.GPSLongitudeRef as string) || 'E';

        if (Array.isArray(latArr) && Array.isArray(lngArr)) {
          const lat = dmsToDecimal(latArr, latRef);
          const lng = dmsToDecimal(lngArr, lngRef);
          if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            const altRaw = rawGps.GPSAltitude as number | undefined;
            // GPSAltitudeRef 1 means below sea level.
            const belowSea = rawGps.GPSAltitudeRef === 1;
            gps = {
              lat,
              lng,
              altitude: typeof altRaw === 'number' ? Number(((belowSea ? -1 : 1) * altRaw).toFixed(1)) : null,
              raw: `${latArr.join('/')} ${latRef}, ${lngArr.join('/')} ${lngRef}`,
            };
          } else {
            notes.push('GPS tags present but the coordinates were out of range; not plotted.');
          }
        }
      }
    }

    for (const [k, v] of Object.entries(raw0)) {
      if (typeof v === 'string' || typeof v === 'number') tags[k] = v;
    }
  } catch (e) {
    notes.push(`EXIF directory walk stopped early: ${e instanceof Error ? e.message : 'unknown'}`);
  }

  const str = (k: string) => (typeof tags[k] === 'string' ? (tags[k] as string) : null);

  if (!gps) {
    notes.push('No GPS tags in this image, so there is nothing to place on the map.');
  }

  return {
    hasExif: Object.keys(tags).length > 0 || gps !== null,
    gps,
    make: str('Make'),
    model: str('Model'),
    lensModel: str('LensModel'),
    serial: str('BodySerialNumber') || str('CameraSerialNumber'),
    software: str('Software'),
    artist: str('Artist'),
    copyright: str('Copyright'),
    dateTimeOriginal: str('DateTimeOriginal') || str('DateTime'),
    dateTimeDigitized: str('DateTimeDigitized'),
    orientation: typeof tags.Orientation === 'number' ? tags.Orientation : null,
    tags,
    notes,
  };
}
