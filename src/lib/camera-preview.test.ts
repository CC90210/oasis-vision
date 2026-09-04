import { describe, it, expect } from 'vitest';
import { preloadFrame, previewMedia, refreshInterval, VIDEO_KINDS, type PreviewKind } from './camera-preview';

describe('previewMedia', () => {
  it('treats a missing stream_type as a snapshot, like the full viewer', () => {
    expect(previewMedia({ feed_url: 'https://x/cam.jpg' })).toEqual({ kind: 'jpg', url: 'https://x/cam.jpg' });
  });

  it('gives Quebec 511 cameras a tile', () => {
    // 675 of these, and every one of them was a bare dot at every zoom.
    const qc = { stream_type: 'mp4', stream_url: 'https://www.quebec511.info/Carte/Fenetres/camera.ashx?id=4057&format=mp4' };
    expect(previewMedia(qc)).toEqual({ kind: 'mp4', url: qc.stream_url });
  });

  it('gives HLS webcams a tile', () => {
    const hls = { stream_type: 'hls', stream_url: 'https://ls.example/live/x.m3u8' };
    expect(previewMedia(hls)).toEqual({ kind: 'hls', url: hls.stream_url });
  });

  it('reads MJPEG off stream_url', () => {
    expect(previewMedia({ stream_type: 'mjpeg', stream_url: 'https://x/stream' }))
      .toEqual({ kind: 'mjpeg', url: 'https://x/stream' });
  });

  /**
   * 35% of the Caltrans playlists badged live answer 404 — the district index
   * lists cameras the media edge has dropped. Those cameras still publish a
   * working still, so the tile carries it and degrades to a picture instead of
   * deleting itself from the map, which is what made the densest camera region
   * render emptier than the source it is built from.
   */
  it('carries the still as a fallback for a stream camera', () => {
    const caltrans = {
      stream_type: 'hls',
      stream_url: 'https://wzmedia.dot.ca.gov/D3/x.stream/playlist.m3u8',
      feed_url: 'https://cwwp2.dot.ca.gov/data/d3/cctv/image/x/x.jpg',
    };
    expect(previewMedia(caltrans)).toEqual({
      kind: 'hls',
      url: caltrans.stream_url,
      fallbackUrl: caltrans.feed_url,
    });
  });

  it('carries the fallback for mp4 clip cameras too', () => {
    const m = previewMedia({ stream_type: 'mp4', stream_url: 'https://x/c.mp4', feed_url: 'https://x/c.jpg' });
    expect(m?.fallbackUrl).toBe('https://x/c.jpg');
  });

  it('omits fallbackUrl when the camera publishes no still', () => {
    // Quebec 511 carries only the clip; there is nothing to fall back to, and
    // an undefined fallback is what tells the tile to hide rather than to show
    // a broken image.
    const m = previewMedia({ stream_type: 'mp4', stream_url: 'https://x/c.mp4' });
    expect(m).toEqual({ kind: 'mp4', url: 'https://x/c.mp4' });
    expect(m).not.toHaveProperty('fallbackUrl');
  });

  it('does not give a snapshot camera a fallback to itself', () => {
    const m = previewMedia({ feed_url: 'https://x/cam.jpg' });
    expect(m).toEqual({ kind: 'jpg', url: 'https://x/cam.jpg' });
    expect(m).not.toHaveProperty('fallbackUrl');
  });

  it('leaves embeds as dots', () => {
    // Eight YouTube players over the map is a different feature.
    expect(previewMedia({ stream_type: 'iframe', stream_url: 'https://youtube.com/embed/x' })).toBeNull();
  });

  it('leaves a kind it does not know as a dot', () => {
    expect(previewMedia({ stream_type: 'rtsp', stream_url: 'rtsp://x/1' })).toBeNull();
  });

  it('refuses a camera whose URL for its own kind is missing or blank', () => {
    expect(previewMedia({ stream_type: 'mp4' })).toBeNull();
    expect(previewMedia({ stream_type: 'mp4', feed_url: 'https://x/cam.jpg' })).toBeNull();
    expect(previewMedia({ stream_type: 'hls', stream_url: '   ' })).toBeNull();
    expect(previewMedia({})).toBeNull();
  });

  it('falls back to stream_url for a snapshot that only carries one', () => {
    expect(previewMedia({ stream_type: 'jpg', stream_url: 'https://x/snap.jpg' }))
      .toEqual({ kind: 'jpg', url: 'https://x/snap.jpg' });
  });

  it('is not confused by the case a source writes its type in', () => {
    expect(previewMedia({ stream_type: 'MP4', stream_url: 'https://x/c.mp4' })?.kind).toBe('mp4');
    expect(previewMedia({ stream_type: 'HLS', stream_url: 'https://x/c.m3u8' })?.kind).toBe('hls');
  });
});

