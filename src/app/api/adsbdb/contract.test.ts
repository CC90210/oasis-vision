import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as typeGet } from './type/[id]/route';
import { GET as routeGet } from './route/[callsign]/route';
import { clearGevCache } from '@/lib/gev-cache';

/**
 * CONTRACT test — what the vendored globe client actually parses.
 *
 * Found by the same method as the six the fix wave was opened for: reading
 * the consuming code rather than the brief.
 *
 * Client source of truth (C:/Users/echel/JARVIS/_ingested/gods-eye-view):
 *   src/data/flights.js:823-828
 *       _enqueueEnrich(`t:${icao24}`, `/api/adsbdb/type/${icao24}`, (data) => {
 *         meta.typeCode     = data.typeCode     || meta.typeCode;
 *         meta.typeName     = data.typeName     || meta.typeName;
 *         meta.registration = data.registration || meta.registration;
 *   src/data/flights.js:815
 *       .then((data) => { if (data && data.found) job.onData(data); })
 *   src/data/flights.js:847-851
 *       meta.airline = data.airline || meta.airline;
 *       if (data.origin && data.destination) meta.route = {origin, destination};
 *   src/data/flights.js:417, 3292      `${route.origin.code} → ${route.destination.code}`
 *   src/data/routePlausible.js:59-67   origin.lat / origin.lon, finite degrees
 *
 * The `|| meta.x` idiom is what made this invisible: a nested `aircraft: {…}`
 * envelope left every field undefined, so enrichment quietly no-opped and the
 * fleet stayed on its default silhouette. Nothing errored, nothing logged.
 */

const AIRCRAFT_UPSTREAM = {
  response: {
    aircraft: {
      type: 'G650 ER',
      icao_type: 'G650',
      manufacturer: 'Gulfstream Aerospace',
      mode_s: 'A835AF',
      registration: 'N628TS',
      registered_owner: 'Falcon Landing LLC',
    },
  },
};

const ROUTE_UPSTREAM = {
  response: {
    flightroute: {
      callsign: 'UAL123',
      airline: { name: 'United Airlines', icao: 'UAL', iata: 'UA' },
      origin: { iata_code: 'LHR', icao_code: 'EGLL', name: 'London Heathrow Airport', latitude: 51.4706, longitude: -0.461941 },
      destination: { iata_code: 'IAD', icao_code: 'KIAD', name: 'Washington Dulles International Airport', latitude: 38.9445, longitude: -77.455803 },
    },
  },
};

function stub(body: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body }));
}

describe('CONTRACT /api/adsbdb/type/[id] — enrichment fields at the top level', () => {
  beforeEach(async () => { await clearGevCache(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('answers found + typeCode + typeName + registration where the client reads them', async () => {
    stub(AIRCRAFT_UPSTREAM);
    const res = await typeGet(new Request('http://localhost/api/adsbdb/type/a835af'), {
      params: Promise.resolve({ id: 'a835af' }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.found).toBe(true);
    expect(data.typeCode).toBe('G650');
    expect(data.typeName).toBe('Gulfstream Aerospace G650 ER');
    expect(data.registration).toBe('N628TS');
    // Not nested — flights.js:826 reads data.typeCode, not data.aircraft.typeCode.
    expect(data.aircraft).toBeUndefined();
    expect(data.provenance).toBeUndefined();
  });
});

describe('CONTRACT /api/adsbdb/route/[callsign] — route fields at the top level', () => {
  beforeEach(async () => { await clearGevCache(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('answers found + airline + origin + destination where the client reads them', async () => {
    stub(ROUTE_UPSTREAM);
    const res = await routeGet(new Request('http://localhost/api/adsbdb/route/UAL123'), {
      params: Promise.resolve({ callsign: 'UAL123' }),
    });
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.found).toBe(true);
    // A string, not an object: flights.js:3289 joins it as display text.
    expect(data.airline).toBe('United Airlines');
    expect(data.origin).toBeTruthy();
    expect(data.destination).toBeTruthy();
    expect(data.flightroute).toBeUndefined();
  });

  it('gives each endpoint the .code the label renders and the lat/lon the plausibility check needs', async () => {
    stub(ROUTE_UPSTREAM);
    const res = await routeGet(new Request('http://localhost/api/adsbdb/route/UAL123'), {
      params: Promise.resolve({ callsign: 'UAL123' }),
    });
    const data = await res.json();

    expect(`${data.origin.code} → ${data.destination.code}`).toBe('LHR → IAD');
    expect(Number.isFinite(data.origin.lat)).toBe(true);
    expect(Number.isFinite(data.origin.lon)).toBe(true);
    expect(Number.isFinite(data.destination.lat)).toBe(true);
    expect(Number.isFinite(data.destination.lon)).toBe(true);
  });
});
