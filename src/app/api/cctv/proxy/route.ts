import { NextRequest, NextResponse } from 'next/server';
import { validateHost } from '@/lib/ssrf-guard';

export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/**
 * CCTV image proxy — bypasses CORS / hotlink protection on camera CDNs.
 *
 * The target URL comes from the request, so this route is only as safe as the
 * checks below. Five defects were closed on 2026-10-01; each has a test in
 * `route.test.ts` that fires on purpose:
 *
 *   1. Redirects are NOT followed blindly. `redirect: 'manual'`, the Location
 *      re-checked against the same allowlist and the same SSRF guard, one hop
 *      maximum. The old code followed any 301/302 anywhere, so an allowed
 *      origin could hand the server a link-local address the allowlist never
 *      saw.
 *   2. Exact hostname equality. The old suffix match on
 *      `s3-eu-west-1.amazonaws.com` admitted every other tenant's bucket on a
 *      shared host. Nothing proxies S3 any more, so that entry is gone.
 *   3. TLS verification stays on. Every live host was probed with strict TLS
 *      on 2026-10-01 and passed.
 *   4. The body is read under a size cap and aborted mid-stream past it.
 *   5. Only image responses are relayed. This route answers from our own
 *      origin with `Access-Control-Allow-Origin: *`, so relaying an upstream's
 *      HTML would serve it as ours.
 *
 * The allowlist is every host a camera list actually hands this route,
 * measured 2026-10-01: the Skyline CDN (static lists), Spain's DGT feed, and
 * the eight Taiwan Highway Bureau snapshot servers. Add a host here only when
 * a camera source starts emitting it.
 */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'cdn.skylinewebcams.com',
  'etraffic.dgt.es',
  'cctv-ss01.thb.gov.tw',
  'cctv-ss02.thb.gov.tw',
  'cctv-ss03.thb.gov.tw',
  'cctv-ss04.thb.gov.tw',
  'cctv-ss05.thb.gov.tw',
  'cctv-ss06.thb.gov.tw',
  'cctv-ss07.thb.gov.tw',
  'cctv-ss08.thb.gov.tw',
]);

/** Largest live frame measured was ~36 KB; 5 MB leaves room without being unbounded. */
export const MAX_FRAME_BYTES = 5 * 1024 * 1024;

const TIMEOUT_MS = 12_000;

// Taiwan Highway Bureau cameras are DigiEver encoders, and they emit a
// malformed response header when the request carries a Referer. Asking
// without a Referer returns a clean JPEG (8/8 servers). An Accept header is
// still required: without one these servers hang up.
function sendsReferer(hostname: string): boolean {
  return !hostname.endsWith('.thb.gov.tw');
}

/** Injection seam for tests; swapped and restored in `route.test.ts`. */
export const proxyDeps = {
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof globalThis.fetch,
  validateHost,
};

export function isAllowedTarget(target: URL): boolean {
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;
  return ALLOWED_HOSTS.has(target.hostname.toLowerCase());
}

async function gate(target: URL): Promise<string | null> {
  if (!isAllowedTarget(target)) return `host ${target.hostname} is not on the allowlist`;
  const check = await proxyDeps.validateHost(target.hostname);
  if (!check.ok) return `blocked target: ${check.reason}`;
  return null;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already closed */
  }
}

function frameRequest(target: URL): RequestInit {
  const headers: Record<string, string> = {
    Accept: 'image/*,*/*',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };
  if (sendsReferer(target.hostname.toLowerCase())) headers.Referer = `https://${target.hostname}/`;
  return { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers, cache: 'no-store' };
}

type FetchOutcome = { ok: true; response: Response } | { ok: false; status: number; reason: string };

/** Fetch with the allowlist and SSRF guard re-checked on the one permitted redirect. */
export async function fetchFrame(target: URL): Promise<FetchOutcome> {
  const first = await gate(target);
  if (first) return { ok: false, status: 403, reason: first };

  let res: Response;
  try {
    res = await proxyDeps.fetch(target.toString(), frameRequest(target));
  } catch (e) {
    return { ok: false, status: 502, reason: e instanceof Error ? e.message : 'upstream unreachable' };
  }
  if (res.status < 300 || res.status >= 400) return { ok: true, response: res };

  const location = res.headers.get('location');
  await discard(res);
  let next: URL | null = null;
  try {
    next = location ? new URL(location, target) : null;
  } catch {
    next = null;
  }
  if (!next) return { ok: false, status: 502, reason: 'upstream redirect had no usable Location' };

  const hop = await gate(next);
  if (hop) return { ok: false, status: 403, reason: `refused redirect: ${hop}` };

  let hopRes: Response;
  try {
    hopRes = await proxyDeps.fetch(next.toString(), frameRequest(next));
  } catch (e) {
    return { ok: false, status: 502, reason: e instanceof Error ? e.message : 'upstream unreachable after redirect' };
  }
  if (hopRes.status >= 300 && hopRes.status < 400) {
    await discard(hopRes);
    return { ok: false, status: 502, reason: 'upstream redirected twice; one hop is the limit' };
  }
  return { ok: true, response: hopRes };
}

/** Read a body, refusing to exceed `maxBytes` whether or not the upstream declared a length. */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(res);
    return null;
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > maxBytes ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('size cap exceeded');
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');
  if (!url) return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  try {
    const outcome = await fetchFrame(target);
    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.reason }, { status: outcome.status });
    }
    const upstream = outcome.response;
    if (upstream.status >= 400) {
      await discard(upstream);
      return NextResponse.json({ error: `Upstream ${upstream.status}` }, { status: upstream.status });
    }

    const contentType = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType.startsWith('image/') || contentType === 'image/svg+xml') {
      await discard(upstream);
      return NextResponse.json({ error: 'Upstream did not return an image' }, { status: 502 });
    }

    const body = await readCapped(upstream, MAX_FRAME_BYTES);
    if (!body) return NextResponse.json({ error: 'Upstream frame exceeded the size cap' }, { status: 502 });

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=5, stale-while-revalidate=10',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.error('Camera proxy error:', message);
    return NextResponse.json({ error: 'Proxy failed: ' + message }, { status: 502 });
  }
}
