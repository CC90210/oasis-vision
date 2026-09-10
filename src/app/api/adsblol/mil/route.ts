import { NextResponse } from 'next/server';
import { fetchMilitary } from '../military';
import { provenanceHeaders } from '@/lib/gev-provenance';

/**
 * Consumers: gods-eye-view src/data/militaryFlights.js:83 (the military layer)
 * and src/data/militaryRegistry.js:108 (the flights layer's classification
 * registry). Both require `data.ac` — the raw upstream array — so the body is
 * the upstream shape and provenance rides in headers.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  try {
    const { feed, age, fetchedAt } = await fetchMilitary();
    return NextResponse.json(feed, {
      headers: provenanceHeaders({ age, fetchedAt, source: 'adsb.lol (ODbL)' }),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn('[OSIRIS] adsb.lol military — the military layer will be empty:', reason);
    // The client checks response.ok first (militaryFlights.js:2790) and reads
    // body.error / body.message for the label (:2806), so an error envelope
    // here never reaches the `data.ac` parse.
    return NextResponse.json({ error: 'adsb.lol unavailable', reason }, { status: 502 });
  }
}
