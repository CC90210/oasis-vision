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
 *
 * ── Unlike the other proxies in this folder, these mappers ARE the contract ─
 * Everywhere else the vendored client parses the raw upstream shape, so the
 * proxy forwards it verbatim. Here the client wants its OWN key names, at the
 * top level of the response:
 *
 *   gods-eye-view src/data/flights.js:823-828
 *       fetch('/api/adsbdb/type/<hex>') → data.found, then
 *       data.typeCode, data.typeName, data.registration
 *   gods-eye-view src/data/flights.js:847-851
 *       fetch('/api/adsbdb/route/<callsign>') → data.found, then
 *       data.airline (a STRING — rendered as text at flights.js:3289),
 *       data.origin and data.destination
 *   gods-eye-view src/data/flights.js:417, 2914-2918, 3292, 3750
 *       route endpoints are read as `.code`
 *   gods-eye-view src/data/routePlausible.js:54-67
 *       and as `.lat` / `.lon`, in degrees — the geometry check that decides
 *       whether a route is shown at all
 *
 * So the translation is real work, not envelope decoration: adsbdb says
 * `icao_type`, `iata_code`, `latitude`; the client says `typeCode`, `code`,
 * `lat`. Verified against live adsbdb responses on 2026-09-09.
 */

const BASE = 'https://api.adsbdb.com/v0';
const TTL_MS = 24 * 3600_000;

export interface AircraftInfo {
  typeCode: string | null;
  typeName: string | null;
  manufacturer: string | null;
  registration: string | null;
  operator: string | null;
}

export interface Airport {
  /** What the client renders: `ORIGIN → DESTINATION`. IATA, else ICAO. */
  code: string | null;
  iata: string | null;
  icao: string | null;
  name: string | null;
  /** Degrees. routePlausible.js requires finite values or it skips the check. */
  lat: number | null;
  lon: number | null;
}

export interface CallsignRoute {
  callsign: string;
  /** A display string, not an object — flights.js:3289 joins it as text. */
  airline: string | null;
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

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * adsbdb answers "no record" with `response: "unknown aircraft"` — a string
 * where an object belongs — so the shape is checked rather than assumed.
 */
export function mapAircraft(raw: unknown): AircraftInfo | null {
  const a = rec(rec(rec(raw)?.response)?.aircraft);
  if (!a) return null;

  const manufacturer = str(a.manufacturer);
  const model = str(a.type);
  // "Gulfstream Aerospace G650 ER" reads better on a label than either half,
  // but a missing manufacturer must not produce a leading space.
  const typeName = [manufacturer, model].filter(Boolean).join(' ') || null;

  return {
    typeCode: str(a.icao_type),
    typeName,
    manufacturer,
    registration: str(a.registration),
    operator: str(a.registered_owner),
  };
}

function mapAirport(raw: unknown): Airport | null {
  const a = rec(raw);
  if (!a) return null;
  const iata = str(a.iata_code);
  const icao = str(a.icao_code);
  return {
    code: iata ?? icao,
    iata,
    icao,
    name: str(a.name),
    lat: num(a.latitude),
    lon: num(a.longitude),
  };
}

export function mapCallsignRoute(raw: unknown): CallsignRoute | null {
  const r = rec(rec(rec(raw)?.response)?.flightroute);
  const callsign = str(r?.callsign);
  if (!r || !callsign) return null;

  return {
    callsign,
    airline: str(rec(r.airline)?.name),
    origin: mapAirport(r.origin),
    destination: mapAirport(r.destination),
  };
}

async function lookup<T>(
  path: string,
  key: string,
  map: (raw: unknown) => T | null,
): Promise<{ data: T | null; age: CacheAge; fetchedAt: number }> {
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
  return { data: result.data, age: result.age, fetchedAt: result.fetchedAt };
}

export async function lookupAircraft(id: string) {
  if (!isValidHexOrReg(id)) throw new Error(`Invalid aircraft identifier: ${id}`);
  return lookup<AircraftInfo>(`aircraft/${encodeURIComponent(id)}`, `adsbdb-ac2-${id}`, mapAircraft);
}

export async function lookupCallsign(callsign: string) {
  if (!isValidCallsign(callsign)) throw new Error(`Invalid callsign: ${callsign}`);
  return lookup<CallsignRoute>(`callsign/${encodeURIComponent(callsign)}`, `adsbdb-cs2-${callsign}`, mapCallsignRoute);
}
