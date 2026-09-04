import { stealthFetch } from '@/lib/stealthFetch';
import { cachedSource } from '@/lib/sourceCache';
import type { CctvCamera, CctvStreamType } from './types';

/**
 * OSIRIS — Asian cameras via the OpenCCTV directory.
 *
 * Source: https://opencctv.org — an aggregator carrying ~145,000 cameras, of
 * which ~30,000 sit inside the Asian boxes below, most of them republished
 * from official city and prefectural operators (Busan and Ansan's ITS, Seoul,
 * Hong Kong's Observatory, Japan's river and road bureaus). It fills the
 * region the traffic-authority feeds cannot: South Korea, Indonesia, Vietnam
 * and the Philippines publish no open machine-readable CCTV index of their
 * own — every national portal checked (Korea's UTIC and ITS, Taiwan's TDX)
 * gates its camera list behind an API key.
 *
 * Two endpoints, both the ones the site's own map calls:
 *
 *   GET  /api/cameras/markers   the whole index as parallel arrays — id, lat,
 *                               lng — and nothing else. 7.3 MB, and it ignores
 *                               every filter parameter tried, so the shape of
 *                               this module is set by having to take all of it
 *                               and narrow locally.
 *   POST /api/cameras/batch     {ids:[…]} → full records. It answers with at
 *                               most 50 rows however many ids are sent, which
 *                               is what BATCH_SIZE encodes and why the region
 *                               is sampled rather than taken whole: 24,000
 *                               cameras would be 483 round trips.
 */

const MARKERS = 'https://opencctv.org/api/cameras/markers';
const BATCH = 'https://opencctv.org/api/cameras/batch';

/** The server truncates a batch response to 50 rows regardless of ids sent. */
const BATCH_SIZE = 50;
/**
 * Asia is split rather than taken whole so a viewport over Jakarta does not
 * pay for Japan. Each sub-region carries its own ceiling on cameras
 * materialised, which is what keeps this to tens of round trips, not 600.
 */
interface Box { minLat: number; maxLat: number; minLng: number; maxLng: number }

/**
 * A region box, optionally minus a rectangle.
 *
 * The index is US-dominated — 67,422 of its 144,942 cameras sit in North
 * America — so any rectangle drawn over Latin America also covers Florida, the
 * Gulf coast and southern Texas, and sample() strides across the combined list.
 * Latin America came back 85% US cameras. Shrinking the rectangle far enough to
 * fix that would cut Mexico off, so the box carries a hole instead.
 */
interface Bounds extends Box { exclude?: Box }

function inBox(lat: number, lng: number, b: Box): boolean {
  return lat > b.minLat && lat < b.maxLat && lng > b.minLng && lng < b.maxLng;
}

