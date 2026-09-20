import { NextRequest, NextResponse } from 'next/server';

// Server-side proxy for IP geolocation — avoids mixed-content block on HTTPS pages
// Three providers with cascading fallback for maximum reliability
export async function GET(request: NextRequest) {
  try {
    // Extract the real client IP from standard proxy headers
    const clientIp =
      request.headers.get('cf-connecting-ip') ||        // Cloudflare
      request.headers.get('x-real-ip') ||                // Nginx / generic
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      '';

    // Skip private/loopback IPs — let the API auto-detect
    const isPrivate = !clientIp || clientIp === '::1' || clientIp === '127.0.0.1' || clientIp.startsWith('192.168.') || clientIp.startsWith('10.') || clientIp.startsWith('172.');
    const ip = isPrivate ? '' : clientIp;

    // ── Provider 1: ipapi.co (HTTPS, free tier 1000/day) ──
    try {
      const url = ip ? `https://ipapi.co/${ip}/json/` : 'https://ipapi.co/json/';
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
        headers: { 'User-Agent': 'OASIS VISION/4.2' },
      });
      if (res.ok) {
        const d = await res.json();
        if (!d.error && d.latitude) {
          return NextResponse.json({
            status: 'success',
            query: d.ip,
            lat: d.latitude,
            lon: d.longitude,
            city: d.city,
            regionName: d.region,
            country: d.country_name,
            isp: d.org || 'Unknown',
            org: d.org || 'Unknown',
            as: d.asn ? `AS${d.asn} ${d.org}` : 'Unknown',
          });
        }
      }
    } catch { /* fall through */ }

    // ── Provider 2: freeipapi.com (HTTPS, no key needed) ──
    try {
      const url = ip ? `https://freeipapi.com/api/json/${ip}` : 'https://freeipapi.com/api/json';
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });
      if (res.ok) {
        const d = await res.json();
        if (d.latitude) {
          return NextResponse.json({
            status: 'success',
            query: d.ipAddress || ip || 'auto',
            lat: d.latitude,
            lon: d.longitude,
            city: d.cityName || 'Unknown',
            regionName: d.regionName || 'Unknown',
            country: d.countryName || 'Unknown',
            isp: d.isp || 'Unknown',
            org: d.isp || 'Unknown',
            as: 'Unknown',
          });
        }
      }
    } catch { /* fall through */ }

    // ── Provider 3: ip-api.com (HTTP — safe here because this is server-to-server) ──
    try {
      const url = ip
        ? `http://ip-api.com/json/${ip}?fields=status,lat,lon,city,regionName,country,query,isp,org,as`
        : 'http://ip-api.com/json/?fields=status,lat,lon,city,regionName,country,query,isp,org,as';
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'success') {
          return NextResponse.json(data);
        }
      }
    } catch { /* fall through */ }

    return NextResponse.json({ error: 'All geolocation providers failed' }, { status: 502 });
  } catch (e) {
    return NextResponse.json(
      { error: 'Failed to reach geolocation service', detail: e instanceof Error ? e.message : String(e) },
      { status: 503 }
    );
  }
}
