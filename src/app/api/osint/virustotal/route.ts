import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';

/**
 * OASIS VISION — VirusTotal reputation for a hash, URL, domain or IP.
 *
 * Tier 2: needs VIRUSTOTAL_API_KEY. The free tier allows 4 lookups per
 * minute, so the local budget is set below that rather than letting
 * the analyst discover the ceiling as an upstream 429.
 *
 * Reports the vendor split as counts, never as a verdict. "7 of 94
 * engines flagged this" is a fact; "malicious" is an interpretation
 * that belongs to the analyst.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const SHA256 = /^[A-Fa-f0-9]{64}$/;
const SHA1 = /^[A-Fa-f0-9]{40}$/;
const MD5 = /^[A-Fa-f0-9]{32}$/;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
const DOMAIN = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

type Kind = 'file' | 'url' | 'domain' | 'ip';

function classify(q: string): { kind: Kind; endpoint: string } | null {
  if (SHA256.test(q) || SHA1.test(q) || MD5.test(q)) {
    return { kind: 'file', endpoint: `files/${q}` };
  }
  if (IPV4.test(q)) {
    return { kind: 'ip', endpoint: `ip_addresses/${q}` };
  }
  if (/^https?:\/\//i.test(q)) {
    // VT keys URLs by the unpadded base64 of the URL itself.
    const id = Buffer.from(q).toString('base64url').replace(/=+$/, '');
    return { kind: 'url', endpoint: `urls/${id}` };
  }
  if (DOMAIN.test(q)) {
    return { kind: 'domain', endpoint: `domains/${q}` };
  }
  return null;
}

interface VtStats { malicious?: number; suspicious?: number; harmless?: number; undetected?: number; timeout?: number }

export async function GET(req: Request) {
  const key = process.env.VIRUSTOTAL_API_KEY;
  if (!key) {
    return NextResponse.json(
      {
        error: 'VirusTotal is not configured',
        tier: 2,
        available: false,
        hint: 'Set VIRUSTOTAL_API_KEY. The free tier allows 4 lookups per minute.',
      },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(req.url);
  const query = (searchParams.get('q') || '').trim();
  if (!query) {
    return NextResponse.json({ error: 'Missing q parameter' }, { status: 400 });
  }
  if (query.length > 2048) {
    return NextResponse.json({ error: 'Query too long' }, { status: 400 });
  }

  const target = classify(query);
  if (!target) {
    return NextResponse.json(
      { error: 'Unrecognised input', detail: 'Expected an MD5/SHA-1/SHA-256 hash, a URL, a domain, or an IPv4 address.' },
      { status: 400 },
    );
  }

  // Below VT's own free-tier ceiling of 4/min, so the analyst hits our
  // limit with a clear message instead of their opaque 429.
  if (isRateLimited(getClientIp(req), 3, 60_000)) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', detail: 'VirusTotal free tier allows 4 lookups per minute.' },
      { status: 429 },
    );
  }

  try {
    const res = await fetch(`https://www.virustotal.com/api/v3/${target.endpoint}`, {
      headers: {
        'x-apikey': key,
        Accept: 'application/json',
        'User-Agent': 'OASIS-VISION/1.0 (+https://github.com/CC90210/oasis-vision)',
      },
      signal: AbortSignal.timeout(20000),
    });

    if (res.status === 404) {
      return NextResponse.json({
        query,
        kind: target.kind,
        found: false,
        detail: 'VirusTotal has no record for this indicator. Absence is not a clean verdict.',
      });
    }
    if (res.status === 401) {
      return NextResponse.json({ error: 'VirusTotal rejected the API key' }, { status: 502 });
    }
    if (res.status === 429) {
      return NextResponse.json(
        { error: 'VirusTotal quota exhausted', detail: 'Free tier: 4/minute, 500/day.' },
        { status: 429 },
      );
    }
    if (!res.ok) throw new Error(`VirusTotal responded ${res.status}`);

    const body = (await res.json()) as {
      data?: { attributes?: Record<string, unknown> };
    };
    const attrs = body.data?.attributes ?? {};
    const stats = (attrs.last_analysis_stats ?? {}) as VtStats;
    const engines =
      (stats.malicious ?? 0) + (stats.suspicious ?? 0) + (stats.harmless ?? 0) + (stats.undetected ?? 0);

    return NextResponse.json(
      {
        query,
        kind: target.kind,
        found: true,
        detections: {
          malicious: stats.malicious ?? 0,
          suspicious: stats.suspicious ?? 0,
          harmless: stats.harmless ?? 0,
          undetected: stats.undetected ?? 0,
          engines,
        },
        // A count, not a verdict.
        summary: `${stats.malicious ?? 0} of ${engines} engines flagged this as malicious.`,
        reputation: typeof attrs.reputation === 'number' ? attrs.reputation : null,
        meaningfulName: (attrs.meaningful_name as string) ?? null,
        fileType: (attrs.type_description as string) ?? null,
        size: typeof attrs.size === 'number' ? attrs.size : null,
        registrar: (attrs.registrar as string) ?? null,
        asOwner: (attrs.as_owner as string) ?? null,
        country: (attrs.country as string) ?? null,
        permalink: `https://www.virustotal.com/gui/search/${encodeURIComponent(query)}`,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[OASIS] VirusTotal lookup failed:', e);
    return NextResponse.json(
      { error: 'VirusTotal lookup failed', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 502 },
    );
  }
}
