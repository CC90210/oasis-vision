import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { canonicalPoint, parsePoints, parsePointsParam, MAX_POINTS } from './points';
import { POST, type HeightResult } from './route';
import { cachedJson, clearGevCache } from '@/lib/gev-cache';

describe('canonicalPoint', () => {
  it('rounds to five decimal places so near-identical points share a cache entry', () => {
    expect(canonicalPoint(-73.612345678, 45.512345678)).toBe('-73.61235,45.51235');
    expect(canonicalPoint(-73.6123500001, 45.5123500001)).toBe('-73.61235,45.51235');
  });

  it('produces a stable key regardless of negative zero', () => {
    expect(canonicalPoint(-0, 0)).toBe(canonicalPoint(0, 0));
  });
});

describe('parsePoints', () => {
  it('accepts an array of lng/lat pairs', () => {
    expect(parsePoints({ points: [[-73.6, 45.5], [2.35, 48.85]] }))
      .toEqual([{ lng: -73.6, lat: 45.5 }, { lng: 2.35, lat: 48.85 }]);
  });

  it('accepts an array of objects', () => {
    expect(parsePoints({ points: [{ lng: -73.6, lat: 45.5 }] }))
      .toEqual([{ lng: -73.6, lat: 45.5 }]);
  });

  it('rejects an out-of-range coordinate rather than clamping it', () => {
    expect(() => parsePoints({ points: [[-73.6, 95]] })).toThrow(/latitude/i);
    expect(() => parsePoints({ points: [[-200, 45]] })).toThrow(/longitude/i);
  });

  it('rejects more points than the cap', () => {
    const many = Array.from({ length: MAX_POINTS + 1 }, () => [0, 0]);
    expect(() => parsePoints({ points: many })).toThrow(/2000/);
  });

  it('rejects a malformed body', () => {
    expect(() => parsePoints({})).toThrow(/points/i);
    expect(() => parsePoints({ points: 'nope' })).toThrow(/points/i);
    expect(() => parsePoints({ points: [[1]] })).toThrow(/pair/i);
  });

  it('accepts an empty list without throwing', () => {
    expect(parsePoints({ points: [] })).toEqual([]);
  });
});

describe('parsePointsParam — the query form the globe client sends', () => {
  it('parses lon,lat pairs separated by semicolons', () => {
    expect(parsePointsParam('-73.60000,45.50000;2.35000,48.85000'))
      .toEqual([{ lng: -73.6, lat: 45.5 }, { lng: 2.35, lat: 48.85 }]);
  });

  it('rejects a non-numeric component rather than coercing it to zero', () => {
    expect(() => parsePointsParam('abc,def')).toThrow(/non-numeric|only digits/i);
  });

  it('charset-allowlists the raw string before splitting it', () => {
    // This string is rebuilt into an upstream query, so it is checked, not
    // merely encoded.
    expect(() => parsePointsParam('1,2&FORMAT=json')).toThrow(/only digits/i);
    expect(() => parsePointsParam('../../etc/passwd')).toThrow(/only digits/i);
  });

  it('rejects an out-of-range coordinate rather than clamping it', () => {
    expect(() => parsePointsParam('-73.6,95')).toThrow(/latitude/i);
    expect(() => parsePointsParam('-200,45')).toThrow(/longitude/i);
  });

  it('rejects more points than the cap', () => {
    const many = Array.from({ length: MAX_POINTS + 1 }, () => '0,0').join(';');
    expect(() => parsePointsParam(many)).toThrow(/2000/);
  });

  it('names the missing parameter instead of answering an empty batch', () => {
    expect(() => parsePointsParam(null)).toThrow(/missing \?points=/);
  });

  it('treats an empty value as an empty batch', () => {
    expect(parsePointsParam('')).toEqual([]);
  });
});

/**
 * The brief's route (not this one — see route.ts's top comment) issued one
 * HTTP request per point and called that "chunked". These tests exist to
 * prove the real behavior: cache hits are looked up per point, only the
 * misses go upstream, upstream calls are capped at UPSTREAM_CHUNK points
 * each, and the response comes back in exact request order regardless of
 * which points were already cached.
 */
