import { NextResponse } from 'next/server';
import { fetchMilitary } from '../military';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  try {
    const { aircraft, age, fetchedAt } = await fetchMilitary();
    return NextResponse.json({ count: aircraft.length, aircraft, provenance: { age, fetchedAt } });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn('[OSIRIS] adsb.lol military — the military layer will be empty:', reason);
    return NextResponse.json({ error: 'adsb.lol unavailable', reason }, { status: 502 });
  }
}
