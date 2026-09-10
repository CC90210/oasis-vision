import { NextResponse } from 'next/server';
import { fetchLaunches, LAUNCH_SOURCE } from './launch';
import { provenanceHeaders } from '@/lib/gev-provenance';

/**
 * Consumer: gods-eye-view src/data/rocketLaunches.js:16 / :3345. The body is
 * `{ count, results }` of raw LL2 records because the client's envelope pick
 * is `Array.isArray(payload) ? payload : payload?.results` (:2782) and its
 * normalizer walks the nested LL2 paths (:2786-2820).
 *
 * The disclaimer that used to sit in the body — "launch context and event
 * timing only, not ascent telemetry" — moved to a header. It is still said
 * out loud, and it no longer sits in a payload the client feeds to a mapper.
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET() {
  try {
    const { feed, age, fetchedAt } = await fetchLaunches();
    return NextResponse.json(feed, {
      headers: provenanceHeaders({
        age,
        fetchedAt,
        source: LAUNCH_SOURCE,
        extra: {
          'X-Oasis-Disclaimer':
            'Launch context and event timing only. Not ascent telemetry or live orbital state.',
        },
      }),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    console.warn('[OSIRIS] launches — the launches layer will be empty:', reason);
    // The client checks response.ok before parsing (rocketLaunches.js:3346).
    return NextResponse.json({ error: 'Launch Library 2 unavailable', reason }, { status: 502 });
  }
}
