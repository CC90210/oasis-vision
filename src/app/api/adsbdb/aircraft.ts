import { cachedJson, type CacheAge } from '@/lib/gev-cache';

/**
 * OASIS VISION — adsbdb aircraft and route lookups.
 *
 * The live transponder feed carries a hex code and a callsign and nothing else.
 * adsbdb turns those into a registration, a model and an operator. Keyless,
 * ODbL.
 *
 * Aircraft records change on a registration timescale, not a flight one, so a
 * day of caching is generous rather than stale. Routes are cached the same way:
 * a callsign's city pair is a schedule, not a position.
 */

const BASE = 'https://api.adsbdb.com/v0';
const TTL_MS = 24 * 3600_000;

export interface AircraftInfo {
  icaoType: string | null;
  manufacturer: string | null;
  model: string | null;
  registration: string | null;
  operator: string | null;
}

export interface Airport {
  iata: string | null;
  icao: string | null;
  name: string | null;
}

export interface CallsignRoute {
  callsign: string;
  origin: Airport | null;
  destination: Airport | null;
}

/** These reach a URL path, so they are allowlisted rather than encoded. */
export function isValidHexOrReg(v: string): boolean {
  return /^[A-Za-z0-9-]{1,12}$/.test(v);
}

export function isValidCallsign(v: string): boolean {
  return /^[A-Za-z0-9]{2,12}$/.test(v);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * adsbdb answers "no record" with `response: "unknown aircraft"` — a string
 * where an object belongs — so the shape is checked rather than assumed.
 */
export function mapAircraft(raw: unknown): AircraftInfo | null {
  const a = rec(rec(rec(raw)?.response)?.aircraft);
  if (!a) return null;

  return {
    icaoType: str(a.icao_type),
    manufacturer: str(a.manufacturer),
    model: str(a.type),
    registration: str(a.registration),
    operator: str(a.registered_owner),
  };
}

function mapAirport(raw: unknown): Airport | null {
  const a = rec(raw);
  if (!a) return null;
  return { iata: str(a.iata_code), icao: str(a.icao_code), name: str(a.name) };
}

export function mapCallsignRoute(raw: unknown): CallsignRoute | null {
  const r = rec(rec(rec(raw)?.response)?.flightroute);
  const callsign = str(r?.callsign);
  if (!r || !callsign) return null;

  return {
    callsign,
    origin: mapAirport(r.origin),
    destination: mapAirport(r.destination),
  };
}

async function lookup<T>(path: string, key: string, map: (raw: unknown) => T | null): Promise<{ data: T | null; age: CacheAge }> {
  const result = await cachedJson<T | null>({
    key,
    ttlMs: TTL_MS,
    fetcher: async () => {
      const res = await fetch(`${BASE}/${path}`, {
        headers: { 'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)' },
        signal: AbortSignal.timeout(12_000),
      });
      // 404 is adsbdb's honest "no such record" and is a valid answer to cache.
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`adsbdb HTTP ${res.status} for ${path}`);
      return map(await res.json());
    },
  });
  return { data: result.data, age: result.age };
}

export const lookupAircraft = (id: string) =>
  lookup<AircraftInfo>(`aircraft/${encodeURIComponent(id)}`, `adsbdb-ac-${id}`, mapAircraft);

export const lookupCallsign = (callsign: string) =>
  lookup<CallsignRoute>(`callsign/${encodeURIComponent(callsign)}`, `adsbdb-cs-${callsign}`, mapCallsignRoute);
