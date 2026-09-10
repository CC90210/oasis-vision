import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as milGet } from './mil/route';
import { clearGevCache } from '@/lib/gev-cache';

/**
 * CONTRACT test — what the vendored globe client actually parses.
 *
 * Client source of truth (C:/Users/echel/JARVIS/_ingested/gods-eye-view):
 *   src/data/militaryFlights.js:83     const API_URL = '/api/adsblol/mil';
 *   src/data/militaryFlights.js:2814-2820
 *                                      // adsb.lol returns { ac: [...aircraft], msg: "...", ... }
 *                                      if (!data || !Array.isArray(data.ac)) → 'Malformed adsb.lol response'
 *   src/data/militaryFlights.js:2824   data.ac.filter(_isUsableMilitaryAircraft)  → hex + lat + lon
 *   src/data/militaryFlights.js:2845-2850, 2858, 3019
 *                                      per-record fields: hex, lon, lat, alt_baro (ft, or the
 *                                      STRING "ground"), alt_geom, track, gs, seen_pos, flight,
 *                                      t, r, ownOp
 *   src/data/militaryRegistry.js:108-111
 *                                      fetch('/api/adsblol/mil') → Array.isArray(data?.ac)
 *
 *   src/data/militaryFlights.js:2200   fetch('/api/adsblol/trace?hex=' + icao24)   ← QUERY param
 *   src/data/militaryFlights.js:2205-2206
 *                                      baseEpochSec = Number(data?.timestamp);
 *                                      trace = Array.isArray(data?.trace) ? data.trace : null;
 *   src/data/militaryFlights.js:2220   trace points are ARRAYS:
 *                                      [secondsAfterTimestamp, lat, lon, alt_ft|'ground'|null, gs_kt, track, …]
 *
 * `{ count, aircraft: [...] }` is not `{ ac: [...] }`, and `/trace/[icao]`
 * nesting the payload under `trace` puts `timestamp` out of reach.
 */

/** Verbatim copy of the client predicate (militaryFlights.js ~2740). */
function isUsableMilitaryAircraft(a: Record<string, unknown> | null): boolean {
  if (!a || Array.isArray(a) || typeof a !== 'object') return false;
  if (typeof a.hex !== 'string' || !a.hex.trim()) return false;
  return Number.isFinite(Number(a.lon)) && Number.isFinite(Number(a.lat));
}

/** Two real trimmed records from https://api.adsb.lol/v2/mil (probed 2026-09-09). */
const AC_GROUND = {
  hex: 'ae57d5', type: 'adsb_icao', flight: '2011    ', r: '2011', t: 'C30J',
  dbFlags: 1, alt_baro: 'ground', gs: 27.5, true_heading: 233.44, squawk: '2113',
  category: 'A3', lat: 21.31192, lon: -158.061002, seen_pos: 4.988,
};
const AC_AIRBORNE = {
  hex: 'af1cb7', type: 'adsb_icao', flight: 'CHAOS55 ', r: '22-03499', t: 'H64',
  dbFlags: 1, alt_baro: 1500, alt_geom: 1650, gs: 71.3, track: 75.38,
  squawk: '1200', category: 'A7', lat: 21.494332, lon: -157.968648, seen_pos: 1.281,
};
const MIL_UPSTREAM = {
  ac: [AC_GROUND, AC_AIRBORNE],
  msg: 'No error',
  now: 1789012051500,
  total: 2,
};

/** A real trimmed readsb trace file (globe.adsb.lol trace_full_*.json, probed 2026-09-09). */
const TRACE_UPSTREAM = {
  icao: 'ae57d5',
  r: '2011',
  t: 'C30J',
  dbFlags: 1,
  desc: 'Lockheed Martin HC-130J Hercules',
  version: 'readsb 3.16.15 05df27d',
  timestamp: 1788922589.834,
  trace: [
    [0.0, 21.300602, -158.071813, 'ground', 0.8, 56.2, 1, null, null, 'adsb_icao', null, null, null, null],
    [3.82, 21.300602, -158.071813, 'ground', 1.1, 53.4, 0, null, null, 'adsb_icao', null, null, null, null],
    [9.84, 21.315758, -158.036652, 625, 136.2, 326.1, 4, -384, null, 'adsb_icao', 650, -384, null, null],
  ],
};

