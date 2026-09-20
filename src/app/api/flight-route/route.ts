/**
 * OASIS VISION — Flight Route API (v2)
 *
 * Resolves callsign/ICAO24 → origin + destination airports.
 * All sources queried IN PARALLEL — first valid result wins.
 *
 * Sources (raced via Promise.any):
 *   1. ADSBDB       (api.adsbdb.com)     — callsign → route
 *   2. HexDB        (hexdb.io)           — callsign → route
 *   3. airplanes.live                     — hex → detailed AC data (may include route)
 *
 * Rate-limit strategy:
 *   - stealthFetch for ADSBDB/HexDB (rotates UA + residential headers)
 *   - plain fetch for airplanes.live (no auth, generous limits)
 *   - 30-min cache for found routes, 2-min cache for misses
 *   - Per-source cooldown after 429s
 */

import { NextRequest, NextResponse } from 'next/server';
import { lookupAirport, lookupAirportAsync, type Airport } from '@/lib/airports';
import { stealthFetch } from '@/lib/stealthFetch';

export const maxDuration = 15;

// ── Cache ──────────────────────────────────────────────────────────
const routeCache = new Map<string, { data: any; ts: number }>();
const CACHE_HIT_TTL  = 30 * 60 * 1000; // 30 min for found routes
const CACHE_MISS_TTL =  2 * 60 * 1000; // 2 min for misses
const FETCH_TIMEOUT  = 4000;            // 4s per source

// Per-source rate-limit cooldown (backs off after 429)
const cooldowns: Record<string, number> = {};
const COOLDOWN_MS = 3 * 60 * 1000; // 3 min cooldown after 429

function isCooledDown(src: string): boolean {
  return (cooldowns[src] || 0) > Date.now();
}
function setCooldown(src: string) {
  cooldowns[src] = Date.now() + COOLDOWN_MS;
}

// ── Math ───────────────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function greatCirclePoints(
  lat1: number, lng1: number, lat2: number, lng2: number, n = 72
): [number, number][] {
  const toR = (d: number) => d * Math.PI / 180;
  const toD = (r: number) => r * 180 / Math.PI;
  const φ1 = toR(lat1), λ1 = toR(lng1), φ2 = toR(lat2), λ2 = toR(lng2);
  const d = 2 * Math.asin(Math.sqrt(
    Math.sin((φ2 - φ1) / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin((λ2 - λ1) / 2) ** 2
  ));
  if (d < 1e-10) return [[lng1, lat1], [lng2, lat2]];
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const A = Math.sin((1 - f) * d) / Math.sin(d);
    const B = Math.sin(f * d) / Math.sin(d);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    pts.push([toD(Math.atan2(y, x)), toD(Math.atan2(z, Math.sqrt(x * x + y * y)))]);
  }
  return pts;
}

function estimateTimes(
  oLat: number, oLng: number, dLat: number, dLng: number,
  cLat: number, cLng: number, speedKt: number | null
) {
  const total = haversineKm(oLat, oLng, dLat, dLng);
  const done  = haversineKm(oLat, oLng, cLat, cLng);
  const left  = haversineKm(cLat, cLng, dLat, dLng);
  const progress = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  const kmh = (speedKt && speedKt > 50) ? speedKt * 1.852 : 800;
  const now = Date.now();
  return {
    departureTime: new Date(now - (done / kmh) * 3600000).toISOString(),
    arrivalTime:   new Date(now + (left / kmh) * 3600000).toISOString(),
    progress,
  };
}

// ── Airport resolver (async — with dynamic fallback) ──────────────
async function resolveAirports(
  oCode: string | null | undefined,
  dCode: string | null | undefined,
  adsbO?: any, adsbD?: any,
): Promise<{ origin: Airport; destination: Airport } | null> {
  if (!oCode || !dCode) return null;
  if (oCode === dCode) return null; // Same airport = invalid route

  // Try local DB first, then async lookup
  let origin = lookupAirport(oCode) || await lookupAirportAsync(oCode);
  let dest   = lookupAirport(dCode) || await lookupAirportAsync(dCode);

  // Fallback to ADSBDB-provided coordinates if available
  if (!origin && adsbO?.latitude && adsbO?.longitude) {
    origin = {
      iata: adsbO.iata_code || '', icao: adsbO.icao_code || oCode,
      name: adsbO.name || oCode, city: adsbO.municipality || '',
      country: adsbO.country_iso_name || '',
      lat: parseFloat(adsbO.latitude), lng: parseFloat(adsbO.longitude),
    };
  }
  if (!dest && adsbD?.latitude && adsbD?.longitude) {
    dest = {
      iata: adsbD.iata_code || '', icao: adsbD.icao_code || dCode,
      name: adsbD.name || dCode, city: adsbD.municipality || '',
      country: adsbD.country_iso_name || '',
      lat: parseFloat(adsbD.latitude), lng: parseFloat(adsbD.longitude),
    };
  }

  if (!origin || !dest) return null;
  // Sanity: both airports must have valid coords
  if (!isFinite(origin.lat) || !isFinite(origin.lng) || !isFinite(dest.lat) || !isFinite(dest.lng)) return null;
  // Sanity: origin and dest shouldn't be at the exact same location
  if (origin.lat === dest.lat && origin.lng === dest.lng) return null;
  return { origin, destination: dest };
}

