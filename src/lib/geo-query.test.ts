import { describe, it, expect } from 'vitest';
import { reduceAddress, queryLadder, isStreetType, isDirectional } from './geo-query';

describe('reduceAddress', () => {
  /**
   * The exact reported failure. Measured 2026-09-04: as typed it returns 0 hits
   * from both Photon and Nominatim; reduced to "1250 Rene-Levesque Montreal" it
   * returns the correct building from both. OSM stores the street as
   * "Boulevard René-Lévesque Ouest", so `Blvd` and `West` match nothing.
   */
  it('rescues the address that returned nothing', () => {
    expect(reduceAddress('1250 Rene-Levesque Blvd West Montreal'))
      .toBe('1250 Rene-Levesque Montreal');
  });

  it('drops unit noise no geocoder indexes', () => {
    expect(reduceAddress('350 Sparks Street Suite 400 Ottawa'))
      .toBe('350 Sparks Ottawa');
  });

  it('handles French street types, since the home city is Montreal', () => {
    expect(reduceAddress('4529 Rue Sainte-Catherine Est Montreal'))
      .toBe('4529 Sainte-Catherine Montreal');
  });

  /**
   * The reduction must not fire on queries that already work — it would throw
   * away the ranking the operator saw. Nothing to strip means null.
   */
  it('returns null when there is nothing to strip', () => {
    expect(reduceAddress('Eiffel Tower Paris')).toBeNull();
    expect(reduceAddress('Montreal Biosphere')).toBeNull();
    expect(reduceAddress('Kyiv')).toBeNull();
  });

  it('returns null rather than eating the whole query', () => {
    // "West Street" is entirely street-type and directional; reducing it leaves
    // nothing to search, which would turn a bad result into no result.
    expect(reduceAddress('the West Street')).toBeNull();
  });

  it('keeps the saint in a name that starts with St', () => {
    // "St" here is Saint, not Street — stripping it would search for "Laurent".
    expect(reduceAddress('St Laurent Boulevard Montreal'))
      .toBe('St Laurent Montreal');
  });

  it('strips St when it really is the street suffix', () => {
    expect(reduceAddress('350 Sparks St West Ottawa')).toBe('350 Sparks Ottawa');
  });

  it('does not strip a leading directional that is part of a place name', () => {
    // "West Island" is a region of Montreal.
    expect(reduceAddress('West Island Montreal Quebec')).toBeNull();
  });
});

describe('isStreetType / isDirectional', () => {
  it('treats ambiguous tokens by position, not by spelling alone', () => {
    const saint = ['St', 'Laurent', 'Boulevard'];
    expect(isStreetType(saint, 0)).toBe(false);
    const suffix = ['Sparks', 'St'];
    expect(isStreetType(suffix, 1)).toBe(true);
    const beforeDir = ['Sparks', 'St', 'West'];
    expect(isStreetType(beforeDir, 1)).toBe(true);
  });

  it('never strips a leading directional', () => {
    expect(isDirectional(['West', 'Island'], 0)).toBe(false);
    expect(isDirectional(['Sainte-Catherine', 'Est'], 1)).toBe(true);
  });
});

describe('queryLadder', () => {
  it('always searches what was typed first', () => {
    const ladder = queryLadder('1250 Rene-Levesque Blvd West Montreal');
    expect(ladder[0]).toBe('1250 Rene-Levesque Blvd West Montreal');
    expect(ladder).toHaveLength(2);
  });

  it('is a single step when reduction gains nothing', () => {
    expect(queryLadder('Eiffel Tower Paris')).toEqual(['Eiffel Tower Paris']);
  });
});
