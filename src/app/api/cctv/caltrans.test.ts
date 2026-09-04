import { describe, it, expect } from 'vitest';
import { mapRecord } from './caltrans';

/**
 * A real row from cctvStatusD03.json, trimmed to the fields the mapper reads.
 * Caltrans nests everything under `cctv`, and the snapshot lives one level
 * deeper under `imageData.static` than the stream does.
 */
const sample = {
  cctv: {
    index: '1',
    inService: 'true',
    location: {
      district: '3',
      locationName: 'Hwy 5 at Pocket',
      nearbyPlace: 'Sacramento',
      county: 'Sacramento',
      route: 'I-5',
      latitude: '38.481128',
      longitude: '-121.510528',
    },
    imageData: {
      streamingVideoURL: 'https://wzmedia.dot.ca.gov/D3/5_Pocket_Rd_OC_SAC5_SB.stream/playlist.m3u8',
      static: { currentImageURL: 'https://cwwp2.dot.ca.gov/data/d3/cctv/image/hwy5atpocket/hwy5atpocket.jpg' },
    },
  },
};

/** Deep-clone so a case can edit one field without leaking into the next. */
const clone = () => JSON.parse(JSON.stringify(sample));

describe('mapRecord', () => {
  it('reads the HLS playlist and keeps the still as a fallback', () => {
    expect(mapRecord(sample, 3)).toEqual({
      id: 'caltrans-d3-1',
      lat: 38.481128,
      lng: -121.510528,
      name: 'Hwy 5 at Pocket',
      city: 'Sacramento',
      country: 'US',
      feed_url: 'https://cwwp2.dot.ca.gov/data/d3/cctv/image/hwy5atpocket/hwy5atpocket.jpg',
      stream_url: 'https://wzmedia.dot.ca.gov/D3/5_Pocket_Rd_OC_SAC5_SB.stream/playlist.m3u8',
      stream_type: 'hls',
      source: 'Caltrans',
    });
  });

  // Both are kept deliberately: 3 of 10 sampled playlists 404 because the index
  // lists cameras the media edge has dropped, so a dead stream has to degrade to
  // a picture rather than to an error.
  it('keeps the still even when a stream is present', () => {
    const cam = mapRecord(sample, 3)!;
    expect(cam.feed_url).toBeTruthy();
    expect(cam.stream_url).toBeTruthy();
  });

  it('withholds a camera the operator marks out of service', () => {
    const r = clone();
    r.cctv.inService = 'false';
    expect(mapRecord(r, 3)).toBeNull();
  });

  it('treats a missing inService flag as out of service rather than live', () => {
    const r = clone();
    delete r.cctv.inService;
    expect(mapRecord(r, 3)).toBeNull();
  });

  it('serves a snapshot-only camera as a camera, with no stream fields', () => {
    const r = clone();
    delete r.cctv.imageData.streamingVideoURL;
    const cam = mapRecord(r, 3)!;
    expect(cam.feed_url).toBeTruthy();
    expect(cam.stream_url).toBeUndefined();
    expect(cam.stream_type).toBeUndefined();
  });

  // The field occasionally holds a viewer page rather than a manifest; calling
  // that `hls` would hand hls.js an HTML document.
  it('ignores a streamingVideoURL that is not a playlist', () => {
    const r = clone();
    r.cctv.imageData.streamingVideoURL = 'https://cwwp2.dot.ca.gov/vm/loc/d3/hwy5atpocket.htm';
    const cam = mapRecord(r, 3)!;
    expect(cam.stream_url).toBeUndefined();
    expect(cam.feed_url).toBeTruthy();
  });

  it('drops a row with neither a stream nor a still', () => {
    const r = clone();
    r.cctv.imageData = {};
    expect(mapRecord(r, 3)).toBeNull();
  });

  it('drops rows outside California, and null-island rows', () => {
    const far = clone();
    far.cctv.location.latitude = '48.9';   // Washington
    expect(mapRecord(far, 3)).toBeNull();

    const zero = clone();
    zero.cctv.location.latitude = '0';
    zero.cctv.location.longitude = '0';
    expect(mapRecord(zero, 3)).toBeNull();
  });

  it('drops rows with unparseable coordinates', () => {
    const r = clone();
    r.cctv.location.latitude = '';
    expect(mapRecord(r, 3)).toBeNull();
  });

  it('falls back to the route when a camera has no location name', () => {
    const r = clone();
    delete r.cctv.location.locationName;
    expect(mapRecord(r, 3)!.name).toBe('I-5');
  });

  it('namespaces ids by district, because index restarts at 1 in each file', () => {
    // Twelve districts each numbering from 1 would collide into a single camera.
    expect(mapRecord(sample, 3)!.id).toBe('caltrans-d3-1');
    expect(mapRecord(sample, 7)!.id).toBe('caltrans-d7-1');
  });

  it('ignores a row with no cctv envelope', () => {
    expect(mapRecord({}, 3)).toBeNull();
  });
});
