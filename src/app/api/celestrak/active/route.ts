import { NextResponse } from 'next/server';
import { fetchTleGroup } from '../tle';

/**
 * The full active-satellite catalogue. Separate from the parameterised route
 * because the client asks for it by path, and because it is the one group
 * CelesTrak rejects without a descriptive User-Agent.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export async function GET() {
  try {
    const { records, age, fetchedAt } = await fetchTleGroup('active');
    return NextResponse.json(
      { group: 'active', count: records.length, records, provenance: { age, fetchedAt } },
      { headers: { 'Cache-Control': 'public, max-age=300' } },
    );
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn('[OSIRIS] celestrak active — satellites layer will be empty:', reason);
    return NextResponse.json({ error: 'CelesTrak unavailable', reason }, { status: 502 });
  }
}
