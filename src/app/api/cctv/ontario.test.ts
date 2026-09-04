import { describe, it, expect } from 'vitest';
import { mapRecord, type Ontario511Record } from './ontario';

/** A real record from https://511on.ca/api/v2/get/cameras. */
const sample: Ontario511Record = {
  Id: 1,
  Source: 'RWIS (MTO)',
  Roadway: 'QEW',
  Direction: 'Unknown',
  Latitude: 42.9142736713825,
  Longitude: -78.9580061508579,
  Location: 'QEW West of Thompson Road',
  Views: [
    { Id: 1, Url: 'https://511on.ca/map/Cctv/1', Status: 'Enabled', Description: 'Toronto Bound' },
    { Id: 2, Url: 'https://511on.ca/map/Cctv/2', Status: 'Enabled', Description: 'Looking Down' },
    { Id: 3, Url: 'https://511on.ca/map/Cctv/3', Status: 'Disabled', Description: 'Fort Erie Bound' },
  ],
};

const clone = (): Ontario511Record => JSON.parse(JSON.stringify(sample));

describe('mapRecord', () => {
  /**
   * THE BUG THIS MODULE EXISTS FOR. The previous inline fetcher read
   * `cam.latitude`; the API returns `Latitude`. Every one of the 940 sites
   * failed `if (!cam.latitude) continue`, so Ontario rendered as a province
   * with no cameras — Barrie, Orangeville and Shelburne included.
   */
  it('reads the capitalised Latitude/Longitude the API actually sends', () => {
    const cams = mapRecord(sample);
    expect(cams.length).toBeGreaterThan(0);
    expect(cams[0].lat).toBeCloseTo(42.914, 3);
    expect(cams[0].lng).toBeCloseTo(-78.958, 3);
  });

  it('ignores lowercase latitude, so the old shape cannot silently pass', () => {
    const lower = { Id: 9, Views: sample.Views, latitude: 44.0, longitude: -79.0 } as unknown as Ontario511Record;
    expect(mapRecord(lower)).toEqual([]);
  });

  it('expands each enabled view into its own camera', () => {
    // One gantry, several angles: 940 sites carry 1,660 views province-wide.
    const cams = mapRecord(sample);
    expect(cams).toHaveLength(2);
    expect(cams.map(c => c.id)).toEqual(['on511-1-1', 'on511-1-2']);
  });

  it('drops disabled views', () => {
    expect(mapRecord(sample).some(c => c.name.includes('Fort Erie'))).toBe(false);
  });

  it('names a camera by place and angle together', () => {
    expect(mapRecord(sample)[0].name).toBe('QEW West of Thompson Road — Toronto Bound');
  });

  it('falls back to the place name when a view has no description', () => {
    const r = clone();
    r.Views = [{ Id: 5, Url: 'https://511on.ca/map/Cctv/5', Status: 'Enabled' }];
    expect(mapRecord(r)[0].name).toBe('QEW West of Thompson Road');
  });

  it('returns nothing for a site whose views are all disabled or urlless', () => {
    const r = clone();
    r.Views = [
      { Id: 1, Url: 'https://511on.ca/map/Cctv/1', Status: 'Disabled' },
      { Id: 2, Url: null, Status: 'Enabled' },
    ];
    expect(mapRecord(r)).toEqual([]);
  });

  it('returns nothing when a site has no views at all', () => {
    const r = clone();
    r.Views = [];
    expect(mapRecord(r)).toEqual([]);
    const r2 = clone();
    delete r2.Views;
    expect(mapRecord(r2)).toEqual([]);
  });

  it('drops rows outside Ontario, and null-island rows', () => {
    const bc = clone();
    bc.Latitude = 49.28; bc.Longitude = -123.12;   // Vancouver
    expect(mapRecord(bc)).toEqual([]);

    const zero = clone();
    zero.Latitude = 0; zero.Longitude = 0;
    expect(mapRecord(zero)).toEqual([]);
  });

  it('drops rows with missing or non-numeric coordinates', () => {
    const r = clone();
    r.Latitude = null;
    expect(mapRecord(r)).toEqual([]);
    const r2 = clone();
    (r2 as Record<string, unknown>).Latitude = 'forty-four';
    expect(mapRecord(r2)).toEqual([]);
  });

  it('marks every camera as a Canadian 511 Ontario still', () => {
    const c = mapRecord(sample)[0];
    expect(c.country).toBe('Canada');
    expect(c.source).toBe('511 Ontario');
    // Stills, not streams: the image endpoint answers image/jpeg, max-age=20.
    expect(c.feed_url).toBe('https://511on.ca/map/Cctv/1');
    expect(c.stream_url).toBeUndefined();
  });

  it('survives a malformed record instead of throwing', () => {
    expect(mapRecord({} as Ontario511Record)).toEqual([]);
    expect(mapRecord(null as unknown as Ontario511Record)).toEqual([]);
  });
});
