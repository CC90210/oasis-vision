import { describe, it, expect } from 'vitest';
import { AircraftTracker, type AircraftInput } from './aircraft-motion';
import { distanceM } from './dead-reckoning';

const ac = (over: Partial<AircraftInput> = {}): AircraftInput => ({
  icao24: 'abc123', callsign: 'ACA123',
  lat: 45.5, lng: -73.6, heading: 90, speed_knots: 480, ...over,
});

describe('AircraftTracker', () => {
  /**
   * The reported bug: aircraft sat motionless between polls because the map
   * drew the last packet and nothing advanced it.
   */
  it('moves an aircraft between polls without new data', () => {
    const t = new AircraftTracker();
    const t0 = 1_000_000;
    t.update([ac()], t0);
    const start = t.points()[0].geometry as GeoJSON.Point;

    // No new feed data — only time passing.
    t.step(t0 + 20_000, 20);
    const later = t.points()[0].geometry as GeoJSON.Point;

    const moved = distanceM(
      { lat: start.coordinates[1], lng: start.coordinates[0] },
      { lat: later.coordinates[1], lng: later.coordinates[0] },
    );
    // 480 kt for 20s is roughly 4.9 km. Convergence damps it slightly.
    expect(moved).toBeGreaterThan(3_000);
  });

  it('builds a trail, which is what makes a heading readable', () => {
    const t = new AircraftTracker();
    t.update([ac()], 0);
    for (let i = 1; i <= 5; i++) t.step(i * 2000, 2);
    const trails = t.trails();
    expect(trails).toHaveLength(1);
    const line = trails[0].geometry as GeoJSON.LineString;
    expect(line.coordinates.length).toBeGreaterThan(2);
  });

  it('caps the trail so memory does not grow without bound', () => {
    const t = new AircraftTracker();
    t.update([ac()], 0);
    for (let i = 1; i <= 200; i++) t.step(i * 1000, 1);
    const line = t.trails()[0].geometry as GeoJSON.LineString;
    expect(line.coordinates.length).toBeLessThanOrEqual(24);
  });

  it('does not grow a trail for a stationary contact', () => {
    // A parked aircraft would otherwise accumulate 24 identical points and
    // draw a zero-length line.
    const t = new AircraftTracker();
    t.update([ac({ speed_knots: 0 })], 0);
    for (let i = 1; i <= 30; i++) t.step(i * 1000, 1);
    expect(t.trails()).toHaveLength(0);
  });

  it('keys on icao24 so a callsign change does not split one airframe', () => {
    const t = new AircraftTracker();
    t.update([ac({ callsign: 'ACA123' })], 0);
    t.update([ac({ callsign: 'ACA124' })], 1000);
    expect(t.size).toBe(1);
  });

  it('falls back to callsign when there is no icao24', () => {
    const t = new AircraftTracker();
    t.update([ac({ icao24: undefined })], 0);
    expect(t.size).toBe(1);
  });

  it('ignores records with no usable identity or position', () => {
    const t = new AircraftTracker();
    t.update([
      ac({ icao24: undefined, callsign: undefined }),
      ac({ icao24: 'x1', lat: NaN }),
      ac({ icao24: 'x2', lng: Infinity }),
    ], 0);
    expect(t.size).toBe(0);
  });

  /**
   * ADS-B ids are reused. Sliding to a reused id would draw the marker across
   * a continent over a second and leave a trail through everything between.
   */
  it('teleports rather than sliding when an id reappears far away', () => {
    const t = new AircraftTracker();
    t.update([ac({ lat: 45.5, lng: -73.6 })], 0);
    t.step(1000, 1);
    t.update([ac({ lat: -33.9, lng: 151.2 })], 2000);   // Sydney
    t.step(3000, 1);
    const p = t.points()[0].geometry as GeoJSON.Point;
    expect(p.coordinates[1]).toBeCloseTo(-33.9, 0);
    // And the trail restarts rather than spanning the planet.
    expect(t.trails().length === 0 || (t.trails()[0].geometry as GeoJSON.LineString).coordinates.length < 4).toBe(true);
  });

  it('forgets contacts that stop appearing, so ghosts do not accumulate', () => {
    const t = new AircraftTracker();
    t.update([ac()], 0);
    expect(t.size).toBe(1);
    t.update([], 6 * 60_000);   // six minutes later, absent from the feed
    expect(t.size).toBe(0);
  });

  it('keeps a contact that is still being reported', () => {
    const t = new AircraftTracker();
    t.update([ac()], 0);
    t.update([ac()], 4 * 60_000);
    expect(t.size).toBe(1);
  });

  it('carries feed properties through to the rendered feature', () => {
    const t = new AircraftTracker();
    t.update([ac({ callsign: 'ACA123', alt: 11000 })], 0);
    const p = t.points()[0].properties!;
    expect(p.callsign).toBe('ACA123');
    expect(p.alt).toBe(11000);
    expect(p.heading).toBe(90);
  });

  it('exposes a position for a follow camera to read', () => {
    const t = new AircraftTracker();
    t.update([ac()], 0);
    const pos = t.positionOf('abc123');
    expect(pos).not.toBeNull();
    expect(pos!.lat).toBeCloseTo(45.5, 3);
    expect(t.positionOf('nope')).toBeNull();
  });

  it('handles a whole poll of aircraft', () => {
    const t = new AircraftTracker();
    const many = Array.from({ length: 500 }, (_, i) =>
      ac({ icao24: `ac${i}`, lat: 40 + (i % 20) * 0.1, lng: -70 - (i % 20) * 0.1 }));
    t.update(many, 0);
    t.step(1000, 1);
    expect(t.size).toBe(500);
    expect(t.points()).toHaveLength(500);
  });
});
