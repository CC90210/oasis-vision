import { describe, it, expect } from 'vitest';
import { lookupAreaCode, isNonGeographic, NANP_AREA_COUNT } from './nanp';

/**
 * The bug these exist to prevent: the previous table held 15 area codes and the
 * route fell back to a country centroid for everything else, so a 705 number
 * (northeastern Ontario) was plotted at 56.13,-106.35 — rural Saskatchewan —
 * and rendered as a target pin.
 */
describe('lookupAreaCode', () => {
  it('resolves 705 to northeastern Ontario, not the centre of Canada', () => {
    const a = lookupAreaCode('705')!;
    expect(a.region).toBe('ON');
    expect(a.country).toBe('CA');
    // Anywhere near 56.13,-106.35 means the centroid bug is back.
    expect(a.lat).toBeGreaterThan(45);
    expect(a.lat).toBeLessThan(48);
    expect(a.lng).toBeLessThan(-79);
    expect(a.lng).toBeGreaterThan(-83);
  });

  it('maps both Montreal area codes to Montreal', () => {
    for (const code of ['514', '438']) {
      const a = lookupAreaCode(code)!;
      expect(a.region).toBe('QC');
      expect(a.lat).toBeCloseTo(45.50, 1);
      expect(a.lng).toBeCloseTo(-73.57, 1);
    }
  });

  it('returns null for an unlisted code rather than guessing a centroid', () => {
    // 907 is Alaska and deliberately not in the table. A wrong pin reads as
    // intelligence; an absent one reads as absent.
    expect(lookupAreaCode('907')).toBeNull();
  });

  it('returns null for toll-free and service codes, which have no geography', () => {
    for (const code of ['800', '833', '844', '855', '866', '877', '888', '900', '911']) {
      expect(lookupAreaCode(code)).toBeNull();
    }
  });

  it('rejects malformed area codes', () => {
    // NANP area codes never start with 0 or 1.
    expect(lookupAreaCode('012')).toBeNull();
    expect(lookupAreaCode('123')).toBeNull();
    expect(lookupAreaCode('70')).toBeNull();
    expect(lookupAreaCode('7055')).toBeNull();
    expect(lookupAreaCode('')).toBeNull();
    expect(lookupAreaCode('abc')).toBeNull();
  });

  it('covers every Canadian province and territory', () => {
    // One representative code per jurisdiction — a missing entry here is a
    // whole province falling back to "no location".
    const perProvince: Record<string, string> = {
      '709': 'NL', '902': 'NS/PE', '506': 'NB', '514': 'QC', '416': 'ON',
      '204': 'MB', '306': 'SK', '403': 'AB', '604': 'BC', '867': 'YT/NT/NU',
    };
    for (const [code, region] of Object.entries(perProvince)) {
      const a = lookupAreaCode(code);
      expect(a, `area code ${code} missing`).not.toBeNull();
      expect(a!.region).toBe(region);
      expect(a!.country).toBe('CA');
    }
  });

  it('gives every entry a plausible coordinate', () => {
    // A 0,0 or transposed lat/lng would put a camera pin in the Gulf of Guinea.
    for (const code of ['705', '514', '604', '867', '212', '310', '312']) {
      const a = lookupAreaCode(code)!;
      expect(Math.abs(a.lat)).toBeGreaterThan(1);
      expect(Math.abs(a.lng)).toBeGreaterThan(1);
      expect(a.lat).toBeGreaterThan(-90);
      expect(a.lat).toBeLessThan(90);
      expect(a.lng).toBeGreaterThan(-180);
      expect(a.lng).toBeLessThan(180);
      expect(a.city).toBeTruthy();
    }
  });

  it('knows materially more than the 15 codes the old table held', () => {
    expect(NANP_AREA_COUNT).toBeGreaterThan(60);
  });
});

describe('isNonGeographic', () => {
  it('flags toll-free and N11 service codes', () => {
    expect(isNonGeographic('800')).toBe(true);
    expect(isNonGeographic('911')).toBe(true);
    expect(isNonGeographic('411')).toBe(true);
  });

  it('does not flag a real geographic code', () => {
    expect(isNonGeographic('705')).toBe(false);
    expect(isNonGeographic('514')).toBe(false);
  });
});
