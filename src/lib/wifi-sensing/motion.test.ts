import { describe, expect, it } from 'vitest';
import { RssiMotionDetector } from './motion';
import type { MotionState } from './types';

// Deterministic PRNG so the noise is the same on every run.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HZ = 4;
const STEP = 1000 / HZ;

/** A still room: whole-dBm readings wandering ±1 dB, as Windows reports them. */
function quiet(rand: () => number) {
  return () => Math.round(-65 + (rand() - 0.5) * 2.4);
}

/** Someone walking through the link: a several-dB swing on top of the noise. */
function walking(rand: () => number, amp: number) {
  return (t: number) => Math.round(-65 + amp * Math.sin(2 * Math.PI * 0.7 * (t / 1000)) + (rand() - 0.5) * 2.4);
}

function run(d: RssiMotionDetector, fromMs: number, toMs: number, gen: (t: number) => number): MotionState[] {
  const out: MotionState[] = [];
  for (let t = fromMs; t < toMs; t += STEP) out.push(d.push(t, gen(t)));
  return out;
}

describe('RssiMotionDetector', () => {
  it('calibrates for the warm-up period before giving any verdict', () => {
    const d = new RssiMotionDetector();
    const states = run(d, 1, 9_000, quiet(mulberry32(1)));
    expect(states.every((s) => s.level === 'calibrating' && s.index === 0)).toBe(true);
  });

  it('stays quiet on a still link — no false motion over two minutes', () => {
    const d = new RssiMotionDetector();
    const states = run(d, 1, 120_000, quiet(mulberry32(2)));
    const judged = states.filter((s) => s.level !== 'calibrating');
    expect(judged.length).toBeGreaterThan(400);
    expect(judged.every((s) => s.level === 'quiet')).toBe(true);
  });

  it('reports movement within about a second of it starting, and clears after it stops', () => {
    const rand = mulberry32(3);
    const d = new RssiMotionDetector();
    run(d, 1, 30_000, quiet(rand));
    const during = run(d, 30_000, 40_000, walking(rand, 5));
    const firstHit = during.findIndex((s) => s.level === 'motion' || s.level === 'strong');
    expect(firstHit).toBeGreaterThanOrEqual(0);
    expect(firstHit * STEP).toBeLessThanOrEqual(2_000);
    expect(during.at(-1)?.level).toBe('strong');
    expect(during.at(-1)!.index).toBeGreaterThan(0.7);

    const after = run(d, 40_000, 50_000, quiet(rand));
    expect(after.at(-1)?.level).toBe('quiet');
    const cleared = after.findIndex((s) => s.level === 'quiet');
    expect(cleared * STEP).toBeLessThanOrEqual(5_000);
  });

  it('grades a gentler disturbance as motion, not strong', () => {
    const rand = mulberry32(4);
    const d = new RssiMotionDetector();
    run(d, 1, 30_000, quiet(rand));
    const during = run(d, 30_000, 40_000, walking(rand, 1.8));
    expect(during.at(-1)?.level).toBe('motion');
  });

  it('does not learn a long burst of movement as the new normal', () => {
    const rand = mulberry32(5);
    const d = new RssiMotionDetector();
    const calm = run(d, 1, 30_000, quiet(rand)).at(-1)!;
    const busy = run(d, 30_000, 60_000, walking(rand, 5)).at(-1)!;
    // Thirty seconds of walking moves the baseline only a little...
    expect(busy.baselineStdDb).toBeLessThan(calm.baselineStdDb * 2);
    // ...so the walking is still reported at the end of it.
    expect(busy.level).toBe('strong');
  });

  it('keeps reporting someone who paces for a full minute', () => {
    const rand = mulberry32(10);
    const d = new RssiMotionDetector();
    run(d, 1, 60_000, quiet(rand));
    const pacing = run(d, 60_000, 120_000, walking(rand, 5));
    expect(pacing.slice(-20).every((s) => s.level === 'strong')).toBe(true);
  });

  it('re-learns a link that becomes permanently noisier, within about three minutes', () => {
    const rand = mulberry32(9);
    const d = new RssiMotionDetector();
    run(d, 1, 60_000, quiet(rand));
    // The laptop is carried next to a microwave: a wider spread, for good.
    const noisier = () => Math.round(-70 + (rand() - 0.5) * 6);
    const states = run(d, 60_000, 300_000, noisier);
    expect(states.slice(0, 40).some((s) => s.level !== 'quiet')).toBe(true);
    expect(states.at(-1)?.level).toBe('quiet');
  });

  it('ignores a single glitched reading', () => {
    const rand = mulberry32(6);
    const d = new RssiMotionDetector();
    const q = quiet(rand);
    run(d, 1, 30_000, q);
    const states = run(d, 30_000, 36_000, (t) => (t === 30_000 ? -78 : q()));
    expect(states.every((s) => s.level === 'quiet')).toBe(true);
  });

  it('drops out-of-order and non-finite readings without advancing', () => {
    const d = new RssiMotionDetector();
    const a = d.push(1000, -60);
    expect(d.push(900, -80)).toBe(a);
    expect(d.push(2000, NaN)).toBe(a);
  });

  it('works at the slow macOS fallback rate by judging a longer window', () => {
    const rand = mulberry32(7);
    const d = new RssiMotionDetector();
    let last: MotionState | null = null;
    for (let t = 1; t < 90_000; t += 3_000) last = d.push(t, quiet(rand)());
    expect(last?.level).toBe('quiet');
    for (let t = 90_000; t < 120_000; t += 3_000) last = d.push(t, walking(rand, 6)(t * 0.37));
    expect(['motion', 'strong']).toContain(last?.level);
  });

  it('starts again from calibration after a reset (roaming to another access point)', () => {
    const d = new RssiMotionDetector();
    run(d, 1, 30_000, quiet(mulberry32(8)));
    d.reset();
    expect(d.push(31_000, -50).level).toBe('calibrating');
  });
});
