import { describe, it, expect } from 'vitest';
import { mapRecord, pageStarts, IBI_STATES, ibiStatesForPoint, type Ibi511Record } from './ibi511-states';

const ny = IBI_STATES.find(s => s.id === 'newyork')!;

const rec = (over: Partial<Ibi511Record> = {}): Ibi511Record => ({
  id: 42,
  roadway: 'I-87',
  location: 'US 9 SB @ I-87 Exit 17',
  latLng: { geography: { wellKnownText: 'POINT (-73.9 41.7)' } },
  images: [{ id: 7, description: 'US 9 SB @ I-87 Exit 17', imageUrl: '/map/Cctv/7', videoUrl: null }],
  ...over,
});

describe('mapRecord', () => {
  it('reads a camera off the DataTables row', () => {
    expect(mapRecord(rec(), ny)).toEqual({
      id: 'newyork-42',
      lat: 41.7,
      lng: -73.9,
      name: 'US 9 SB @ I-87 Exit 17',
      city: 'New York',
      country: 'US',
      feed_url: 'https://511ny.org/map/Cctv/7',
      source: '511NY',
    });
  });

  it('makes a site-relative image path absolute against the state base', () => {
    // These sites return both forms; a relative path left alone renders as a
    // broken image against our own origin.
    const abs = mapRecord(rec({ images: [{ id: 1, imageUrl: 'https://cdn.example/x.jpg' }] }), ny)!;
    expect(abs.feed_url).toBe('https://cdn.example/x.jpg');
    const rel = mapRecord(rec({ images: [{ id: 1, imageUrl: 'map/Cctv/1' }] }), ny)!;
    expect(rel.feed_url).toBe('https://511ny.org/map/Cctv/1');
  });

  it('takes an HLS video URL as a stream', () => {
    const cam = mapRecord(rec({
      images: [{ id: 1, imageUrl: '/map/Cctv/1', videoUrl: 'https://s.example/live/1.m3u8' }],
    }), ny)!;
    expect(cam.stream_url).toBe('https://s.example/live/1.m3u8');
    expect(cam.stream_type).toBe('hls');
    // The still is kept as a fallback for when the playlist is dead.
    expect(cam.feed_url).toBeTruthy();
  });

  it('ignores a videoUrl that is a viewer page rather than a playlist', () => {
    // Handing hls.js an HTML document produces a silent dead tile.
    const cam = mapRecord(rec({
      images: [{ id: 1, imageUrl: '/map/Cctv/1', videoUrl: 'https://511ny.org/cctv/view/1' }],
    }), ny)!;
    expect(cam.stream_url).toBeUndefined();
  });

  it('withholds blocked, disabled and video-disabled cameras appropriately', () => {
    expect(mapRecord(rec({ images: [{ id: 1, imageUrl: '/x', blocked: true }] }), ny)).toBeNull();
    expect(mapRecord(rec({ images: [{ id: 1, imageUrl: '/x', disabled: true }] }), ny)).toBeNull();
    const noVid = mapRecord(rec({
      images: [{ id: 1, imageUrl: '/x', videoUrl: 'https://s/1.m3u8', videoDisabled: true }],
    }), ny)!;
    expect(noVid.stream_url).toBeUndefined();
    expect(noVid.feed_url).toBeTruthy();
  });

  it('drops rows outside the state box', () => {
    // A mis-geocoded row would otherwise put a New York camera in the Pacific.
    expect(mapRecord(rec({ latLng: { geography: { wellKnownText: 'POINT (-118.2 34.0)' } } }), ny)).toBeNull();
  });

  it('drops rows with no parseable position, no images, or no usable url', () => {
    expect(mapRecord(rec({ latLng: null }), ny)).toBeNull();
    expect(mapRecord(rec({ images: [] }), ny)).toBeNull();
    expect(mapRecord(rec({ images: [{ id: 1 }] }), ny)).toBeNull();
    expect(mapRecord(rec({ id: undefined }), ny)).toBeNull();
  });

  it('falls back through description, location, roadway, then a generated name', () => {
    expect(mapRecord(rec({ images: [{ id: 1, imageUrl: '/x' }], location: 'Loc' }), ny)!.name).toBe('Loc');
    expect(mapRecord(rec({ images: [{ id: 1, imageUrl: '/x' }], location: 'N/A' }), ny)!.name).toBe('I-87');
    expect(mapRecord(rec({ images: [{ id: 1, imageUrl: '/x' }], location: 'N/A', roadway: null }), ny)!.name)
      .toBe('511NY Camera 42');
  });

  it('namespaces ids by state, because row ids restart per site', () => {
    const fl = IBI_STATES.find(s => s.id === 'florida')!;
    const flRec = rec({ latLng: { geography: { wellKnownText: 'POINT (-80.2 25.8)' } } });
    expect(mapRecord(rec(), ny)!.id).toBe('newyork-42');
    expect(mapRecord(flRec, fl)!.id).toBe('florida-42');
  });
});

