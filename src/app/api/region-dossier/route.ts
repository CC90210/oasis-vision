import { NextResponse } from 'next/server';

/**
 * OASIS VISION — Area assessment for any coordinate.
 *
 * WHAT WAS WRONG (measured 2026-09-04)
 * This endpoint asked Nominatim to reverse-geocode at `zoom=5`, which is
 * country/state granularity. Clicking the Montréal Biosphère returned:
 *
 *   zoom=5   ->  "Québec, Canada"                    city: ""
 *   zoom=18  ->  "Espace 67, Ville-Marie, Montréal, ... H3C 4G8, Canada"
 *
 * Everything downstream then described the COUNTRY — Canada's population, its
 * capital, its head of state — no matter how precisely the operator clicked.
 * The Wikipedia lookup used `city || countryName`, and since `city` was always
 * empty at zoom 5, it always fetched the article for the country. That is the
 * whole of "I tried to assess a very particular area and it doesn't know that
 * spot": the request never asked for the spot.
 *
 * WHAT IT DOES NOW
 * Five sources, each answering a question an operator would actually ask, all
 * of them real measurements or real records rather than generated prose:
 *
 *   1. Where am I          Nominatim reverse @ zoom 18 — street, block, postcode
 *   2. What is written     Wikipedia geosearch — articles ABOUT this coordinate,
 *                          ranked by distance, instead of guessing a title
 *   3. What is here        Overpass — emergency services, power, transport,
 *                          government and named landmarks within the radius
 *   4. Conditions          Open-Meteo — observed temperature, wind, visibility
 *   5. Background          Wikidata — the country facts, kept as context
 *
 * Every source fails soft and says so in `degraded`, because a silent empty
 * section reads on screen as "nothing here", which is the opposite of unknown.
 */

export const maxDuration = 45;

const UA = { 'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)' };

/** Metres around the point that "here" means. Kept modest: Overpass is shared. */
const DEFAULT_RADIUS = 1200;
const MAX_RADIUS = 5000;

export interface PlaceIdentity {
  name: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
  country_code?: string;
  display_name?: string;
}

/**
 * Build the most specific human name Nominatim's address block supports,
 * falling back level by level. A point in open water or desert has none of the
 * fine levels, and naming it after the country would be a false precision — so
 * this returns the finest level that actually exists and nothing more.
 */
/**
 * Can an English text-to-speech voice actually read this?
 *
 * `accept-language=en` translates Nominatim's ADDRESS block but not the feature
 * name: at a shelter in Bulgaria the address came back "Dolno Izvorovo,
 * Kazanlak, Stara Zagora, Bulgaria" while the name stayed
 * "Заслон на маркировачите", and namedetails offered no English alternative
 * because none exists. Handing that to an English voice produces noise, so a
 * name in another script is skipped in favour of the address chain, which IS
 * English and IS speakable. The untranslated name is still in display_name.
 */
export function isSpeakableInEnglish(s: string): boolean {
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (!letters) return true;
  const latin = letters.replace(/[^\p{Script=Latin}]/gu, '').length;
  return latin / letters.length >= 0.7;
}

