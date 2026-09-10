import { NextResponse } from 'next/server';
import { fetchStates } from './states';

export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export async function GET() {
  try {
    const { states, age, fetchedAt } = await fetchStates();
    return NextResponse.json({ count: states.length, states, provenance: { age, fetchedAt } });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn('[OSIRIS] opensky — the flights layer will be empty:', reason);
    return NextResponse.json({ error: 'OpenSky unavailable', reason }, { status: 502 });
  }
}
