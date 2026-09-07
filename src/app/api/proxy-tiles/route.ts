import { NextRequest, NextResponse } from 'next/server';

/**
 * Is this URL one of the handful of upstreams the map is allowed to reach?
 *
 * The previous form was an open proxy to the whole of S3, and it read as safe:
 *
 *   ALLOWED_HOSTS = ['cartocdn.com', 'elevation-tiles-prod.s3.amazonaws.com', 's3.amazonaws.com']
 *   allowed  = ALLOWED_HOSTS.some(h => host === h || host.endsWith(`.${h}`))
 *   s3PathOk = host !== 's3.amazonaws.com' || path.startsWith('/elevation-tiles-prod/')
 *
 * `host.endsWith('.s3.amazonaws.com')` admits ANY virtual-hosted bucket, and
 * the path guard only fires for the bare `s3.amazonaws.com` host — so
 * `?url=https://attacker-bucket.s3.amazonaws.com/anything` passed both checks.
 * The comment claimed S3 was narrowed to the elevation bucket; the code did not
 * do that. Found by an independent audit, 2026-09-07.
 *
 * Written as explicit cases rather than a suffix list: a suffix match over a
 * shared multi-tenant host is the bug, not the implementation of it.
 */
export function isAllowedTarget(target: URL): boolean {
  // http(s) only — no file:, data:, gopher:, or anything else undici will take.
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return false;

  const host = target.hostname.toLowerCase();

  // CARTO basemap style, sprites, glyphs and vector tiles.
  if (host === 'cartocdn.com' || host.endsWith('.cartocdn.com')) return true;

  // AWS Terrain Tiles — the DEM behind real 3D terrain. Keyless and public, but
  // served with no Access-Control-Allow-Origin, so MapLibre cannot fetch it
  // from the browser and it has to come through here. Both addressing forms of
  // the SAME bucket are allowed, and nothing else on S3 is.
  if (host === 'elevation-tiles-prod.s3.amazonaws.com') return true;
  if (host === 's3.amazonaws.com' && target.pathname.startsWith('/elevation-tiles-prod/')) return true;

  return false;
}

/**
 * Release a response we are not going to read. An unread body keeps its undici
 * connection open until GC, and this route retries and short-circuits often
 * enough for that to accumulate under load.
 */
async function discard(res: Response): Promise<void> {
  try { await res.body?.cancel(); } catch { /* already closed or never had one */ }
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  try {
    /**
     * Strict host allowlist — this must never become an open proxy.
     *
     * cartocdn: the basemap style and its vector tiles.
     * elevation-tiles-prod: AWS Terrain Tiles, the DEM behind real 3D terrain.
     *   Keyless and public, but served with NO Access-Control-Allow-Origin, so
     *   MapLibre cannot fetch it from the browser directly — it has to come
     *   through here.
     */
    const targetUrl = new URL(url);
    if (!isAllowedTarget(targetUrl)) {
      return NextResponse.json({ error: 'Forbidden domain' }, { status: 403 });
    }

    /**
     * Retried, and this is not optional politeness.
     *
     * Everything the map draws comes through here, including the ONE request
     * the whole application depends on: the basemap style.json. MapLibre does
     * not retry a failed style — a single transient error leaves the map blank
     * forever, `mapReady` never fires, and every control gated on it (the area
     * assessment button among them) stays disabled with nothing on screen
     * explaining why. Observed exactly that on 2026-09-04: one 500 on a cold
     * start, and the same URL returned 200 immediately afterwards.
     *
     * Only transient conditions are retried. A 403 or 404 is an answer, and
     * asking again just doubles the latency before the same reply.
     */
    let response: Response | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250));
      try {
        response = await fetch(targetUrl.toString(), {
          signal: AbortSignal.timeout(15000),
          // The allowlist checks the URL we ASK for. Following a redirect
          // silently would let any allowed origin hand the server a new
          // destination the allowlist never saw — including a link-local or
          // loopback address. Handled manually below instead.
          redirect: 'manual',
          headers: {
            'Accept': '*/*',
            'User-Agent': 'Osiris-Tile-Proxy/1.0',
          },
          // Using Next.js fetch cache options to heavily cache tiles locally
          next: {
            revalidate: 31536000, // Cache for 1 year
          }
        });
        if (response.ok || response.status < 500) break;
        lastError = `HTTP ${response.status}`;
        // A body left unread holds its undici connection open. Every retried
        // 5xx used to leak one.
        await discard(response);
      } catch (e) {
        lastError = e;
        response = null;
      }
    }

    if (!response) {
      console.error('Tile proxy: upstream unreachable', targetUrl.hostname, lastError);
      return NextResponse.json({ error: 'Upstream unreachable' }, { status: 502 });
    }

    // A redirect is an answer we have to re-check, not one to follow blindly.
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await discard(response);
      let next: URL | null = null;
      try { next = location ? new URL(location, targetUrl) : null; } catch { next = null; }
      if (!next || !isAllowedTarget(next)) {
        console.error('Tile proxy: refused redirect to', location, 'from', targetUrl.hostname);
        return NextResponse.json({ error: 'Upstream redirected off the allowlist' }, { status: 502 });
      }
      // An in-allowlist redirect is legitimate (CARTO does this); one hop only,
      // so a redirect loop cannot spin the server.
      const hop = await fetch(next.toString(), {
        signal: AbortSignal.timeout(15000),
        redirect: 'manual',
        headers: { Accept: '*/*', 'User-Agent': 'Osiris-Tile-Proxy/1.0' },
        next: { revalidate: 31536000 },
      });
      if (!hop.ok) {
        await discard(hop);
        return NextResponse.json({ error: 'Failed to fetch tile' }, { status: hop.status });
      }
      response = hop;
    }

    if (!response.ok) {
      const status = response.status;
      await discard(response);
      return NextResponse.json({ error: 'Failed to fetch tile' }, { status });
    }

    const data = await response.arrayBuffer();
    
    // Forward the content-type from the upstream response
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    return new NextResponse(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    console.error('Tile proxy error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
