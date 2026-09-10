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
 */

const LL2_URL = 'https://ll.thespacedevs.com/2.3.0/launches/';
const TTL_MS = 15 * 60_000;
const WINDOW_DAYS = 30;

export interface Launch {
  id: string;
  name: string | null;
  status: string | null;
  statusAbbrev: string | null;
  net: string | null;
  provider: string | null;
  rocket: string | null;
  padName: string | null;
  padLocation: string | null;
  lat: number | null;
  lng: number | null;
  missionDescription: string | null;
  orbitName: string | null;
}

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** LL2 sends pad coordinates as numbers on some records and strings on others. */
const coord = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

export function mapLaunch(raw: unknown): Launch | null {
  const l = rec(raw);
  const id = str(l?.id);
  if (!l || !id) return null;

  const status = rec(l.status);
  const pad = rec(l.pad);
  const mission = rec(l.mission);

  return {
    id,
    name: str(l.name),
    status: str(status?.name),
    statusAbbrev: str(status?.abbrev),
    net: str(l.net),
    provider: str(rec(l.launch_service_provider)?.name),
    rocket: str(rec(rec(l.rocket)?.configuration)?.full_name),
    padName: str(pad?.name),
    padLocation: str(rec(pad?.location)?.name),
    lat: coord(pad?.latitude),
    lng: coord(pad?.longitude),
    missionDescription: str(mission?.description),
    orbitName: str(rec(mission?.orbit)?.name),
  };
}

export async function fetchLaunches(): Promise<{ launches: Launch[]; age: CacheAge; fetchedAt: number }> {
  const result = await cachedJson<Launch[]>({
    key: 'll2-launches-30d',
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
      const rows = Array.isArray(body?.results) ? body.results : [];
      const launches: Launch[] = [];
      for (const row of rows) {
        const m = mapLaunch(row);
        if (m) launches.push(m);
      }
      return launches;
    },
  });

  console.log(`[OSIRIS] launches — ${result.data.length} in the last ${WINDOW_DAYS}d (${result.age})`);
  return { launches: result.data, age: result.age, fetchedAt: result.fetchedAt };
}
