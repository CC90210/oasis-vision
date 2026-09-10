import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from './route';
import { clearGevCache } from '@/lib/gev-cache';

/**
 * CONTRACT test — what the vendored globe client actually parses.
 *
 * Client source of truth (C:/Users/echel/JARVIS/_ingested/gods-eye-view):
 *   src/data/flights.js:273       const API_URL = '/api/opensky';
 *   src/data/flights.js:4079      fetch(_flightApiUrl(viewer))   → `${API_URL}?lat=..&lon=..`
 *   src/data/flights.js:4136-4139 if (!data || !Array.isArray(data.states)) → 'Malformed OpenSky response'
 *   src/data/flights.js:4143      const usableStates = data.states.filter(_isUsableOpenSkyState);
 *   src/data/flights.js:3216-3221 _isUsableOpenSkyState: Array.isArray(state)
 *                                 && typeof state[0] === 'string'
 *                                 && Number.isFinite(state[5]) && Number.isFinite(state[6])
 *   src/data/flights.js:4152      Number(data.time) * 1000  → snapshot age readout
 *   src/data/flights.js:4186-4187 state[17] emitter category (needs upstream ?extended=1)
 *                                 state[11] vertical rate
 *   src/data/flights.js:4082-4086 headers x-flight-source, x-flight-coverage,
 *                                 x-opensky-auth-mode-used, x-opensky-auth-reason
 *
 * OpenSky state vectors are POSITIONAL ARRAYS. An envelope of mapped objects
 * makes every row unusable, `usableStates` empty, and the layer reports
 * 'Malformed OpenSky aircraft rows' — with a 200 on the wire.
 */

/** Verbatim copy of the client predicate (flights.js:3216-3221). */
function isUsableOpenSkyState(state: unknown): boolean {
  const s = state as unknown[];
  if (!Array.isArray(s) || typeof s[0] !== 'string' || !String(s[0]).trim()) return false;
  return Number.isFinite(s[5]) && Number.isFinite(s[6]);
}

/**
 * A real trimmed OpenSky `/states/all?extended=1` row. 18 fields:
 * 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
 * 5 longitude, 6 latitude, 7 baro_altitude, 8 on_ground, 9 velocity,
 * 10 true_track, 11 vertical_rate, 12 sensors, 13 geo_altitude, 14 squawk,
 * 15 spi, 16 position_source, 17 category
 */
const ROW: unknown[] = [
  'a835af', 'UAL123  ', 'United States', 1757430000, 1757430001,
  -77.0369, 38.9021, 9448.8, false, 227.5,
  87.4, 0.33, null, 9601.2, '1234',
  false, 0, 5,
];

const UPSTREAM = { time: 1757430002, states: [ROW] };

function stubUpstream() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => UPSTREAM,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const req = () => new Request('http://localhost/api/opensky?lat=38.9021&lon=-77.0369');

describe('CONTRACT /api/opensky — raw positional state vectors', () => {
  beforeEach(async () => {
    await clearGevCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns data.states as arrays the client predicate accepts', async () => {
    stubUpstream();
    const res = await GET(req());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.states)).toBe(true);
    expect(data.states.filter(isUsableOpenSkyState)).toHaveLength(1);

    const state = data.states[0];
    expect(state[0]).toBe('a835af');
    expect(state[5]).toBe(-77.0369); // longitude
    expect(state[6]).toBe(38.9021);  // latitude
    expect(state[11]).toBe(0.33);    // vertical rate
    expect(state[17]).toBe(5);       // emitter category (extended=1)
  });

  it('carries data.time in epoch SECONDS so the client can age the snapshot', async () => {
    stubUpstream();
    const data = await (await GET(req())).json();
    expect(Number.isFinite(Number(data.time))).toBe(true);
    expect(Number(data.time)).toBe(1757430002);
  });

  it('keeps provenance out of the body and in headers', async () => {
    stubUpstream();
    const res = await GET(req());
    const data = await res.json();
    expect(data.provenance).toBeUndefined();
    expect(res.headers.get('x-oasis-age')).toMatch(/^(fresh|cached|stale)$/);
    expect(res.headers.get('x-flight-source')).toBeTruthy();
    expect(res.headers.get('x-opensky-auth-mode-used')).toMatch(/^(anon|oauth)$/);
  });

  it('asks upstream for extended=1, without which state[17] is never present', async () => {
    const fetchMock = stubUpstream();
    await GET(req());
    const called = String(fetchMock.mock.calls[0][0]);
    expect(new URL(called).searchParams.get('extended')).toBe('1');
  });
});

describe('CONTRACT /api/opensky — shared OpenSky budget discipline', () => {
  beforeEach(async () => {
    await clearGevCache();
    delete process.env.OPENSKY_CLIENT_ID;
    delete process.env.OPENSKY_CLIENT_SECRET;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paces anonymous polling far slower than a per-session cache would', async () => {
    // src/app/api/flights/route.ts:237 openSkyInterval() — 900_000 anonymous.
    // The globe route shares that per-IP pool and must not out-poll it; a 9s
    // TTL burns the 400 credits/day anonymous budget in ~15 minutes and takes
    // the PRE-EXISTING console's flight layer down with it.
    const { anonymousIntervalMs, authenticatedIntervalMs } = await import('./states');
    expect(anonymousIntervalMs()).toBeGreaterThanOrEqual(900_000);
    expect(authenticatedIntervalMs()).toBeGreaterThanOrEqual(90_000);
  });

  it('backs off after a 429 instead of re-poking a limited endpoint', async () => {
    const { openSkyCooldownMs } = await import('./states');
    expect(openSkyCooldownMs()).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it('actually reads the OpenSky credential that setup/status advertises', async () => {
    const src = await import('node:fs/promises').then(fs =>
      fs.readFile(new URL('./states.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('OPENSKY_CLIENT_ID');
    expect(src).toContain('OPENSKY_CLIENT_SECRET');
  });
});
