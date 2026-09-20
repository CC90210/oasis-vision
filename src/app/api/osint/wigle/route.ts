import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { recordReconQuery } from '@/lib/recon-audit';

/**
 * OASIS VISION — WiFi network geolocation (WiGLE).
 *
 * Tier 2: needs WIGLE_API_KEY (a base64 "encoded for use" token from
 * wigle.net). Returns observed positions for an SSID or BSSID, which
 * is the point — a network name becomes a set of map pins.
 *
 * When the key is absent this answers 503 with `tier: 2` and
 * `available: false`, and the panel greys the tool out BEFORE the
 * analyst types. That is the whole difference from `/api/scanner`,
 * which presents a live input box over a guaranteed error.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const BSSID = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/;

interface WigleNetwork {
  ssid?: string;
  netid?: string;
  trilat?: number;
  trilong?: number;
  city?: string;
  region?: string;
  country?: string;
  lastupdt?: string;
  encryption?: string;
  channel?: number;
}

export async function GET(req: Request) {
  const key = process.env.WIGLE_API_KEY;
  if (!key) {
    return NextResponse.json(
      {
        error: 'WiGLE is not configured',
        tier: 2,
        available: false,
        hint: 'Set WIGLE_API_KEY to the base64 "encoded for use" token from wigle.net/account.',
      },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(req.url);
  const query = (searchParams.get('q') || '').trim();
  if (!query) {
    return NextResponse.json({ error: 'Missing q parameter (SSID or BSSID)' }, { status: 400 });
  }
  if (query.length > 64) {
    return NextResponse.json({ error: 'Query too long' }, { status: 400 });
  }

  if (isRateLimited(getClientIp(req), 8, 60_000)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  // A BSSID identifies one radio; an SSID is a name many networks share.
  const isBssid = BSSID.test(query);
  const params = new URLSearchParams({ resultsPerPage: '25' });
  if (isBssid) params.set('netid', query.toUpperCase());
  else params.set('ssid', query);

  try {
    const res = await fetch(`https://api.wigle.net/api/v2/network/search?${params}`, {
      headers: {
        Authorization: `Basic ${key}`,
        Accept: 'application/json',
        'User-Agent': 'OASIS-VISION/1.0 (+https://github.com/CC90210/oasis-vision)',
      },
      signal: AbortSignal.timeout(20000),
    });

    if (res.status === 401) {
      return NextResponse.json(
        { error: 'WiGLE rejected the credentials', detail: 'Check WIGLE_API_KEY is the encoded token, not the API name.' },
        { status: 502 },
      );
    }
    if (res.status === 429) {
      return NextResponse.json(
        { error: 'WiGLE daily quota exhausted', detail: 'Free accounts have a small daily query budget.' },
        { status: 429 },
      );
    }
    if (!res.ok) throw new Error(`WiGLE responded ${res.status}`);

    const data = (await res.json()) as { success?: boolean; results?: WigleNetwork[]; totalResults?: number };
    const results = data.results ?? [];

    const geo = results
      .filter((n) => typeof n.trilat === 'number' && typeof n.trilong === 'number')
      .map((n) => ({
        lat: n.trilat as number,
        lng: n.trilong as number,
        label: n.ssid || n.netid || 'Unnamed network',
        provenance: `WiGLE observation${n.lastupdt ? `, last seen ${n.lastupdt}` : ''} — a crowd-sourced sighting, not a live position`,
        kind: 'wifi' as const,
      }));

    recordReconQuery({ tool: 'wigle', subject: query, purpose: searchParams.get('purpose') || 'unspecified', tier: 2 });

    return NextResponse.json(
      {
        query,
        matchedOn: isBssid ? 'bssid' : 'ssid',
        total: data.totalResults ?? results.length,
        returned: results.length,
        networks: results.map((n) => ({
          ssid: n.ssid ?? null,
          bssid: n.netid ?? null,
          lat: n.trilat ?? null,
          lng: n.trilong ?? null,
          city: n.city ?? null,
          region: n.region ?? null,
          country: n.country ?? null,
          encryption: n.encryption ?? null,
          channel: n.channel ?? null,
          lastSeen: n.lastupdt ?? null,
        })),
        geo,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[OASIS] WiGLE lookup failed:', e);
    return NextResponse.json(
      { error: 'WiGLE lookup failed', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 502 },
    );
  }
}
