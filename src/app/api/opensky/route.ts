import { NextResponse } from 'next/server';
import { fetchStates } from './states';
import { provenanceHeaders } from '@/lib/gev-provenance';

/**
 * Consumer: gods-eye-view src/data/flights.js:273 (`API_URL = '/api/opensky'`),
 * called as `${API_URL}?lat=..&lon=..` (flights.js:325-336). The lat/lon are a
 * camera hint; this route answers with the worldwide snapshot and says so in
 * `x-flight-coverage`, which the client displays verbatim (flights.js:4159).
 *
 * The body is the raw upstream `{ time, states }`. Provenance is in headers —
 * see src/lib/gev-provenance.ts for why it cannot be in the body.
 *
 * The client reads these headers directly:
 *   x-flight-source / x-flight-coverage       flights.js:4081-4082
 *   x-opensky-auth-mode-used                  flights.js:4084
 *   x-opensky-auth-reason                     flights.js:4086 → _deriveOpenSkyAuthError
 */
export const dynamic = 'force-dynamic';
export const maxDuration = 45;

export async function GET(_request?: Request) {
  try {
    const { payload, age, fetchedAt, authMode } = await fetchStates();

    return NextResponse.json(payload, {
      headers: provenanceHeaders({
        age,
        fetchedAt,
        source: 'OpenSky Network',
        extra: {
          'x-flight-source': 'OpenSky Network',
          'x-flight-coverage': 'worldwide upstream snapshot',
          'x-opensky-auth-mode-used': authMode,
          // Read only on 401/403 by the client. Naming the anonymous mode is
          // what turns "OpenSky auth failed" into "OpenSky auth required".
          'x-opensky-auth-reason': authMode === 'oauth' ? 'oauth_ok' : 'missing_oauth_and_basic_creds',
        },
      }),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'unknown';
    const limited = /429|rate limited|cooldown/i.test(reason);
    console.warn('[OSIRIS] opensky (globe) — the flights layer will be empty:', reason);

    // 429 is a distinct branch in the client (flights.js:4088-4095): it backs
    // off politely instead of treating it as an outage. Reporting it as 502
    // would make the globe retry into a limited endpoint.
    return NextResponse.json(
      { error: limited ? 'OpenSky rate limited' : 'OpenSky unavailable', reason },
      {
        status: limited ? 429 : 502,
        headers: {
          'x-opensky-auth-mode-used': process.env.OPENSKY_CLIENT_ID?.trim() ? 'oauth' : 'anon',
        },
      },
    );
  }
}
