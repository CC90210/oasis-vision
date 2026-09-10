import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mapAircraft, mapCallsignRoute, isValidHexOrReg, isValidCallsign, lookupAircraft, lookupCallsign } from './aircraft';

/**
 * These mappers are the one place in this folder where a mapper IS the
 * contract: the vendored client wants its own key names at the top level of
 * the response, not the raw adsbdb shape. So these tests assert the CLIENT's
 * names, checked against live adsbdb responses (probed 2026-09-09).
 *
 *   gods-eye-view src/data/flights.js:826-828   typeCode, typeName, registration
 *   gods-eye-view src/data/flights.js:850-851   airline (a string), origin, destination
 *   gods-eye-view src/data/flights.js:417, 3292 origin.code → destination.code
 *   gods-eye-view src/data/routePlausible.js:59 origin.lat / origin.lon, finite
 */

// A real trimmed response from https://api.adsbdb.com/v0/aircraft/A835AF
const aircraftRaw = {
  response: {
    aircraft: {
      type: 'G650 ER',
      icao_type: 'G650',
      manufacturer: 'Gulfstream Aerospace',
      mode_s: 'A835AF',
      registration: 'N628TS',
      registered_owner: 'Falcon Landing LLC',
      registered_owner_country_name: 'United States',
      url_photo: null,
    },
  },
};

// A real trimmed response from https://api.adsbdb.com/v0/callsign/UAL123
const routeRaw = {
  response: {
    flightroute: {
      callsign: 'UAL123',
      callsign_icao: 'UAL123',
      callsign_iata: 'UA123',
      airline: { name: 'United Airlines', icao: 'UAL', iata: 'UA', country: 'United States' },
      origin: {
        iata_code: 'LHR', icao_code: 'EGLL', name: 'London Heathrow Airport',
        latitude: 51.4706, longitude: -0.461941, municipality: 'London', elevation: 83,
      },
      destination: {
        iata_code: 'IAD', icao_code: 'KIAD', name: 'Washington Dulles International Airport',
        latitude: 38.9445, longitude: -77.455803, municipality: 'Washington', elevation: 312,
      },
    },
  },
};

describe('mapAircraft', () => {
  it('maps a real response into the names the client reads', () => {
    expect(mapAircraft(aircraftRaw)).toEqual({
      typeCode: 'G650',
      typeName: 'Gulfstream Aerospace G650 ER',
      manufacturer: 'Gulfstream Aerospace',
      registration: 'N628TS',
      operator: 'Falcon Landing LLC',
    });
  });

  it('returns null when adsbdb has no record', () => {
    expect(mapAircraft({ response: 'unknown aircraft' })).toBeNull();
    expect(mapAircraft({})).toBeNull();
    expect(mapAircraft(null)).toBeNull();
  });

  it('leaves absent fields absent rather than inventing a value', () => {
    const partial = { response: { aircraft: { icao_type: 'B789', mode_s: 'A835AF' } } };
    const out = mapAircraft(partial);
    expect(out?.manufacturer).toBeNull();
    expect(out?.operator).toBeNull();
    expect(out?.typeCode).toBe('B789');
  });

  it('does not emit a leading space when the manufacturer is missing', () => {
    const partial = { response: { aircraft: { icao_type: 'B789', type: 'Boeing 787-9' } } };
    expect(mapAircraft(partial)?.typeName).toBe('Boeing 787-9');
  });
});

describe('mapCallsignRoute', () => {
  it('maps a real response into the names the client reads', () => {
    expect(mapCallsignRoute(routeRaw)).toEqual({
      callsign: 'UAL123',
      // A STRING — flights.js:3289 joins it as display text. The nested
      // adsbdb airline object would render as "[object Object]".
      airline: 'United Airlines',
      origin: {
        code: 'LHR', iata: 'LHR', icao: 'EGLL', name: 'London Heathrow Airport',
        lat: 51.4706, lon: -0.461941,
      },
      destination: {
        code: 'IAD', iata: 'IAD', icao: 'KIAD', name: 'Washington Dulles International Airport',
        lat: 38.9445, lon: -77.455803,
      },
    });
  });

  it('supplies the finite lat/lon routePlausible needs, or the route is hidden', () => {
    const out = mapCallsignRoute(routeRaw);
    expect(Number.isFinite(out?.origin?.lat)).toBe(true);
    expect(Number.isFinite(out?.origin?.lon)).toBe(true);
    expect(Number.isFinite(out?.destination?.lat)).toBe(true);
    expect(Number.isFinite(out?.destination?.lon)).toBe(true);
  });

  it('falls back to the ICAO code when an airport has no IATA code', () => {
    const noIata = {
      response: {
        flightroute: {
          callsign: 'ABC1',
          origin: { icao_code: 'CYUL', name: 'Montreal', latitude: 45.47, longitude: -73.74 },
          destination: { icao_code: 'KJFK', name: 'New York', latitude: 40.64, longitude: -73.78 },
        },
      },
    };
    expect(mapCallsignRoute(noIata)?.origin?.code).toBe('CYUL');
  });

  it('returns null when there is no route', () => {
    expect(mapCallsignRoute({ response: 'unknown callsign' })).toBeNull();
  });
});

describe('input validation', () => {
  it('accepts hex codes and registrations', () => {
    expect(isValidHexOrReg('A835AF')).toBe(true);
    expect(isValidHexOrReg('N38955')).toBe(true);
    expect(isValidHexOrReg('C-GABC')).toBe(true);
  });

  it('rejects anything that could escape the path segment', () => {
    expect(isValidHexOrReg('../../secret')).toBe(false);
    expect(isValidHexOrReg('A835AF?x=1')).toBe(false);
    expect(isValidHexOrReg('')).toBe(false);
  });

  it('accepts callsigns and rejects path tricks', () => {
    expect(isValidCallsign('UAL123')).toBe(true);
    expect(isValidCallsign('../x')).toBe(false);
  });
});

describe('lookupAircraft validation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects traversal attempts locally without network access', async () => {
    await expect(lookupAircraft('../../secret')).rejects.toThrow('Invalid aircraft identifier: ../../secret');
    // Must not have made any network calls
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('lookupCallsign validation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects traversal attempts locally without network access', async () => {
    await expect(lookupCallsign('../evil')).rejects.toThrow('Invalid callsign: ../evil');
    // Must not have made any network calls
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
