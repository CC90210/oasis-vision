import { NextResponse } from 'next/server';
import { cachedJson } from '@/lib/gev-cache';
import { provenanceHeaders } from '@/lib/gev-provenance';
import { parsePoints, parsePointsParam, canonicalPoint, UPSTREAM_CHUNK, type Point } from './points';

/**
 * Re:Earth terrain point-height proxy. Keyless.
 *
 * ── The contract this serves ───────────────────────────────────────────────
 * GET `?points=lon,lat;lon,lat;…` → `{ results: [{lon, lat, elevation, geoid,
 * ellipsoid}, …] }`, same length and order as the request.
 *
 *   gods-eye-view src/data/terrainHeights.js:100-103   GET, query string
 *   gods-eye-view src/data/terrainHeights.js:106-111   Array.isArray(body.results)
 *                                                      and results.length === chunk.length
 *   gods-eye-view src/data/terrainHeights.js:117-119   Number(results[i].ellipsoid), must be finite
 *   gods-eye-view src/data/terrainHeights.js:113-115   mapped POSITIONALLY
 *
 * This route previously accepted only POST with a JSON body and answered
 * `{ heights: [...] }` of `elevation` values. Both halves were wrong, and the
 * failure was invisible: the client catches, and substitutes `geoidFallback()`
 * (terrainHeights.js:126-131) — the geoid surface, a coast-level prior — which
 * renders as a real ground height. At Austin that is ~165 m below the airport.
 * "Sea-level poison" is the client's own name for it. Wrong by ~33 m even at
 * the sample point in the contract test.
 *
 * ELLIPSOID, not elevation: `elevation` is orthometric (height above the
 * geoid); `ellipsoid` is height above the WGS84 ellipsoid, which is what
 * Cesium places entities against.
 *
 * ── Upstream ──────────────────────────────────────────────────────────────
 * RULING R6: the brief this route was drafted from claimed upstream accepts
 * at most 256 points per call and that larger batches are "chunked
 * sequentially", but its own code issued one HTTP request per point. This
 * file does real batching.
 *
 * The upstream's batch shape is undocumented — its own docs page only
 * describes tile-based terrain and never mentions a point-height endpoint.
 * Probing the live endpoint directly (re-confirmed 2026-09-09) found:
 *
 *   GET https://terrain.reearth.land/heights.json?points=lon,lat;lon,lat;...
 *   -> 400 { "error": "missing ?points= (format: lon,lat;lon,lat;...)" }
 *   -> 400 { "error": "malformed point: \"abc,def\" (non-numeric component)" }
 *   -> 400 { "error": "too many points: 257 > 256" }
 *   -> 200 { "tileset": "mapterhorn-egm08", "version": "5",
 *            "results": [{ "lon", "lat", "elevation", "geoid", "ellipsoid" }, ...] }
 *
 * Caching + batching: `cachedJson` is called once per point, so its mem/disk
 * hit-check and single-flight logic run exactly as documented — a point
 * already cached never touches the network. The fetcher passed for a genuine
 * miss hands the point to a per-request batch loader; every miss produced
 * during the same synchronous pass joins one microtask-deferred queue before
 * any upstream call fires, split into calls of at most UPSTREAM_CHUNK points.
 * The final array is built by `Promise.all` over the ORIGINAL points array,
 * so it comes back in exact request order regardless of cache-hit/miss layout
 * or which chunk resolved first — returning hits before misses would place
 * every entity at the wrong height while the response looked successful.
 *
 * RULING R20: chunks are awaited one at a time, never fired concurrently.
 * The whole reason R6 replaced the brief's implementation was courtesy to a
 * free, keyless, community-run endpoint — a fan-out of up to 8 simultaneous
 * requests at the 2,000-point cap is the opposite of that, and it is also
 * the shape that gets an IP quietly rate-limited (which would fail as an
 * empty terrain layer, not an error).
 */

const UPSTREAM = 'https://terrain.reearth.land/heights.json';
const TTL_MS = 30 * 24 * 3600_000;
const PROVENANCE = 'Re:Earth Terrain / Mapterhorn (CC BY 4.0)';

export const dynamic = 'force-dynamic';
export const maxDuration = 45;

/** One resolved point, in the shape the client reads positionally. */
export interface HeightResult {
  lon: number;
  lat: number;
  /** Orthometric height (above the geoid), metres. */
  elevation: number | null;
  /** Geoid undulation at the point, metres. */
  geoid: number | null;
  /** Height above the WGS84 ellipsoid, metres. THIS is what the client uses. */
  ellipsoid: number | null;
}

interface UpstreamResult {
  lon?: unknown;
  lat?: unknown;
  elevation?: unknown;
  geoid?: unknown;
  ellipsoid?: unknown;
}