describe('IBI_STATES', () => {
  it('gives every state a plausible box and a measured expectation', () => {
    for (const s of IBI_STATES) {
      expect(s.bounds.minLat, s.id).toBeLessThan(s.bounds.maxLat);
      expect(s.bounds.minLng, s.id).toBeLessThan(s.bounds.maxLng);
      expect(s.expect, s.id).toBeGreaterThan(0);
      expect(s.base).toMatch(/^https:\/\//);
    }
  });

  it('uses unique region ids', () => {
    expect(new Set(IBI_STATES.map(s => s.id)).size).toBe(IBI_STATES.length);
  });
});

describe('ibiStatesForPoint', () => {
  /** The reported gap: New York had no camera within 60km, nearest 890km. */
  it('routes a New York viewport to the New York cameras', () => {
    expect(ibiStatesForPoint(40.71, -74.01)).toContain('newyork');
  });

  it('routes Miami to Florida', () => {
    expect(ibiStatesForPoint(25.76, -80.19)).toContain('florida');
  });

  it('returns nothing for a point outside every state box', () => {
    expect(ibiStatesForPoint(48.86, 2.35)).toEqual([]);      // Paris
    expect(ibiStatesForPoint(-33.87, 151.21)).toEqual([]);   // Sydney
  });
});

/**
 * These servers are slow and burst-intolerant: Georgia needs 40 pages and lost
 * 14 of them at twelve concurrent requests in 11.9s, against a 12s region
 * budget. A bounded sample is the only thing that fits — and it has to be
 * strided, because the rows are ordered by roadway, so the first N pages are
 * one corner of the state.
 */
describe('pageStarts', () => {
  it('returns nothing when one page covers the state', () => {
    expect(pageStarts(50)).toEqual([]);
    expect(pageStarts(100)).toEqual([]);
  });

  it('takes every page when the state is small enough', () => {
    // 489 cameras is five pages; there is no reason to sample.
    expect(pageStarts(489)).toEqual([100, 200, 300, 400]);
  });

  it('caps the number of requests for a large state', () => {
    // Florida is 49 pages. Fetching all of them cannot fit the budget.
    expect(pageStarts(4953).length).toBeLessThanOrEqual(17);
  });

  it('spreads the sample across the whole range, not the front', () => {
    // Taking the first 17 pages of Georgia would return one highway corridor
    // and leave the rest of the state looking like it has no cameras.
    const starts = pageStarts(4043);
    expect(Math.max(...starts)).toBeGreaterThan(3000);
    expect(Math.min(...starts)).toBeLessThan(500);
  });

  it('never repeats an offset', () => {
    for (const total of [4043, 4953, 1871, 1000, 250]) {
      const s = pageStarts(total);
      expect(new Set(s).size, String(total)).toBe(s.length);
    }
  });

  it('stays inside the row count', () => {
    for (const total of [4043, 4953, 1871, 250]) {
      for (const s of pageStarts(total)) expect(s).toBeLessThan(total);
    }
  });

  it('returns offsets in ascending order', () => {
    const s = pageStarts(4953);
    expect([...s].sort((a, b) => a - b)).toEqual(s);
  });
});
