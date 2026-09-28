/**
 * Motion from a single WiFi link's RSSI.
 *
 * A person moving near the path between this computer and its access point
 * changes the multipath the receiver sees, and the RSSI starts to wander. A
 * still room produces a small, steady spread. So the detector compares the
 * spread of the last few seconds against the spread this link shows when it is
 * quiet, learned as it runs.
 *
 * What it cannot do, and the view must never imply: tell a person from a door,
 * a fan, the laptop being picked up or a microwave; count people; locate them;
 * or see anyone who is sitting still. It answers one question — "is the link
 * being disturbed right now, compared with how it behaves when nothing moves?"
 *
 * The quiet baseline is a low percentile of the spreads seen over the last
 * three minutes. A room is almost never in motion for 90% of three minutes, so
 * someone pacing for a minute is still reported at the end of it instead of
 * being learned as normal (an EMA baseline failed exactly that test: thirty
 * seconds of walking raised it 2.5x and downgraded the verdict). A link that
 * becomes permanently noisier — the laptop carried to another room — is
 * re-learned once the old quiet readings age out, in about three minutes.
 */
import type { MotionLevel, MotionState } from './types';

export interface MotionOptions {
  /** Readings considered "now". */
  shortWindowMs: number;
  /** Time spent learning the quiet baseline before any verdict is given. */
  warmupMs: number;
  /**
   * Floor for the baseline spread, dB. Windows reports whole dBm, and whole-dB
   * rounding alone gives a spread of ~0.3-0.5 dB, so a baseline below this
   * would flag rounding noise as movement.
   */
  minBaselineStdDb: number;
  /** Consecutive readings a new level must hold before it is reported. */
  hysteresisReads: number;
  /** Spread ratios (short / baseline) at which `motion` and `strong` begin. */
  motionRatio: number;
  strongRatio: number;
  /** How far back the quiet baseline looks, and which percentile of it counts as quiet. */
  baselineHorizonMs: number;
  baselinePercentile: number;
}

/** Readings needed before a spread means anything. */
const MIN_SAMPLES = 5;

export const DEFAULT_MOTION_OPTIONS: MotionOptions = {
  shortWindowMs: 3000,
  warmupMs: 10_000,
  minBaselineStdDb: 0.6,
  hysteresisReads: 3,
  motionRatio: 1.8,
  strongRatio: 3.2,
  baselineHorizonMs: 180_000,
  baselinePercentile: 0.1,
};

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

