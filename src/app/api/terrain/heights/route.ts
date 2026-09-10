import { NextResponse } from 'next/server';
import { cachedJson } from '@/lib/gev-cache';
import { parsePoints, canonicalPoint, UPSTREAM_CHUNK, type Point } from './points';

/**
 * Re:Earth terrain point-height proxy. Keyless.
 *
 * RULING R6: the brief this route was drafted from claimed upstream accepts
 * at most 256 points per call and that larger batches are "chunked
 * sequentially", but its own code issued one HTTP request per point — the
 * chunk loop only iterated the per-point calls, it never batched them. At
 * 2,000 points that is 2,000 sequential round trips against a 45s budget,
 * and it hammers a free, keyless community endpoint with 2,000 requests
 * where 8 would do. This file replaces that with real batching.
 *
 * The upstream's real batch shape is undocumented — its own docs page
 * (fetched directly) only describes tile-based terrain (quantized-mesh,
 * Terrarium, Terrain-RGB) and never mentions a point-height endpoint at all.
 * Probing the live endpoint directly found:
 *
 *   GET https://terrain.reearth.land/heights.json?points=lon,lat;lon,lat;...
 *   -> 400 { "error": "missing ?points= (format: lon,lat;lon,lat;...)" }   (no points param)
 *   -> 400 { "error": "malformed point: \"abc,def\" (non-numeric component)" }
 *   -> 400 { "error": "too many points: 257 > 256" }                       (confirms the 256 cap)
 *   -> 200 { "tileset": "mapterhorn-egm08", "version": "5",
 *            "results": [{ "lon", "lat", "elevation", "geoid", "ellipsoid" }, ...] }
 *
 * NOT the brief's guessed `?locations=lat,lng` for a single point: the real
 * param is `points`, pairs are `lon,lat` (not lat,lng) separated by `;`, and
 * the value is `elevation` (not `height`). A 3-point probe returned results
 * in the same order the points were requested, but the response length is
 * still checked against the request rather than trusted on faith.
 *
 * Caching + batching strategy: `cachedJson` is called once per point, so its
 * own mem/disk hit-check and single-flight logic run exactly as documented —
 * a point already cached never touches the network. The fetcher passed for a
 * genuine cache miss hands the point to a per-request batch loader instead of
 * fetching it directly; every miss produced during the same synchronous pass
 * over the request's points joins one microtask-deferred queue before any
 * upstream call fires, and that queue is split into calls of at most
 * UPSTREAM_CHUNK points. The final array is built by `Promise.all` over the
 * ORIGINAL points array, so it comes back in exact request order regardless
 * of cache-hit/miss layout or which upstream chunk resolved first — returning
 * hits before misses (or vice versa) would place every entity at the wrong
 * height while the response looked entirely successful.
 */

const UPSTREAM = 'https://terrain.reearth.land/heights.json';
const TTL_MS = 30 * 24 * 3600_000;
const PROVENANCE = 'Re:Earth Terrain / Mapterhorn (CC BY 4.0)';

export const dynamic = 'force-dynamic';
export const maxDuration = 45;

interface UpstreamResult {
  lon?: unknown;
  lat?: unknown;
  elevation?: unknown;
}

/** One real upstream call. Caller guarantees `points.length <= UPSTREAM_CHUNK`. */
export async function fetchBatch(points: Point[]): Promise<Array<number | null>> {
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

  return body.results.map((r) =>
    typeof r.elevation === 'number' && Number.isFinite(r.elevation) ? r.elevation : null,
  );
}

/**
 * Collects cache-miss point lookups from a single request and fires them
 * upstream in groups of at most UPSTREAM_CHUNK. `load(p)` is synchronous up
 * to the point it queues the job and schedules a microtask flush, so every
 * miss discovered during one synchronous pass over the request's points (see
 * `resolveHeights`) lands in the same queue before the first upstream call
 * goes out.
 */
function createBatchLoader() {
  type Job = { point: Point; resolve: (v: number | null) => void; reject: (e: unknown) => void };
  let queue: Job[] = [];
  let flushScheduled = false;

  function flush() {
    flushScheduled = false;
    const jobs = queue;
    queue = [];
    for (let i = 0; i < jobs.length; i += UPSTREAM_CHUNK) {
      const slice = jobs.slice(i, i + UPSTREAM_CHUNK);
      fetchBatch(slice.map((j) => j.point))
        .then((results) => slice.forEach((j, idx) => j.resolve(results[idx])))
        .catch((e) => slice.forEach((j) => j.reject(e)));
    }
  }

  return function load(point: Point): Promise<number | null> {
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
 * failure (network error, malformed upstream response) resolves to `null`
 * rather than failing the whole batch — a `catch { return [] }` here would
 * silently drop every OTHER point's real answer along with the one that
 * failed.
 */
export async function resolveHeights(points: Point[]): Promise<{ heights: Array<number | null>; unresolved: number }> {
  const load = createBatchLoader();
  let unresolved = 0;

  const heights = await Promise.all(
    points.map(async (p) => {
      const key = `terrain-${canonicalPoint(p.lng, p.lat)}`;
      try {
        const result = await cachedJson<number | null>({
          key,
          ttlMs: TTL_MS,
          diskTtlMs: TTL_MS,
          fetcher: () => load(p),
        });
        if (result.data === null) unresolved++;
        return result.data;
      } catch (e) {
        unresolved++;
        if (unresolved === 1) {
          console.warn('[OSIRIS] terrain heights — falling back to null:', e instanceof Error ? e.message : e);
        }
        // A null height is honest: the caller falls back to the bundled
        // geoid. Silently substituting zero would place an entity at sea
        // level, which looks like data instead of a gap.
        return null;
      }
    }),
  );

  if (unresolved > 0) {
    console.warn(`[OSIRIS] terrain heights — ${unresolved}/${points.length} points unresolved`);
  }

  return { heights, unresolved };
}

export async function POST(request: Request) {
  let points: Point[];
  try {
    points = parsePoints(await request.json());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid body' }, { status: 400 });
  }

  if (points.length === 0) {
    return NextResponse.json({ heights: [], provenance: { source: PROVENANCE, unresolved: 0 } });
  }

  const { heights, unresolved } = await resolveHeights(points);

  return NextResponse.json({
    heights,
    provenance: { source: PROVENANCE, unresolved },
  });
}
