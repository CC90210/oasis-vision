import { cachedJson, type CacheAge } from '@/lib/gev-cache';

/**
 * OASIS VISION — adsb.lol military aircraft snapshot and readsb traces.
 *
 * Keyless, ODbL. This is the feed behind the military layer on the globe.
 *
 * ── What the snapshot returns, and why ─────────────────────────────────────
 * The upstream body verbatim: `{ ac, now, total, msg }`.
 *
 *   gods-eye-view src/data/militaryFlights.js:2814-2820
 *       // adsb.lol returns { ac: [...aircraft], msg: "...", ... }
 *       if (!data || !Array.isArray(data.ac)) → 'Malformed adsb.lol response'
 *   gods-eye-view src/data/militaryFlights.js:2845-2850, 2858, 3019
 *       per-record: hex, lon, lat, alt_baro, alt_geom, track, gs, seen_pos,
 *       flight, t, r, ownOp
 *   gods-eye-view src/data/militaryRegistry.js:108-111
 *       the flights layer ALSO reads this endpoint for `data.ac[].hex`
 *
 * Two details that produce wrong answers if missed, and which is why the
 * records are forwarded raw rather than reshaped:
 *   - `flight` is space-padded to eight characters. The client trims it
 *     itself; a proxy that trims and renames the field removes it instead.
 *   - `alt_baro` is the STRING "ground" for an aircraft on the ground, and
 *     militaryFlights.js:2858 branches on that exact string. Coerced to a
 *     number it becomes NaN and the aircraft vanishes from the layer.
 *
 * ── Traces ────────────────────────────────────────────────────────────────
 * `https://api.adsb.lol/v2/icao/<hex>` is NOT a trace. Probed 2026-09-09 it
 * answers `{ ac: [ ...one live record... ], msg, now, total }` — no
 * `timestamp`, no `trace`. The client reads `data.timestamp` and `data.trace`
 * (militaryFlights.js:2205-2206) for ~24 h of history, which is the readsb
 * trace file served from globe.adsb.lol. That is what this fetches.
 */

const MIL_URL = 'https://api.adsb.lol/v2/mil';
const TRACE_BASE = 'https://globe.adsb.lol/data/traces';
const TTL_MS = 15_000;
const UA = { 'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)' };

export interface MilFeed {
  ac: Array<Record<string, unknown>>;
  now: number | null;
  total: number;
  msg: string;
}

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

/**
 * The field meanings, in one place, pinned by military.test.ts.
 *
 * No longer the response — the client needs the raw record. Kept as the
 * VALIDATOR: it is the server-side twin of the client's
 * `_isUsableMilitaryAircraft` (militaryFlights.js ~2740), so a record this
 * rejects is one the client would drop anyway, and a whole upstream body that
 * yields none of them is a shape change worth failing on rather than
 * forwarding as an empty sky.
 */
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

export async function fetchMilitary(): Promise<{ feed: MilFeed; age: CacheAge; fetchedAt: number }> {
  const result = await cachedJson<MilFeed>({
    key: 'adsblol-mil-raw',
    ttlMs: TTL_MS,
    fetcher: async () => {
      const res = await fetch(MIL_URL, { headers: UA, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`adsb.lol HTTP ${res.status}`);

      const body = await res.json();
      const rows: unknown[] = Array.isArray(body?.ac) ? body.ac : [];

      // Contribution check, not presence: forward only records the client can
      // actually use, and treat "rows arrived but none are usable" as a shape
      // change so the stale copy is served and the reason is named.
      const usable = rows.filter(r => mapMilAircraft(r) !== null) as Array<Record<string, unknown>>;
      if (rows.length > 0 && usable.length === 0) {
        throw new Error(`adsb.lol returned ${rows.length} records, none of them usable contacts`);
      }

      return {
        ac: usable,
        now: num(body?.now),
        total: usable.length,
        msg: typeof body?.msg === 'string' ? body.msg : 'No error',
      };
    },
  });

  console.log(`[OSIRIS] adsb.lol military — ${result.data.ac.length} contacts (${result.age})`);
  if (result.data.ac.length === 0) {
    console.warn('[OSIRIS] adsb.lol military — zero contacts; the military layer will be empty');
  }
  return { feed: result.data, age: result.age, fetchedAt: result.fetchedAt };
}

/**
 * readsb trace file for one aircraft. Returned VERBATIM: the client reads
 * `data.timestamp` and `data.trace` off the top level, and every trace point
 * is a positional array
 * `[secondsAfterTimestamp, lat, lon, alt_ft|'ground'|null, gs_kt, track, …]`
 * (militaryFlights.js:2220-2229).
 */
export async function fetchTrace(icao: string): Promise<{ data: unknown; age: CacheAge; fetchedAt: number }> {
  if (!isValidIcaoHex(icao)) throw new Error(`adsb.lol: rejected icao "${icao}"`);

  const hex = icao.toLowerCase();
  // readsb shards trace files by the LAST TWO characters of the hex.
  const shard = hex.slice(-2);

  const result = await cachedJson<unknown>({
    key: `adsblol-trace-${hex}`,
    ttlMs: 60_000,
    fetcher: async () => {
      const res = await fetch(`${TRACE_BASE}/${shard}/trace_full_${hex}.json`, {
        headers: UA,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`adsb.lol trace HTTP ${res.status} for ${hex}`);

      const body = await res.json();
      if (!Array.isArray(body?.trace) || !Number.isFinite(Number(body?.timestamp))) {
        throw new Error(`adsb.lol trace for ${hex} carries no { timestamp, trace }`);
      }
      return body;
    },
  });
  return { data: result.data, age: result.age, fetchedAt: result.fetchedAt };
}
