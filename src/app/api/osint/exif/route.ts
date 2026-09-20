import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp, validateHost, safeFetch } from '@/lib/ssrf-guard';
import { parseExif } from '@/lib/forensics/exif';
import { recordReconQuery } from '@/lib/recon-audit';

/**
 * OASIS VISION — Image EXIF forensics.
 *
 * POST a JPEG body, or GET with ?url= to pull one. GPS tags come back
 * as decimal degrees ready to drop on the globe.
 *
 * The ?url= path is SSRF-guarded: without it, this endpoint would be a
 * confused deputy that fetches the local network on request.
 */

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const MAX_BYTES = 25 * 1024 * 1024;

function geoFrom(result: ReturnType<typeof parseExif>, label: string) {
  if (!result.gps) return [];
  return [{
    lat: result.gps.lat,
    lng: result.gps.lng,
    label,
    provenance: `EXIF GPS tags embedded in the image${result.make ? ` (${result.make} ${result.model ?? ''})`.trimEnd() : ''}`,
    kind: 'exif' as const,
  }];
}

export async function POST(req: Request) {
  if (isRateLimited(getClientIp(req), 12, 60_000, 'exif')) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const length = Number(req.headers.get('content-length') || 0);
  if (length > MAX_BYTES) {
    return NextResponse.json({ error: `Image exceeds the ${MAX_BYTES / 1024 / 1024} MB limit` }, { status: 413 });
  }

  try {
    const buf = await req.arrayBuffer();
    if (buf.byteLength === 0) {
      return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
    }
    if (buf.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: 'Image too large' }, { status: 413 });
    }

    const result = parseExif(buf);
    recordReconQuery({ tool: 'exif', subject: `upload:${buf.byteLength}b`, purpose: 'upload', tier: 1 });

    return NextResponse.json(
      { ...result, geo: geoFrom(result, 'Image capture location'), bytes: buf.byteLength },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[OASIS] exif parse failed:', e);
    return NextResponse.json(
      { error: 'Could not read the image', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 400 },
    );
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const target = (searchParams.get('url') || '').trim();

  if (!target) {
    return NextResponse.json(
      { error: 'Missing url parameter', hint: 'POST the image bytes instead to analyse a local file.' },
      { status: 400 },
    );
  }
  if (isRateLimited(getClientIp(req), 12, 60_000, 'exif')) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ error: 'Malformed URL' }, { status: 400 });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return NextResponse.json({ error: 'Only http and https URLs are supported' }, { status: 400 });
  }

  // Resolve and reject private/reserved space before we fetch.
  const guard = await validateHost(parsed.hostname);
  if (!guard.ok) {
    return NextResponse.json(
      { error: 'Target host is not allowed', detail: `Target validation failed: ${guard.reason}` },
      { status: 403 },
    );
  }

  try {
    // safeFetch, NOT fetch with redirect:'follow'. Validating the host
    // once and then following redirects checks only the first hop: a
    // public URL answering 302 -> http://169.254.169.254/ would sail
    // past the guard above and hand back cloud metadata. safeFetch
    // re-validates every hop, which is why it exists.
    const res = await safeFetch(parsed.toString(), {
      headers: { 'User-Agent': 'OASIS-VISION/1.0 (+https://github.com/CC90210/oasis-vision)' },
      signal: AbortSignal.timeout(15000),
      maxRedirects: 3,
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Image fetch returned HTTP ${res.status}` }, { status: 502 });
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return NextResponse.json({ error: 'Image too large' }, { status: 413 });
    }

    const result = parseExif(buf);
    recordReconQuery({ tool: 'exif', subject: parsed.toString(), purpose: 'url', tier: 1 });

    return NextResponse.json(
      { ...result, geo: geoFrom(result, parsed.hostname), bytes: buf.byteLength, source: parsed.toString() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[OASIS] exif url fetch failed:', e);
    return NextResponse.json(
      { error: 'Could not fetch the image', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 502 },
    );
  }
}
