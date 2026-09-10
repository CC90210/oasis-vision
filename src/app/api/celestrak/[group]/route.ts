import { NextResponse } from 'next/server';
import { fetchTleGroup, isValidGroup } from '../tle';

/**
 * Path-style CelesTrak proxy — the vendored globe client requests groups as
 * `/api/celestrak/<group>` (see gods-eye-view src/data/satellites.js and
 * rocketLaunches.js), never as `/api/celestrak?GROUP=<group>`. Every group
 * other than `active` 404d until this route existed.
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
    const { records, age, fetchedAt } = await fetchTleGroup(normalized);
    return NextResponse.json(
      { group: normalized, count: records.length, records, provenance: { age, fetchedAt } },
      { headers: { 'Cache-Control': 'public, max-age=300' } },
    );
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn(`[OSIRIS] celestrak ${normalized} — satellites layer will be empty:`, reason);
    return NextResponse.json({ error: 'CelesTrak unavailable', reason }, { status: 502 });
  }
}
