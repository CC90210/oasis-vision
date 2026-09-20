import { CctvCamera } from './types';
import { stealthFetch } from '@/lib/stealthFetch';

/**
 * OASIS VISION — Iceland CCTV Cameras
 * Source: Vegagerðin (Icelandic Road and Coastal Administration)
 * Official public API: https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1
 * Returns ~488 live road cameras across the entire island with real-time JPEG snapshots.
 */

interface VegagerdinCamera {
  Maelist_nr: number;
  Myndavel: string;       // Location name (Icelandic)
  Vegheiti: string;       // Road name
  NrVegur: string;        // Road number
  Skyring: string;        // Description / direction
  Slod: string;           // Image URL (JPEG)
  PntX: number;           // ISN93 X
  PntY: number;           // ISN93 Y
  Breidd: number;         // Latitude (WGS84)
  Lengd: number;          // Longitude (WGS84)
}

export async function fetchIcelandCameras(): Promise<CctvCamera[]> {
  try {
    const res = await stealthFetch(
      'https://gagnaveita.vegagerdin.is/api/vefmyndavelar2014_1',
      { signal: AbortSignal.timeout(12000) }
    );
    if (!res.ok) return [];

    const data: VegagerdinCamera[] = await res.json();
    const cameras: CctvCamera[] = [];

    for (const cam of data) {
      // Validate coordinates and image URL
      if (!cam.Breidd || !cam.Lengd || !cam.Slod) continue;

      // Ensure image URL is absolute
      let feedUrl = cam.Slod;
      if (feedUrl.startsWith('/')) {
        feedUrl = `https://www.vegagerdin.is${feedUrl}`;
      }

      cameras.push({
        id: `is-${cam.Maelist_nr}-${cameras.length}`,
        lat: cam.Breidd,
        lng: cam.Lengd,
        name: `${cam.Myndavel} — ${cam.Skyring}`,
        city: cam.Myndavel,
        country: 'Iceland',
        feed_url: feedUrl,
        source: 'Vegagerðin',
      });
    }

    return cameras;
  } catch (e) {
    // Silent fallback — don't crash the aggregator
    return [];
  }
}
