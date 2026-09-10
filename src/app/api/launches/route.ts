import { NextResponse } from 'next/server';
import { fetchLaunches } from './launch';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  try {
    const { launches, age, fetchedAt } = await fetchLaunches();
    return NextResponse.json({
      count: launches.length,
      launches,
      provenance: { age, fetchedAt, source: 'Launch Library 2 — The Space Devs' },
      // Said out loud so no consumer mistakes this for tracking data.
      disclaimer: 'Launch context and event timing only. Not ascent telemetry or live orbital state.',
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn('[OSIRIS] launches — the launches layer will be empty:', reason);
    return NextResponse.json({ error: 'Launch Library 2 unavailable', reason }, { status: 502 });
  }
}
