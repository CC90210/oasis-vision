import { cachedJson, type CacheAge } from './gev-cache';
import { createHash } from 'node:crypto';

/**
 * OASIS VISION — Overpass (OpenStreetMap) query client.
 *
 * Public Overpass mirrors refuse constantly: rate limits, 504s under load, and
 * whole-mirror outages. God's Eye View learned this in production — on
 * 2026-07-17 all three of its mirrors were down during US morning peak and a
 * 45-second TTL left nothing to serve.
 *
 * Two rules carry the weight:
 *
 *   1. Rotate on ANY refusal, not just 429. A connection refused fails in
 *      milliseconds, so trying the next mirror costs nothing.
 *   2. A REFUSAL IS NEVER CACHED AS DATA. A cached 429 is indistinguishable
 *      from a region with no features, which is exactly the defect CLAUDE.md
 *      bans. Exhausting every mirror throws a named error; it never returns [].
 *
 * Geometry is static for months, so a fresh answer is good for a day and a
 * stale one still beats an empty map.
 */

export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
] as const;

const DEFAULT_TTL_MS = 24 * 3600_000;
const BOUNDARY_DISK_TTL_MS = 30 * 24 * 3600_000;
const DEFAULT_DISK_TTL_MS = 7 * 24 * 3600_000;
const TIMEOUT_MS = 22_000;
const MAX_BBOX_DEG = 12;

export interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OverpassOptions {
  /** Admin boundaries change almost never — keep them a month. */
  boundary?: boolean;
  ttlMs?: number;
  timeoutMs?: number;
}

export interface OverpassResult {
  elements: OverpassElement[];
  provenance: { mirror: string; age: CacheAge; fetchedAt: number };
}

/**
 * Reject a viewport before it becomes a query. An oversized box is a
 * multi-megabyte answer that will time out on a shared mirror, and an
 * antimeridian-crossing box silently returns the wrong half of the world.
 */
export function assertBbox(n: number, s: number, e: number, w: number): void {
  for (const [label, v] of [['n', n], ['s', s], ['e', e], ['w', w]] as const) {
    if (!Number.isFinite(v)) throw new Error(`overpass: ${label} is not a number`);
  }
  if (n <= s) throw new Error('overpass: north must be greater than south');
  if (e < w) throw new Error('overpass: bbox crosses the antimeridian, which is not supported');
  if (Math.abs(n - s) > MAX_BBOX_DEG || Math.abs(e - w) > MAX_BBOX_DEG) {
    throw new Error(`overpass: bbox exceeds the ${MAX_BBOX_DEG} degree limit`);
  }
}

const normalise = (ql: string) => ql.replace(/\s+/g, ' ').trim();

async function fetchFromMirrors(ql: string, timeoutMs: number): Promise<{ elements: OverpassElement[]; mirror: string }> {
  const refusals: string[] = [];

  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)',
        },
        body: new URLSearchParams({ data: ql }).toString(),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        refusals.push(`${new URL(mirror).hostname} HTTP ${res.status}`);
        continue;
      }

      const body = await res.json();
      if (!Array.isArray(body?.elements)) {
        refusals.push(`${new URL(mirror).hostname} returned no elements array`);
        continue;
      }
      return { elements: body.elements as OverpassElement[], mirror };
    } catch (e) {
      refusals.push(`${new URL(mirror).hostname} ${e instanceof Error ? e.message : 'failed'}`);
    }
  }

  // Named, and never an empty success. The caller decides what to tell the user.
  throw new Error(`every overpass mirror refused: ${refusals.join('; ')}`);
}

export async function overpassQuery(ql: string, opts: OverpassOptions = {}): Promise<OverpassResult> {
  const query = normalise(ql);
  const key = `overpass-${createHash('sha1').update(query).digest('hex').slice(0, 16)}`;

  const result = await cachedJson<{ elements: OverpassElement[]; mirror: string }>({
    key,
    ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
    diskTtlMs: opts.boundary ? BOUNDARY_DISK_TTL_MS : DEFAULT_DISK_TTL_MS,
    fetcher: () => fetchFromMirrors(query, opts.timeoutMs ?? TIMEOUT_MS),
  });

  console.log(
    `[OSIRIS] overpass ${key} — ${result.data.elements.length} elements ` +
    `(${result.age}, ${new URL(result.data.mirror).hostname})`,
  );

  return {
    elements: result.data.elements,
    provenance: { mirror: result.data.mirror, age: result.age, fetchedAt: result.fetchedAt },
  };
}
