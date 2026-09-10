import { NextResponse } from 'next/server';
import { lookupCallsign, isValidCallsign } from '../../aircraft';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ callsign: string }> }) {
  const { callsign } = await params;

  if (!isValidCallsign(callsign)) {
    return NextResponse.json({ error: 'Invalid callsign' }, { status: 400 });
  }

  try {
    const { data, age } = await lookupCallsign(callsign.toUpperCase());
    if (!data) return NextResponse.json({ found: false, callsign }, { status: 404 });
    return NextResponse.json({ found: true, callsign, flightroute: data, provenance: { age } });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] adsbdb callsign ${callsign} — route will be unknown:`, reason);
    return NextResponse.json({ error: 'adsbdb unavailable', reason }, { status: 502 });
  }
}
