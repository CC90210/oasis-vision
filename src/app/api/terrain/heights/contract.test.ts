import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as route from './route';
import { clearGevCache } from '@/lib/gev-cache';

/**
 * CONTRACT test — what the vendored globe client actually parses.
 *
 * Client source of truth (C:/Users/echel/JARVIS/_ingested/gods-eye-view):
 *   src/data/terrainHeights.js:100-103
 *       const pointsParam = chunk.map(({lat,lon}) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(';');
 *       const url = `/api/terrain/heights?points=${encodeURIComponent(pointsParam)}`;
 *       const res = await fetch(url, …)              ← GET, query string. No POST, no JSON body.
 *   src/data/terrainHeights.js:106-111
 *       if (!Array.isArray(body?.results)) throw 'malformed terrain heights response'
 *       if (body.results.length !== chunk.length) throw 'length mismatch'
 *   src/data/terrainHeights.js:117-119
 *       const ellipsoid = Number(body.results[i]?.ellipsoid);   ← ELLIPSOID, not elevation
 *       if (!Number.isFinite(ellipsoid)) throw 'non-finite ellipsoid height at index i'
 *   src/data/terrainHeights.js:113-115
 *       results are mapped POSITIONALLY — request order is load-bearing.
 *
 * A POST-only route makes every GET 405; the client throws, catches, and
 * substitutes geoidFallback() — a coast-level prior rendered as a real ground
 * height (terrainHeights.js:126-131, "sea-level poison"). That is confident
 * nonsense, not an outage, so it never surfaces as an error.
 *
 * `{ heights: [...] }` of `elevation` values is wrong twice over: wrong key,
 * and orthometric elevation is ~33 m from the ellipsoidal height at the sample
 * point below.
 */

/** Real Re:Earth response for these two points, probed 2026-09-09. */
const REEARTH_BODY = {
  tileset: 'mapterhorn-egm08',
  version: '5',
  results: [
    { lon: -77.0369, lat: 38.9021, elevation: 17.198017704721973, geoid: -32.93868748143556, ellipsoid: -15.740669776713585 },
    { lon: -105, lat: 39.7, elevation: 1594.665694503592, geoid: -17.192705154418945, ellipsoid: 1577.472989349173 },
  ],
};

const POINTS = '-77.03690,38.90210;-105.00000,39.70000';
const url = (points = POINTS) =>
  `http://localhost/api/terrain/heights?points=${encodeURIComponent(points)}`;

function stubUpstream(body: unknown = REEARTH_BODY) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('CONTRACT /api/terrain/heights — GET ?points=lon,lat;… → results[].ellipsoid', () => {
  beforeEach(async () => {
    await clearGevCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('exposes a GET handler at all', () => {
    expect(typeof route.GET).toBe('function');
  });

  it('parses the ?points= query the client sends and returns results in order', async () => {
    stubUpstream();
    const res = await route.GET!(new Request(url()));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(Array.isArray(body.results)).toBe(true);
    expect(body.results).toHaveLength(2);
    expect(Number(body.results[0].lon)).toBeCloseTo(-77.0369, 5);
    expect(Number(body.results[1].lon)).toBeCloseTo(-105, 5);
  });

  it('returns ELLIPSOID heights, not orthometric elevation', async () => {
    stubUpstream();
    const body = await (await route.GET!(new Request(url()))).json();

    for (let i = 0; i < 2; i += 1) {
      const ellipsoid = Number(body.results[i]?.ellipsoid);
      expect(Number.isFinite(ellipsoid)).toBe(true);
    }
    // -15.74 (ellipsoidal) vs 17.19 (orthometric) — a 33 m difference that
    // would sink every entity placed on it.
    expect(Number(body.results[0].ellipsoid)).toBeCloseTo(-15.740669776713585, 6);
    expect(Number(body.results[1].ellipsoid)).toBeCloseTo(1577.472989349173, 6);
  });

  it('never substitutes zero for a point it could not resolve', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('upstream down')));
    const body = await (await route.GET!(new Request(url()))).json();

    expect(body.results).toHaveLength(2);
    expect(body.results[0].ellipsoid).toBeNull();
    expect(body.results[1].ellipsoid).toBeNull();
  });

  it('rejects a malformed points string without calling upstream', async () => {
    const fetchMock = stubUpstream();
    const res = await route.GET!(new Request(url('abc,def')));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps provenance in headers, not in the body', async () => {
    stubUpstream();
    const res = await route.GET!(new Request(url()));
    const body = await res.json();
    expect(body.provenance).toBeUndefined();
    expect(res.headers.get('x-oasis-source')).toContain('Re:Earth');
  });
});
