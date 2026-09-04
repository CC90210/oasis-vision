/**
 * OASIS VISION — smooth aircraft motion between position reports.
 *
 * ADS-B reaches us in polls tens of seconds apart, so a marker driven straight
 * from the feed teleports: it sits still, jumps, sits still. Following one is
 * unwatchable, and a follow camera chasing a teleporting target is worse.
 *
 * So each aircraft carries an anchor that advances continuously on its last
 * reported course and speed, and converges on the next real fix rather than
 * snapping to it. God's Eye View does the same thing for its cockpit mode
 * (src/ui.js:1216-1244) — this is that idea rebuilt as pure functions, with no
 * dependency on any map engine, which is why it can live here and be tested
 * without a browser.
 *
 * The rule this exists to enforce: dead reckoning is a display convenience, and
 * a predicted position is not an observation. `staleness` and `predicted` are
 * returned so the UI can say which one it is showing.
 */

const EARTH_RADIUS_M = 6_371_008.8;
const KNOTS_TO_MPS = 0.514444;
const DEG = Math.PI / 180;

export interface Fix {
  lat: number;
  lng: number;
  /** Degrees true, 0 = north. */
  heading: number;
  /** Metres per second. */
  speedMps: number;
  /** Epoch ms when this fix was observed. */
  at: number;
}

export interface Reckoned {
  lat: number;
  lng: number;
  heading: number;
  /** Seconds since the last real observation. */
  staleness: number;
  /** True when the position is extrapolated rather than observed. */
  predicted: boolean;
}

export function knotsToMps(knots: number): number {
  return knots * KNOTS_TO_MPS;
}

/**
 * Advance a point along a great circle.
 *
 * Flat-earth arithmetic (adding metres to degrees) is adequate for a few
 * seconds at low latitude and visibly wrong for a polar route or a long gap —
 * the error grows with 1/cos(lat), so a transatlantic flight at 60°N drifts
 * twice as fast sideways as the same maths suggests.
 */
export function advance(lat: number, lng: number, headingDeg: number, distanceM: number): { lat: number; lng: number } {
  if (!Number.isFinite(distanceM) || distanceM === 0) return { lat, lng };
  const d = distanceM / EARTH_RADIUS_M;
  const brg = headingDeg * DEG;
  const lat1 = lat * DEG;
  const lng1 = lng * DEG;

  const sinLat2 = Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg);
  const lat2 = Math.asin(Math.min(1, Math.max(-1, sinLat2)));
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * sinLat2,
    );

  return {
    lat: lat2 / DEG,
    // Keep longitude in -180..180 so a track across the antimeridian does not
    // send the camera the long way round the planet.
    lng: (((lng2 / DEG + 540) % 360) - 180),
  };
}

/**
 * Where an aircraft is now, given its last fix.
 *
 * `maxCoastSec` bounds how long a stale fix keeps being extrapolated. Past that
 * the aircraft is held at its last computed point rather than flown into the
 * ocean on a heading it may have abandoned minutes ago — a lost contact must
 * look lost, not confidently wrong.
 */
export function reckon(fix: Fix, nowMs: number, maxCoastSec = 120): Reckoned {
  const staleness = Math.max(0, (nowMs - fix.at) / 1000);
  const coast = Math.min(staleness, maxCoastSec);
  const speed = Number.isFinite(fix.speedMps) && fix.speedMps > 0 ? fix.speedMps : 0;
  const { lat, lng } = advance(fix.lat, fix.lng, fix.heading, speed * coast);
  return { lat, lng, heading: fix.heading, staleness, predicted: staleness > 0.5 };
}

/**
 * Blend the currently-displayed position toward the truth.
 *
 * A new fix rarely lands exactly where the reckoning predicted, and snapping to
 * it makes the marker twitch on every poll. Correcting a bounded fraction of
 * the error per frame absorbs the difference over a second or so.
 *
 * The bound is proportional to the gap, so a large divergence — a contact
 * reacquired after a long silence — still resolves promptly instead of crawling
 * for a minute.
 */
export function converge(
  shown: { lat: number; lng: number },
  truth: { lat: number; lng: number },
  dtSec: number,
  /** Fraction of remaining error removed per second. */
  rate = 3,
): { lat: number; lng: number } {
  if (!Number.isFinite(dtSec) || dtSec <= 0) return shown;
  // Exponential approach: frame-rate independent, unlike a fixed lerp factor.
  const t = 1 - Math.exp(-rate * dtSec);
  return {
    lat: shown.lat + (truth.lat - shown.lat) * t,
    lng: shown.lng + shortestLngDelta(shown.lng, truth.lng) * t,
  };
}

/** Signed shortest longitude difference, so convergence never crosses the globe. */
export function shortestLngDelta(from: number, to: number): number {
  return (((to - from + 540) % 360) - 180);
}

/** Great-circle distance in metres — used to decide when a contact has jumped. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = shortestLngDelta(a.lng, b.lng) * DEG;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}
