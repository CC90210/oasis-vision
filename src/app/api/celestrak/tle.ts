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
): Promise<{ records: TleRecord[]; age: CacheAge; fetchedAt: number }> {
  if (!isValidGroup(group)) throw new Error(`celestrak: rejected group name "${group}"`);

  const result = await cachedJson<TleRecord[]>({
    key: `celestrak-${group}`,
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

      const records = parseTle(await res.text());
      if (records.length === 0) {
        // A 200 carrying no parseable TLE is CelesTrak throttling us with an
        // HTML page. Treated as a failure so the stale copy is served instead.
        throw new Error(`CelesTrak returned no parseable TLE for group ${group}`);
      }
      return records;
    },
  });

  console.log(`[OSIRIS] celestrak ${group} — ${result.data.length} objects (${result.age})`);
  return { records: result.data, age: result.age, fetchedAt: result.fetchedAt };
}
