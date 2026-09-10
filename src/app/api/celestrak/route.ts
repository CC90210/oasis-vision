import { NextResponse, type NextRequest } from 'next/server';
import { fetchTleGroup, isValidGroup } from './tle';
import { provenanceHeaders } from '@/lib/gev-provenance';

/**
 * Query-string form, `?GROUP=<name>`. The vendored globe client does not use
 * it — it asks path-style — but this shipped alongside and there is exactly
 * one CelesTrak contract in this app: raw TLE text with provenance in headers.
 * Two shapes on the same upstream is how the path/envelope drift started.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const group = (request.nextUrl.searchParams.get('GROUP') || 'stations').toLowerCase();

  if (!isValidGroup(group)) {
    return NextResponse.json({ error: 'Invalid GROUP' }, { status: 400 });
  }

  try {
    const { text, records, age, fetchedAt } = await fetchTleGroup(group);
    return new NextResponse(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        ...provenanceHeaders({
          age,
          fetchedAt,
          source: 'CelesTrak GP (celestrak.org)',
          extra: { 'X-Oasis-Group': group, 'X-Oasis-Count': String(records.length) },
        }),
      },
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] celestrak ${group} — satellites layer will be empty:`, reason);
    return NextResponse.json({ error: 'CelesTrak unavailable', reason }, { status: 502 });
  }
}
