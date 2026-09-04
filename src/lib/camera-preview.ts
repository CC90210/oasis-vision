/**
 * OSIRIS — what a camera can show inside a map preview tile.
 *
 * The tiles started out as JPEG snapshots only. That left Quebec 511 — 675
 * cameras, every one of them an MP4 clip — and the 75 HLS webcams as bare dots
 * at every zoom, which reads as "no camera here" rather than "this one needs a
 * player". Both play in a `<video>`, so both can have a tile.
 *
 * Kept out of the component so the rules are testable without a map.
 */

export type PreviewKind = 'jpg' | 'mjpeg' | 'mp4' | 'hls';

/** Fields of a camera record this module reads. */
export interface PreviewSource {
  stream_type?: string;
  feed_url?: string;
  stream_url?: string;
}

/** Kinds that need a `<video>` rather than an `<img>`. */
export const VIDEO_KINDS: ReadonlySet<PreviewKind> = new Set<PreviewKind>(['mp4', 'hls']);

/**
 * The URL a tile should render, and how.
 *
 * `null` means the camera stays a dot: either it is an embed (a YouTube or
 * operator page — eight of those in iframes over the map is a different
 * feature with a far worse frame budget) or the record has no usable URL for
 * the kind it claims to be.
 */
export function previewMedia(cam: PreviewSource): { kind: PreviewKind; url: string; fallbackUrl?: string } | null {
  /* Absent stream_type means a snapshot feed, the same default the full viewer
     uses. */
  const declared = (cam.stream_type ?? 'jpg').toLowerCase();

  if (declared === 'mp4' || declared === 'hls') {
    const url = cam.stream_url?.trim();
    if (!url) return null;
    /* 35% of the Caltrans playlists badged live answer 404 — the district index
       lists cameras the media edge has dropped. Those cameras still publish a
       working still, so the tile carries it and degrades to a picture instead
       of removing itself from the map. */
    const fallbackUrl = cam.feed_url?.trim();
    return fallbackUrl ? { kind: declared, url, fallbackUrl } : { kind: declared, url };
  }

  if (declared === 'mjpeg') {
    /* A single response that never ends, so it is an <img> like a snapshot —
       but it must not be cache-busted, or every refresh restarts the stream. */
    const url = cam.stream_url?.trim();
    return url ? { kind: 'mjpeg', url } : null;
  }

  if (declared === 'jpg') {
    const url = cam.feed_url?.trim() || cam.stream_url?.trim();
    return url ? { kind: 'jpg', url } : null;
  }

  // iframe, and anything unrecognised.
  return null;
}

/** Cache-buster: snapshot feeds are one URL that returns a new frame each time. */
export function freshen(url: string): string {
  return url.includes('?') ? `${url}&_t=${Date.now()}` : `${url}?_t=${Date.now()}`;
}

/**
 * Fetch and decode a frame off-screen, resolving with the same URL once it is
 * ready to paint.
 *
 * Pointing a visible `<img>` straight at the next URL is what makes snapshot
 * cameras flash: the element discards the frame it is showing the moment `src`
 * changes, then holds empty until the new bytes arrive and decode. Awaiting
 * this first turns the swap into a single composited frame.
 *
 * Deliberately no `crossOrigin`: nothing here reads the pixels back, and
 * setting it would put the request in CORS mode, so every camera origin that
 * does not send `Access-Control-Allow-Origin` would fail to preload and the
 * tile would never advance.
 */
export function preloadFrame(url: string): Promise<string> {
  // No DOM under SSR or in the node test environment — nothing to preload.
  if (typeof Image === 'undefined') return Promise.resolve(url);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const done = () => resolve(url);
    img.onload = () => {
      // decode() resolves when the bitmap is ready to paint; without it the
      // first paint after the swap can still stall. Not in every browser.
      if (typeof img.decode === 'function') img.decode().then(done, done);
      else done();
    };
    img.onerror = () => reject(new Error(`frame failed to load: ${url}`));
    img.src = url;
  });
}

/**
 * How often a tile should re-request, in ms — or 0 for the kinds that keep
 * themselves current.
 *
 * A snapshot is one still frame, so it has to be re-fetched to look live. MP4
 * clips are short and loop, so they go stale too, but re-pointing a `<video>`
 * restarts playback: doing that on the snapshot cadence would make every clip
 * stutter every 15 seconds, so they refresh far less often. HLS and MJPEG are
 * continuous streams and must never be re-pointed.
 */
export function refreshInterval(kind: PreviewKind): number {
  if (kind === 'jpg') return 15000;
  if (kind === 'mp4') return 60000;
  return 0;
}
