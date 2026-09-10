import { NextResponse } from 'next/server';
import { fetchTrace, isValidIcaoHex } from '../military';
import { provenanceHeaders } from '@/lib/gev-provenance';

/**
 * Trail backfill for the military layer.
 *
 * The client calls this as a QUERY, not a path segment:
 *   gods-eye-view src/data/militaryFlights.js:2200
 *     fetch('/api/adsblol/trace?hex=' + encodeURIComponent(icao24))
 *
 * and reads the readsb trace file's own top level:
 *   militaryFlights.js:2205-2206
 *     baseEpochSec = Number(data?.timestamp);
 *     trace = Array.isArray(data?.trace) ? data.trace : null;
 *
 * This replaces `/api/adsblol/trace/[icao]`, which was unreachable from the
 * client (wrong shape of URL) and nested the payload under `trace`, putting
 * `timestamp` out of reach even if it had been reached. Failure here is silent
 * by design on the client side — it keeps the locally accumulated trail — so
 * nothing would ever have reported it.
 *
 * The hex is charset-allowlisted before it reaches a URL path, not merely
 * encoded: it is interpolated into an upstream path segment.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: Request) {
  const hex = new URL(request.url).searchParams.get('hex') ?? '';

  if (!isValidIcaoHex(hex)) {
    return NextResponse.json({ error: 'Invalid or missing hex' }, { status: 400 });
  }

  try {
    const { data, age, fetchedAt } = await fetchTrace(hex);
    // Verbatim upstream body: { icao, r, t, timestamp, trace: [...] }.
    return NextResponse.json(data, {
      headers: provenanceHeaders({ age, fetchedAt, source: 'adsb.lol readsb trace (ODbL)' }),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] adsb.lol trace ${hex} — no backfilled trail will be drawn:`, reason);
    return NextResponse.json({ error: 'adsb.lol unavailable', reason }, { status: 502 });
  }
}
