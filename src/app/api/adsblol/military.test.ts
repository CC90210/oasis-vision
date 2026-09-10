import { describe, it, expect } from 'vitest';
import { mapMilAircraft, isValidIcaoHex } from './military';

// A real trimmed record from https://api.adsb.lol/v2/mil
const sample = {
  hex: 'ae1460',
  type: 'adsb_icao',
  flight: 'RCH285  ',
  r: '09-0015',
  t: 'C17',
  alt_baro: 31000,
  gs: 442.3,
  track: 87.4,
  squawk: '1234',
  lat: 38.9021,
  lon: -77.0369,
};

const patch = (p: Record<string, unknown>) => ({ ...sample, ...p });

describe('mapMilAircraft', () => {
  it('maps a real record and trims the padded callsign', () => {
    expect(mapMilAircraft(sample)).toEqual({
      hex: 'ae1460',
      callsign: 'RCH285',
      lat: 38.9021,
      lng: -77.0369,
      altFt: 31000,
      headingDeg: 87.4,
      speedKts: 442.3,
      squawk: '1234',
      type: 'C17',
    });
  });

  it('drops a record with no position', () => {
    expect(mapMilAircraft(patch({ lat: undefined, lon: undefined }))).toBeNull();
    expect(mapMilAircraft(patch({ lat: null }))).toBeNull();
  });

  it('reads ground as altitude zero rather than discarding the aircraft', () => {
    expect(mapMilAircraft(patch({ alt_baro: 'ground' }))?.altFt).toBe(0);
  });

  it('leaves an absent field null instead of defaulting it to zero', () => {
    const out = mapMilAircraft(patch({ gs: undefined, track: undefined, squawk: undefined }));
    expect(out?.speedKts).toBeNull();
    expect(out?.headingDeg).toBeNull();
    expect(out?.squawk).toBeNull();
  });

  it('rejects a non-record', () => {
    expect(mapMilAircraft(null)).toBeNull();
    expect(mapMilAircraft('nope')).toBeNull();
  });
});

describe('isValidIcaoHex', () => {
  it('accepts a six-character hex code', () => {
    expect(isValidIcaoHex('ae1460')).toBe(true);
    expect(isValidIcaoHex('A835AF')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidIcaoHex('ae146')).toBe(false);
    expect(isValidIcaoHex('../../x')).toBe(false);
    expect(isValidIcaoHex('zzzzzz')).toBe(false);
  });
});
