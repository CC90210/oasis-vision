import { NextResponse } from 'next/server';
import { lookupCallsign, isValidCallsign } from '../../aircraft';
import { provenanceHeaders } from '@/lib/gev-provenance';

/**
 * Consumer: gods-eye-view src/data/flights.js:847-851 — reads `data.found`,
 * then `data.airline`, `data.origin`, `data.destination` at the TOP level,
 * and only sets a route when BOTH endpoints are present. A nested
 * `flightroute: {…}` envelope meant no tracked aircraft ever got a route.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ callsign: string }> }) {
  const { callsign } = await params;

  if (!isValidCallsign(callsign)) {
    return NextResponse.json({ error: 'Invalid callsign' }, { status: 400 });
  }

  try {
    const { data, age, fetchedAt } = await lookupCallsign(callsign.toUpperCase());
    if (!data) return NextResponse.json({ found: false, callsign }, { status: 404 });

    return NextResponse.json(
      { found: true, ...data },
      { headers: provenanceHeaders({ age, fetchedAt, source: 'adsbdb (ODbL)' }) },
    );
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] adsbdb callsign ${callsign} — route will be unknown:`, reason);
    return NextResponse.json({ error: 'adsbdb unavailable', reason }, { status: 502 });
  }
}
