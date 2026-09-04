import { NextRequest, NextResponse } from 'next/server';

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
    const ALLOWED_HOSTS = [
      'cartocdn.com',
      'elevation-tiles-prod.s3.amazonaws.com',
      's3.amazonaws.com',
    ];
    const targetUrl = new URL(url);
    const host = targetUrl.hostname.toLowerCase();
    const allowed = ALLOWED_HOSTS.some(h => host === h || host.endsWith(`.${h}`));
    // s3.amazonaws.com is a shared host: narrow it to the elevation bucket
    // rather than admitting every bucket on S3.
    const s3PathOk = host !== 's3.amazonaws.com' || targetUrl.pathname.startsWith('/elevation-tiles-prod/');
    if (!allowed || !s3PathOk) {
      return NextResponse.json({ error: 'Forbidden domain' }, { status: 403 });
    }

    const response = await fetch(targetUrl.toString(), { signal: AbortSignal.timeout(15000),
      headers: {
        'Accept': '*/*',
        'User-Agent': 'Osiris-Tile-Proxy/1.0',
      },
      // Using Next.js fetch cache options to heavily cache tiles locally
      next: {
        revalidate: 31536000, // Cache for 1 year
      }
    });

    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch tile' }, { status: response.status });
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