export function describePlace(addr: Record<string, string>, rawName?: string): string {
  // A name in another script is not a name this read-out can use.
  const fallbackName = rawName && isSpeakableInEnglish(rawName) ? rawName : undefined;
  const road = addr.road || addr.pedestrian || addr.footway;
  // Administrative districts carry no meaning for an operator: at Times Square
  // Nominatim's suburb is "Manhattan Community Board 5", which is true and
  // useless. Skipped in favour of the next level that names a real place.
  const area = [addr.neighbourhood, addr.quarter, addr.suburb, addr.city_district, addr.hamlet]
    .find((v) => v && !/community board|electoral|\bward\b|census|precinct \d/i.test(v));
  const settlement = addr.city || addr.town || addr.village || addr.municipality;

  // Two levels can carry the same string — at Times Square, Nominatim returns
  // name "7th Avenue" AND road "7th Avenue", which naively joined reads
  // "7th Avenue, 7th Avenue". Deduplicate case-insensitively before joining.
  const seen = new Set<string>();
  const unique = ([fallbackName, road, area, settlement].filter(Boolean) as string[]).filter((p) => {
    // Same script rule as the name: accept-language covers most address levels,
    // but not every one in every country.
    if (!isSpeakableInEnglish(p)) return false;
    const k = p.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Two levels is the readable limit for a headline; the full chain is already
  // available in display_name for anyone who wants it.
  if (unique.length) return unique.slice(0, 2).join(', ');
  return addr.county || addr.state || addr.country || 'Unnamed location';
}

/* ───────────────────────── Overpass: what is physically here ──────────────── */

/**
 * The categories worth calling out on a reconnaissance read-out, each mapped to
 * the OSM tags that actually carry them. Anything not in this list is reported
 * only if it has a name, under `landmarks`.
 */
const INFRA_SELECTORS: string[] = [
  '["amenity"~"^(police|fire_station|hospital)$"]',
  '["amenity"~"^(clinic|doctors|pharmacy)$"]',
  '["aeroway"="aerodrome"]',
  '["railway"="station"]',
  '["amenity"="bus_station"]',
  '["public_transport"="station"]',
  '["power"~"^(plant|substation)$"]',
  '["office"~"^(government|diplomatic)$"]',
  '["amenity"~"^(townhall|courthouse|embassy)$"]',
  '["landuse"="military"]',
  '["military"]',
  '["amenity"~"^(school|university|college)$"]',
  // Named landmarks carry the "what is that building" answer.
  '["name"]["tourism"]',
  '["name"]["historic"]',
];

export interface InfraItem { category: string; name: string; kind: string; lat: number; lng: number }

interface OverpassElement {
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
}

export function buildOverpass(lat: number, lng: number, radius: number): string {
  const parts = INFRA_SELECTORS.map((sel) => `nwr${sel}(around:${radius},${lat},${lng});`);
  return `[out:json][timeout:25];(${parts.join('')});out center tags 120;`;
}

/** Which of our categories an OSM element belongs to, or null for a landmark. */
export function categorize(tags: Record<string, string>): { category: string; kind: string } | null {
  const a = tags.amenity, r = tags.railway, p = tags.power, o = tags.office;
  if (a === 'police' || a === 'fire_station' || a === 'hospital') return { category: 'emergency', kind: a };
  if (a === 'clinic' || a === 'doctors' || a === 'pharmacy') return { category: 'medical', kind: a };
  if (tags.aeroway === 'aerodrome') return { category: 'transport', kind: 'airport' };
  if (r === 'station' || a === 'bus_station' || tags.public_transport === 'station')
    return { category: 'transport', kind: r === 'station' ? 'rail station' : 'transit station' };
  if (p === 'plant' || p === 'substation') return { category: 'power', kind: p };
  if (o === 'government' || a === 'townhall' || a === 'courthouse') return { category: 'government', kind: o || a };
  if (a === 'embassy' || o === 'diplomatic') return { category: 'government', kind: 'diplomatic mission' };
  if (tags.military || tags.landuse === 'military') return { category: 'security', kind: tags.military || 'military land' };
  if (a === 'school' || a === 'university' || a === 'college') return { category: 'education', kind: a };
  if (tags.tourism || tags.historic) return { category: 'landmark', kind: tags.tourism || tags.historic };
  return null;
}

/**
 * Overpass mirrors, tried in order. The main instance rate-limits hard: three
 * assessments in quick succession earned an HTTP 429 during testing, which is
 * exactly the pattern an operator sweeping an area produces. These mirrors run
 * the same software over the same planet data, so the fallback is a different
 * host, not a different answer.
 */
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

async function fetchInfrastructure(lat: number, lng: number, radius: number) {
  const query = 'data=' + encodeURIComponent(buildOverpass(lat, lng, radius));

  let body: { elements?: Record<string, never>[] } | null = null;
  let lastError = 'no mirror attempted';
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        body: query,
        headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        // 12s each, so three mirrors plus the reverse geocode still fit inside
        // this route's 45s budget. At 20s each a point over open ocean — where
        // every mirror runs the query to completion and returns nothing —
        // exceeded maxDuration and the whole assessment was killed.
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) { lastError = `HTTP ${res.status}`; continue; }
      body = await res.json();
      break;
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'failed';
    }
  }
  // Every mirror failing is reported, never swallowed: an empty result and an
  // unreachable service look identical on screen and mean opposite things.
  if (!body) throw new Error(`Overpass unavailable (${lastError})`);

  const items: InfraItem[] = [];
  const seen = new Set<string>();
  for (const el of (body.elements || []) as unknown as OverpassElement[]) {
    const tags = el.tags || {};
    const c = categorize(tags);
    if (!c) continue;
    const name = tags.name || tags['name:en'] || tags.operator || '';
    // An unnamed pharmacy still counts toward the medical tally, but an unnamed
    // landmark is noise — a bench tagged historic tells an operator nothing.
    if (!name && c.category === 'landmark') continue;
    const key = `${c.category}|${name || c.kind}|${(el.lat ?? el.center?.lat ?? 0).toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      category: c.category,
      kind: c.kind,
      name: name || `Unnamed ${c.kind}`,
      lat: el.lat ?? el.center?.lat ?? lat,
      lng: el.lon ?? el.center?.lon ?? lng,
    });
  }
  return items;
}

/* ───────────────────────── Open-Meteo: observed conditions ────────────────── */

export interface Conditions {
  tempC: number | null;
  feelsC: number | null;
  windKph: number | null;
  gustKph: number | null;
  windDir: number | null;
  visibilityM: number | null;
  cloudPct: number | null;
  precipMm: number | null;
  isDay: boolean | null;
  observedAt: string | null;
}

async function fetchConditions(lat: number, lng: number): Promise<Conditions> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    '&current=temperature_2m,apparent_temperature,precipitation,cloud_cover,' +
    'wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day&hourly=visibility' +
    '&forecast_days=1&wind_speed_unit=kmh&timezone=auto';
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
  const b = await res.json();
  const c = b.current || {};

  // Visibility is hourly-only; take the reading for the current hour.
  let visibilityM: number | null = null;
  const times: string[] = b.hourly?.time || [];
  const vis: number[] = b.hourly?.visibility || [];
  if (times.length && vis.length) {
    const i = times.indexOf((c.time || '').slice(0, 13) + ':00');
    visibilityM = i >= 0 ? vis[i] ?? null : vis[0] ?? null;
  }

  return {
    tempC: c.temperature_2m ?? null,
    feelsC: c.apparent_temperature ?? null,
    windKph: c.wind_speed_10m ?? null,
    gustKph: c.wind_gusts_10m ?? null,
    windDir: c.wind_direction_10m ?? null,
    visibilityM,
    cloudPct: c.cloud_cover ?? null,
    precipMm: c.precipitation ?? null,
    isDay: c.is_day === undefined ? null : c.is_day === 1,
    observedAt: c.time ?? null,
  };
}

/* ───────────────────────── Wikipedia: articles about THIS point ───────────── */

/**
 * Titles that read as an incident rather than a place. Wikipedia's geosearch
 * ranks purely by distance, and at Times Square the nearest article is
 * "2017 Times Square car attack" — 6 metres away and a perfectly real record,
 * but the wrong thing to open an area assessment with. Incidents stay in the
 * nearby list where an operator can see them; they just do not lead.
 */
const INCIDENT = /^\d{4}\b|\b(attack|bombing|shooting|massacre|crash|derailment|disaster|riot|protest|explosion|hijack|siege|murder|robbery)\b/i;

/**
 * Rank articles for "what is this place": a title the reverse geocode already
 * named wins, then non-incident articles by distance, then everything else.
 */
export function rankArticles<T extends { title: string; distanceM: number }>(
  articles: T[],
  placeText: string,
): T[] {
  const hay = placeText.toLowerCase();
  const score = (a: T) => {
    // Incident FIRST. An incident article usually contains the place name —
    // "2017 Times Square car attack" contains "Times Square" — so testing the
    // name match first scored the attack as the best description of the place.
    if (INCIDENT.test(a.title)) return 2;
    const t = a.title.toLowerCase();
    const named = hay.includes(t) || t.includes(hay.split(',')[0].trim());
    return named ? 0 : 1;
  };
  return [...articles].sort((a, b) => score(a) - score(b) || a.distanceM - b.distanceM);
}

async function fetchNearbyArticles(lat: number, lng: number, radius: number) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&list=geosearch' +
    `&gscoord=${lat}%7C${lng}&gsradius=${Math.min(Math.max(radius, 500), 10000)}` +
    // 20, not 6. Geosearch returns strictly the NEAREST articles, and rankArticles
    // can only reorder what it is handed: at Times Square the six nearest were a
    // theatre, a photograph and a mural, so the article "Times Square" itself was
    // cut before ranking ever saw it. Fetch a wide set, rank, then show five.
    '&gslimit=20&format=json&origin=*';
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Wikipedia geosearch HTTP ${res.status}`);
  const b = await res.json();
  return (b.query?.geosearch || []).map((g: Record<string, number | string>) => ({
    title: String(g.title),
    distanceM: Math.round(Number(g.dist)),
  }));
}

