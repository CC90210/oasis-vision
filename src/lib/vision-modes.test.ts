import { describe, it, expect } from 'vitest';
import {
  VISION_MODES, visionMode, filterId, visionFilterCss, visionFilterDefs,
  type VisionModeId,
} from './vision-modes';

describe('VISION_MODES', () => {
  it('starts with an off state, so the map can always be seen as rendered', () => {
    expect(VISION_MODES[0].id).toBe('none');
    expect(VISION_MODES[0].table).toBeUndefined();
  });

  it('gives every mode a blurb that does not claim to be a sensor', () => {
    // The recurring defect in this codebase is confident overstatement. Thermal
    // is false colour on brightness; the label must not imply radiometry.
    for (const m of VISION_MODES) {
      expect(m.blurb, `${m.id} has no blurb`).toBeTruthy();
      expect(m.label).not.toMatch(/infrared|radiometric|sensor/i);
    }
    expect(visionMode('thermal').blurb).toMatch(/not a sensor/i);
  });

  it('gives each LUT the same number of stops per channel', () => {
    // Mismatched channel lengths make feComponentTransfer interpolate the
    // channels against different domains, which skews the whole ramp.
    for (const m of VISION_MODES) {
      if (!m.table) continue;
      expect(m.table.r.length, m.id).toBe(m.table.g.length);
      expect(m.table.g.length, m.id).toBe(m.table.b.length);
      expect(m.table.r.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps every stop inside 0..1', () => {
    for (const m of VISION_MODES) {
      if (!m.table) continue;
      for (const ch of ['r', 'g', 'b'] as const) {
        for (const v of m.table[ch]) {
          expect(v, `${m.id}.${ch}`).toBeGreaterThanOrEqual(0);
          expect(v, `${m.id}.${ch}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('ramps thermal from black to white, as ironbow does', () => {
    // Taken from God's Eye View src/styles/thermal.js:40-46 so the look matches.
    const t = visionMode('thermal').table!;
    expect([t.r[0], t.g[0], t.b[0]]).toEqual([0, 0, 0]);
    const last = t.r.length - 1;
    expect([t.r[last], t.g[last], t.b[last]]).toEqual([1, 1, 1]);
    // Red leads green through the middle — that is what makes it read as heat
    // rather than as a greyscale ramp.
    expect(t.r[3]).toBeGreaterThan(t.g[3]);
  });

  it('keeps night vision green-dominant at every lit stop', () => {
    const t = visionMode('nightvision').table!;
    for (let i = 1; i < t.g.length; i++) {
      expect(t.g[i]).toBeGreaterThan(t.r[i]);
      expect(t.g[i]).toBeGreaterThan(t.b[i]);
    }
  });
});

describe('visionFilterCss', () => {
  it('is empty for the off state', () => {
    // An identity SVG filter still forces the canvas onto its own compositing
    // layer, costing a full-screen readback per frame for no visual change.
    expect(visionFilterCss('none')).toBe('');
  });

  it('references the mode filter for an active mode', () => {
    expect(visionFilterCss('thermal')).toContain('url(#oasis-vision-thermal)');
    expect(visionFilterCss('nightvision')).toContain('url(#oasis-vision-nightvision)');
  });

  it('falls back to off for an unknown mode instead of emitting a dead url()', () => {
    expect(visionFilterCss('bogus' as VisionModeId)).toBe('');
  });
});

describe('visionFilterDefs', () => {
  const defs = visionFilterDefs();

  it('emits one filter per LUT mode and none for the off state', () => {
    const count = (defs.match(/<filter /g) || []).length;
    expect(count).toBe(VISION_MODES.filter(m => m.table).length);
    expect(defs).not.toContain(filterId('none'));
  });

  it('pins sRGB interpolation', () => {
    // The SVG default is linearRGB, which shifts every stop and turns the
    // ironbow ramp muddy — a silent, wrong-looking result rather than an error.
    const filters = defs.match(/<filter [^>]*>/g) || [];
    expect(filters.length).toBeGreaterThan(0);
    for (const f of filters) expect(f).toContain('color-interpolation-filters="sRGB"');
  });

  it('collapses to luminance before applying the LUT', () => {
    // Rec.709 luma weights — mapping per-channel instead would tint the ramp.
    expect(defs).toContain('0.2126 0.7152 0.0722');
  });

  it('writes each channel table into its own transfer function', () => {
    const t = visionMode('thermal').table!;
    expect(defs).toContain(`<feFuncR type="table" tableValues="${t.r.join(' ')}"/>`);
    expect(defs).toContain(`<feFuncG type="table" tableValues="${t.g.join(' ')}"/>`);
    expect(defs).toContain(`<feFuncB type="table" tableValues="${t.b.join(' ')}"/>`);
  });

  it('produces markup with balanced filter tags', () => {
    expect((defs.match(/<filter /g) || []).length).toBe((defs.match(/<\/filter>/g) || []).length);
  });
});