// ── Source 1: ADSBDB (via stealthFetch to avoid rate limits) ──────
async function fromAdsbdb(callsign: string): Promise<{ origin: Airport; destination: Airport }> {
  if (isCooledDown('adsbdb')) throw new Error('adsbdb cooled down');
  const res = await stealthFetch(
    `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
  );
  if (res.status === 429) { setCooldown('adsbdb'); throw new Error('adsbdb 429'); }
  if (!res.ok) throw new Error(`adsbdb ${res.status}`);
  const data = await res.json();
  const route = data?.response?.flightroute;
  if (!route?.origin || !route?.destination) throw new Error('adsbdb: no route');
  const pair = await resolveAirports(
    route.origin.icao_code || route.origin.iata_code,
    route.destination.icao_code || route.destination.iata_code,
    route.origin, route.destination,
  );
  if (!pair) throw new Error('adsbdb: unresolved');
  return pair;
}

// ── Source 2: HexDB (via stealthFetch) ─────────────────────────────
async function fromHexdb(callsign: string): Promise<{ origin: Airport; destination: Airport }> {
  if (isCooledDown('hexdb')) throw new Error('hexdb cooled down');
  const res = await stealthFetch(
    `https://hexdb.io/api/v1/route/callsign/${encodeURIComponent(callsign)}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT) },
  );
  if (res.status === 429) { setCooldown('hexdb'); throw new Error('hexdb 429'); }
  if (!res.ok) throw new Error(`hexdb ${res.status}`);
  const data = await res.json();
  let oCode: string | null = null, dCode: string | null = null;
  if (data.route && typeof data.route === 'string' && data.route.includes('-')) {
    const parts = data.route.split('-');
    oCode = parts[0]?.trim(); dCode = parts[parts.length - 1]?.trim();
  } else if (data.origin && data.destination) {
    oCode = data.origin; dCode = data.destination;
  }
  const pair = await resolveAirports(oCode, dCode);
  if (!pair) throw new Error('hexdb: unresolved');
  return pair;
}

// ── Source 3: airplanes.live ───────────────────────────────────────
async function fromAirplanesLive(icao24: string, callsign: string): Promise<{ origin: Airport; destination: Airport }> {
  if (!icao24 && !callsign) throw new Error('no identifier');
  const url = icao24
    ? `https://api.airplanes.live/v2/hex/${encodeURIComponent(icao24)}`
    : `https://api.airplanes.live/v2/callsign/${encodeURIComponent(callsign)}`;
  if (isCooledDown('airplaneslive')) throw new Error('airplaneslive cooled down');
  const res = await stealthFetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (res.status === 429) { setCooldown('airplaneslive'); throw new Error('airplaneslive 429'); }
  if (!res.ok) throw new Error(`airplaneslive ${res.status}`);
  const data = await res.json();
  const ac = data?.ac?.[0];
  if (!ac) throw new Error('airplaneslive: no ac');

  let oCode: string | null = null;
  let dCode: string | null = null;
  let oData: any = null;
  let dData: any = null;

  // Pattern 1: explicit origin/destination DB objects with ICAO + coords
  if (ac.oDB?.icao && ac.dDB?.icao) {
    oCode = ac.oDB.icao; dCode = ac.dDB.icao;
    // airplanes.live provides lat/lon directly in oDB/dDB
    if (ac.oDB.lat && ac.oDB.lon) {
      oData = { latitude: ac.oDB.lat, longitude: ac.oDB.lon, name: ac.oDB.name, municipality: ac.oDB.city, country_iso_name: ac.oDB.country, iata_code: ac.oDB.iata || '', icao_code: ac.oDB.icao };
    }
    if (ac.dDB.lat && ac.dDB.lon) {
      dData = { latitude: ac.dDB.lat, longitude: ac.dDB.lon, name: ac.dDB.name, municipality: ac.dDB.city, country_iso_name: ac.dDB.country, iata_code: ac.dDB.iata || '', icao_code: ac.dDB.icao };
    }
  }
  // Pattern 2: .from / .to fields
  else if (ac.from && ac.to) {
    oCode = ac.from; dCode = ac.to;
  }
  // Pattern 3: route string like "KJFK-EGLL"
  else if (ac.route && typeof ac.route === 'string' && ac.route.includes('-')) {
    const parts = ac.route.split('-');
    oCode = parts[0]?.trim(); dCode = parts[parts.length - 1]?.trim();
  }

  const pair = await resolveAirports(oCode, dCode, oData, dData);
  if (!pair) throw new Error('airplaneslive: unresolved');
  return pair;
}