const REGIONS: Record<string, { bounds: Bounds; cap: number }> = {
  /* China, Japan, the Koreas and Taiwan — 24,188 candidates. */
  eastasia: { bounds: { minLat: 18, maxLat: 46, minLng: 73.5, maxLng: 146 }, cap: 1200 },
  /* Indochina, Indonesia, the Philippines — 7,781 candidates. */
  seasia: { bounds: { minLat: -11, maxLat: 24, minLng: 92, maxLng: 130 }, cap: 800 },
  /* The Gulf, Iran, Central Asia and the subcontinent — 1,379 candidates, so
     the cap is never the binding constraint here; it is a guard, not a quota. */
  westasia: { bounds: { minLat: 5, maxLat: 56, minLng: 25, maxLng: 92 }, cap: 600 },

  /* ── The rest of the world ──
   *
   * The index holds 144,942 cameras and only the three Asian boxes above were
   * ever queried, so 138,107 candidates were never looked at — which is why
   * Russia, Mongolia and Africa rendered as blank map. Counts below are
   * measured against the live index, not estimated.
   *
   * Caps stay in the same band as the existing regions on purpose: BATCH_SIZE
   * is 50, so a cap of 1,600 is 32 parallel round trips, comparable to
   * eastasia's 24. These are viewport-scoped — a region is only fetched when
   * the map is actually over it — so the ceiling bounds one region's cost, not
   * the planet's.
   */
  /* 42,411 candidates — the densest region in the index after North America. */
  europe: { bounds: { minLat: 35, maxLat: 72, minLng: -25, maxLng: 40 }, cap: 1600 },
  /* 67,422 candidates. Overlaps the state DOT sources, which are different
     providers with namespaced ids, so the two sets complement rather than
     duplicate. */
  northam: { bounds: { minLat: 24, maxLat: 72, minLng: -170, maxLng: -52 }, cap: 1600 },
  /* 14,984 candidates across Mexico, Central and South America. */
  latam: {
    bounds: {
      minLat: -56, maxLat: 30, minLng: -118, maxLng: -34,
      /* Texas, the Gulf coast and Florida. Mexico lies west and south of this
         hole so it survives; northam already covers what is cut out. */
      exclude: { minLat: 24.3, maxLat: 30, minLng: -106, maxLng: -79 },
    },
    cap: 1200,
  },
  /* 7,871 candidates across Russia, Belarus, the Caucasus and Mongolia. */
  russia: { bounds: { minLat: 41, maxLat: 78, minLng: 19, maxLng: 180 }, cap: 1200 },
  /* 3,727 candidates across Australia, New Zealand and the Pacific. */
  oceania: { bounds: { minLat: -50, maxLat: 0, minLng: 110, maxLng: 180 }, cap: 800 },
  /* 1,692 candidates — the thinnest region in the index, and the cap never
     binds. Sparse coverage here is the source's, not ours. */
  africa: { bounds: { minLat: -35, maxLat: 37.4, minLng: -18, maxLng: 52 }, cap: 800 },
};

/** The index, as three parallel arrays. */
interface MarkerIndex {
  ids?: string[];
  lats?: number[];
  lngs?: number[];
}

/** One row from /api/cameras/batch (only the fields we consume). */
export interface OpenCctvRecord {
  id?: string;
  name?: string | null;
  city?: string | null;
  country?: string | null;
  lat?: number;
  lng?: number;
  feed_url?: string | null;
  feed_type?: string | null;
  source?: string | null;
  active?: number;
  /** Set when appending a query string to feed_url returns an error instead. */
  cache_buster_breaks_url?: boolean;
}

/** OpenCCTV's `feed_type` in OSIRIS's vocabulary; null means unusable. */
export function streamKind(feedType?: string | null): CctvStreamType | 'jpg' | null {
  switch ((feedType || '').toLowerCase()) {
    case 'm3u8':
    case 'hls': return 'hls';
    case 'mjpeg': return 'mjpeg';
    case 'image': return 'jpg';
    case 'iframe': return 'iframe';
    default: return null;
  }
}

/** Map one record to a camera, or null if it should be skipped. */
export function mapRecord(rec: OpenCctvRecord): CctvCamera | null {
  if (!rec?.id || rec.active === 0) return null;

  const url = rec.feed_url?.trim();
  if (!url) return null;

  const kind = streamKind(rec.feed_type);
  if (!kind) return null;

  const { lat, lng } = rec;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  /* A snapshot tile re-requests with `?_t=` on every refresh. Where the source
     has recorded that a query string breaks the URL, that tile would turn into
     a broken box the moment it refreshed, so it never gets one. */
  if (kind === 'jpg' && rec.cache_buster_breaks_url) return null;

  const name = rec.name?.trim() || rec.city?.trim() || 'Camera';

  return {
    id: `occ-${rec.id}`,
    lat,
    lng,
    name,
    city: rec.city?.trim() || '',
    country: rec.country?.trim() || '',
    /* A still is a feed_url; everything else is a stream the player picks up. */
    ...(kind === 'jpg' ? { feed_url: url } : { stream_url: url, stream_type: kind }),
    source: rec.source?.trim() ? `OpenCCTV / ${rec.source.trim()}` : 'OpenCCTV',
  };
}

/**
 * Thin the candidates down to MAX_CAMERAS by walking the list at a fixed
 * stride. The index is ordered by id, which groups cameras by operator and so
 * by place — taking the first N would return one city and call it a region.
 */