function percentile(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

export class RssiMotionDetector {
  private readonly opts: MotionOptions;
  private window: Array<{ t: number; v: number }> = [];
  private spreads: Array<{ t: number; s: number }> = [];
  private baseline: number | null = null;
  private firstT: number | null = null;
  private level: MotionLevel = 'calibrating';
  private candidate: MotionLevel | null = null;
  private candidateReads = 0;
  private lastT = -Infinity;
  private last: MotionState = RssiMotionDetector.empty();

  constructor(opts: Partial<MotionOptions> = {}) {
    this.opts = { ...DEFAULT_MOTION_OPTIONS, ...opts };
  }

  private static empty(): MotionState {
    return { level: 'calibrating', index: 0, meanDbm: NaN, shortStdDb: 0, baselineStdDb: 0, learnedSeconds: 0 };
  }

  /** The state after the most recent accepted reading. */
  get current(): MotionState {
    return this.last;
  }

  reset(): void {
    this.window = [];
    this.spreads = [];
    this.baseline = null;
    this.firstT = null;
    this.level = 'calibrating';
    this.candidate = null;
    this.candidateReads = 0;
    this.lastT = -Infinity;
    this.last = RssiMotionDetector.empty();
  }

  /** Feed one reading; returns the state after it. Out-of-order readings are ignored. */
  push(t: number, rssiDbm: number): MotionState {
    if (!Number.isFinite(t) || !Number.isFinite(rssiDbm) || t <= this.lastT) return this.last;
    this.lastT = t;
    if (this.firstT == null) this.firstT = t;

    this.window.push({ t, v: rssiDbm });
    // Time-based, but never fewer than MIN_SAMPLES: on the slow macOS fallback
    // (one read per ~3 s) a 3 s window would hold one reading and never judge.
    const cutoff = t - this.opts.shortWindowMs;
    while (this.window.length > MIN_SAMPLES && this.window[0].t < cutoff) this.window.shift();

    if (this.window.length >= MIN_SAMPLES) {
      this.spreads.push({ t, s: this.stats().std });
      const horizon = t - this.opts.baselineHorizonMs;
      while (this.spreads.length && this.spreads[0].t < horizon) this.spreads.shift();
      this.baseline = percentile(this.spreads.map((x) => x.s), this.opts.baselinePercentile);
    }
    this.last = this.evaluate(t);
    return this.last;
  }

  /**
   * Mean of the raw readings, and the spread of the window after two
   * de-glitching steps, so that only a disturbance that persists counts:
   *
   *  1. Median-of-3. Recorded on a still Windows 11 link (Realtek 8852BE):
   *     isolated reads 9 dB above the rest, one every ~6 s, each gone on the
   *     next read. Movement holds a new level for more than one read (runs of
   *     2-13 reads in the same recording) and survives the filter.
   *  2. The most extreme filtered reading per ten is set aside, for the case
   *     the median cannot fix: two glitches one read apart.
   */
  private stats(): { mean: number; std: number } {
    const raw = this.window.map((s) => s.v);
    const n = raw.length;
    if (!n) return { mean: NaN, std: 0 };
    const mean = raw.reduce((a, b) => a + b, 0) / n;
    const vals = n >= 3 ? raw.slice(1, -1).map((v, i) => median3(raw[i], v, raw[i + 2])) : raw;
    const sorted = [...vals].sort((a, b) => a - b);
    const k = sorted.length;
    const median = k % 2 ? sorted[(k - 1) / 2] : (sorted[k / 2 - 1] + sorted[k / 2]) / 2;
    const kept = vals
      .sort((a, b) => Math.abs(a - median) - Math.abs(b - median))
      .slice(0, k - Math.floor(k / 10));
    const m = kept.reduce((a, b) => a + b, 0) / kept.length;
    const sq = kept.reduce((a, b) => a + (b - m) ** 2, 0);
    return { mean, std: kept.length > 1 ? Math.sqrt(sq / (kept.length - 1)) : 0 };
  }

  /** Called once per accepted reading: it advances the hysteresis counter. */
  private evaluate(t: number): MotionState {
    const { mean, std } = this.stats();
    const learned = this.firstT == null ? 0 : Math.max(0, t - this.firstT);
    const base = Math.max(this.baseline ?? 0, this.opts.minBaselineStdDb);
    const ratio = std / base;

    let next: MotionLevel;
    if (learned < this.opts.warmupMs || this.window.length < MIN_SAMPLES) next = 'calibrating';
    else if (ratio >= this.opts.strongRatio) next = 'strong';
    else if (ratio >= this.opts.motionRatio) next = 'motion';
    else next = 'quiet';

    if (next === this.level) {
      this.candidate = null;
      this.candidateReads = 0;
    } else if (this.level === 'calibrating' && next !== 'calibrating') {
      // Leaving warm-up is not a transition to debounce.
      this.level = next;
    } else if (next === this.candidate) {
      if (++this.candidateReads >= this.opts.hysteresisReads) {
        this.level = next;
        this.candidate = null;
        this.candidateReads = 0;
      }
    } else {
      this.candidate = next;
      this.candidateReads = 1;
    }

    // 0 at the quiet spread, 1 at a quarter past the strong threshold.
    const full = this.opts.strongRatio * 1.25 - 1;
    return {
      level: this.level,
      index: this.level === 'calibrating' ? 0 : Math.max(0, Math.min(1, (ratio - 1) / full)),
      meanDbm: mean,
      shortStdDb: std,
      baselineStdDb: base,
      learnedSeconds: Math.round(learned / 100) / 10,
    };
  }
}
