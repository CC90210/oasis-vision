import { stealthFetch } from '@/lib/stealthFetch';
import { cachedSource } from '@/lib/sourceCache';
import type { CctvCamera } from './types';

/**
 * OASIS VISION — Ontario 511 (MTO) highway cameras.
 * Source: https://511on.ca/api/v2/get/cameras — NO API KEY, 940 sites.
 *
 * Replaces an inline fetcher in route.ts that returned nothing. That code read
 * `cam.latitude` / `cam.longitude`; the API returns `Latitude` / `Longitude`,
 * capitalised. Every one of the 940 records failed the truthiness guard and was
 * skipped, leaving only three hardcoded Toronto rows behind it — so the whole
 * province looked like a coverage gap instead of a case-sensitivity bug. Barrie,
 * Orangeville and Shelburne all had cameras the entire time (36, 81 and 15
 * within ~50 km respectively).
 *
 * Each site carries a `Views` array — distinct camera angles at one gantry,
 * 1,660 across the province. Every enabled view becomes its own map entity,
 * because "QEW West of Thompson Road / Toronto Bound" and ".../ Fort Erie Bound"
 * are different pictures and an operator wants to pick one.
 *
 * These are stills, not video: the image endpoint answers `image/jpeg` with
 * `Cache-Control: max-age=20`. Ontario's own help page advertises continuous
 * HLS; measured against the API, that claim is false. 20 s is nonetheless the
 * fastest refresh of any Canadian source, which makes these the best candidates
 * for a still-to-HLS relay later.
 */

/** Ontario bounding box — drops mis-geocoded rows. */
const ON_BOUNDS = { minLat: 41.6, maxLat: 57.0, minLng: -95.5, maxLng: -74.0 };

export interface Ontario511View {
  Id?: number;
  Url?: string | null;
  Status?: string | null;
  Description?: string | null;
}

export interface Ontario511Record {
  Id?: number;
  Source?: string | null;
  Roadway?: string | null;
  Direction?: string | null;
  Latitude?: number | null;
  Longitude?: number | null;
  Location?: string | null;
  Views?: Ontario511View[] | null;
}

/**
 * Expand one site into a camera per enabled view.
 *
 * Exported for the tests: the province-wide payload is 372 KB and the whole of
 * the interesting behaviour is in this expansion.
 */
export function mapRecord(rec: Ontario511Record): CctvCamera[] {
  if (!rec) return [];

  const lat = rec.Latitude;
  const lng = rec.Longitude;
  if (!Number.isFinite(lat as number) || !Number.isFinite(lng as number)) return [];
  if ((lat as number) === 0 && (lng as number) === 0) return [];
  if ((lat as number) < ON_BOUNDS.minLat || (lat as number) > ON_BOUNDS.maxLat) return [];
  if ((lng as number) < ON_BOUNDS.minLng || (lng as number) > ON_BOUNDS.maxLng) return [];

  const views = (rec.Views ?? []).filter(v => v?.Url && String(v.Status).toLowerCase() === 'enabled');
  if (!views.length) return [];

  const place = rec.Location?.trim() || rec.Roadway?.trim() || 'Ontario Camera';

  return views.map(v => ({
    id: `on511-${rec.Id}-${v.Id}`,
    lat: lat as number,
    lng: lng as number,
    // "Hwy 400 at Dunlop St — Southbound" reads better on a pin than either half.
    name: v.Description?.trim() ? `${place} — ${v.Description.trim()}` : place,
    city: rec.Roadway?.trim() || 'Ontario',
    country: 'Canada',
    feed_url: v.Url as string,
    source: '511 Ontario',
  }));
}

async function loadOntarioCameras(): Promise<CctvCamera[]> {
  const res = await stealthFetch('https://511on.ca/api/v2/get/cameras', { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    console.warn(`[OASIS] Ontario cameras — 511ON HTTP ${res.status}`);
    return [];
  }
  const data = await res.json();
  const rows: Ontario511Record[] = Array.isArray(data) ? data : [];

  const cams: CctvCamera[] = [];
  for (const rec of rows) cams.push(...mapRecord(rec));

  console.log(`[OASIS] Ontario cameras — 511ON: ${cams.length} views across ${rows.length} sites`);
  return cams;
}

export const fetchOntarioCameras = cachedSource('ontario511', loadOntarioCameras);