// ── Handler ────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const callsign  = (sp.get('callsign') || '').trim().toUpperCase();
  const icao24    = (sp.get('icao24')   || '').trim().toLowerCase();
  const currentLat = parseFloat(sp.get('lat') || '0');
  const currentLng = parseFloat(sp.get('lng') || '0');
  const speedKt    = parseFloat(sp.get('speed') || '0') || null;

  if (!callsign) {
    return NextResponse.json({ error: 'callsign required' }, { status: 400 });
  }

  // ── Cache ──
  const cacheKey = callsign;
  const cached = routeCache.get(cacheKey);
  if (cached) {
    const ttl = cached.data.found ? CACHE_HIT_TTL : CACHE_MISS_TTL;
    if (Date.now() - cached.ts < ttl) {
      const out = { ...cached.data };
      if (out.found && currentLat && currentLng) {
        Object.assign(out, estimateTimes(
          out.origin.lat, out.origin.lng, out.destination.lat, out.destination.lng,
          currentLat, currentLng, speedKt,
        ));
      }
      return NextResponse.json(out, {
        headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' },
      });
    }
  }

  // ── Parallel race — first valid result wins ──
  let route: { origin: Airport; destination: Airport } | null = null;
  let source = '';

  try {
    const result = await Promise.any([
      fromAdsbdb(callsign).then(r => ({ ...r, _s: 'adsbdb' as const })),
      fromHexdb(callsign).then(r => ({ ...r, _s: 'hexdb' as const })),
      fromAirplanesLive(icao24, callsign).then(r => ({ ...r, _s: 'airplaneslive' as const })),
    ]);
    route = { origin: result.origin, destination: result.destination };
    source = result._s;
  } catch {
    // All sources failed
  }

  // ── Route plausibility check ──
  if (route && currentLat && currentLng) {
    const { origin, destination } = route;
    const routeDist = haversineKm(origin.lat, origin.lng, destination.lat, destination.lng);
    // Reject implausibly short routes (probably bad data)
    if (routeDist < 30) {
      route = null;
    } else {
      // Check plane is roughly between origin and destination (within 1.5x route distance from either end)
      const distToOrigin = haversineKm(currentLat, currentLng, origin.lat, origin.lng);
      const distToDest = haversineKm(currentLat, currentLng, destination.lat, destination.lng);
      const maxReasonable = routeDist * 1.5;
      if (distToOrigin > maxReasonable && distToDest > maxReasonable) {
        // Plane is far from both endpoints — likely wrong route
        console.warn(`[OASIS] Route ${callsign} ${origin.icao}→${destination.icao} rejected: plane ${Math.round(distToOrigin)}km from origin, ${Math.round(distToDest)}km from dest, route only ${Math.round(routeDist)}km`);
        route = null;
      }
    }
  }

  if (!route) {
    const miss = { found: false, callsign, icao24 };
    routeCache.set(cacheKey, { data: miss, ts: Date.now() });
    return NextResponse.json(miss, {
      headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120' },
    });
  }

  const { origin, destination } = route;
  const arc = greatCirclePoints(origin.lat, origin.lng, destination.lat, destination.lng, 72);
  const totalDistanceKm = Math.round(haversineKm(origin.lat, origin.lng, destination.lat, destination.lng));
  const times = (currentLat && currentLng)
    ? estimateTimes(origin.lat, origin.lng, destination.lat, destination.lng, currentLat, currentLng, speedKt)
    : { departureTime: null, arrivalTime: null, progress: 0 };

  const out = {
    found: true, callsign, icao24, source,
    origin:      { iata: origin.iata, icao: origin.icao, name: origin.name, city: origin.city, country: origin.country, lat: origin.lat, lng: origin.lng },
    destination: { iata: destination.iata, icao: destination.icao, name: destination.name, city: destination.city, country: destination.country, lat: destination.lat, lng: destination.lng },
    arc, totalDistanceKm, ...times,
  };

  routeCache.set(cacheKey, { data: { ...out, departureTime: null, arrivalTime: null, progress: 0 }, ts: Date.now() });

  // Evict stale entries
  if (routeCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of routeCache) {
      if (now - v.ts > CACHE_HIT_TTL * 2) routeCache.delete(k);
    }
  }

  return NextResponse.json(out, {
    headers: { 'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=300' },
  });
}
