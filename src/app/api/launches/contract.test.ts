import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from './route';
import { clearGevCache } from '@/lib/gev-cache';

/**
 * CONTRACT test — what the vendored globe client actually parses.
 *
 * Client source of truth (C:/Users/echel/JARVIS/_ingested/gods-eye-view):
 *   src/data/rocketLaunches.js:16     const API_URL = '/api/launches';
 *   src/data/rocketLaunches.js:3345-3346
 *                                     normalizeRocketLaunches(await response.json())
 *   src/data/rocketLaunches.js:2782-2783
 *                                     const launches = Array.isArray(payload) ? payload : payload?.results;
 *                                     if (!Array.isArray(launches)) return [];
 *   src/data/rocketLaunches.js:2786-2820
 *                                     reads RAW Launch Library 2 records:
 *                                       launch.net / window_start
 *                                       launch.pad.{name,latitude,longitude}
 *                                       launch.pad.location.{name,coordinates}
 *                                       launch.status.name
 *                                       launch.launch_service_provider.name
 *                                       launch.mission.{name,description,orbit}
 *                                       launch.timeline[].{type.abbrev,relative_time}
 *                                       launch.trajectory
 *
 * `{ count, launches: [...] }` fails the `payload?.results` read, returns [],
 * and the launches layer renders nothing behind a 200. Even keyed correctly,
 * the FLATTENED record (lat/lng/padName/provider) has none of the nested paths
 * the normalizer walks, so it would still produce zero launches.
 */

/** Verbatim copy of the client's envelope pick (rocketLaunches.js:2782). */
const pickLaunches = (payload: unknown): unknown[] | null => {
  const l = Array.isArray(payload) ? payload : (payload as { results?: unknown })?.results;
  return Array.isArray(l) ? l : null;
};

/** A real trimmed LL2 2.3.0 `mode=detailed` record (probed 2026-09-09). */
const LL2_RECORD = {
  id: '153ef8ef-b12b-43f4-a4bf-05b225c0cd37',
  name: 'Falcon 9 Block 5 | Starlink Group 15-24',
  slug: 'falcon-9-block-5-starlink-group-15-24',
  net: '2026-09-06T14:26:54Z',
  window_start: '2026-09-06T10:59:00Z',
  status: { id: 3, name: 'Launch Successful', abbrev: 'Success' },
  launch_service_provider: { id: 121, name: 'SpaceX' },
  rocket: { configuration: { full_name: 'Falcon 9 Block 5' } },
  mission: {
    name: 'Starlink Group 15-24',
    description: 'A batch of 27 satellites for the Starlink mega-constellation.',
    orbit: { id: 8, name: 'Low Earth Orbit', abbrev: 'LEO' },
  },
  pad: {
    name: 'Space Launch Complex 4E',
    latitude: 34.632,
    longitude: -120.611,
    location: { name: 'Vandenberg SFB, CA, USA' },
  },
  timeline: [{ type: { id: 1, abbrev: 'GO for Prop Load' }, relative_time: '-PT38M' }],
};

const LL2_UPSTREAM = { count: 1, results: [LL2_RECORD] };

function stubUpstream() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => LL2_UPSTREAM,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('CONTRACT /api/launches — payload.results of raw LL2 records', () => {
  beforeEach(async () => {
    await clearGevCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers a payload the client envelope pick accepts', async () => {
    stubUpstream();
    const data = await (await GET()).json();
    const launches = pickLaunches(data);
    expect(launches).not.toBeNull();
    expect(launches).toHaveLength(1);
  });

  it('preserves every nested path the client normalizer walks', async () => {
    stubUpstream();
    const data = await (await GET()).json();
    const launch = pickLaunches(data)![0] as Record<string, never>;

    expect(launch.id).toBe('153ef8ef-b12b-43f4-a4bf-05b225c0cd37');
    expect(launch.net).toBe('2026-09-06T14:26:54Z');
    expect(launch.window_start).toBe('2026-09-06T10:59:00Z');
    expect((launch.status as { name: string }).name).toBe('Launch Successful');
    expect((launch.pad as { latitude: number }).latitude).toBe(34.632);
    expect((launch.pad as { longitude: number }).longitude).toBe(-120.611);
    expect((launch.pad as { name: string }).name).toBe('Space Launch Complex 4E');
    expect((launch.pad as { location: { name: string } }).location.name).toBe('Vandenberg SFB, CA, USA');
    expect((launch.launch_service_provider as { name: string }).name).toBe('SpaceX');
    expect((launch.mission as { name: string }).name).toBe('Starlink Group 15-24');
    expect((launch.mission as { orbit: { name: string } }).orbit.name).toBe('Low Earth Orbit');
    expect((launch.timeline as Array<{ relative_time: string }>)[0].relative_time).toBe('-PT38M');
  });

  it('keeps provenance in headers, not in the body', async () => {
    stubUpstream();
    const res = await GET();
    const data = await res.json();
    expect(data.provenance).toBeUndefined();
    expect(res.headers.get('x-oasis-age')).toMatch(/^(fresh|cached|stale)$/);
    expect(res.headers.get('x-oasis-source')).toContain('Launch Library 2');
  });
});
