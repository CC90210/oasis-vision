import { describe, it, expect } from 'vitest';
import { setLabelsForImagery, labelLayerIds, LABEL_CLASSES, type LabelTarget } from './map-labels';

/** Records every paint call, and can pretend a layer is missing. */
function fakeMap(missing: string[] = []) {
  const calls: Array<{ id: string; prop: string; value: unknown }> = [];
  const map: LabelTarget = {
    getLayer: (id: string) => (missing.includes(id) ? undefined : { id }),
    setPaintProperty: (id, prop, value) => { calls.push({ id, prop, value }); },
  };
  return { map, calls };
}

describe('setLabelsForImagery', () => {
  /**
   * The reported bug: country names were unreadable on the satellite view.
   * CARTO paints them around rgba(157,157,157) with a 1px #111 halo, which is
   * right for the dark style and nearly invisible over sunlit terrain.
   */
  it('paints countries white with a heavy halo over imagery', () => {
    const { map, calls } = fakeMap();
    setLabelsForImagery(map, true);
    const country = calls.filter(c => c.id === 'place_country_1');
    expect(country.find(c => c.prop === 'text-color')!.value).toBe('#FFFFFF');
    expect(country.find(c => c.prop === 'text-halo-color')!.value).toBe('#000000');
    expect(country.find(c => c.prop === 'text-halo-width')!.value).toBeGreaterThanOrEqual(2);
  });

  it('gives countries a heavier halo than towns', () => {
    // Zoomed out, a country label spans thousands of km of varied terrain and
    // needs the most separation from what is under it.
    const country = LABEL_CLASSES.find(c => c.ids.includes('place_country_1'))!;
    const town = LABEL_CLASSES.find(c => c.ids.includes('place_town'))!;
    expect(country.haloWidth).toBeGreaterThan(town.haloWidth);
  });

  /**
   * Restoring must hand back undefined, not a hardcoded colour. MapLibre reads
   * undefined as "use the loaded style's value"; baking in an original would
   * freeze the dark theme and fight the Style Studio, which repaints these same
   * properties.
   */
  it('restores by clearing the override, not by setting a colour', () => {
    const { map, calls } = fakeMap();
    setLabelsForImagery(map, false);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.value, `${c.id}.${c.prop}`).toBeUndefined();
  });

  it('touches every label class in both directions', () => {
    for (const imagery of [true, false]) {
      const { map, calls } = fakeMap();
      setLabelsForImagery(map, imagery);
      const touched = new Set(calls.map(c => c.id));
      for (const id of labelLayerIds()) expect(touched.has(id), id).toBe(true);
    }
  });

  it('skips layers the style does not have rather than throwing', () => {
    // CARTO revises dark-matter; a renamed layer should cost one unreadable
    // label, not the entire style switch.
    const { map, calls } = fakeMap(['place_country_1', 'place_state']);
    expect(() => setLabelsForImagery(map, true)).not.toThrow();
    expect(calls.some(c => c.id === 'place_country_1')).toBe(false);
    expect(calls.some(c => c.id === 'place_country_2')).toBe(true);
  });

  it('sets colour, halo colour, halo width and blur for each layer', () => {
    const { map, calls } = fakeMap();
    setLabelsForImagery(map, true);
    const props = calls.filter(c => c.id === 'place_country_2').map(c => c.prop);
    expect(props).toEqual(
      expect.arrayContaining(['text-color', 'text-halo-color', 'text-halo-width', 'text-halo-blur']),
    );
  });
});

describe('LABEL_CLASSES', () => {
  it('lists no layer twice, so one class cannot silently override another', () => {
    const all = labelLayerIds();
    expect(new Set(all).size).toBe(all.length);
  });

  it('uses light text on every class, since imagery is bright', () => {
    for (const c of LABEL_CLASSES) {
      expect(c.color, c.ids[0]).toMatch(/^#[EF][0-9A-F]/i);
      expect(c.haloWidth).toBeGreaterThan(1);
    }
  });
});
