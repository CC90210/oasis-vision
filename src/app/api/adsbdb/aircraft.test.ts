import { describe, it, expect } from 'vitest';
import { mapAircraft, mapCallsignRoute, isValidHexOrReg, isValidCallsign } from './aircraft';

// A real trimmed response from https://api.adsbdb.com/v0/aircraft/A835AF
const aircraftRaw = {
  response: {
    aircraft: {
      type: 'Boeing 787-9 Dreamliner',
      icao_type: 'B789',
      manufacturer: 'Boeing',
      mode_s: 'A835AF',
      registration: 'N38955',
      registered_owner: 'United Airlines',
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
      origin: { iata_code: 'EWR', icao_code: 'KEWR', name: 'Newark Liberty International' },
      destination: { iata_code: 'SFO', icao_code: 'KSFO', name: 'San Francisco International' },
    },
  },
};

describe('mapAircraft', () => {
  it('maps a real response', () => {
    expect(mapAircraft(aircraftRaw)).toEqual({
      icaoType: 'B789',
      manufacturer: 'Boeing',
      model: 'Boeing 787-9 Dreamliner',
      registration: 'N38955',
      operator: 'United Airlines',
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
  });
});

describe('mapCallsignRoute', () => {
  it('maps a real response', () => {
    expect(mapCallsignRoute(routeRaw)).toEqual({
      callsign: 'UAL123',
      origin: { iata: 'EWR', icao: 'KEWR', name: 'Newark Liberty International' },
      destination: { iata: 'SFO', icao: 'KSFO', name: 'San Francisco International' },
    });
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