describe('CONTRACT /api/adsblol/mil — data.ac, raw upstream records', () => {
  beforeEach(async () => {
    await clearGevCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns data.ac, the array the client requires by name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => MIL_UPSTREAM,
    }));

    const res = await milGet();
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.ac)).toBe(true);
    expect(data.ac.filter(isUsableMilitaryAircraft)).toHaveLength(2);
  });

  it('preserves the raw record fields the layer reads, ground string included', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => MIL_UPSTREAM,
    }));

    const data = await (await milGet()).json();
    const [ground, airborne] = data.ac;

    // "ground" must survive as the STRING — militaryFlights.js:2858 branches on it.
    expect(ground.alt_baro).toBe('ground');
    expect(ground.lon).toBe(-158.061002);
    expect(ground.lat).toBe(21.31192);
    expect(ground.seen_pos).toBe(4.988);
    expect(ground.flight).toBe('2011    '); // client trims; the proxy must not eat the field
    expect(airborne.alt_geom).toBe(1650);
    expect(airborne.track).toBe(75.38);
    expect(airborne.r).toBe('22-03499');
    expect(airborne.t).toBe('H64');
  });

  it('keeps provenance in headers, not in the body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => MIL_UPSTREAM,
    }));

    const res = await milGet();
    const data = await res.json();
    expect(data.provenance).toBeUndefined();
    expect(res.headers.get('x-oasis-age')).toMatch(/^(fresh|cached|stale)$/);
  });
});

describe('CONTRACT /api/adsblol/trace — ?hex= with timestamp+trace at top level', () => {
  beforeEach(async () => {
    await clearGevCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('accepts ?hex= and answers { timestamp, trace } the client reads directly', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => TRACE_UPSTREAM,
    });
    vi.stubGlobal('fetch', fetchMock);

    // Dynamic import so a missing route file fails THIS test rather than
    // collapsing the whole file at collection time.
    const { GET } = await import('./trace/route');
    const res = await GET(new Request('http://localhost/api/adsblol/trace?hex=ae57d5'));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Number.isFinite(Number(data.timestamp))).toBe(true);
    expect(Number(data.timestamp)).toBe(1788922589.834);
    expect(Array.isArray(data.trace)).toBe(true);
    expect(Array.isArray(data.trace[0])).toBe(true);
    // [secondsAfterTimestamp, lat, lon, alt_ft|'ground'|null, …]
    expect(data.trace[0][0]).toBe(0.0);
    expect(data.trace[0][1]).toBe(21.300602);
    expect(data.trace[0][2]).toBe(-158.071813);
    expect(data.trace[0][3]).toBe('ground');
    expect(data.trace[2][3]).toBe(625);
  });

  it('fetches the readsb trace file, not the /v2/icao live snapshot', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => TRACE_UPSTREAM,
    });
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('./trace/route');
    await GET(new Request('http://localhost/api/adsblol/trace?hex=ae57d5'));

    // https://api.adsb.lol/v2/icao/<hex> returns { ac: [...] } — a live
    // snapshot with no `timestamp` and no `trace`. Probed 2026-09-09.
    const called = String(fetchMock.mock.calls[0][0]);
    expect(called).not.toContain('/v2/icao/');
    expect(called).toContain('trace_full_ae57d5.json');
  });

  it('still rejects a non-hex identifier before any upstream call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { GET } = await import('./trace/route');
    const res = await GET(new Request('http://localhost/api/adsblol/trace?hex=..%2F..%2Fetc'));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
