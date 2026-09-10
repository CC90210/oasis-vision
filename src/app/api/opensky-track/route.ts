import { NextResponse, type NextRequest } from 'next/server';
import { fetchTrack } from '../opensky/states';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const icao = request.nextUrl.searchParams.get('icao24') || '';

  if (!/^[0-9a-fA-F]{6}$/.test(icao)) {
    return NextResponse.json({ error: 'Invalid or missing icao24' }, { status: 400 });
  }

  try {
    const { data, age } = await fetchTrack(icao);
    return NextResponse.json({ icao24: icao.toLowerCase(), track: data, provenance: { age } });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] opensky track ${icao} — no track will be drawn:`, reason);
    return NextResponse.json({ error: 'OpenSky unavailable', reason }, { status: 502 });
  }
}
