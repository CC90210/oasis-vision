import { describe, it, expect } from 'vitest';
import {
  THERMAL_LAYERS, thermalLayer, gibsDate, thermalTileUrl, THERMAL_ATTRIBUTION,
} from './thermal-imagery';

describe('THERMAL_LAYERS', () => {
  it('pins a tile matrix set per layer, because GIBS varies it', () => {
    // Requesting Level7 for a VIIRS layer returns
    // "TILEMATRIXSET is invalid for LAYER" — a 400, not a tile. That is exactly
    // how this shipped broken the first time it was tried.
    expect(thermalLayer('viirs-day')!.matrixSet).toBe('GoogleMapsCompatible_Level9');
    expect(thermalLayer('modis-day')!.matrixSet).toBe('GoogleMapsCompatible_Level7');
  });

  it('keeps maxZoom consistent with the matrix set level', () => {
    // Requesting past the published level returns an error tile, which renders
    // as a grey square over the map rather than as nothing.
    for (const l of THERMAL_LAYERS) {
      const level = Number(l.matrixSet.replace(/\D/g, ''));
      expect(l.maxZoom, l.id).toBeLessThanOrEqual(level);
    }
  });

  it('describes each band without implying it can see small objects', () => {
    for (const l of THERMAL_LAYERS) {
      expect(l.blurb, l.id).toBeTruthy();
      expect(l.blurb).toMatch(/temperature/i);
    }
    // ~375 m/px: a wildfire front is legible, an aircraft never will be.
    expect(thermalLayer('viirs-day')!.blurb).toMatch(/375 m/);
  });

  it('offers a night band, which is when thermal contrast is most useful', () => {
    expect(thermalLayer('viirs-night')).toBeDefined();
    expect(thermalLayer('viirs-night')!.layer).toMatch(/_Night$/);
  });

  it('returns undefined for an unknown id rather than a broken default', () => {
    expect(thermalLayer('nope')).toBeUndefined();
  });
});

describe('gibsDate', () => {
  it('asks for yesterday by default', () => {
    // GIBS publishes hours after the pass, so today commonly yields an EMPTY
    // tile rather than an error — data that silently is not there.
    const now = new Date('2026-09-04T06:00:00Z');
    expect(gibsDate(now)).toBe('2026-09-03');
  });

  it('formats as YYYY-MM-DD, which is what the WMTS path expects', () => {
    expect(gibsDate(new Date('2026-01-05T00:00:00Z'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(gibsDate(new Date('2026-03-01T12:00:00Z'))).toBe('2026-02-28');
    expect(gibsDate(new Date('2026-01-01T12:00:00Z'))).toBe('2025-12-31');
  });

  it('honours an explicit lookback', () => {
    expect(gibsDate(new Date('2026-09-04T00:00:00Z'), 3)).toBe('2026-09-01');
  });
});

describe('thermalTileUrl', () => {
  const def = thermalLayer('viirs-day')!;
  const url = thermalTileUrl(def, '2026-09-03');

  it('puts row before column, as GIBS REST requires', () => {
    // {z}/{x}/{y} instead returns tiles of the WRONG PLACE rather than an
    // error, which is far harder to notice than a failure.
    expect(url.endsWith('/{z}/{y}/{x}.png')).toBe(true);
  });

  it('keeps the MapLibre placeholders literal', () => {
    for (const p of ['{z}', '{y}', '{x}']) expect(url).toContain(p);
    expect(url).not.toContain('%7B');
  });

  it('embeds the layer, date and matrix set in the documented order', () => {
    expect(url).toContain(`/${def.layer}/default/2026-09-03/${def.matrixSet}/`);
  });

  it('is fetched directly — GIBS is CORS-open, so it needs no proxy hop', () => {
    expect(url.startsWith('https://gibs.earthdata.nasa.gov/')).toBe(true);
    expect(url).not.toContain('/api/proxy-tiles');
  });
});

describe('THERMAL_ATTRIBUTION', () => {
  it('credits NASA GIBS, which its terms require', () => {
    expect(THERMAL_ATTRIBUTION).toMatch(/NASA/);
    expect(THERMAL_ATTRIBUTION).toMatch(/GIBS/);
  });
});
