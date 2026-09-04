import { describe, it, expect } from 'vitest';
import { advance, reckon, converge, shortestLngDelta, distanceM, knotsToMps, type Fix } from './dead-reckoning';

const fix = (over: Partial<Fix> = {}): Fix => ({
  lat: 45.5017, lng: -73.5673,      // Montréal
  heading: 90, speedMps: 250, at: 1_000_000, ...over,
});

describe('advance', () => {
  it('moves east along a parallel for a heading of 090', () => {
    const p = advance(0, 0, 90, 111_195);   // ~1 degree at the equator
    expect(p.lng).toBeCloseTo(1, 2);
    expect(p.lat).toBeCloseTo(0, 6);
  });

  it('moves north for a heading of 000', () => {
    const p = advance(0, 0, 0, 111_195);
    expect(p.lat).toBeCloseTo(1, 2);
    expect(p.lng).toBeCloseTo(0, 6);
  });

  it('covers more longitude per metre at high latitude', () => {
    // Flat arithmetic misses this entirely: the same eastward distance is a
    // much larger longitude change at 60N than at the equator.
    const eq = advance(0, 0, 90, 100_000);
    const north = advance(60, 0, 90, 100_000);
    expect(Math.abs(north.lng)).toBeGreaterThan(Math.abs(eq.lng) * 1.8);
  });

  it('wraps across the antimeridian instead of running off the scale', () => {
    // A track that leaves at +179.9 must arrive near -180, not at +180.1, or
    // the follow camera swings the long way round the planet.
    const p = advance(0, 179.9, 90, 40_000);
    expect(p.lng).toBeLessThan(0);
    expect(p.lng).toBeGreaterThan(-180);
  });

  it('is a no-op for zero or non-finite distance', () => {
    expect(advance(10, 20, 45, 0)).toEqual({ lat: 10, lng: 20 });
    expect(advance(10, 20, 45, NaN)).toEqual({ lat: 10, lng: 20 });
  });
});

describe('reckon', () => {
  it('returns the observed position at the moment of the fix', () => {
    const f = fix();
    const r = reckon(f, f.at);
    expect(r.lat).toBeCloseTo(f.lat, 9);
    expect(r.lng).toBeCloseTo(f.lng, 9);
    expect(r.predicted).toBe(false);
    expect(r.staleness).toBe(0);
  });

  it('flies the aircraft forward between polls', () => {
    // 250 m/s for 20s is 5 km — the gap that makes an un-reckoned marker jump.
    const f = fix();
    const r = reckon(f, f.at + 20_000);
    expect(distanceM(f, r)).toBeGreaterThan(4_900);
    expect(distanceM(f, r)).toBeLessThan(5_100);
    expect(r.predicted).toBe(true);
    expect(r.staleness).toBeCloseTo(20, 3);
  });

  /**
   * A contact that stops reporting must look lost rather than be flown
   * confidently across an ocean on a heading it may have abandoned.
   */
  it('stops coasting once the fix is older than the bound', () => {
    const f = fix();
    const at2min = reckon(f, f.at + 120_000, 120);
    const at10min = reckon(f, f.at + 600_000, 120);
    expect(distanceM(at2min, at10min)).toBeLessThan(1);
    // But it still reports how stale it is, so the UI can say so.
    expect(at10min.staleness).toBeCloseTo(600, 1);
    expect(at10min.predicted).toBe(true);
  });

  it('holds position for a grounded or speedless contact', () => {
    const f = fix({ speedMps: 0 });
    const r = reckon(f, f.at + 60_000);
    expect(distanceM(f, r)).toBeLessThan(1);
  });

  it('treats a missing or negative speed as stationary rather than NaN', () => {
    for (const speedMps of [NaN, -100, undefined as unknown as number]) {
      const r = reckon(fix({ speedMps }), 1_060_000);
      expect(Number.isFinite(r.lat)).toBe(true);
      expect(Number.isFinite(r.lng)).toBe(true);
    }
  });
});

describe('converge', () => {
  it('closes on the truth without snapping to it', () => {
    const shown = { lat: 0, lng: 0 };
    const truth = { lat: 1, lng: 0 };
    const step = converge(shown, truth, 0.1);
    expect(step.lat).toBeGreaterThan(0);
    expect(step.lat).toBeLessThan(1);
  });

  it('converges further in a longer step, and is frame-rate independent', () => {
    const shown = { lat: 0, lng: 0 };
    const truth = { lat: 1, lng: 0 };
    // One 0.2s step must land at the same place as two 0.1s steps.
    const one = converge(shown, truth, 0.2);
    const two = converge(converge(shown, truth, 0.1), truth, 0.1);
    expect(one.lat).toBeCloseTo(two.lat, 6);
  });

  it('takes the short way round the antimeridian', () => {
    // 179 -> -179 is 2 degrees east, not 358 degrees west.
    const step = converge({ lat: 0, lng: 179 }, { lat: 0, lng: -179 }, 0.5);
    expect(step.lng).toBeGreaterThan(179);
  });

  it('is a no-op for a zero or invalid timestep', () => {
    const shown = { lat: 5, lng: 5 };
    expect(converge(shown, { lat: 9, lng: 9 }, 0)).toEqual(shown);
    expect(converge(shown, { lat: 9, lng: 9 }, NaN)).toEqual(shown);
  });
});

describe('shortestLngDelta', () => {
  it('never returns more than half the globe', () => {
    for (const [a, b] of [[179, -179], [-179, 179], [0, 190], [10, -170]]) {
      expect(Math.abs(shortestLngDelta(a, b))).toBeLessThanOrEqual(180);
    }
  });
});

describe('knotsToMps', () => {
  it('converts a typical cruise speed', () => {
    // 470 kt ~ 242 m/s.
    expect(knotsToMps(470)).toBeCloseTo(241.8, 0);
  });
});
