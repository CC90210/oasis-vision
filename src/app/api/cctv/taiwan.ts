import type { CctvCamera } from './types';
import { stealthFetch } from '@/lib/stealthFetch';


/**
 * Taiwan CCTV Cameras
 * Sources:
 *  - Taiwan Highway Bureau (THB) — 2,128 cameras via thbapp.thb.gov.tw API
 *    Direct JPEG snapshots from cctv-ss{01-07}.thb.gov.tw
 *  - YouTube 24/7 live streams across major cities
 */

// ── YouTube Live Streams ──
const YOUTUBE_CAMERAS: CctvCamera[] = [
  {
    id: 'tw-taipei-101',
    lat: 25.0330, lng: 121.5654,
    name: 'Taipei 101 Live',
    city: 'Taipei', country: 'Taiwan',
    stream_url: 'https://www.youtube.com/embed/rL5YKnxBudA?autoplay=1&mute=1',
    stream_type: 'iframe',
    source: 'YouTube',
  },
  {
    id: 'tw-taipei-ximending',
    lat: 25.0422, lng: 121.5079,
    name: 'Ximending Walking District',
    city: 'Taipei', country: 'Taiwan',
    stream_url: 'https://www.youtube.com/embed/W3A3gCqj7bY?autoplay=1&mute=1',
    stream_type: 'iframe',
    source: 'YouTube',
  },
  {
    id: 'tw-kaohsiung-harbor',
    lat: 22.6142, lng: 120.2843,
    name: 'Kaohsiung Harbor Live',
    city: 'Kaohsiung', country: 'Taiwan',
    stream_url: 'https://www.youtube.com/embed/PdX18mxuYRE?autoplay=1&mute=1',
    stream_type: 'iframe',
    source: 'YouTube',
  },
  {
    id: 'tw-keelung-harbor',
    lat: 25.1291, lng: 121.7423,
    name: 'Keelung Harbor',
    city: 'Keelung', country: 'Taiwan',
    stream_url: 'https://www.youtube.com/embed/SX90gCtF3bY?autoplay=1&mute=1',
    stream_type: 'iframe',
    source: 'YouTube',
  },
];

// ── Taiwan Highway Bureau (THB) — Dynamic fetch of 2,000+ cameras ──
async function fetchTHBCameras(): Promise<CctvCamera[]> {
  try {
    const res = await stealthFetch(
      'https://thbapp.thb.gov.tw/services/cctv/thb',
      { signal: AbortSignal.timeout(20000), headers: { 'Accept': 'application/json' } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    if (!Array.isArray(data)) return [];

    return data
      .filter((c: any) => c.gisy && c.gisx && c.html)
      .map((c: any) => {
        // Extract camera name from stakenumber (e.g. "台2線107K+000" → "Highway 2 — 107K+000")
        const stake = c.stakenumber || '';
        // Determine city from coordinates (rough bounding boxes for major cities)
        const lat = parseFloat(c.gisy);
        const lng = parseFloat(c.gisx);
        let city = 'Taiwan';
        if (lat > 24.9 && lat < 25.2 && lng > 121.4 && lng < 121.7) city = 'Taipei';
        else if (lat > 24.0 && lat < 24.3 && lng > 120.5 && lng < 120.9) city = 'Taichung';
        else if (lat > 22.5 && lat < 22.8 && lng > 120.1 && lng < 120.5) city = 'Kaohsiung';
        else if (lat > 22.9 && lat < 23.1 && lng > 120.1 && lng < 120.3) city = 'Tainan';
        else if (lat > 24.7 && lat < 25.0 && lng > 121.0 && lng < 121.5) city = 'Taoyuan';
        else if (lat > 24.7 && lat < 25.0 && lng > 121.5 && lng < 122.0) city = 'New Taipei';
        else if (lat > 23.3 && lat < 23.6 && lng > 120.3 && lng < 120.6) city = 'Chiayi';
        else if (lat > 23.8 && lat < 24.1 && lng > 120.6 && lng < 121.0) city = 'Changhua';
        else if (lat > 24.7 && lat < 24.9 && lng > 121.6 && lng < 122.0) city = 'Yilan';
        else if (lat > 23.9 && lat < 24.2 && lng > 121.4 && lng < 121.7) city = 'Hualien';

        return {
          id: `tw-thb-${(c.id || stake).replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}`,
          lat,
          lng,
          name: stake || c.id || 'THB Camera',
          city,
          country: 'Taiwan',
          feed_url: `/api/cctv/proxy?url=${encodeURIComponent(`${c.html}/snapshot`)}`,
          source: 'THB Highway Bureau',
        };
      });
  } catch (e) {
    console.warn('[OASIS] Taiwan THB fetch failed:', e);
    return [];
  }
}

export async function fetchTaiwanCameras(): Promise<CctvCamera[]> {
  const thb = await fetchTHBCameras();
  console.log(`[OASIS] Taiwan cameras — THB: ${thb.length}, YouTube: ${YOUTUBE_CAMERAS.length}`);
  return [...YOUTUBE_CAMERAS, ...thb];
}
