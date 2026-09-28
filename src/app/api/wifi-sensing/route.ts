import { NextRequest, NextResponse } from 'next/server';
import { hostSampler } from '@/lib/wifi-sensing/host-sampler';

// Reads this machine's WiFi adapter through child processes: Node runtime, never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/wifi-sensing[?since=<ms>]
 *
 * The live state of this computer's own WiFi link for OASIS WIFI. Polling it
 * keeps the sampler running; it stops ~20 s after the last poll. `since`
 * returns only history newer than that timestamp, so a 2-4 Hz poller does not
 * re-download the whole minute each time.
 *
 * Every poller reads one shared buffer, so request volume never multiplies the
 * number of processes reading the adapter.
 */
export async function GET(req: NextRequest) {
  const sampler = hostSampler();
  sampler.touch();
  const since = Number(req.nextUrl.searchParams.get('since'));
  return NextResponse.json(sampler.snapshot(Number.isFinite(since) && since > 0 ? since : 0), {
    headers: { 'Cache-Control': 'no-store' },
  });
}
