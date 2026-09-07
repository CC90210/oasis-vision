import { describe, it, expect } from 'vitest';
import {
  buildAreaBrief, compass, speakCoordinates, spokenCount, firstSentences,
  type BriefInput,
} from './area-brief';

const base: BriefInput = {
  coordinates: { lat: 45.5137, lng: -73.5324 },
  radius: 1200,
  place: { name: 'Espace 67', suburb: 'Ville-Marie', city: 'Montréal', state: 'Québec', country: 'Canada', postcode: 'H3C 4G8' },
  conditions: { tempC: 21.4, feelsC: 21.0, windKph: 12, windDir: 250, cloudPct: 20, visibilityM: 24000, isDay: true },
  infrastructure: { counts: { emergency: 2, landmark: 5 }, total: 7, items: [
    { category: 'emergency', name: 'Poste de quartier 21', kind: 'police' },
    { category: 'landmark', name: 'Biosphère', kind: 'museum' },
  ] },
  degraded: [],
};

describe('buildAreaBrief', () => {
  /**
   * The whole point of the rewrite. The old dossier led with the COUNTRY on
   * every click — Canada, Ottawa, 36,991,981 — because it reverse-geocoded at
   * zoom 5. The brief must open with the actual spot.
   */
  it('opens with the specific place, not the country', () => {
    const { speech } = buildAreaBrief(base);
    expect(speech.indexOf('Espace 67')).toBeLessThan(speech.indexOf('Canada'));
    expect(speech).toMatch(/^Assessment for Espace 67/);
  });

  /**
   * Live in Bulgaria the headline resolved to "SZR1064, Dolno Izvorovo" and the
   * sentence then read "...in Dolno Izvorovo, Stara Zagora, and Bulgaria",
   * naming the village twice in one breath.
   */
  it('does not repeat a level the headline already names', () => {
    const { speech } = buildAreaBrief({
      ...base,
      place: { name: 'SZR1064, Dolno Izvorovo', city: 'Dolno Izvorovo', state: 'Stara Zagora', country: 'Bulgaria' },
    });
    expect(speech).toContain('Assessment for SZR1064, Dolno Izvorovo, in Stara Zagora and Bulgaria.');
    expect(speech.match(/Dolno Izvorovo/g)).toHaveLength(1);
  });

  it('still mentions the country, but as closing context', () => {
    const { lines } = buildAreaBrief(base);
    expect(lines[lines.length - 1]).toMatch(/inside Canada/);
  });

  it('counts what is actually mapped nearby', () => {
    const { speech } = buildAreaBrief(base);
    expect(speech).toContain('two emergency services');
    expect(speech).toContain('five named landmarks');
    expect(speech).toContain('Poste de quartier 21');
  });

  /**
   * A failed source must be spoken as unavailable. Dropping the sentence would
   * be heard as "there is nothing there", which is the opposite of the truth
   * and the exact defect the old silent catch blocks produced.
   */
  it('says a source is unavailable rather than going quiet', () => {
    const { speech } = buildAreaBrief({ ...base, degraded: ['infrastructure (Overpass HTTP 504)'] });
    expect(speech).toContain('Infrastructure data is unavailable');
    expect(speech).not.toContain('Nothing of note is mapped');
  });

  it('distinguishes nothing-mapped from source-failed', () => {
    const { speech } = buildAreaBrief({ ...base, infrastructure: { counts: {}, items: [], total: 0 } });
    expect(speech).toContain('Nothing of note is mapped within 1.2 kilometres');
  });

  /**
   * Absent is not zero — and this module had the defect it exists to prevent.
   * A null `infrastructure` with nothing in `degraded` used to be spoken as
   * "Nothing of note is mapped": the caller's two failure signals had to agree
   * for the sentence to be true. Found by an independent audit 2026-09-07.
   */
  it('speaks a missing infrastructure object as unknown, not as zero', () => {
    const { speech } = buildAreaBrief({ ...base, infrastructure: null, degraded: [] });
    expect(speech).toContain('Infrastructure data is unavailable');
    expect(speech).not.toContain('Nothing of note is mapped');
  });

  it('says degrees Celsius, because a spoken "21 degrees" is ambiguous', () => {
    expect(buildAreaBrief(base).speech).toContain('21 degrees Celsius');
  });

  it('gives gusts their unit', () => {
    const gusty = buildAreaBrief({ ...base, conditions: { ...base.conditions, windKph: 20, gustKph: 55 } });
    expect(gusty.speech).toContain('gusting 55 kilometres per hour');
  });

  it('does not claim both kinds exist in the government plural', () => {
    // "two government and diplomatic sites" asserts one of each; two townhalls
    // are neither.
    const { speech } = buildAreaBrief({
      ...base,
      infrastructure: { counts: { government: 2 }, items: [], total: 2 },
    });
    expect(speech).toContain('two government or diplomatic sites');
  });

  it('handles open ocean, where no name exists', () => {
    const { speech } = buildAreaBrief({
      coordinates: { lat: -30.5, lng: -140.25 },
      place: { name: 'Unknown location' },
      conditions: null,
      infrastructure: null,
      degraded: ['conditions (timeout)', 'infrastructure (timeout)'],
    });
    expect(speech).toContain('30.500 degrees south');
    expect(speech).toContain('140.250 degrees west');
    expect(speech).toContain('No named place is recorded');
  });

  it('reports the operator’s own live coverage', () => {
    const { speech } = buildAreaBrief({ ...base, camerasNearby: 3, aircraftOverhead: 1 });
    expect(speech).toContain('three cameras in range');
    expect(speech).toContain('one aircraft overhead');
  });

  it('omits coverage entirely when there is none, rather than saying zero', () => {
    const { speech } = buildAreaBrief({ ...base, camerasNearby: 0, aircraftOverhead: 0 });
    expect(speech).not.toContain('Live coverage');
  });

  it('calls out reduced visibility, and stays silent when it is fine', () => {
    expect(buildAreaBrief(base).speech).not.toContain('Visibility is reduced');
    const fog = buildAreaBrief({ ...base, conditions: { ...base.conditions, visibilityM: 800 } });
    expect(fog.speech).toContain('Visibility is reduced, about 0.8 kilometres');
  });

  it('mentions gusts only when they materially exceed the wind', () => {
    expect(buildAreaBrief(base).speech).not.toContain('gusting');
    const gusty = buildAreaBrief({ ...base, conditions: { ...base.conditions, windKph: 20, gustKph: 55 } });
    expect(gusty.speech).toContain('gusting 55');
  });

  it('keeps the spoken text free of glyphs a voice engine mangles', () => {
    const { speech } = buildAreaBrief({ ...base, camerasNearby: 2 });
    expect(speech).not.toMatch(/[•▲△°%|]/);
  });

  it('speech and screen lines never disagree', () => {
    const { speech, lines } = buildAreaBrief(base);
    expect(speech).toBe(lines.join(' '));
  });
});

describe('helpers', () => {
  it('names the compass point a wind blows from', () => {
    expect(compass(0)).toBe('north');
    expect(compass(90)).toBe('east');
    expect(compass(225)).toBe('southwest');
    expect(compass(359)).toBe('north');
    expect(compass(-90)).toBe('west'); // negative bearings must not throw off the index
  });

  it('speaks southern and western coordinates with the right hemisphere', () => {
    expect(speakCoordinates(-33.86, 151.21)).toBe('33.860 degrees south, 151.210 degrees east');
  });

  it('spells out small counts and leaves large ones as digits', () => {
    expect(spokenCount(3)).toBe('three');
    expect(spokenCount(10)).toBe('ten');
    expect(spokenCount(11)).toBe('11');
  });

  it('trims an extract to whole sentences', () => {
    expect(firstSentences('One. Two. Three. Four.')).toBe('One. Two.');
  });
});
