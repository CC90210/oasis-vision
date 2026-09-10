import { NextResponse } from 'next/server';
import { fetchTrack } from '../opensky/states';
import { provenanceHeaders } from '@/lib/gev-provenance';

/**
 * Trail backfill for the civil flights layer.
 *
 * Consumer: gods-eye-view src/data/flights.js:3044-3049 —
 *   fetch('/api/opensky-track?icao24=' + icao24)
 *   path = Array.isArray(data?.path) ? data.path : null;
 *
 * `data.path` at the TOP level, of positional waypoints
 * `[time, latitude, longitude, baro_altitude, true_track, on_ground]`
 * (flights.js:3054). Nesting the upstream body under `track` put `path` out
 * of reach; the client's catch is silent by design (it keeps the locally
 * accumulated trail), so nothing reported it.
 *
 * Same defect class as the six the fix wave was opened for — found by reading
 * the client rather than the brief.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request) {
  // `new URL(request.url)` rather than `request.nextUrl`: the latter exists
  // only on Next's own request wrapper, so a plain Request — which is what a
  // test hands it, and what the route contract is actually written against —
  // threw before it ever validated the icao24.
  const icao = new URL(request.url).searchParams.get('icao24') || '';

  if (!/^[0-9a-fA-F]{6}$/.test(icao)) {
    return NextResponse.json({ error: 'Invalid or missing icao24' }, { status: 400 });
  }

  try {
    const { data, age, fetchedAt } = await fetchTrack(icao);
    // Verbatim upstream body: { icao24, callsign, startTime, endTime, path }.
    return NextResponse.json(data, {
      headers: provenanceHeaders({ age, fetchedAt, source: 'OpenSky Network' }),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] opensky track ${icao} — no backfilled trail will be drawn:`, reason);
    return NextResponse.json({ error: 'OpenSky unavailable', reason }, { status: 502 });
  }
}