export function sample<T>(items: T[], cap: number): T[] {
  if (items.length <= cap) return items;
  const stride = items.length / cap;
  const out: T[] = [];
  for (let i = 0; out.length < cap && Math.floor(i) < items.length; i += stride) {
    out.push(items[Math.floor(i)]);
  }
  return out;
}

async function fetchBatch(ids: string[]): Promise<OpenCctvRecord[]> {
  const res = await stealthFetch(BATCH, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Referer: 'https://opencctv.org/',
    },
    body: JSON.stringify({ ids }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data.filter(Boolean) : [];
}

/** The marker index, fetched once and shared by every Asian sub-region. */
const markerIndex = cachedSource('opencctv-index', async (): Promise<MarkerIndex[]> => {
  const res = await stealthFetch(MARKERS, {
    signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/json', Referer: 'https://opencctv.org/' },
  });
  if (!res.ok) throw new Error(`OpenCCTV markers HTTP ${res.status}`);

  const index = (await res.json()) as MarkerIndex;
  if (!Array.isArray(index.ids) || !Array.isArray(index.lats) || !Array.isArray(index.lngs)) {
    throw new Error('OpenCCTV markers returned no index');
  }
  /* Wrapped in an array because the cache stores lists; it is one 7.3 MB
     download shared by all three regions rather than one download each. */
  return [index];
});

function loader(region: string, bounds: Bounds, cap: number) {
  return async (): Promise<CctvCamera[]> => {
    const [index] = await markerIndex();
    const ids = index?.ids ?? [];
    const lats = index?.lats ?? [];
    const lngs = index?.lngs ?? [];

    const inRegion: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      const lat = lats[i];
      const lng = lngs[i];
      if (!inBox(lat, lng, bounds)) continue;
      if (bounds.exclude && inBox(lat, lng, bounds.exclude)) continue;
      inRegion.push(ids[i]);
    }

    const wanted = sample(inRegion, cap);
    const chunks: string[][] = [];
    for (let i = 0; i < wanted.length; i += BATCH_SIZE) {
      chunks.push(wanted.slice(i, i + BATCH_SIZE));
    }

    const results = await Promise.allSettled(chunks.map(fetchBatch));
    const seen = new Map<string, CctvCamera>();
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const rec of r.value) {
        const cam = mapRecord(rec);
        if (cam) seen.set(cam.id, cam);
      }
    }

    const cams = [...seen.values()];
    console.log(`[OSIRIS] ${region} cameras — OpenCCTV: ${cams.length} of ${inRegion.length} in region`);
    return cams;
  };
}

export const fetchEastAsiaCameras = cachedSource('eastasia', loader('East Asia', REGIONS.eastasia.bounds, REGIONS.eastasia.cap));
export const fetchSeAsiaCameras = cachedSource('seasia', loader('Southeast Asia', REGIONS.seasia.bounds, REGIONS.seasia.cap));
export const fetchWestAsiaCameras = cachedSource('westasia', loader('West & Central Asia', REGIONS.westasia.bounds, REGIONS.westasia.cap));

export const fetchOpenEuropeCameras = cachedSource('oc-europe', loader('Europe', REGIONS.europe.bounds, REGIONS.europe.cap));
export const fetchOpenNorthAmericaCameras = cachedSource('oc-northam', loader('North America', REGIONS.northam.bounds, REGIONS.northam.cap));
export const fetchOpenLatamCameras = cachedSource('oc-latam', loader('Latin America', REGIONS.latam.bounds, REGIONS.latam.cap));
export const fetchOpenRussiaCameras = cachedSource('oc-russia', loader('Russia & Mongolia', REGIONS.russia.bounds, REGIONS.russia.cap));
export const fetchOpenOceaniaCameras = cachedSource('oc-oceania', loader('Oceania', REGIONS.oceania.bounds, REGIONS.oceania.cap));
export const fetchOpenAfricaCameras = cachedSource('oc-africa', loader('Africa', REGIONS.africa.bounds, REGIONS.africa.cap));
