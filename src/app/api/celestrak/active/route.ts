import { NextResponse } from 'next/server';
import { fetchTleGroup } from '../tle';
import { provenanceHeaders } from '@/lib/gev-provenance';

/**
 * The full active-satellite catalogue. Separate from the parameterised route
 * because the client asks for it by path, and because it is the one group
 * CelesTrak rejects without a descriptive User-Agent.
 *
 * Consumer: gods-eye-view src/data/rocketLaunches.js:3258-3262 —
 * `fetch('/api/celestrak/active').then(r => r.text())`. Raw TLE text, same as
 * the parameterised sibling; provenance rides in headers.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export async function GET() {
  try {
    const { text, records, age, fetchedAt } = await fetchTleGroup('active');
    return new NextResponse(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        ...provenanceHeaders({
          age,
          fetchedAt,
          source: 'CelesTrak GP (celestrak.org)',
          extra: { 'X-Oasis-Group': 'active', 'X-Oasis-Count': String(records.length) },
        }),
      },
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn('[OSIRIS] celestrak active — satellites layer will be empty:', reason);
    return NextResponse.json({ error: 'CelesTrak unavailable', reason }, { status: 502 });
  }
}
