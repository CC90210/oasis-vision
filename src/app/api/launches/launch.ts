import { cachedJson, type CacheAge } from '@/lib/gev-cache';

/**
 * OASIS VISION — Launch Library 2 (The Space Devs), rolling 30 days.
 *
 * Anonymous access is capped at 15 calls per HOUR. The 15-minute cache is the
 * mechanism that keeps this route inside that cap, not a performance choice —
 * remove it and the layer dies four minutes into a session. LL2_API_TOKEN
 * raises the cap and is never exposed to the client.
 *
 * LL2 supplies launch context and event timing. It does NOT supply continuous
 * ascent telemetry or live orbital state, and a failed launch must never be
 * given fallback trajectory geometry or a live marker — that would be the
 * "confident nonsense" this codebase names as its recurring defect.
 *
 * ── What this returns, and why ─────────────────────────────────────────────
 * The upstream `results` array of RAW LL2 records.
 *
 *   gods-eye-view src/data/rocketLaunches.js:3345-3346
 *       normalizeRocketLaunches(await response.json())
 *   gods-eye-view src/data/rocketLaunches.js:2782-2783
 *       const launches = Array.isArray(payload) ? payload : payload?.results;
 *   gods-eye-view src/data/rocketLaunches.js:2786-2820
 *       walks launch.net / window_start, launch.pad.{name,latitude,longitude},
 *       launch.pad.location.{name,coordinates}, launch.status.name,
 *       launch.launch_service_provider.name, launch.mission.{name,description,
 *       orbit}, launch.timeline[].{type.abbrev,relative_time},
 *       launch.trajectory
 *
 * There was a `mapLaunch` here that flattened those into
 * `{ lat, lng, padName, provider, … }`. It has been REMOVED rather than kept
 * as a validator, for a reason specific to this endpoint: its only remaining
 * gate would have been "the record has an id", and the client explicitly does
 * not require one (`String(launch.id || launch.slug || launch.name || …)`,
 * rocketLaunches.js:2797). A proxy that filters more strictly than its
 * consumer drops launches the globe would happily have rendered, and it does
 * so silently. The gate below is therefore the weakest one that is still
 * honest: it must be a record, not an array, not a string.
 */

const LL2_URL = 'https://ll.thespacedevs.com/2.3.0/launches/';
const TTL_MS = 15 * 60_000;
const WINDOW_DAYS = 30;

/**
 * Header values are ByteStrings: any code point above 255 throws when the
 * response is constructed. An em dash here took the whole route to 502 until
 * the contract test caught it. ASCII only in anything that becomes a header.
 */
export const LAUNCH_SOURCE = 'Launch Library 2 (The Space Devs)';

export interface LaunchFeed {
  count: number;
  results: Array<Record<string, unknown>>;
}

/**
 * The weakest honest gate: a launch record is a JSON object. Anything else
 * (LL2's error strings, a stray array) cannot be walked by the client's
 * normalizer and would throw inside it.
 */
export function isLaunchRecord(raw: unknown): raw is Record<string, unknown> {
  return Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw);
}

export async function fetchLaunches(): Promise<{ feed: LaunchFeed; age: CacheAge; fetchedAt: number }> {
  const result = await cachedJson<LaunchFeed>({
    key: 'll2-launches-30d-raw',
    ttlMs: TTL_MS,
    fetcher: async () => {
      const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
      const until = new Date().toISOString();
      const url = new URL(LL2_URL);
      url.searchParams.set('net__gte', since);
      url.searchParams.set('net__lte', until);
      url.searchParams.set('limit', '50');
      url.searchParams.set('mode', 'detailed');
      url.searchParams.set('ordering', '-net');

      const headers: Record<string, string> = { 'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)' };
      const token = process.env.LL2_API_TOKEN?.trim();
      if (token) headers.Authorization = `Token ${token}`;

      const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(25_000) });
      if (res.status === 429) throw new Error('Launch Library 2 rate limited (15 calls/hour anonymous)');
      if (!res.ok) throw new Error(`Launch Library 2 HTTP ${res.status}`);

      const body = await res.json();
      const rows: unknown[] = Array.isArray(body?.results) ? body.results : [];
      const results = rows.filter(isLaunchRecord);
      if (rows.length > 0 && results.length === 0) {
        throw new Error(`Launch Library 2 returned ${rows.length} rows, none of them launch records`);
      }

      return { count: results.length, results };
    },
  });

  console.log(`[OSIRIS] launches — ${result.data.results.length} in the last ${WINDOW_DAYS}d (${result.age})`);
  if (result.data.results.length === 0) {
    console.warn('[OSIRIS] launches — zero launches in window; the launches layer will be empty');
  }
  return { feed: result.data, age: result.age, fetchedAt: result.fetchedAt };
}
