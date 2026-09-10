import { cachedJson, type CacheAge } from '@/lib/gev-cache';

/**
 * OASIS VISION — adsb.lol military aircraft snapshot and traces.
 *
 * Keyless, ODbL. This is the feed behind the military layer on the globe.
 *
 * Two details that produce wrong answers if missed:
 *   - `flight` is space-padded to eight characters. Untrimmed, every callsign
 *     compares unequal to itself.
 *   - `alt_baro` is the STRING "ground" for an aircraft on the ground. Coerced
 *     naively it becomes NaN and the aircraft vanishes from the layer.
 */

const MIL_URL = 'https://api.adsb.lol/v2/mil';
const TRACE_BASE = 'https://api.adsb.lol/v2/icao';
const TTL_MS = 15_000;

export interface MilAircraft {
  hex: string;
  callsign: string | null;
  lat: number;
  lng: number;
  altFt: number | null;
  headingDeg: number | null;
  speedKts: number | null;
  squawk: string | null;
  type: string | null;
}

export function isValidIcaoHex(v: string): boolean {
  return /^[0-9a-fA-F]{6}$/.test(v);
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function mapMilAircraft(raw: unknown): MilAircraft | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;

  const hex = str(a.hex);
  const lat = num(a.lat);
  const lng = num(a.lon);
  // No position means nothing to draw. Not an error, just not a contact.
  if (!hex || lat === null || lng === null) return null;

  return {
    hex,
    callsign: str(a.flight),
    lat,
    lng,
    altFt: a.alt_baro === 'ground' ? 0 : num(a.alt_baro),
    headingDeg: num(a.track),
    speedKts: num(a.gs),
    squawk: str(a.squawk),
    type: str(a.t),
  };
}

export async function fetchMilitary(): Promise<{ aircraft: MilAircraft[]; age: CacheAge; fetchedAt: number }> {
  const result = await cachedJson<MilAircraft[]>({
    key: 'adsblol-mil',
    ttlMs: TTL_MS,
    fetcher: async () => {
      const res = await fetch(MIL_URL, {
        headers: { 'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`adsb.lol HTTP ${res.status}`);

      const body = await res.json();
      const rows = Array.isArray(body?.ac) ? body.ac : [];
      const aircraft: MilAircraft[] = [];
      for (const row of rows) {
        const m = mapMilAircraft(row);
        if (m) aircraft.push(m);
      }
      return aircraft;
    },
  });

  console.log(`[OSIRIS] adsb.lol military — ${result.data.length} contacts (${result.age})`);
  return { aircraft: result.data, age: result.age, fetchedAt: result.fetchedAt };
}

export async function fetchTrace(icao: string): Promise<{ data: unknown; age: CacheAge }> {
  if (!isValidIcaoHex(icao)) throw new Error(`adsb.lol: rejected icao "${icao}"`);

  const result = await cachedJson<unknown>({
    key: `adsblol-trace-${icao.toLowerCase()}`,
    ttlMs: 60_000,
    fetcher: async () => {
      const res = await fetch(`${TRACE_BASE}/${encodeURIComponent(icao.toLowerCase())}`, {
        headers: { 'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`adsb.lol trace HTTP ${res.status} for ${icao}`);
      return res.json();
    },
  });
  return { data: result.data, age: result.age };
}
