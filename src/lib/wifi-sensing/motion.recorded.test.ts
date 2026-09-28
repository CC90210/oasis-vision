import { describe, expect, it } from 'vitest';
import { RssiMotionDetector } from './motion';

/*
 * 648 consecutive RSSI reads (dBm, sign dropped) from `netsh wlan show
 * interfaces` on Windows 11 / Realtek 8852BE, 5 GHz ch 104, ~3.9 reads/s,
 * recorded 2026-09-27 through /api/wifi-sensing.
 *
 * Reads 0-~480: a still-looking link that glitches — single reads jump from
 * the -68..-71 band to -61..-64 and return on the next read, about one every
 * six seconds. Reads ~490-600: a sustained disturbance — the link flips to
 * the -61 band and holds it for runs of 2-13 reads.
 *
 * Before the median-of-3 filter, the detector flagged 42% of this recording,
 * most of it from the lone glitches. This fixture holds that fixed.
 */
const RECORDED = `
70 70 69 68 70 68 68 68 64 68 67 68 71 68 69 69 70 68 66 68 68 70 69 67 67 70 71 70 70 61 67 70 71 70 69 70 65 70 68 70
70 68 69 69 69 68 69 70 69 69 69 69 70 64 68 69 69 64 70 68 69 71 70 71 69 70 70 70 69 70 69 68 70 67 70 68 70 67 68 70
69 69 70 71 69 69 68 70 70 70 70 71 69 70 70 62 69 71 70 70 69 70 70 70 70 69 68 69 69 66 70 67 67 69 69 70 69 67 65 70
70 70 71 69 69 70 70 69 68 70 69 70 70 70 70 70 70 69 70 69 69 70 68 70 71 69 70 69 70 69 70 70 70 69 70 69 70 69 68 70
70 71 69 70 70 70 70 70 69 68 70 70 69 70 69 70 70 70 68 69 68 68 70 70 71 67 68 70 69 69 64 70 69 68 70 69 68 65 70 70
70 68 68 68 70 68 69 70 68 70 70 68 64 69 69 70 68 69 69 68 69 70 70 68 70 70 69 68 67 68 69 69 69 68 69 69 69 68 70 69
70 67 69 70 69 69 70 69 68 70 70 69 70 68 69 68 70 68 68 69 70 69 67 69 69 69 70 69 70 70 69 69 68 69 68 70 69 69 70 67
70 69 69 70 67 69 70 69 69 68 70 69 68 69 69 69 68 68 67 67 69 67 70 69 69 63 68 70 70 68 68 69 69 67 70 70 70 69 68 70
67 68 69 68 69 68 68 68 68 70 68 70 68 69 70 69 69 69 69 70 70 70 71 71 68 68 69 70 69 69 67 68 63 70 68 70 69 68 69 70
68 70 69 71 69 70 69 68 67 69 70 69 67 70 70 69 71 68 69 71 70 61 70 61 70 61 70 70 71 70 69 70 68 69 70 71 70 68 68 70
70 68 70 70 69 71 69 70 67 68 70 68 70 68 68 71 69 69 70 70 71 70 70 70 70 69 70 70 69 71 70 71 71 71 70 71 69 69 69 63
70 70 70 70 68 64 70 68 70 68 70 70 70 70 68 70 70 68 69 70 70 70 67 71 69 71 70 70 70 68 70 70 70 63 71 61 69 71 70 69
69 70 71 69 71 69 69 70 69 70 70 71 69 69 70 69 71 70 70 70 71 61 70 71 67 69 70 69 71 70 70 61 61 63 61 61 71 61 63 71
61 62 62 69 70 70 71 61 62 69 67 61 61 61 62 61 62 70 61 70 70 61 70 61 61 62 70 61 71 71 61 63 70 61 61 62 69 61 71 70
71 71 61 62 70 70 61 71 69 61 62 61 61 61 70 61 62 61 70 61 71 71 71 71 70 68 69 68 68 70 70 70 71 71 69 70 69 68 69 70
68 69 68 70 68 70 69 70 61 61 71 70 69 61 70 70 70 71 70 70 70 68 68 70 68 70 70 70 70 70 61 69 69 70 70 71 71 68 68 67
70 70 68 69 70 69 70 70`;

const READS = RECORDED.trim().split(/\s+/).map((v) => -Number(v));
const STEP_MS = 255;

function replay() {
  const d = new RssiMotionDetector();
  return READS.map((v, i) => d.push(1 + i * STEP_MS, v).level);
}
const flagged = (l: string) => l === 'motion' || l === 'strong';

describe('RssiMotionDetector on a recorded Windows link', () => {
  const levels = replay();

  it('uses the whole recording', () => {
    expect(READS).toHaveLength(648);
    expect(READS.every((v) => v <= -61 && v >= -71)).toBe(true);
  });

  it('does not report the adapter\'s lone glitches as movement', () => {
    const stretch = levels.slice(40, 470);
    const episodes = stretch.filter((l, i) => i > 0 && flagged(l) && !flagged(stretch[i - 1])).length;
    // One short episode remains: three glitches one read apart (reads ~381-386),
    // which no filter can tell from a real flutter. Everything else is quiet.
    expect(episodes).toBeLessThanOrEqual(1);
    expect(stretch.filter(flagged).length / stretch.length).toBeLessThan(0.03);
  });

  it('reports the sustained disturbance', () => {
    const burst = levels.slice(500, 600);
    expect(burst.filter(flagged).length / burst.length).toBeGreaterThan(0.6);
    expect(levels.slice(480, 530).some(flagged)).toBe(true);
  });
});
