import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from './route';
import { clearGevCache } from '@/lib/gev-cache';

/**
 * CONTRACT test — what the vendored globe client actually parses.
 *
 * Found by the same method as the six: reading the consuming code.
 *
 * Client source of truth (C:/Users/echel/JARVIS/_ingested/gods-eye-view):
 *   src/data/flights.js:3044-3049
 *       fetch('/api/opensky-track?icao24=' + icao24)
 *       path = Array.isArray(data?.path) ? data.path : null;
 *   src/data/flights.js:3054
 *       // OpenSky track waypoints: [time, latitude, longitude, baro_altitude,
 *       //                           true_track, on_ground]
 *   src/data/flights.js:3050
 *       catch { return; }  ← the failure is SILENT by design; it keeps the
 *                             locally accumulated trail and reports nothing.
 *
 * Nesting the upstream body under `track` put `path` out of reach, so the
 * trail backfill never ran and no error was ever raised about it.
 */

/** A real trimmed OpenSky /tracks/all body. */
const TRACK_UPSTREAM = {
  icao24: 'a835af',
  callsign: 'UAL123',
  startTime: 1757426400,
  endTime: 1757430000,
  path: [
    [1757426400, 38.8021, -77.1369, 1200.15, 87.4, false],
    [1757427000, 38.8521, -77.0869, 4500.88, 88.1, false],
    [1757430000, 38.9021, -77.0369, 9448.8, 87.4, false],
  ],
};

const req = (icao = 'a835af') =>
  new Request(`http://localhost/api/opensky-track?icao24=${icao}`);

describe('CONTRACT /api/opensky-track — data.path at the top level', () => {
  beforeEach(async () => { await clearGevCache(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns the upstream body so data.path is an array of waypoints', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => TRACK_UPSTREAM,
    }));

    const res = await GET(req());
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(Array.isArray(data.path)).toBe(true);
    expect(data.path).toHaveLength(3);
    // [time, lat, lon, baro_altitude, true_track, on_ground]
    expect(data.path[0][0]).toBe(1757426400);
    expect(data.path[0][1]).toBe(38.8021);
    expect(data.path[0][2]).toBe(-77.1369);
    // Not nested, and no provenance field in the body.
    expect(data.track).toBeUndefined();
    expect(data.provenance).toBeUndefined();
    expect(res.headers.get('x-oasis-age')).toMatch(/^(fresh|cached|stale)$/);
  });

  it('still rejects a non-hex icao24 before any upstream call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await GET(req('..%2F..%2Fetc'));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
