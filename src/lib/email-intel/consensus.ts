/**
 * ═══════════════════════════════════════════════════════════════
 *  OASIS VISION — Name consensus
 *
 *  Turns a pile of weak name signals into one claim with a stated
 *  confidence, or into no claim at all.
 *
 *  The rule that matters: confidence comes from INDEPENDENT AGREEMENT,
 *  never from a single source sounding authoritative. One profile that
 *  says "Jane Doe" is `possible`. Four unrelated sources that all say
 *  "Jane Doe" is `confirmed`. A source seen twice is still one source.
 *
 *  This is the direct expression of the project's first non-negotiable:
 *  never label a thing as more than it is.
 * ═══════════════════════════════════════════════════════════════
 */

import type { NameSignal, IdentitySummary, NameConfidence } from './types';

/**
 * Normalise for COMPARISON only — the displayed name keeps its original
 * casing and accents. Strips punctuation, collapses whitespace, folds
 * diacritics so "Jean-Luc Picard" and "Jean Luc Picard" agree.
 */
export function normaliseName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reject strings that are obviously not a person's name before they can
 * win a consensus. Usernames and placeholders leak in from profile
 * fields constantly.
 */
export function looksLikeName(candidate: string): boolean {
  const n = normaliseName(candidate);
  if (n.length < 3 || n.length > 70) return false;
  if (/^\d+$/.test(n)) return false;
  if (/(unknown|anonymous|null|undefined|test user|no name|n a)$/.test(n)) return false;
  // A name has letters. A handle like "x_1337_x" normalises to "x 1337 x".
  if (!/[a-z]{2}/.test(n)) return false;
  return true;
}

/**
 * Thresholds. Deliberately demanding: `confirmed` needs three
 * independent sources, because two can trivially be the same datum
 * copied between services (a GitHub profile scraped into a directory,
 * then into an aggregator).
 */
const CONFIRMED_SOURCES = 3;
const PROBABLE_SOURCES = 2;

function bandFor(sourceCount: number, totalWeight: number): NameConfidence {
  if (sourceCount >= CONFIRMED_SOURCES && totalWeight >= 2.0) return 'confirmed';
  if (sourceCount >= PROBABLE_SOURCES && totalWeight >= 1.2) return 'probable';
  if (sourceCount >= 1) return 'possible';
  return 'unknown';
}

function describe(band: NameConfidence, sources: string[]): string {
  const list = sources.join(', ');
  switch (band) {
    case 'confirmed':
      return `${sources.length} independent sources agree (${list}).`;
    case 'probable':
      return `${sources.length} independent sources agree (${list}), short of the 3 required to confirm.`;
    case 'possible':
      return `Only ${list} reports this name. A single source is not corroboration.`;
    default:
      return 'No source reported a usable name.';
  }
}

/**
 * Collapse signals into a graded identity.
 *
 * Deduplicates by (normalised name, source) so a source that reports the
 * same name twice cannot inflate its own agreement count — the single
 * easiest way to manufacture false confidence.
 */
export function buildConsensus(signals: NameSignal[]): IdentitySummary {
  const usable = signals.filter((s) => s.name && looksLikeName(s.name));

  if (usable.length === 0) {
    return {
      name: null,
      confidence: 'unknown',
      sources: [],
      reasoning: describe('unknown', []),
      candidates: [],
    };
  }

  // key -> { display, sources: Map<source, weight> }
  const groups = new Map<string, { display: string; sources: Map<string, number> }>();

  for (const sig of usable) {
    const key = normaliseName(sig.name);
    let group = groups.get(key);
    if (!group) {
      group = { display: sig.name.trim(), sources: new Map() };
      groups.set(key, group);
    }
    // Same source twice: keep the stronger signal, do not add a second vote.
    const existing = group.sources.get(sig.source);
    if (existing === undefined || sig.weight > existing) {
      group.sources.set(sig.source, sig.weight);
    }
  }

  const candidates = [...groups.values()]
    .map((g) => {
      const sources = [...g.sources.keys()].sort();
      const weight = [...g.sources.values()].reduce((a, b) => a + b, 0);
      return { name: g.display, sources, score: Number(weight.toFixed(2)), count: sources.length };
    })
    // Most independent sources wins; weight breaks the tie.
    .sort((a, b) => b.count - a.count || b.score - a.score);

  const top = candidates[0];
  const runnerUp = candidates[1];

  // A genuine tie between two different names is not a 'possible' claim
  // for the alphabetically-first one — it is a contested identity, and
  // reporting either as the answer would be the exact failure mode this
  // module exists to prevent.
  const contested =
    runnerUp !== undefined &&
    runnerUp.count === top.count &&
    Math.abs(runnerUp.score - top.score) < 0.01;

  if (contested) {
    return {
      name: null,
      confidence: 'unknown',
      sources: [],
      reasoning:
        `Sources disagree: "${top.name}" (${top.sources.join(', ')}) and ` +
        `"${runnerUp.name}" (${runnerUp.sources.join(', ')}) are equally supported. No name claimed.`,
      candidates: candidates.map(({ name, sources, score }) => ({ name, sources, score })),
    };
  }

  const band = bandFor(top.count, top.score);

  return {
    name: top.name,
    confidence: band,
    sources: top.sources,
    reasoning: describe(band, top.sources),
    candidates: candidates.map(({ name, sources, score }) => ({ name, sources, score })),
  };
}