const fin = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** One real upstream call. Caller guarantees `points.length <= UPSTREAM_CHUNK`. */
export async function fetchBatch(points: Point[]): Promise<Array<HeightResult>> {
  const url = new URL(UPSTREAM);
  url.searchParams.set('points', points.map((p) => `${p.lng},${p.lat}`).join(';'));

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Re:Earth terrain HTTP ${res.status}`);

  const body = (await res.json()) as { results?: UpstreamResult[] };
  if (!Array.isArray(body.results) || body.results.length !== points.length) {
    const got = Array.isArray(body.results) ? body.results.length : typeof body.results;
    throw new Error(`Re:Earth terrain: expected ${points.length} results, got ${got}`);
  }

  return body.results.map((r, i) => ({
    // The request's own coordinates, not the upstream echo: the client maps
    // positionally and these must line up with what it asked for.
    lon: points[i].lng,
    lat: points[i].lat,
    elevation: fin(r.elevation),
    geoid: fin(r.geoid),
    ellipsoid: fin(r.ellipsoid),
  }));
}

/**
 * Collects cache-miss point lookups from a single request and fires them
 * upstream in groups of at most UPSTREAM_CHUNK, one group at a time.
 */
function createBatchLoader() {
  type Job = { point: Point; resolve: (v: HeightResult | null) => void; reject: (e: unknown) => void };
  let queue: Job[] = [];
  let flushScheduled = false;

  async function flush() {
    flushScheduled = false;
    const jobs = queue;
    queue = [];
    for (let i = 0; i < jobs.length; i += UPSTREAM_CHUNK) {
      const slice = jobs.slice(i, i + UPSTREAM_CHUNK);
      try {
        const results = await fetchBatch(slice.map((j) => j.point));
        slice.forEach((j, idx) => j.resolve(results[idx]));
      } catch (e) {
        slice.forEach((j) => j.reject(e));
      }
    }
  }

  return function load(point: Point): Promise<HeightResult | null> {
    return new Promise((resolve, reject) => {
      queue.push({ point, resolve, reject });
      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    });
  };
}

/**
 * Resolves heights for every point, in exact request order. A per-point
 * failure (network error, malformed upstream response) resolves to a record
 * whose heights are `null` rather than failing the whole batch — a
 * `catch { return [] }` here would silently drop every OTHER point's real
 * answer along with the one that failed.
 *
 * `null`, never `0`. The client throws on a non-finite ellipsoid and falls
 * back to its bundled geoid for that chunk, which is an honest approximation
 * it labels as such. A zero would be sea level presented as a measurement.
 */
export async function resolveHeights(
  points: Point[],
): Promise<{ results: HeightResult[]; unresolved: number }> {
  const load = createBatchLoader();
  let unresolved = 0;

  const results = await Promise.all(
    points.map(async (p) => {
      const key = `terrain-pt-${canonicalPoint(p.lng, p.lat)}`;
      const empty: HeightResult = { lon: p.lng, lat: p.lat, elevation: null, geoid: null, ellipsoid: null };
      try {
        const result = await cachedJson<HeightResult | null>({
          key,
          ttlMs: TTL_MS,
          diskTtlMs: TTL_MS,
          fetcher: () => load(p),
        });
        if (!result.data || result.data.ellipsoid === null) {
          unresolved++;
          return result.data ?? empty;
        }
        // Cached entries carry the canonical coordinate they were stored
        // under; re-stamp the request's own so positional mapping is exact.
        return { ...result.data, lon: p.lng, lat: p.lat };
      } catch (e) {
        unresolved++;
        if (unresolved === 1) {
          console.warn('[OSIRIS] terrain heights — falling back to null:', e instanceof Error ? e.message : e);
        }
        return empty;
      }
    }),
  );

  if (unresolved > 0) {
    console.warn(`[OSIRIS] terrain heights — ${unresolved}/${points.length} points unresolved`);
  }

  return { results, unresolved };
}

function respond(results: HeightResult[], unresolved: number) {
  return NextResponse.json(
    { results },
    {
      headers: provenanceHeaders({
        // Per-point cache ages differ across a batch, so a single `age` for
        // the response would be a claim this route cannot make. It reports
        // what it can stand behind instead: how many points it could not
        // resolve at all.
        age: 'fresh',
        source: PROVENANCE,
        extra: {
          'X-Oasis-Unresolved': String(unresolved),
          'X-Oasis-Points': String(results.length),
          'X-Oasis-Age-Note': 'per-point cache; X-Oasis-Age describes this response assembly, not each point',
        },
      }),
    },
  );
}

/** The contract the vendored client actually calls. */
export async function GET(request: Request) {
  let points: Point[];
  try {
    points = parsePointsParam(new URL(request.url).searchParams.get('points'));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid points' }, { status: 400 });
  }

  if (points.length === 0) return respond([], 0);

  const { results, unresolved } = await resolveHeights(points);
  return respond(results, unresolved);
}

/**
 * Kept for callers that would rather send a body than a query string (the
 * GET has a Node header-size ceiling somewhere past ~700-1500 points, which
 * is why the client chunks at 200). Same envelope as GET — one contract.
 */
export async function POST(request: Request) {
  let points: Point[];
  try {
    points = parsePoints(await request.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid body' }, { status: 400 });
  }

  if (points.length === 0) return respond([], 0);

  const { results, unresolved } = await resolveHeights(points);
  return respond(results, unresolved);
}
