import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { recordReconQuery } from '@/lib/recon-audit';

/**
 * OASIS VISION — Onion service crawl, via an opt-in sidecar.
 *
 * TorBot is GPL-3.0 and needs a Tor daemon, so it is NEVER imported or
 * bundled here. It runs as a separate container and this route speaks
 * to it over HTTP. See docs/recon-expansion/PLAN.md section 3 and 4.3.
 *
 * Set TORBOT_URL to enable. Without it the route answers 503 with
 * `available: false`, and the panel greys the tool out before the
 * analyst types.
 *
 * Handling rules, deliberately strict:
 *   - opt-in per query, never part of a default sweep
 *   - depth hard-capped regardless of what is requested
 *   - only .onion targets; this is not a general web crawler
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ONION = /^(?:https?:\/\/)?[a-z2-7]{16,56}\.onion(?:\/.*)?$/i;
const MAX_DEPTH = 2;

export async function GET(req: Request) {
  const base = process.env.TORBOT_URL;
  if (!base) {
    return NextResponse.json(
      {
        error: 'Dark-web crawling is not enabled',
        tier: 3,
        available: false,
        hint:
          'Runs as a separate opt-in container (Tor daemon required). Set TORBOT_URL to its address. ' +
          'Nothing is bundled into OASIS VISION.',
      },
      { status: 503 },
    );
  }

  const { searchParams } = new URL(req.url);
  const target = (searchParams.get('url') || '').trim();

  if (!target) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }
  if (!ONION.test(target)) {
    return NextResponse.json(
      {
        error: 'Not an onion address',
        detail: 'This tool crawls .onion services only. Use the DOMAIN & WEB tools for the clear web.',
      },
      { status: 400 },
    );
  }

  // Crawling is expensive and slow; the budget is tighter than anything else here.
  if (isRateLimited(getClientIp(req), 3, 300_000)) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', detail: 'Maximum 3 onion crawls per 5 minutes.' },
      { status: 429 },
    );
  }

  const requested = Number(searchParams.get('depth') || 1);
  const depth = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 1, MAX_DEPTH);
  const purpose = searchParams.get('purpose') || 'unspecified';

  try {
    const url = new URL('/crawl', base);
    url.searchParams.set('url', target);
    url.searchParams.set('depth', String(depth));

    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json', 'User-Agent': 'OASIS-VISION/1.0' },
      signal: AbortSignal.timeout(110_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Crawler returned HTTP ${res.status}`, detail: 'Check the sidecar is running and Tor is reachable.' },
        { status: 502 },
      );
    }

    const data = await res.json();
    recordReconQuery({ tool: 'darkweb', subject: target, purpose, tier: 3 });

    return NextResponse.json(
      { ...data, target, depth, depthCapped: requested > MAX_DEPTH },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[OASIS] darkweb crawl failed:', e);
    return NextResponse.json(
      {
        error: 'Crawl failed',
        detail: e instanceof Error ? e.message : 'unknown',
        hint: 'A timeout usually means the Tor circuit could not be built, not that the service is gone.',
      },
      { status: 502 },
    );
  }
}
