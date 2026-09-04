/**
 * OASIS VISION — keeping aircraft moving between position reports.
 *
 * The feed arrives in polls tens of seconds apart. Rendering it straight makes
 * every aircraft sit motionless and then jump, which is what "the planes aren't
 * moving" means: nothing is wrong with the data, the map was only ever drawing
 * the last packet.
 *
 * This holds the last fix per aircraft and produces an interpolated position
 * for any instant, so the map can be redrawn at animation rate from a feed that
 * updates twice a minute. It also keeps a short trail, which is what makes a
 * heading legible at a glance.
 *
 * Pure state + functions, no map engine, so it is testable without a browser.
 */

import { reckon, converge, distanceM, type Fix } from './dead-reckoning';

export interface AircraftInput {
  callsign?: string;
  icao24?: string;
  lat: number;
  lng: number;
  heading?: number;
  speed_knots?: number;
  [k: string]: unknown;
}

interface TrackState {
  fix: Fix;
  /** Where it is currently drawn — converges toward the reckoned truth. */
  shown: { lat: number; lng: number };
  /** Recent drawn positions, oldest first. */
  trail: [number, number][];
  /** Everything the popup and styling need, carried through untouched. */
  props: Record<string, unknown>;
  lastSeen: number;
}

const KNOTS_TO_MPS = 0.514444;
/** Trail length. Enough to read a heading; long enough to cost memory if unbounded. */
const MAX_TRAIL = 24;
/** Drop an aircraft this long after its last appearance in the feed. */
const FORGET_AFTER_MS = 5 * 60_000;
/**
 * A jump larger than this is a different aircraft reusing an id, or a bad fix.
 * Teleport rather than sliding the marker across a continent over a second.
 */
const TELEPORT_M = 200_000;

export class AircraftTracker {
  private tracks = new Map<string, TrackState>();

  /** Stable key: ICAO24 is unique per airframe; callsign is the fallback. */
  static key(a: AircraftInput): string | null {
    const k = (a.icao24 || a.callsign || '').toString().trim();
    return k || null;
  }

  /** Feed a poll's worth of aircraft. */
  update(list: AircraftInput[], now: number): void {
    for (const a of list || []) {
      const k = AircraftTracker.key(a);
      if (!k) continue;
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lng)) continue;

      const fix: Fix = {
        lat: a.lat,
        lng: a.lng,
        heading: Number.isFinite(a.heading as number) ? (a.heading as number) : 0,
        speedMps: Number.isFinite(a.speed_knots as number) ? (a.speed_knots as number) * KNOTS_TO_MPS : 0,
        at: now,
      };

      const prev = this.tracks.get(k);
      if (!prev) {
        this.tracks.set(k, { fix, shown: { lat: a.lat, lng: a.lng }, trail: [[a.lng, a.lat]], props: { ...a }, lastSeen: now });
        continue;
      }

      // An id that reappears somewhere impossible is not the same flight
      // continuing; sliding to it would draw a line across a continent.
      const jumped = distanceM(prev.shown, fix) > TELEPORT_M;
      prev.fix = fix;
      prev.props = { ...a };
      prev.lastSeen = now;
      if (jumped) {
        prev.shown = { lat: a.lat, lng: a.lng };
        prev.trail = [[a.lng, a.lat]];
      }
    }

    // Forget anything that has stopped appearing, or the map accumulates ghosts.
    for (const [k, t] of this.tracks) {
      if (now - t.lastSeen > FORGET_AFTER_MS) this.tracks.delete(k);
    }
  }

  /**
   * Advance every track to `now` and return drawable positions.
   *
   * `dtSec` is the wall time since the previous call, used for convergence.
   */
  step(now: number, dtSec: number): void {
    for (const t of this.tracks.values()) {
      const truth = reckon(t.fix, now);
      t.shown = converge(t.shown, truth, dtSec);
      const last = t.trail[t.trail.length - 1];
      // Only extend the trail when the aircraft has actually moved, so a
      // parked contact does not accumulate 24 identical points.
      if (!last || Math.abs(last[0] - t.shown.lng) > 1e-5 || Math.abs(last[1] - t.shown.lat) > 1e-5) {
        t.trail.push([t.shown.lng, t.shown.lat]);
        if (t.trail.length > MAX_TRAIL) t.trail.shift();
      }
    }
  }

  /** Point features at the interpolated positions. */
  points(): GeoJSON.Feature[] {
    const out: GeoJSON.Feature[] = [];
    for (const t of this.tracks.values()) {
      out.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [t.shown.lng, t.shown.lat] },
        properties: { ...t.props, heading: t.fix.heading, predicted: reckonStale(t.fix) },
      });
    }
    return out;
  }

  /** Trail lines. Only tracks with a real trail get one. */
  trails(): GeoJSON.Feature[] {
    const out: GeoJSON.Feature[] = [];
    for (const t of this.tracks.values()) {
      if (t.trail.length < 2) continue;
      out.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: t.trail },
        properties: { callsign: t.props.callsign ?? '' },
      });
    }
    return out;
  }

  /** The drawn position of one aircraft — what a follow camera reads. */
  positionOf(key: string): { lat: number; lng: number; heading: number } | null {
    const t = this.tracks.get(key);
    return t ? { ...t.shown, heading: t.fix.heading } : null;
  }

  get size(): number {
    return this.tracks.size;
  }

  clear(): void {
    this.tracks.clear();
  }
}

/** True once a fix is old enough that the shown position is extrapolated. */
function reckonStale(fix: Fix, now = Date.now()): boolean {
  return now - fix.at > 500;
}
