import { stealthFetch } from '@/lib/stealthFetch';
import { cachedSource } from '@/lib/sourceCache';
import { buildQuery, parseWkt } from './ibi511';
import type { CctvCamera } from './types';

/**
 * OASIS VISION — US state DOT cameras on the IBI 511 platform.
 *
 * Utah and Nevada already read through ibi511.ts. Seven more state DOTs run the
 * identical vendor stack, and this generalises that reader over all of them
 * rather than copying nevada.ts eight times.
 *
 * WHY NOT THE DOCUMENTED REST API. Every one of these states also publishes
 * `/api/v2/get/cameras`, which is the endpoint their docs point at — and it
 * answers `<Error><Message>Invalid Key</Message></Error>` without a registered
 * key. The `/List/GetData/Cameras` DataTables endpoint below is what each
 * state's own public map calls, needs no key, and returns the same cameras.
 * Measured live before this was written: NY 1,871 · FL 4,953 · GA 4,043 ·
 * PA 1,542 · NC 1,139 · AZ 644 · WI 489 — 14,681 cameras that the app was
 * previously not reaching at all.
 *
 * This is what closed the biggest coverage hole on the map: New York had zero
 * cameras with the nearest 890 km away, and Miami zero with the nearest 1,541
 * km, because us-east carried four hand-written entries.
 */

export interface Ibi511State {
  /** Region key used by the route. */
  id: string;
  label: string;
  base: string;
  /** Shown on each camera and used to namespace its id. */
  source: string;
  /** Rough state bounding box, to drop mis-geocoded rows. */
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number };
  /** Measured row count, so a collapse to a fraction of it is visible in logs. */
  expect: number;
}

export const IBI_STATES: Ibi511State[] = [
  { id: 'newyork', label: 'New York', base: 'https://511ny.org', source: '511NY',
    bounds: { minLat: 40.4, maxLat: 45.1, minLng: -80.0, maxLng: -71.8 }, expect: 1871 },
  { id: 'pennsylvania', label: 'Pennsylvania', base: 'https://www.511pa.com', source: '511PA',
    bounds: { minLat: 39.6, maxLat: 42.4, minLng: -80.6, maxLng: -74.6 }, expect: 1542 },
  { id: 'georgia', label: 'Georgia', base: 'https://www.511ga.org', source: '511GA',
    bounds: { minLat: 30.3, maxLat: 35.1, minLng: -85.7, maxLng: -80.7 }, expect: 4043 },
  { id: 'florida', label: 'Florida', base: 'https://fl511.com', source: 'FL511',
    bounds: { minLat: 24.3, maxLat: 31.1, minLng: -87.7, maxLng: -79.9 }, expect: 4953 },
  { id: 'northcarolina', label: 'North Carolina', base: 'https://drivenc.gov', source: 'DriveNC',
    bounds: { minLat: 33.7, maxLat: 36.7, minLng: -84.4, maxLng: -75.4 }, expect: 1139 },
  { id: 'arizona', label: 'Arizona', base: 'https://az511.gov', source: 'AZ511',
    bounds: { minLat: 31.2, maxLat: 37.1, minLng: -115.0, maxLng: -108.9 }, expect: 644 },
  { id: 'wisconsin', label: 'Wisconsin', base: 'https://511wi.gov', source: '511WI',
    bounds: { minLat: 42.4, maxLat: 47.4, minLng: -93.0, maxLng: -86.7 }, expect: 489 },
];

const PAGE_SIZE = 100;   // the server caps a response at 100 rows whatever is asked

/**
 * Pages actually fetched per state, and the reason there is a cap at all.
 *
 * These servers are both slow and burst-intolerant. Measured directly: Georgia
 * needs 40 pages and Florida 49, and at twelve concurrent requests Georgia
 * still lost 14 of 40 pages in 11.9s while Florida lost 18 of 49 in 10.9s.
 * The CCTV route gives each region a 12s budget, so fetching a whole state
 * inside one request is not achievable however the concurrency is tuned —
 * raising it produces 500s, lowering it produces timeouts.
 *
 * So a bounded sample is taken instead, STRIDED across the full page range
 * rather than taken from the front. The rows are ordered by sortOrder and
 * roadway, which groups them by highway and therefore by place: the first
 * eighteen pages of Florida would be one corner of Florida and would read as
 * "the rest of the state has no cameras". Striding spreads the sample
 * statewide. Same reasoning as sample() in opencctv.ts.
 */
const MAX_PAGES = 18;
/** Pages in flight at once. See above — this is load-bearing, not politeness. */
const PAGE_CONCURRENCY = 6;

/** One row from /List/GetData/Cameras — only the fields consumed here. */
export interface Ibi511Record {
  id?: number;
  roadway?: string | null;
  location?: string | null;
  latLng?: { geography?: { wellKnownText?: string | null } | null } | null;
  images?: Array<{
    id?: number;
    description?: string | null;
    imageUrl?: string | null;
    videoUrl?: string | null;
    blocked?: boolean;
    disabled?: boolean;
    videoDisabled?: boolean;
  }> | null;
}

/**
 * Map one row to a camera, or null to skip it.
 *
 * Exported for the tests: the payload is thousands of rows and the interesting
 * behaviour is entirely here.
 */
