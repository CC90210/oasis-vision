import { describe, it, expect } from 'vitest';
import { scoreRisk } from './route';

describe('scoreRisk', () => {
  /**
   * The score is a keyword tally and the readout must say so. Before this, a
   * headline scoring 8 rendered "AI Analysis indicates elevated tactical
   * priority based on OSINT stream patterns" in a red alert box — a fixed
   * sentence with no model anywhere in the path.
   */
  it('returns the terms that produced the score, not just a number', () => {
    const r = scoreRisk('Missile strike kills civilians near the frontline');
    expect(r.matched).toEqual(expect.arrayContaining(['missile', 'strike', 'frontline']));
    expect(r.score).toBe(Math.min(10, 1 + r.matched.length * 2));
  });

  /**
   * A known limitation, pinned rather than hidden: matching is plain substring
   * against uninflected keywords, so "kills" and "killing" do NOT match the
   * keyword "killed". Headlines are usually written in the present tense, so
   * this misses more than it looks like it should.
   *
   * Left as-is deliberately — widening the list shifts every score in the feed,
   * including across the flag threshold, and that is a behaviour change to make
   * on purpose with the operator, not a drive-by fix. Now at least it is
   * visible instead of being a silent scoring gap.
   */
  it('does not match inflected forms — a documented limitation, not a bug to hide', () => {
    expect(scoreRisk('Missile kills three').matched).toEqual(['missile']);
    expect(scoreRisk('Missile killed three').matched).toEqual(expect.arrayContaining(['missile', 'killed']));
  });

  it('scores a quiet headline at the floor with nothing matched', () => {
    const r = scoreRisk('Local council approves new bicycle lane');
    expect(r.matched).toEqual([]);
    expect(r.score).toBe(1);
  });

  it('caps at 10 however many terms match', () => {
    const r = scoreRisk('war missile strike attack crisis tension military conflict nuclear invasion bomb drone');
    expect(r.score).toBe(10);
    expect(r.matched.length).toBeGreaterThan(5);
  });

  /**
   * The flag threshold is 8, which needs four matches (1 + 4*2 = 9). Three
   * matches scores 7 and must NOT flag — pinned because the UI renders the
   * flag as a red critical box.
   */
  it('needs four terms to cross the flag threshold', () => {
    expect(scoreRisk('war missile strike').score).toBe(7);
    expect(scoreRisk('war missile strike attack').score).toBe(9);
  });

  it('is case-insensitive', () => {
    expect(scoreRisk('MISSILE STRIKE').matched).toEqual(scoreRisk('missile strike').matched);
  });

  it('does not double-count a term that appears twice', () => {
    // Otherwise a headline repeating one word outranks one naming four threats.
    expect(scoreRisk('missile missile missile').matched).toEqual(['missile']);
  });
});
