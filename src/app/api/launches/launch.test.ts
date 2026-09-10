import { describe, it, expect } from 'vitest';
import { mapLaunch } from './launch';

// A real trimmed record from
// https://ll.thespacedevs.com/2.3.0/launches/?net__gte=...&mode=detailed
const sample = {
  id: '9d576892-1a5f-4b3c-9d2e-000000000001',
  name: 'Falcon 9 Block 5 | Starlink Group 11-5',
  net: '2026-09-08T14:22:00Z',
  status: { id: 3, name: 'Launch Successful', abbrev: 'Success' },
  launch_service_provider: { id: 121, name: 'SpaceX' },
  rocket: { configuration: { id: 164, name: 'Falcon 9', full_name: 'Falcon 9 Block 5' } },
  mission: { name: 'Starlink Group 11-5', description: 'A batch of satellites.', orbit: { name: 'Low Earth Orbit' } },
  pad: {
    id: 80,
    name: 'Space Launch Complex 4E',
    latitude: 34.632,
    longitude: -120.611,
    location: { name: 'Vandenberg SFB, CA, USA' },
  },
};

const patch = (p: Record<string, unknown>) => ({ ...sample, ...p });

describe('mapLaunch', () => {
  it('maps a real detailed record', () => {
    expect(mapLaunch(sample)).toEqual({
      id: '9d576892-1a5f-4b3c-9d2e-000000000001',
      name: 'Falcon 9 Block 5 | Starlink Group 11-5',
      status: 'Launch Successful',
      statusAbbrev: 'Success',
      net: '2026-09-08T14:22:00Z',
      provider: 'SpaceX',
      rocket: 'Falcon 9 Block 5',
      padName: 'Space Launch Complex 4E',
      padLocation: 'Vandenberg SFB, CA, USA',
      lat: 34.632,
      lng: -120.611,
      missionDescription: 'A batch of satellites.',
      orbitName: 'Low Earth Orbit',
    });
  });

  it('parses pad coordinates delivered as strings', () => {
    const out = mapLaunch(patch({ pad: { ...sample.pad, latitude: '34.632', longitude: '-120.611' } }));
    expect(out?.lat).toBe(34.632);
    expect(out?.lng).toBe(-120.611);
  });

  it('keeps a launch with no pad coordinates but reports them as null', () => {
    const out = mapLaunch(patch({ pad: { ...sample.pad, latitude: null, longitude: null } }));
    expect(out).not.toBeNull();
    expect(out?.lat).toBeNull();
    expect(out?.lng).toBeNull();
  });

  it('carries a failure status through instead of normalising it away', () => {
    const out = mapLaunch(patch({ status: { id: 4, name: 'Launch Failure', abbrev: 'Failure' } }));
    expect(out?.status).toBe('Launch Failure');
    expect(out?.statusAbbrev).toBe('Failure');
  });

  it('leaves absent optional blocks null rather than inventing them', () => {
    const out = mapLaunch(patch({ mission: null }));
    expect(out?.missionDescription).toBeNull();
    expect(out?.orbitName).toBeNull();
  });

  it('rejects a record with no id', () => {
    expect(mapLaunch(patch({ id: undefined }))).toBeNull();
    expect(mapLaunch(null)).toBeNull();
  });
});
