import { NextResponse } from 'next/server';
import { lookupAircraft, isValidHexOrReg } from '../../aircraft';
import { provenanceHeaders } from '@/lib/gev-provenance';

/**
 * Consumer: gods-eye-view src/data/flights.js:823-828 — reads `data.found`,
 * then `data.typeCode`, `data.typeName`, `data.registration` at the TOP
 * level. A nested `aircraft: {…}` envelope left every one of those undefined,
 * and the client's `data.typeCode || meta.typeCode` idiom turned that into a
 * silent no-op: the whole fleet stayed on the default airliner silhouette
 * with no error anywhere.
 */
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  if (!isValidHexOrReg(id)) {
    return NextResponse.json({ error: 'Invalid aircraft identifier' }, { status: 400 });
  }

  try {
    const { data, age, fetchedAt } = await lookupAircraft(id.toUpperCase());
    // `found: false` with 404 — the client checks response.ok first
    // (flights.js:812), so this never reaches the enrichment callback.
    if (!data) return NextResponse.json({ found: false, id }, { status: 404 });

    return NextResponse.json(
      { found: true, id, ...data },
      { headers: provenanceHeaders({ age, fetchedAt, source: 'adsbdb (ODbL)' }) },
    );
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] adsbdb aircraft ${id} — identity will be unknown:`, reason);
    return NextResponse.json({ error: 'adsbdb unavailable', reason }, { status: 502 });
  }
}
