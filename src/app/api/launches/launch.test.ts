import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isLaunchRecord, fetchLaunches } from './launch';
import { clearGevCache } from '@/lib/gev-cache';

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

/**
 * `mapLaunch` was REMOVED, not demoted to a validator. It flattened LL2
 * records into `{ lat, lng, padName, provider, … }`, and the vendored client
 * walks the nested LL2 paths instead (gods-eye-view
 * src/data/rocketLaunches.js:2786-2820), so its output could not be the
 * response. Keeping it as a gate would have been worse than deleting it: its
 * only surviving rule was "the record has an id", and the client explicitly
 * tolerates a record with none (`launch.id || launch.slug || launch.name`,
 * rocketLaunches.js:2797). A proxy that filters more strictly than its
 * consumer drops launches the globe would have rendered — silently, since a
 * short list looks exactly like a quiet month.
 *
 * What replaced it is the weakest honest gate. These tests pin that it stays
 * weak. The response shape itself is pinned by contract.test.ts.
 */
describe('isLaunchRecord', () => {
  it('accepts a launch record with no id, because the client does', () => {
    expect(isLaunchRecord({ ...sample, id: undefined })).toBe(true);
    expect(isLaunchRecord({ slug: 'some-launch' })).toBe(true);
  });

  it('accepts a real detailed record', () => {
    expect(isLaunchRecord(sample)).toBe(true);
  });

  it('rejects what the client normalizer cannot walk', () => {
    expect(isLaunchRecord(null)).toBe(false);
    expect(isLaunchRecord('unknown launch')).toBe(false);
    expect(isLaunchRecord([])).toBe(false);
    expect(isLaunchRecord(42)).toBe(false);
  });
});

/**
 * A mapper test cannot catch a wrong QUESTION. `ordering=-net` (descending)
 * across a lower bound with no upper bound returns the 50 furthest-future
 * TBD launches — a 200 full of well-formed, entirely wrong-decade data. These
 * assert on the URL fetchLaunches actually builds, not on a mapped fixture.
 */
describe('fetchLaunches — query window', () => {
  beforeEach(async () => {
    await clearGevCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bounds the query on both ends of the rolling 30-day window', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const before = Date.now();
    await fetchLaunches();
    const after = Date.now();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]));
    const gte = calledUrl.searchParams.get('net__gte');
    const lte = calledUrl.searchParams.get('net__lte');

    // The defect this pins: a lower bound with NO upper bound, combined with
    // descending order, answers from 2029-2039 instead of the last 30 days.
    expect(lte).not.toBeNull();
    expect(gte).not.toBeNull();

    const gteMs = Date.parse(gte!);
    const lteMs = Date.parse(lte!);

    // Upper bound is "now", not the far future.
    expect(lteMs).toBeGreaterThanOrEqual(before - 1000);
    expect(lteMs).toBeLessThanOrEqual(after + 1000);

    // Lower bound is ~30 days before the upper bound, not before all time.
    const spanDays = (lteMs - gteMs) / 86_400_000;
    expect(spanDays).toBeGreaterThan(29);
    expect(spanDays).toBeLessThan(31);
  });

  it('forwards the upstream records untouched', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ count: 1, results: [sample] }),
    }));

    const { feed } = await fetchLaunches();
    expect(feed.count).toBe(1);
    // Deep equality with the upstream record: nothing renamed, nothing dropped.
    expect(feed.results[0]).toEqual(sample);
  });
});