export function mapRecord(rec: Ibi511Record, state: Ibi511State): CctvCamera | null {
  if (!rec || typeof rec.id !== 'number') return null;

  const img = rec.images?.[0];
  if (!img || img.blocked || img.disabled) return null;

  const coords = parseWkt(rec.latLng?.geography?.wellKnownText);
  if (!coords) return null;

  const { lat, lng } = coords;
  const b = state.bounds;
  if (lat < b.minLat || lat > b.maxLat || lng < b.minLng || lng > b.maxLng) return null;

  /* `location` is very often the literal string "N/A" on these feeds. Treating
     it as a value short-circuits the chain, so a camera with a perfectly good
     roadway name ends up labelled "511NY Camera 42". Filter the placeholder out
     of the candidates rather than testing for it after the fact. */
  const name = [img.description, rec.location, rec.roadway]
    .map(v => v?.trim())
    .find(v => v && v !== 'N/A');

  const snapshot = img.imageUrl ? absolute(state.base, img.imageUrl) : undefined;
  const video = img.videoDisabled ? undefined : img.videoUrl?.trim() || undefined;
  if (!snapshot && !video) return null;

  return {
    id: `${state.id}-${rec.id}`,
    lat,
    lng,
    name: name || `${state.source} Camera ${rec.id}`,
    city: state.label,
    country: 'US',
    ...(snapshot ? { feed_url: snapshot } : {}),
    // Only a real playlist counts as a stream; some rows carry a viewer page.
    ...(video && video.includes('.m3u8')
      ? { stream_url: video, stream_type: 'hls' as const }
      : {}),
    source: state.source,
  };
}

/**
 * Which page offsets to request, after page 0.
 *
 * Every page when a state is small enough; otherwise evenly spaced across the
 * whole range so the sample is statewide rather than one highway corridor.
 *
 * Exported for the tests: whether the sample is strided or taken from the front
 * is the difference between statewide coverage and a map that looks empty
 * outside one city.
 */
export function pageStarts(total: number, pageSize = PAGE_SIZE, maxPages = MAX_PAGES): number[] {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return [];
  const wanted = Math.min(pages - 1, maxPages - 1);
  if (wanted <= 0) return [];
  if (pages - 1 <= wanted) {
    return Array.from({ length: pages - 1 }, (_, i) => (i + 1) * pageSize);
  }
  const stride = (pages - 1) / wanted;
  const out = new Set<number>();
  for (let i = 0; i < wanted; i++) {
    out.add((1 + Math.floor(i * stride)) * pageSize);
  }
  return [...out].sort((a, b) => a - b);
}

/** These sites return image paths both absolute and site-relative. */
function absolute(base: string, url: string): string {
  return /^https?:\/\//i.test(url) ? url : `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}

async function fetchPage(state: Ibi511State, start: number): Promise<{ rows: Ibi511Record[]; total: number }> {
  const url = `${state.base}/List/GetData/Cameras?query=${buildQuery(start, PAGE_SIZE)}&lang=en-US`;
  const res = await stealthFetch(url, {
    signal: AbortSignal.timeout(20000),
    headers: { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${state.source} HTTP ${res.status}`);
  const data = await res.json();
  return {
    rows: Array.isArray(data?.data) ? data.data : [],
    total: Number(data?.recordsTotal) || 0,
  };
}

function loader(state: Ibi511State) {
  return async (): Promise<CctvCamera[]> => {
    const first = await fetchPage(state, 0);
    const seen = new Map<number, CctvCamera>();

    const ingest = (rows: Ibi511Record[]) => {
      for (const rec of rows) {
        const cam = mapRecord(rec, state);
        if (cam && typeof rec.id === 'number') seen.set(rec.id, cam);
      }
    };
    ingest(first.rows);

    const starts = pageStarts(first.total);

    /* Bounded concurrency, and it is load-bearing rather than politeness.
     * Firing every page at once made these servers answer 500: Georgia (40
     * pages) returned nothing at all, Florida (50) and New York (19) came back
     * badly short, while Arizona (7), North Carolina (12) and Wisconsin (5)
     * were unaffected — the failures tracked page count exactly. One retry
     * covers a single transient rejection. */
    let failedPages = 0;
    for (let i = 0; i < starts.length; i += PAGE_CONCURRENCY) {
      const batch = starts.slice(i, i + PAGE_CONCURRENCY);
      const results = await Promise.allSettled(batch.map(async s => {
        try {
          return await fetchPage(state, s);
        } catch {
          await new Promise(r => setTimeout(r, 400));
          return fetchPage(state, s);
        }
      }));
      for (const r of results) {
        if (r.status === 'fulfilled') ingest(r.value.rows);
        else failedPages++;
      }
    }

    const cams = [...seen.values()];
    console.log(
      `[OASIS] ${state.label} cameras — ${state.source}: ${cams.length} of ${first.total}` +
      (failedPages ? `, ${failedPages}/${starts.length} pages failed` : ''),
    );
    return cams;
  };
}

/** Region key → fetcher, one per state. */
export const IBI_STATE_FETCHERS: Record<string, () => Promise<CctvCamera[]>> =
  Object.fromEntries(IBI_STATES.map(s => [s.id, cachedSource(`ibi511-${s.id}`, loader(s))]));

/** Region keys a viewport over `lat,lng` should request. */
export function ibiStatesForPoint(lat: number, lng: number): string[] {
  return IBI_STATES.filter(s =>
    lat > s.bounds.minLat && lat < s.bounds.maxLat &&
    lng > s.bounds.minLng && lng < s.bounds.maxLng).map(s => s.id);
}