describe('POST /api/terrain/heights — real batching, order preservation', () => {
  const TTL_MS = 30 * 24 * 3600_000;

  beforeEach(async () => {
    await clearGevCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function postRequest(points: unknown) {
    return new Request('http://localhost/api/terrain/heights', {
      method: 'POST',
      body: JSON.stringify({ points }),
    });
  }

  /** Deterministic per-point elevation so expected values are easy to compute. */
  const elevationOf = (lng: number, lat: number) => lng * 10 + lat;

  function stubUpstream() {
    const fn = vi.fn().mockImplementation(async (url: string | URL) => {
      const u = new URL(String(url));
      const raw = u.searchParams.get('points') ?? '';
      const pts = raw
        .split(';')
        .filter(Boolean)
        .map((s) => {
          const [lng, lat] = s.split(',').map(Number);
          return { lng, lat };
        });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tileset: 'mapterhorn-egm08',
          version: '5',
          results: pts.map((p) => ({
            lon: p.lng,
            lat: p.lat,
            elevation: elevationOf(p.lng, p.lat),
            geoid: 0,
            ellipsoid: elevationOf(p.lng, p.lat),
          })),
        }),
      };
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  }

  it('returns heights lined up positionally, not grouped by cache hit/miss', async () => {
    // Pre-populate the cache for one point directly, bypassing the route —
    // it must come back at its OWN position, not shoved to the front or back.
    const cachedPoint = { lng: 10, lat: 10 };
    const key = `terrain-pt-${canonicalPoint(cachedPoint.lng, cachedPoint.lat)}`;
    await cachedJson<HeightResult>({
      key,
      ttlMs: TTL_MS,
      fetcher: async () => ({ lon: cachedPoint.lng, lat: cachedPoint.lat, elevation: 999, geoid: 0, ellipsoid: 999 }),
    });

    const missA = { lng: 20, lat: 20 };
    const missB = { lng: 30, lat: 30 };
    // Deliberately interleaved: miss, hit, miss. Returning hits-then-misses
    // (or misses-then-hits) would produce [999, 220, 330] or [220, 330, 999]
    // instead of the correct request-order array below.
    const points = [missA, cachedPoint, missB];

    stubUpstream();
    const res = await POST(postRequest(points));
    const body = await res.json();

    expect(body.results.map((r: HeightResult) => r.ellipsoid)).toEqual([
      elevationOf(missA.lng, missA.lat),
      999,
      elevationOf(missB.lng, missB.lat),
    ]);
    // The coordinates come back too, and in request order.
    expect(body.results.map((r: HeightResult) => r.lon)).toEqual([missA.lng, cachedPoint.lng, missB.lng]);
  });

  it('batches only the cache misses, at most UPSTREAM_CHUNK per upstream call', async () => {
    const points = Array.from({ length: 300 }, (_, i) => ({ lng: -170 + i * 0.001, lat: 10 }));
    const fetchMock = stubUpstream();

    const res = await POST(postRequest(points));
    const body = await res.json();

    expect(body.results).toHaveLength(300);
    expect(body.results.every((r: HeightResult) => r.ellipsoid !== null)).toBe(true);
    // 300 misses at UPSTREAM_CHUNK=256 must be 2 upstream calls, never 300.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * RULING R20: a call-COUNT assertion cannot detect a fan-out — two chunks
   * fired concurrently still produce exactly 2 calls. This tracks how many
   * fetch() calls are simultaneously outstanding and asserts that number
   * never exceeds 1, which only a real `await` between chunks satisfies.
   */
  it('awaits each chunk before starting the next, never firing chunks concurrently', async () => {
    const points = Array.from({ length: 300 }, (_, i) => ({ lng: -170 + i * 0.001, lat: 20 }));
    let inFlight = 0;
    let maxInFlight = 0;

    const fetchMock = vi.fn().mockImplementation(async (url: string | URL) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // long enough for a fan-out to overlap
      const u = new URL(String(url));
      const raw = u.searchParams.get('points') ?? '';
      const pts = raw
        .split(';')
        .filter(Boolean)
        .map((s) => {
          const [lng, lat] = s.split(',').map(Number);
          return { lng, lat };
        });
      inFlight--;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tileset: 'mapterhorn-egm08',
          version: '5',
          results: pts.map((p) => ({
            lon: p.lng,
            lat: p.lat,
            elevation: elevationOf(p.lng, p.lat),
            geoid: 0,
            ellipsoid: elevationOf(p.lng, p.lat),
          })),
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await POST(postRequest(points));
    const body = await res.json();

    expect(body.results).toHaveLength(300);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 300 misses / 256 per call = 2 chunks
    expect(maxInFlight).toBeLessThanOrEqual(1); // ...but never both in flight at once
  });

  it('returns null (never 0) for a point upstream cannot resolve, and does not cache the failure', async () => {
    const point = { lng: 40, lat: 40 };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
    const first = await POST(postRequest([point]));
    const firstBody = await first.json();
    expect(firstBody.results.map((r: HeightResult) => r.ellipsoid)).toEqual([null]);
    // Provenance moved to headers so the body stays the shape the client parses.
    expect(first.headers.get('x-oasis-unresolved')).toBe('1');

    // A fetcher that throws is never cached (documented gev-cache contract).
    // If the failure had been cached, this second call would still see fetch
    // called only once instead of twice.
    const fetchMock = stubUpstream();
    const second = await POST(postRequest([point]));
    const secondBody = await second.json();
    expect(secondBody.results.map((r: HeightResult) => r.ellipsoid)).toEqual([elevationOf(point.lng, point.lat)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
