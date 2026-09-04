import { stealthFetch } from '@/lib/stealthFetch';
import { cachedSource } from '@/lib/sourceCache';
import type { CctvCamera } from './types';

/**
 * OASIS VISION — Caltrans California CCTV (per-district status JSON)
 * Source: https://cwwp2.dot.ca.gov/data/d{n}/cctv/cctvStatusD{nn}.json — NO API KEY.
 *
 * This replaces the ArcGIS FeatureServer this app used to read for California.
 * Measured against both endpoints on 2026-09-04: ArcGIS returns ~2,000 cameras
 * and exposes nothing but `currentImageURL`, a still. The district files return
 * 3,538 cameras of which 2,284 carry `imageData.streamingVideoURL` — a real
 * rolling HLS playlist on wzmedia.dot.ca.gov, served with
 * `Access-Control-Allow-Origin: *`, so hls.js plays it with no proxy.
 *
 * That matters more than the extra 1,500 cameras: continuous video is the thing
 * this dataset is short of. Roughly 14% of the app's ~23k cameras were true
 * streams before this; California alone adds ~2,284.
 *
 * Every camera keeps its still as `feed_url` even when it has a stream, because
 * a measured 3 of 10 sampled playlists 404 — the index lists cameras the media
 * edge has dropped. The viewer falls back to the snapshot rather than showing
 * an error, so a dead stream degrades to a picture instead of to nothing.
 */

/** District file ids. `d1`..`d12` in the path, zero-padded in the filename. */
const DISTRICTS = Array.from({ length: 12 }, (_, i) => i + 1);

/** California bounding box — drops mis-geocoded rows. */
const CA_BOUNDS = { minLat: 32.0, maxLat: 42.2, minLng: -125.0, maxLng: -113.9 };

interface CaltransRecord {
  cctv?: {
    index?: string;
    inService?: string;
    location?: {
      district?: string;
      locationName?: string;
      nearbyPlace?: string;
      county?: string;
      route?: string;
      latitude?: string;
      longitude?: string;
    };
    imageData?: {
      streamingVideoURL?: string;
      static?: { currentImageURL?: string };
    };
  };
}

/**
 * Map one district row to a camera, or null to skip it.
 *
 * Exported for the tests: the district payload is large and slow to fetch, and
 * the interesting behaviour is entirely in this mapping.
 */
export function mapRecord(row: CaltransRecord, district: number): CctvCamera | null {
  const cc = row?.cctv;
  if (!cc) return null;

  // `inService` is the operator's own word for whether the camera is live.
  // Anything not explicitly true is withheld rather than shown as broken.
  if (String(cc.inService).toLowerCase() !== 'true') return null;

  const loc = cc.location ?? {};
  const lat = Number(loc.latitude);
  const lng = Number(loc.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return null;
  if (lat < CA_BOUNDS.minLat || lat > CA_BOUNDS.maxLat) return null;
  if (lng < CA_BOUNDS.minLng || lng > CA_BOUNDS.maxLng) return null;

  const stream = cc.imageData?.streamingVideoURL?.trim();
  const snapshot = cc.imageData?.static?.currentImageURL?.trim();
  // A row with neither is a map pin that can never show anything.
  if (!stream && !snapshot) return null;

  const name = loc.locationName?.trim() || loc.route?.trim() || `Caltrans D${district}`;

  return {
    id: `caltrans-d${district}-${cc.index ?? name}`,
    lat,
    lng,
    name,
    city: loc.nearbyPlace?.trim() || loc.county?.trim() || 'California',
    country: 'US',
    ...(snapshot ? { feed_url: snapshot } : {}),
    // Only a real playlist counts as a stream; the field occasionally holds a
    // placeholder page rather than a manifest.
    ...(stream && stream.includes('.m3u8')
      ? { stream_url: stream, stream_type: 'hls' as const }
      : {}),
    source: 'Caltrans',
  };
}

async function fetchDistrict(d: number): Promise<CctvCamera[]> {
  const file = `cctvStatusD${String(d).padStart(2, '0')}.json`;
  const url = `https://cwwp2.dot.ca.gov/data/d${d}/cctv/${file}`;
  const res = await stealthFetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const data = await res.json();
  const rows: CaltransRecord[] = Array.isArray(data?.data) ? data.data : [];
  const out: CctvCamera[] = [];
  for (const row of rows) {
    const cam = mapRecord(row, d);
    if (cam) out.push(cam);
  }
  return out;
}

async function loadCaltransCameras(): Promise<CctvCamera[]> {
  // Twelve small independent files: fan out, and let a district that is down
  // cost only itself rather than the state.
  const settled = await Promise.allSettled(DISTRICTS.map(fetchDistrict));

  const byId = new Map<string, CctvCamera>();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    for (const cam of r.value) byId.set(cam.id, cam);
  }

  const cams = [...byId.values()];
  const streams = cams.filter(c => c.stream_type === 'hls').length;
  const failed = settled.filter(r => r.status === 'rejected').length;
  console.log(
    `[OASIS] California cameras — Caltrans: ${cams.length} (${streams} live HLS)` +
    (failed ? `, ${failed}/12 districts unreachable` : ''),
  );
  return cams;
}

export const fetchCaltransCameras = cachedSource('caltrans', loadCaltransCameras);
