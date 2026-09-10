import { NextResponse, type NextRequest } from 'next/server';
import { fetchTleGroup, isValidGroup } from './tle';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const group = (request.nextUrl.searchParams.get('GROUP') || 'stations').toLowerCase();

  if (!isValidGroup(group)) {
    return NextResponse.json({ error: 'Invalid GROUP' }, { status: 400 });
  }

  try {
    const { records, age, fetchedAt } = await fetchTleGroup(group);
    return NextResponse.json(
      { group, count: records.length, records, provenance: { age, fetchedAt } },
      { headers: { 'Cache-Control': 'public, max-age=300' } },
    );
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] celestrak ${group} — satellites layer will be empty:`, reason);
    return NextResponse.json({ error: 'CelesTrak unavailable', reason }, { status: 502 });
  }
}