describe('refreshInterval', () => {
  it('re-requests snapshots often enough to look live', () => {
    expect(refreshInterval('jpg')).toBe(15000);
  });

  it('re-points MP4 clips far less often, because that restarts playback', () => {
    expect(refreshInterval('mp4')).toBeGreaterThan(refreshInterval('jpg'));
  });

  it('never re-points a continuous stream', () => {
    // Re-pointing an HLS or MJPEG source tears down a stream that is already live.
    expect(refreshInterval('hls')).toBe(0);
    expect(refreshInterval('mjpeg')).toBe(0);
  });
});

describe('VIDEO_KINDS', () => {
  it('is exactly the kinds that need a video element', () => {
    const kinds: PreviewKind[] = ['jpg', 'mjpeg', 'mp4', 'hls'];
    expect(kinds.filter(k => VIDEO_KINDS.has(k))).toEqual(['mp4', 'hls']);
  });
});

/**
 * Snapshot tiles used to assign straight to `src`, which blanks the element
 * until the new bytes decode — the flash on every refresh. preloadFrame is what
 * moves the fetch off-screen, so both the viewer and the map tiles can swap in
 * one composited frame.
 */
describe('preloadFrame', () => {
  /** Minimal stand-in for the browser's Image, recording what was set on it. */
  class FakeImage {
    static last: FakeImage | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    crossOrigin: string | null = null;
    decodeCalls = 0;
    private _src = '';
    constructor() { FakeImage.last = this; }
    get src() { return this._src; }
    set src(v: string) { this._src = v; }
    decode() { this.decodeCalls++; return Promise.resolve(); }
  }

  const withFakeImage = async (fn: () => Promise<unknown>) => {
    const g = globalThis as Record<string, unknown>;
    const had = 'Image' in g;
    const prev = g.Image;
    g.Image = FakeImage as unknown;
    try { return await fn(); } finally { if (had) g.Image = prev; else delete g.Image; }
  };

  it('resolves with the url once the frame has loaded and decoded', async () => {
    await withFakeImage(async () => {
      const p = preloadFrame('https://cam/x.jpg?_t=1');
      FakeImage.last!.onload!();
      await expect(p).resolves.toBe('https://cam/x.jpg?_t=1');
      expect(FakeImage.last!.decodeCalls).toBe(1);
    });
  });

  it('rejects when the frame fails, so the caller can keep the last good one', async () => {
    await withFakeImage(async () => {
      const p = preloadFrame('https://cam/dead.jpg');
      FakeImage.last!.onerror!();
      await expect(p).rejects.toThrow(/failed to load/);
    });
  });

  // Regression: setting crossOrigin puts the request in CORS mode, so every
  // camera origin that does not send Access-Control-Allow-Origin would fail to
  // preload and the tile would silently stop advancing. Nothing reads the
  // pixels back, so it must stay unset.
  it('never sets crossOrigin', async () => {
    await withFakeImage(async () => {
      const p = preloadFrame('https://cam/x.jpg');
      expect(FakeImage.last!.crossOrigin).toBeNull();
      FakeImage.last!.onload!();
      await p;
    });
  });

  it('resolves without a DOM, so server rendering does not throw', async () => {
    const g = globalThis as Record<string, unknown>;
    const had = 'Image' in g;
    const prev = g.Image;
    if (had) delete g.Image;
    try {
      await expect(preloadFrame('https://cam/x.jpg')).resolves.toBe('https://cam/x.jpg');
    } finally { if (had) g.Image = prev; }
  });
});
