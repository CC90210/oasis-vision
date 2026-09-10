import { NextResponse } from 'next/server';
import { fetchTrace, isValidIcaoHex } from '../../military';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_request: Request, { params }: { params: Promise<{ icao: string }> }) {
  const { icao } = await params;

  if (!isValidIcaoHex(icao)) {
    return NextResponse.json({ error: 'Invalid ICAO hex' }, { status: 400 });
  }

  try {
    const { data, age } = await fetchTrace(icao);
    return NextResponse.json({ icao: icao.toLowerCase(), trace: data, provenance: { age } });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] adsb.lol trace ${icao} — no track will be drawn:`, reason);
    return NextResponse.json({ error: 'adsb.lol unavailable', reason }, { status: 502 });
  }
}
