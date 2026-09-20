import type { CctvCamera } from './types';
import {
  LATAM_SKYLINE_CAMERAS,
  AFRICA_SKYLINE_CAMERAS,
  EUROPE_SKYLINE_CAMERAS,
} from './world-skyline.generated';

/**
 * OASIS VISION — public live webcams outside Asia.
 *
 * Fills the regions OASIS VISION had no CCTV coverage for at all: Latin America, the
 * Caribbean, Africa, and the European countries with no traffic-authority feed
 * of their own. Split by continent so viewport-scoped queries stay meaningful.
 */

export async function fetchLatamLiveCameras(): Promise<CctvCamera[]> {
  return LATAM_SKYLINE_CAMERAS;
}

export async function fetchAfricaLiveCameras(): Promise<CctvCamera[]> {
  return AFRICA_SKYLINE_CAMERAS;
}

export async function fetchEuropeLiveCameras(): Promise<CctvCamera[]> {
  return EUROPE_SKYLINE_CAMERAS;
}
