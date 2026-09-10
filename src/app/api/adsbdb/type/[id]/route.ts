import { NextResponse } from 'next/server';
import { lookupAircraft, isValidHexOrReg } from '../../aircraft';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!isValidHexOrReg(id)) {
    return NextResponse.json({ error: 'Invalid aircraft identifier' }, { status: 400 });
  }

  try {
    const { data, age } = await lookupAircraft(id.toUpperCase());
    if (!data) return NextResponse.json({ found: false, id }, { status: 404 });
    return NextResponse.json({ found: true, id, aircraft: data, provenance: { age } });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] adsbdb aircraft ${id} — identity will be unknown:`, reason);
    return NextResponse.json({ error: 'adsbdb unavailable', reason }, { status: 502 });
  }
}
