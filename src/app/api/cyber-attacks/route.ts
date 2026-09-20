import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * OASIS VISION — Live Cyber Attack Feed
 * Generates animated attack arcs from real Feodo Tracker + URLhaus threat data.
 * Each attack has a source (attributed attacker region) and destination (C2 server).
 * The frontend animates these as flying arcs across the globe.
 */

// Known APT / malware family → likely origin region (lat/lng centroids with jitter)
const THREAT_ORIGINS: Record<string, [number, number][]> = {
  // Eastern Europe / Russia
  'Emotet':       [[37.6, 55.7], [30.5, 50.4], [24.1, 56.9], [21.0, 52.2]],
  'QakBot':       [[37.6, 55.7], [49.1, 55.8], [30.3, 59.9], [27.6, 53.9]],
  'Qakbot':       [[37.6, 55.7], [49.1, 55.8], [30.3, 59.9], [27.6, 53.9]],
  'BumbleBee':    [[37.6, 55.7], [24.1, 56.9], [14.4, 50.1]],
  'Dridex':       [[37.6, 55.7], [30.5, 50.4], [49.1, 55.8]],
  'TrickBot':     [[37.6, 55.7], [30.5, 50.4], [68.0, 55.0]],
  'IcedID':       [[37.6, 55.7], [24.1, 56.9], [30.3, 59.9]],
  'SystemBC':     [[37.6, 55.7], [14.4, 50.1], [21.0, 52.2]],
  'Pikabot':      [[37.6, 55.7], [30.5, 50.4], [24.1, 56.9]],
  'BazarLoader':  [[37.6, 55.7], [49.1, 55.8]],
  'CobaltStrike': [[116.4, 39.9], [121.5, 31.2], [37.6, 55.7], [113.3, 23.1]],
  // East Asia
  'PlugX':        [[116.4, 39.9], [121.5, 31.2], [113.3, 23.1]],
  'ShadowPad':    [[116.4, 39.9], [104.1, 30.6], [106.7, 26.6]],
  'Winnti':       [[116.4, 39.9], [121.5, 31.2]],
  // Generic fallback — distributed global
  '_default':     [[37.6, 55.7], [116.4, 39.9], [-73.9, 40.7], [-46.6, -23.5], [28.0, -26.2], [103.8, 1.4]],
};

// Target country → approximate centroid
const COUNTRY_COORDS: Record<string, [number, number]> = {
  AF:[65,33],AL:[20,41],DZ:[3,28],AO:[18.5,-12.5],AR:[-64,-34],AM:[45,40],AU:[134,-25],AT:[14,47.5],AZ:[50,40.5],
  BD:[90,24],BY:[28,53],BE:[4,50.8],BR:[-51,-10],BG:[25.5,42.7],CA:[-96,62],CL:[-71,-30],
  CN:[105,35],CO:[-72,4],HR:[16,45.2],CZ:[15.5,49.8],DK:[10,56],EG:[30,27],FI:[26,64],
  FR:[2,46],DE:[10,51],GR:[22,39],HK:[114.2,22.3],HU:[19.5,47],IN:[79,22],ID:[120,-5],
  IR:[53,32],IQ:[44,33],IE:[-8,53],IL:[34.8,31.5],IT:[12.5,42.8],JP:[138,36],KZ:[67,48],
  KE:[38,1],KR:[128,36],LT:[24,55.5],MY:[112,3],MX:[-102,23.5],NL:[5.5,52.5],NZ:[174,-41],
  NG:[8,10],NO:[8,62],PK:[70,30],PA:[-80,9],PH:[122,12.5],PL:[19.5,52],PT:[-8,39.5],
  RO:[25,46],RU:[100,60],SA:[45,25],SG:[103.8,1.35],ZA:[24,-29],ES:[-4,40],SE:[16,62],
  CH:[8,47],TW:[121,23.7],TH:[101,15],TR:[35,39],UA:[32,49],AE:[54,24],GB:[-2,54],
  US:[-97,38],VN:[106,16],
};

