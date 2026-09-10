import { cachedJson, type CacheAge } from '@/lib/gev-cache';

/**
 * OASIS VISION — OpenSky state vectors for the God's Eye View globe.
 *
 * Separate from src/app/api/flights/route.ts, which serves the MapLibre console
 * with a different response shape. Both call OpenSky; neither should be made to
 * serve the other's client.
 *
 * OpenSky returns state vectors as POSITIONAL ARRAYS. Index 5 is longitude and
 * index 6 is latitude — that order, which is the reverse of how they are
 * usually written. Swapping them plots every aircraft somewhere plausible and
 * wrong, so the mapping is pinned by its own test.
 *
 * Anonymous access is heavily rate limited; a call costs 4 credits against a
 * 4,000/day budget with credentials. The 9-second cache is what keeps a globe
 * that polls inside that budget.
 */

const STATES_URL = 'https://opensky-network.org/api/states/all';
const TRACK_URL = 'https://opensky-network.org/api/tracks/all';
const TTL_MS = 9_000;

export interface OpenSkyState {
  hex: string;
  callsign: string | null;
  country: string | null;
  lat: number;
  lng: number;
  altM: number | null;
  onGround: boolean;
  speedMs: number | null;
  headingDeg: number | null;
  verticalRateMs: number | null;
  squawk: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function mapStateVector(row: unknown[]): OpenSkyState | null {
  if (!Array.isArray(row) || row.length < 15) return null;

  const hex = str(row[0]);
  const lng = num(row[5]);
  const lat = num(row[6]);
  if (!hex || lat === null || lng === null) return null;

  return {
    hex,
    callsign: str(row[1]),
    country: str(row[2]),
    lat,
    lng,
    altM: num(row[7]),
    onGround: row[8] === true,
    speedMs: num(row[9]),
    headingDeg: num(row[10]),
    verticalRateMs: num(row[11]),
    squawk: str(row[14]),
  };
}

export async function fetchStates(): Promise<{ states: OpenSkyState[]; age: CacheAge; fetchedAt: number }> {
  const result = await cachedJson<OpenSkyState[]>({
    key: 'opensky-states',
    ttlMs: TTL_MS,
    fetcher: async () => {
      const res = await fetch(STATES_URL, {
        headers: { 'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)' },
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status === 429) throw new Error('OpenSky rate limited (429)');
      if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);

      const body = await res.json();
      const rows = Array.isArray(body?.states) ? body.states : [];
      const states: OpenSkyState[] = [];
      for (const row of rows) {
        const s = mapStateVector(row);
        if (s) states.push(s);
      }
      return states;
    },
  });

  console.log(`[OSIRIS] opensky states — ${result.data.length} aircraft (${result.age})`);
  return { states: result.data, age: result.age, fetchedAt: result.fetchedAt };
}

export async function fetchTrack(icao: string): Promise<{ data: unknown; age: CacheAge }> {
  if (!/^[0-9a-fA-F]{6}$/.test(icao)) throw new Error(`opensky: rejected icao "${icao}"`);

  const result = await cachedJson<unknown>({
    key: `opensky-track-${icao.toLowerCase()}`,
    ttlMs: 60_000,
    fetcher: async () => {
      const url = new URL(TRACK_URL);
      url.searchParams.set('icao24', icao.toLowerCase());
      url.searchParams.set('time', '0');
      const res = await fetch(url.toString(), {
        headers: { 'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`OpenSky track HTTP ${res.status} for ${icao}`);
      return res.json();
    },
  });
  return { data: result.data, age: result.age };
}
