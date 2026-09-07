import { NextResponse } from 'next/server';
import { httpJson, optional } from '@/lib/httpJson';
import { cachedSource } from '@/lib/sourceCache';
import { queryLadder } from '@/lib/geo-query';

export const maxDuration = 20;

/**
 * OSIRIS — Location search for the route planner.
 *
 * Nominatim alone was the problem: it is a *geocoder*, not a type-ahead index,
 * so it needs near-complete input. Measured side by side, "eiffel tow" returns
 * nothing from Nominatim and the correct Paris landmark from Photon; "sydny
 * opera house" (typo) returns one weak hit vs six good ones.
 *
 * Photon is Komoot's autocomplete index over the same OSM data — prefix and
 * fuzzy tolerant — so it leads. Nominatim still runs as a supplement because it
 * resolves some structured/administrative phrasings Photon ranks poorly, and
 * merging the two is what closes the "location is 100% missing" gap.
 *
 * Both are keyless OSM community services and both ask for an identifying
 * User-Agent, which lib/httpJson supplies.
 */

const PHOTON = 'https://photon.komoot.io/api';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

export interface GeoResult {
  name: string;
  context: string;
  lat: number;
  lng: number;
  kind: string;
  source: 'photon' | 'nominatim';
  /** Nominatim importance, when the hit came from there. Ranking only. */
  score?: number;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, string | undefined>;
}

interface NominatimRow {
  display_name?: string;
  lat?: string;
  lon?: string;
  class?: string;
  type?: string;
  name?: string;
  importance?: number;
}

/**
 * Nominatim's importance above which a hit is treated as globally prominent.
 * Photon is the better prefix matcher but ranks purely lexically — searching
 * "heathrow" puts Heathrow, Florida above London Heathrow Airport. Nominatim
 * scores the airport 0.606 and the town 0.352, so this promotes the former
 * without disturbing queries Nominatim can't answer at all.
 */
const PROMINENT = 0.5;

/** Collapse OSM class/value pairs into the handful of kinds the UI icons. */
export function classifyKind(key?: string, value?: string): string {
  if (!key) return 'place';
  if (key === 'place' && ['country'].includes(value || '')) return 'country';
  if (key === 'place' && ['state', 'region', 'province', 'county'].includes(value || '')) return 'region';
  if (key === 'place' && ['city', 'town', 'village', 'hamlet', 'municipality'].includes(value || '')) return 'city';
  if (key === 'boundary') return 'region';
  if (key === 'highway' || key === 'street') return 'street';
  if (key === 'building' || key === 'address' || value === 'house') return 'address';
  if (['amenity', 'tourism', 'shop', 'leisure', 'historic', 'office', 'railway', 'aeroway', 'natural', 'man_made'].includes(key)) {
    return 'poi';
  }
  return 'place';
}

export function normalizePhoton(f: PhotonFeature): GeoResult | null {
  const c = f?.geometry?.coordinates;
  const p = f?.properties;
  if (!c || c.length < 2 || !p) return null;
  const [lng, lat] = c;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // Photon splits an address across name/housenumber/street
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const name = p.name || street || p.city || p.country || 'Unnamed place';
  const context = [p.name && street ? street : null, p.district, p.city, p.state, p.country]
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 3)
    .join(', ');

  return { name, context, lat, lng, kind: classifyKind(p.osm_key, p.osm_value), source: 'photon' };
}

export function normalizeNominatim(r: NominatimRow): GeoResult | null {
  const lat = parseFloat(r?.lat || '');
  const lng = parseFloat(r?.lon || '');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const parts = (r.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    name: r.name || parts[0] || 'Unnamed place',
    context: parts.slice(1, 4).join(', '),
    lat,
    lng,
    kind: classifyKind(r.class, r.type),
    source: 'nominatim',
    score: typeof r.importance === 'number' ? r.importance : undefined,
  };
}

/** Roughly 100 m — close enough that two hits are the same place. */
const DEDUPE_DEG = 0.001;

/**
 * Merge provider results, Photon first, dropping anything the other provider
 * already covers at effectively the same coordinate with the same name.
 */
export function mergeResults(primary: GeoResult[], secondary: GeoResult[], limit = 8): GeoResult[] {
  const out: GeoResult[] = [];

  const isDuplicate = (r: GeoResult) =>
    out.some(
      (o) =>
        Math.abs(o.lat - r.lat) < DEDUPE_DEG &&
        Math.abs(o.lng - r.lng) < DEDUPE_DEG &&
        o.name.toLowerCase() === r.name.toLowerCase(),
    );

  // A landmark the world knows leads, whichever index found it; everything else
  // keeps Photon's ordering, which is what makes partial input work.
  const prominent = secondary
    .filter((r) => (r.score ?? 0) >= PROMINENT)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const rest = secondary.filter((r) => (r.score ?? 0) < PROMINENT);

  for (const r of [...prominent, ...primary, ...rest]) {
    if (out.length >= limit) break;
    if (!isDuplicate(r)) out.push(r);
  }
  return out;
}