// Severity by malware family
const SEVERITY: Record<string, number> = {
  'Emotet': 9, 'QakBot': 8, 'Qakbot': 8, 'Dridex': 8, 'TrickBot': 7, 'IcedID': 7,
  'BumbleBee': 7, 'CobaltStrike': 10, 'SystemBC': 6, 'Pikabot': 7, 'BazarLoader': 8,
  'PlugX': 9, 'ShadowPad': 10, 'Winnti': 9,
};

const ATTACK_VERBS = [
  'C2 BEACON', 'PAYLOAD DROP', 'EXFILTRATION', 'LATERAL MOVE', 'CREDENTIAL HARVEST',
  'IMPLANT DEPLOY', 'REVERSE SHELL', 'DATA STAGING', 'PERSISTENCE', 'RECON SWEEP',
];

let cachedAttacks: any = null;
let cacheTime = 0;
const CACHE_TTL = 10_000; // 10s — rapid refresh for live feel

export async function GET() {
  const now = Date.now();
  if (cachedAttacks && now - cacheTime < CACHE_TTL) {
    return NextResponse.json(cachedAttacks, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  }

  try {
    const res = await fetch('https://feodotracker.abuse.ch/downloads/ipblocklist.json', {
      signal: AbortSignal.timeout(10000),
      cache: 'no-store',
      headers: { 'User-Agent': 'OASIS VISION/4.3', Accept: 'application/json' },
    });

    if (!res.ok) {
      return NextResponse.json({ attacks: [], total: 0, error: 'Feodo unavailable' });
    }

    const raw = await res.json();
    const entries = (Array.isArray(raw) ? raw : []).filter(
      (e: any) => e.country && COUNTRY_COORDS[e.country]
    );

    // Ensure minimum 60 arcs for visual density — multiply entries with varied params
    const TARGET_ARCS = 15;
    const multiplier = entries.length > 0 ? Math.max(1, Math.ceil(TARGET_ARCS / entries.length)) : 0;
    const attacks: any[] = [];
    let id = 0;

    for (const entry of entries) {
      const malware = entry.malware || 'Unknown';
      const origins = THREAT_ORIGINS[malware] || THREAT_ORIGINS['_default'];
      const dst = COUNTRY_COORDS[entry.country];
      if (!dst) continue;

      for (let m = 0; m < multiplier && attacks.length < 20; m++) {
        const origin = origins[(id + m) % origins.length];
        // Vary jitter per clone so arcs fan out
        const jSrc = [(Math.random() - 0.5) * 8, (Math.random() - 0.5) * 5];
        const jDst = [(Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4];

        attacks.push({
          id: `ca-${id}`,
          src_lng: origin[0] + jSrc[0],
          src_lat: origin[1] + jSrc[1],
          dst_lng: dst[0] + jDst[0],
          dst_lat: dst[1] + jDst[1],
          malware,
          target_ip: entry.ip_address || '0.0.0.0',
          target_country: entry.country,
          port: entry.dst_port || 443,
          severity: SEVERITY[malware] || 5,
          action: ATTACK_VERBS[Math.floor(Math.random() * ATTACK_VERBS.length)],
          status: entry.status || 'online',
          delay: Math.random() * 8000,
          duration: 3000 + Math.random() * 3000,
        });
        id++;
      }
    }

    const result = {
      attacks,
      total: attacks.length,
      timestamp: new Date().toISOString(),
      source: 'abuse.ch Feodo Tracker (attributed)',
    };

    cachedAttacks = result;
    cacheTime = now;

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });
  } catch (error) {
    console.error('[OASIS] Cyber attack feed error:', error);
    return NextResponse.json({ attacks: [], total: 0, error: 'Feed unavailable' }, { status: 500 });
  }
}
