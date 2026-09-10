import { describe, it, expect } from 'vitest';
import { mapStateVector } from './states';

// A real state vector from https://opensky-network.org/api/states/all
// Index order is fixed by OpenSky:
// 0 icao24, 1 callsign, 2 origin_country, 3 time_position, 4 last_contact,
// 5 longitude, 6 latitude, 7 baro_altitude, 8 on_ground, 9 velocity,
// 10 true_track, 11 vertical_rate, 12 sensors, 13 geo_altitude, 14 squawk
const sample: unknown[] = [
  'a835af', 'UAL123 ', 'United States', 1757430000, 1757430001,
  -77.0369, 38.9021, 9448.8, false, 227.5,
  87.4, 0.33, null, 9601.2, '1234',
];

const at = (i: number, v: unknown) => sample.map((x, j) => (j === i ? v : x));

describe('mapStateVector', () => {
  it('maps a real state vector with the right index meanings', () => {
    expect(mapStateVector(sample)).toEqual({
      hex: 'a835af',
      callsign: 'UAL123',
      country: 'United States',
      lat: 38.9021,
      lng: -77.0369,
      altM: 9448.8,
      onGround: false,
      speedMs: 227.5,
      headingDeg: 87.4,
      verticalRateMs: 0.33,
      squawk: '1234',
    });
  });

  it('does not confuse latitude with longitude', () => {
    // Index 5 is LONGITUDE and index 6 is LATITUDE. Reversing them is the
    // single most likely defect in this file, so it is pinned explicitly.
    const out = mapStateVector(sample);
    expect(out?.lng).toBe(-77.0369);
    expect(out?.lat).toBe(38.9021);
  });

  it('drops a vector with no position', () => {
    expect(mapStateVector(at(5, null))).toBeNull();
    expect(mapStateVector(at(6, null))).toBeNull();
  });

  it('trims the space-padded callsign and nulls an empty one', () => {
    expect(mapStateVector(at(1, '        '))?.callsign).toBeNull();
  });

  it('keeps on_ground false distinct from missing', () => {
    expect(mapStateVector(at(8, true))?.onGround).toBe(true);
    expect(mapStateVector(at(8, false))?.onGround).toBe(false);
  });

  it('rejects anything that is not an array of the expected length', () => {
    expect(mapStateVector([])).toBeNull();
    expect(mapStateVector(null as unknown as unknown[])).toBeNull();
  });
});
