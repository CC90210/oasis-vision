import { cachedJson, type CacheAge } from '@/lib/gev-cache';

/**
 * OASIS VISION — CelesTrak GP/TLE proxy.
 *
 * CelesTrak sends no CORS headers, so the browser cannot fetch it directly.
 * It also asks clients not to refetch GP data more than about every two hours
 * and throttles offenders, so the cache is a courtesy obligation rather than a
 * performance tweak: 6 h TTL, and a stale TLE beats an empty satellite layer.
 *
 * It 403s bulk groups such as `active` unless the request carries a descriptive
 * User-Agent with a contact point.
 *
 * WHAT THIS RETURNS, AND WHY: the raw upstream TLE TEXT, verbatim.
 * The vendored globe client does `parseTLE(await res.text())`
 * (gods-eye-view src/data/satellites.js:1104-1108 and :1637, and
 * src/data/rocketLaunches.js:3258-3262). It never calls `res.json()` here.
 * A JSON envelope parses to zero entries, so the satellite layer empties
 * behind a 200 with nothing logged anywhere — the worst failure shape in
 * this codebase. `parseTle` below stays as a VALIDATOR and a counter, not
 * as the response.
 */

const GP_URL = 'https://celestrak.org/NORAD/elements/gp.php';
const TTL_MS = 6 * 3600_000;
const UA = 'OasisVision/1.0 celestrak-proxy (+https://oasisai.work)';

export interface TleRecord {
  name: string;
  line1: string;
  line2: string;
  noradId: string;
}

/**
 * Group names reach a URL, so they are charset-allowlisted rather than merely
 * encoded. `stations&FORMAT=json` would otherwise change what we asked for.
 */
export function isValidGroup(group: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(group);
}

/**
 * TLE is a fixed three-line format: name, then two 69-character element lines.
 * Anything that is not a well-formed triple is dropped rather than guessed at —
 * CelesTrak serves HTML error pages with status 200 when throttling, and a
 * half-parsed record would be plotted as a satellite that does not exist.
 *
 * This no longer shapes the response. It is the gate that decides whether the
 * body we are about to hand the client is TLE at all, and it supplies the
 * object count for the log line. Kept, and kept tested, for exactly that.
 */
export function parseTle(text: string): TleRecord[] {
  const lines = text.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0);
  const out: TleRecord[] = [];

  for (let i = 0; i + 2 < lines.length + 1; i += 3) {
    const name = lines[i]?.trim();
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (!name || !line1 || !line2) break;
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;

    const noradId = line1.slice(2, 7).trim();
    if (!/^\d{1,5}$/.test(noradId)) continue;

    out.push({ name, line1, line2, noradId });
  }

  return out;
}

export async function fetchTleGroup(
  group: string,
): Promise<{ text: string; records: TleRecord[]; age: CacheAge; fetchedAt: number }> {
  if (!isValidGroup(group)) throw new Error(`celestrak: rejected group name "${group}"`);

  const result = await cachedJson<string>({
    key: `celestrak-text-${group}`,
    ttlMs: TTL_MS,
    fetcher: async () => {
      const url = new URL(GP_URL);
      url.searchParams.set('GROUP', group);
      url.searchParams.set('FORMAT', 'tle');

      const res = await fetch(url.toString(), {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`CelesTrak HTTP ${res.status} for group ${group}`);

      const text = await res.text();
      if (parseTle(text).length === 0) {
        // A 200 carrying no parseable TLE is CelesTrak throttling us with an
        // HTML page. Treated as a failure so the stale copy is served instead
        // of an HTML page reaching the client's parser as "zero satellites".
        throw new Error(`CelesTrak returned no parseable TLE for group ${group}`);
      }
      return text;
    },
  });

  const records = parseTle(result.data);
  console.log(`[OSIRIS] celestrak ${group} — ${records.length} objects (${result.age})`);
  return { text: result.data, records, age: result.age, fetchedAt: result.fetchedAt };
}