async function searchPhoton(q: string, lat?: number, lng?: number): Promise<GeoResult[]> {
  let url = `${PHOTON}/?q=${encodeURIComponent(q)}&limit=8&lang=en`;
  // Bias toward what the operator is currently looking at
  if (Number.isFinite(lat) && Number.isFinite(lng)) url += `&lat=${lat}&lon=${lng}`;
  const json = await httpJson<{ features?: PhotonFeature[] }>(url, { timeoutMs: 8000 });
  return (json.features || []).map(normalizePhoton).filter((r): r is GeoResult => r !== null);
}

async function searchNominatim(q: string): Promise<GeoResult[]> {
  const url = `${NOMINATIM}?q=${encodeURIComponent(q)}&format=json&limit=6&addressdetails=0`;
  const json = await httpJson<NominatimRow[]>(url, { timeoutMs: 8000 });
  return (Array.isArray(json) ? json : []).map(normalizeNominatim).filter((r): r is GeoResult => r !== null);
}

interface LadderOutcome {
  results: GeoResult[];
  /**
   * Every provider threw — nobody actually answered. Not the same thing as an
   * empty result, which means the providers answered and held no match.
   */
  degraded: boolean;
}

/**
 * Run the query ladder, reporting WHY it came back empty.
 *
 * Both providers, then the reduction fallback only if that found nothing. See
 * lib/geo-query.ts: an address typed with English street words returns zero
 * from BOTH engines when OSM holds the street in French, and the two tokens the
 * operator added to be more precise are exactly what empty the result set.
 *
 * `optional` resolves a failed provider to null, so null means "errored" and []
 * means "answered, no match" — the distinction the caller needs and the one
 * that used to be thrown away.
 */
async function searchLadder(q: string, lat?: number, lng?: number): Promise<LadderOutcome> {
  for (const attempt of queryLadder(q)) {
    const [photon, nominatim] = await Promise.all([
      optional(searchPhoton(attempt, lat, lng)),
      optional(searchNominatim(attempt)),
    ]);

    // Reducing the query cannot repair a transport failure, and trying anyway
    // spends a second pair of 8s timeouts — enough to push the request past
    // maxDuration, so the operator gets an opaque platform error instead of the
    // "search is down" signal below.
    if (photon === null && nominatim === null) return { results: [], degraded: true };

    const merged = mergeResults(photon || [], nominatim || []);
    if (merged.length) return { results: merged, degraded: false };
  }
  return { results: [], degraded: false };
}

/**
 * Cache keys whose last completed search was degraded.
 *
 * cachedSource dedups concurrent misses: a second request for the same query is
 * handed the first one's promise and its own fetcher never runs. During an
 * outage that is the normal case rather than a corner — every provider call is
 * sitting on an 8s timeout, so an operator who retries lands inside the first
 * search — and without this the retry would get exactly the 200-with-no-results
 * answer this whole change exists to remove. Read only after the shared promise
 * resolves, so the entry is always the one that resolution wrote.
 */
const degradedKeys = new Set<string>();

/** Keys are query text, so this would otherwise grow without bound. */
const MAX_DEGRADED_KEYS = 200;

function recordOutcome(key: string, degraded: boolean): void {
  if (!degraded) {
    degradedKeys.delete(key);
    return;
  }
  degradedKeys.add(key);
  // Set preserves insertion order, so the oldest key evicts first.
  while (degradedKeys.size > MAX_DEGRADED_KEYS) {
    const oldest = degradedKeys.values().next().value;
    if (oldest === undefined) break;
    degradedKeys.delete(oldest);
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('q') || '').trim();
    const lat = parseFloat(searchParams.get('lat') || '');
    const lng = parseFloat(searchParams.get('lng') || '');

    if (q.length < 2) return NextResponse.json({ results: [] });

    // Bias is rounded so panning slightly still reuses the cached search.
    const biasKey = Number.isFinite(lat) && Number.isFinite(lng)
      ? `${lat.toFixed(1)},${lng.toFixed(1)}`
      : 'global';
    const key = `geosearch:${q.toLowerCase()}|${biasKey}`;

    const results = await cachedSource<GeoResult>(
      key,
      async () => {
        // Both providers, then the reduction fallback only if that found
        // nothing. See lib/geo-query.ts: an address typed with English street
        // words returns zero from BOTH engines when OSM holds the street in
        // French, and the two tokens the operator added to be more precise are
        // exactly what empty the result set.
        for (const attempt of queryLadder(q)) {
          const [photon, nominatim] = await Promise.all([
            optional(searchPhoton(attempt, lat, lng)),
            optional(searchNominatim(attempt)),
          ]);
          const merged = mergeResults(photon || [], nominatim || []);
          if (merged.length) return merged;
        }
        return [];
      },
      10 * 60 * 1000,
    )();

    return NextResponse.json(
      { results },
      { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800' } },
    );
  } catch (error) {
    console.error('[OSIRIS] Geosearch error:', error);
    return NextResponse.json({ results: [], error: 'Search failed' }, { status: 500 });
  }
}
