/**
 * OASIS VISION — point handling for the terrain-height proxy.
 *
 * Terrain does not move, so every point is cached for 30 days and keyed by its
 * canonical 5-decimal-place form. That resolution is about one metre, which is
 * finer than the terrain mesh, and it means reordered or partially overlapping
 * batches reuse prior work instead of refetching.
 *
 * Coordinates are rejected rather than clamped. A clamped latitude of 95 would
 * return a real height for the wrong place, which is worse than an error.
 */

export const MAX_POINTS = 2000;
export const UPSTREAM_CHUNK = 256;

export interface Point {
  lng: number;
  lat: number;
}

export function canonicalPoint(lng: number, lat: number): string {
  // `+ 0` collapses -0 to 0 so two spellings of the same point share a key.
  const round = (v: number) => (Number(v.toFixed(5)) + 0).toFixed(5).replace(/\.?0+$/, '') || '0';
  return `${round(lng)},${round(lat)}`;
}

function checkedPoint(lng: unknown, lat: unknown, i: number): Point {
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error(`terrain: point ${i} has an out-of-range longitude`);
  }
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error(`terrain: point ${i} has an out-of-range latitude`);
  }
  return { lng, lat };
}

/**
 * The query form the vendored globe client sends:
 *
 *   gods-eye-view src/data/terrainHeights.js:100-103
 *     const pointsParam = chunk.map(({lat,lon}) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(';');
 *     fetch(`/api/terrain/heights?points=${encodeURIComponent(pointsParam)}`)
 *
 * `lon,lat` order — the same order the upstream uses, and the reverse of how
 * coordinates are usually written. It is charset-checked before it is split,
 * because this string is rebuilt into an upstream query.
 */
export function parsePointsParam(raw: string | null): Point[] {
  if (raw === null) throw new Error('terrain: missing ?points= (format: lon,lat;lon,lat;...)');

  const trimmed = raw.trim();
  if (!trimmed) return [];

  if (!/^[-0-9.,;\s]+$/.test(trimmed)) {
    throw new Error('terrain: ?points= accepts only digits, "-", ".", "," and ";"');
  }

  const pairs = trimmed.split(';').map(s => s.trim()).filter(s => s.length > 0);
  if (pairs.length > MAX_POINTS) {
    throw new Error(`terrain: at most ${MAX_POINTS} points per request`);
  }

  return pairs.map((pair, i) => {
    const parts = pair.split(',');
    if (parts.length !== 2) throw new Error(`terrain: point ${i} is not a "lon,lat" pair`);
    const lng = Number(parts[0]);
    const lat = Number(parts[1]);
    if (parts[0].trim() === '' || parts[1].trim() === '' || !Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new Error(`terrain: point ${i} has a non-numeric component`);
    }
    return checkedPoint(lng, lat, i);
  });
}

export function parsePoints(body: unknown): Point[] {
  const raw = (body as { points?: unknown })?.points;
  if (!Array.isArray(raw)) throw new Error('terrain: body must carry a "points" array');
  if (raw.length > MAX_POINTS) throw new Error(`terrain: at most ${MAX_POINTS} points per request`);

  return raw.map((entry, i) => {
    let lng: unknown;
    let lat: unknown;

    if (Array.isArray(entry)) {
      if (entry.length < 2) throw new Error(`terrain: point ${i} is not a [lng, lat] pair`);
      [lng, lat] = entry;
    } else if (entry && typeof entry === 'object') {
      ({ lng, lat } = entry as { lng?: unknown; lat?: unknown });
    } else {
      throw new Error(`terrain: point ${i} is not a pair or an object`);
    }

    return checkedPoint(lng, lat, i);
  });
}
