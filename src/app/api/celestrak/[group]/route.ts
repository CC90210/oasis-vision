import { NextResponse } from 'next/server';
import { fetchTleGroup, isValidGroup } from '../tle';
import { provenanceHeaders } from '@/lib/gev-provenance';

/**
 * Path-style CelesTrak proxy — the vendored globe client requests groups as
 * `/api/celestrak/<group>` (gods-eye-view src/data/satellites.js:1096 and
 * :1635), never as `/api/celestrak?GROUP=<group>`, and it reads the response
 * with `res.text()` into `parseTLE` (satellites.js:1104-1108, :1637).
 *
 * So this answers `text/plain` carrying the upstream TLE verbatim. Provenance
 * rides in headers (see `provenanceHeaders`) because a JSON envelope here
 * parses to zero satellites behind a 200 and reports nothing.
 *
 * `active` keeps its own static sibling route (`../active/route.ts`) — Next
 * gives a static segment precedence over a dynamic one at the same path, so
 * both coexist without this route ever handling that group.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(_request: Request, { params }: { params: Promise<{ group: string }> }) {
  const { group } = await params;
  const normalized = group.toLowerCase();

  if (!isValidGroup(normalized)) {
    return NextResponse.json({ error: 'Invalid group' }, { status: 400 });
  }

  try {
    const { text, records, age, fetchedAt } = await fetchTleGroup(normalized);
    return new NextResponse(text, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        ...provenanceHeaders({
          age,
          fetchedAt,
          source: 'CelesTrak GP (celestrak.org)',
          extra: { 'X-Oasis-Group': normalized, 'X-Oasis-Count': String(records.length) },
        }),
      },
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] celestrak ${normalized} — satellites layer will be empty:`, reason);
    // A non-2xx is what the client checks first (satellites.js:1097, :1636),
    // so an error body is safe here: it never reaches parseTLE.
    return NextResponse.json({ error: 'CelesTrak unavailable', reason }, { status: 502 });
  }
}