async function fetchSummary(title: string) {
  const res = await fetch(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    { headers: UA, signal: AbortSignal.timeout(6000) },
  );
  if (!res.ok) throw new Error(`Wikipedia summary HTTP ${res.status}`);
  const w = await res.json();
  return { title: w.title, extract: w.extract?.slice(0, 700), thumbnail: w.thumbnail?.source };
}

/* ───────────────────────── Wikidata: country background ───────────────────── */

async function fetchCountry(countryName: string) {
  const safe = countryName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const sparql = `SELECT ?population ?areaVal ?capitalLabel ?regionLabel ?flagUrl
    (GROUP_CONCAT(DISTINCT ?langLabel; separator=", ") AS ?languages)
    (GROUP_CONCAT(DISTINCT ?currLabel; separator=", ") AS ?currencies) WHERE {
      ?country wdt:P31/wdt:P279* wd:Q6256; rdfs:label "${safe}"@en.
      OPTIONAL { ?country wdt:P1082 ?population. }
      OPTIONAL { ?country wdt:P2046 ?areaVal. }
      OPTIONAL { ?country wdt:P36 ?capital. }
      OPTIONAL { ?country wdt:P30 ?region. }
      OPTIONAL { ?country wdt:P37 ?lang. }
      OPTIONAL { ?country wdt:P38 ?curr. }
      OPTIONAL { ?country wdt:P41 ?flagUrl. }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "en".
        ?capital rdfs:label ?capitalLabel. ?region rdfs:label ?regionLabel.
        ?lang rdfs:label ?langLabel. ?curr rdfs:label ?currLabel. }
    } GROUP BY ?population ?areaVal ?capitalLabel ?regionLabel ?flagUrl LIMIT 1`;

  const res = await fetch(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, {
    headers: { ...UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  const wd = await res.json();
  const b = wd.results?.bindings?.[0];
  if (!b) return null;
  return {
    name: countryName,
    capital: b.capitalLabel?.value,
    population: b.population?.value ? parseInt(b.population.value, 10) : undefined,
    area: b.areaVal?.value ? parseFloat(b.areaVal.value) : undefined,
    region: b.regionLabel?.value,
    languages: b.languages?.value ? b.languages.value.split(', ') : [],
    currencies: b.currencies?.value ? b.currencies.value.split(', ') : [],
    flag_url: b.flagUrl?.value,
  };
}

/* ───────────────────────────────── Handler ────────────────────────────────── */

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const lat = parseFloat(searchParams.get('lat') || '');
  const lng = parseFloat(searchParams.get('lng') || '');
  const radius = Math.min(
    Math.max(parseInt(searchParams.get('radius') || '', 10) || DEFAULT_RADIUS, 200),
    MAX_RADIUS,
  );

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return NextResponse.json({ error: 'lat and lng are required' }, { status: 400 });
  }

  /** Sources that failed, named, so the UI can say "unknown" not "none". */
  const degraded: string[] = [];

  try {
    // zoom=18 is the whole fix for "it doesn't know that spot" — see the header.
    let place: PlaceIdentity = { name: 'Unknown location' };
    try {
      const res = await fetch(
        // accept-language=en matters more than it looks. Without it Nominatim
        // answers in the local language, so a point in Bulgaria came back as
        // "Заслон на маркировачите ... България" — correct, and then handed
        // verbatim to an English text-to-speech voice, which mangles it. The
        // interface language is English; the read-out has to be too.
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=18&addressdetails=1&accept-language=en`,
        { headers: UA, signal: AbortSignal.timeout(9000) },
      );
      if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
      const g = await res.json();
      const addr = g.address || {};
      place = {
        name: describePlace(addr, g.name || undefined),
        road: addr.road,
        neighbourhood: addr.neighbourhood || addr.quarter,
        suburb: addr.suburb || addr.city_district,
        city: addr.city || addr.town || addr.village || addr.municipality,
        county: addr.county,
        state: addr.state || addr.region,
        postcode: addr.postcode,
        country: addr.country,
        country_code: addr.country_code?.toUpperCase(),
        display_name: g.display_name,
      };
    } catch (e) {
      degraded.push(`place (${e instanceof Error ? e.message : 'failed'})`);
    }

    const [infraR, condR, nearbyR, countryR] = await Promise.allSettled([
      fetchInfrastructure(lat, lng, radius),
      fetchConditions(lat, lng),
      fetchNearbyArticles(lat, lng, radius),
      place.country ? fetchCountry(place.country) : Promise.resolve(null),
    ]);

    if (infraR.status === 'rejected') degraded.push(`infrastructure (${infraR.reason?.message || 'failed'})`);
    if (condR.status === 'rejected') degraded.push(`conditions (${condR.reason?.message || 'failed'})`);
    if (nearbyR.status === 'rejected') degraded.push(`nearby articles (${nearbyR.reason?.message || 'failed'})`);
    if (countryR.status === 'rejected') degraded.push(`country (${countryR.reason?.message || 'failed'})`);

    const infrastructure = infraR.status === 'fulfilled' ? infraR.value : null;
    // Ranked so the assessment opens with the PLACE. Distance alone put
    // "2017 Times Square car attack" first at Times Square — a real record, but
    // the wrong lead for "what is this area"; it stays in the list below.
    // display_name is in the haystack deliberately. At Times Square the headline
    // name resolves to "7th Avenue, Manhattan" — the string "Times Square" only
    // appears in the full chain, so without it the ranker had no way to know the
    // article named after the place WAS the place, and led with a theatre 14 m
    // closer.
    const nearby = rankArticles(
      nearbyR.status === 'fulfilled' ? nearbyR.value : [],
      [place.name, place.suburb, place.city, place.display_name].filter(Boolean).join(', '),
    );

    // The brief describes the nearest thing Wikipedia actually has an article
    // about — not the country, which is what the old code always fell back to.
    let wikipedia = null;
    if (nearby.length) {
      try {
        wikipedia = await fetchSummary(nearby[0].title);
      } catch (e) {
        degraded.push(`brief (${e instanceof Error ? e.message : 'failed'})`);
      }
    }

    const counts: Record<string, number> = {};
    for (const it of infrastructure || []) counts[it.category] = (counts[it.category] || 0) + 1;

    return NextResponse.json(
      {
        coordinates: { lat, lng },
        radius,
        place,
        conditions: condR.status === 'fulfilled' ? condR.value : null,
        infrastructure: infrastructure
          ? { counts, items: infrastructure.slice(0, 60), total: infrastructure.length }
          : null,
        nearby,
        wikipedia,
        country: countryR.status === 'fulfilled' ? countryR.value : null,
        degraded,
        timestamp: new Date().toISOString(),
      },
      { headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600' } },
    );
  } catch (error) {
    console.error('[OASIS] Area assessment error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Area assessment failed' },
      { status: 500 },
    );
  }
}
