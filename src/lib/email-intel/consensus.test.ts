import { describe, it, expect } from 'vitest';
import { buildConsensus, normaliseName, looksLikeName } from './consensus';
import type { NameSignal } from './types';

const sig = (name: string, source: string, weight = 0.8): NameSignal => ({ name, source, weight });

describe('normaliseName', () => {
  it('folds diacritics, punctuation and spacing so variants agree', () => {
    expect(normaliseName('Jean-Luc Picard')).toBe(normaliseName('Jean Luc Picard'));
    expect(normaliseName('Renée  O’Hara')).toBe('renee o hara');
  });
});

describe('looksLikeName', () => {
  it('rejects placeholders, numbers and handles with no word in them', () => {
    expect(looksLikeName('unknown')).toBe(false);
    expect(looksLikeName('12345')).toBe(false);
    expect(looksLikeName('x_1337_x')).toBe(false);
    expect(looksLikeName('an')).toBe(false);
  });

  it('accepts ordinary human names', () => {
    expect(looksLikeName('Katriel Moses')).toBe(true);
    expect(looksLikeName('Renée O’Hara')).toBe(true);
  });
});

describe('buildConsensus', () => {
  it('claims nothing when no source reported a name', () => {
    const r = buildConsensus([]);
    expect(r.name).toBeNull();
    expect(r.confidence).toBe('unknown');
  });

  it('grades a single source as possible, never confirmed', () => {
    const r = buildConsensus([sig('Jane Doe', 'GitHub')]);
    expect(r.name).toBe('Jane Doe');
    expect(r.confidence).toBe('possible');
    expect(r.reasoning).toMatch(/single source is not corroboration/i);
  });

  it('needs three independent sources to confirm', () => {
    const two = buildConsensus([sig('Jane Doe', 'GitHub'), sig('Jane Doe', 'Gravatar')]);
    expect(two.confidence).toBe('probable');

    const three = buildConsensus([
      sig('Jane Doe', 'GitHub'),
      sig('Jane Doe', 'Gravatar'),
      sig('Jane Doe', 'PGP keyserver', 0.9),
    ]);
    expect(three.confidence).toBe('confirmed');
    expect(three.sources).toEqual(['GitHub', 'Gravatar', 'PGP keyserver']);
  });

  it('does not let one source vote twice to manufacture agreement', () => {
    const r = buildConsensus([
      sig('Jane Doe', 'GitHub'),
      sig('Jane Doe', 'GitHub'),
      sig('Jane Doe', 'GitHub'),
    ]);
    expect(r.sources).toEqual(['GitHub']);
    expect(r.confidence).toBe('possible');
  });

  it('treats spelling variants of one name as agreement', () => {
    const r = buildConsensus([
      sig('Jean-Luc Picard', 'GitHub'),
      sig('Jean Luc Picard', 'Gravatar'),
      sig('Jean-Luc Picard', 'PGP keyserver', 0.9),
    ]);
    expect(r.confidence).toBe('confirmed');
    expect(r.sources).toHaveLength(3);
  });

  it('claims NO name when two candidates are equally supported', () => {
    const r = buildConsensus([
      sig('Jane Doe', 'GitHub'),
      sig('John Smith', 'Gravatar'),
    ]);
    expect(r.name).toBeNull();
    expect(r.confidence).toBe('unknown');
    expect(r.reasoning).toMatch(/disagree/i);
    // Both candidates still surface for the analyst to judge.
    expect(r.candidates).toHaveLength(2);
  });

  it('picks the better-supported name when the field is not tied', () => {
    const r = buildConsensus([
      sig('Jane Doe', 'GitHub'),
      sig('Jane Doe', 'Gravatar'),
      sig('John Smith', 'PGP keyserver'),
    ]);
    expect(r.name).toBe('Jane Doe');
    expect(r.confidence).toBe('probable');
  });

  it('ignores junk candidates entirely', () => {
    const r = buildConsensus([sig('Jane Doe', 'GitHub'), sig('unknown', 'Gravatar')]);
    expect(r.candidates).toHaveLength(1);
    expect(r.name).toBe('Jane Doe');
  });
});
