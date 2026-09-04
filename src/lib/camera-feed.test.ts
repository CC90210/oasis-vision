import { describe, it, expect } from 'vitest';
import { describeFeed, isHostedOffPlatform, liveFeedAtSource, localEmbed, needsResolution, offPlatformView, type FeedState } from './camera-feed';

const SKY = 'https://www.skylinewebcams.com/en/webcam/japan/gunma/yubatake/yubatake.html';
const WATCH = 'https://www.youtube.com/watch?v=UemFRPrl1hk';
const CHANNEL_LIVE = 'https://www.youtube.com/@AaronPreslin/live';

describe('isHostedOffPlatform', () => {
  it('is true only when we hold nothing but a link', () => {
    expect(isHostedOffPlatform({ external_url: SKY })).toBe(true);
    expect(isHostedOffPlatform({ external_url: SKY, stream_url: 'https://x/live.m3u8' })).toBe(false);
    expect(isHostedOffPlatform({ external_url: SKY, feed_url: 'https://x/snap.jpg' })).toBe(false);
  });

  it('is safe on a missing or empty camera', () => {
    expect(isHostedOffPlatform(null)).toBe(false);
    expect(isHostedOffPlatform(undefined)).toBe(false);
    expect(isHostedOffPlatform({})).toBe(false);
  });
});

describe('localEmbed', () => {
  it('builds an embed from a link that already names the video', () => {
    // No round-trip: the URL carries everything needed.
    expect(localEmbed({ external_url: WATCH })).toContain('/embed/UemFRPrl1hk');
    expect(localEmbed({ external_url: 'https://youtu.be/GrEEoEmmrKs' })).toContain('/embed/GrEEoEmmrKs');
  });

  it('cannot answer for a channel link, which names no video', () => {
    expect(localEmbed({ external_url: CHANNEL_LIVE })).toBeNull();
  });

  it('cannot answer for an operator page', () => {
    expect(localEmbed({ external_url: SKY })).toBeNull();
  });

  it('leaves a camera alone when it already has a playable feed', () => {
    expect(localEmbed({ external_url: WATCH, stream_url: 'https://x/y.m3u8' })).toBeNull();
  });
});

describe('needsResolution', () => {
  it('resolves an operator page', () => {
    expect(needsResolution({ external_url: SKY })).toBe(true);
  });

  it('resolves a channel live link, whose video changes every broadcast', () => {
    expect(needsResolution({ external_url: CHANNEL_LIVE })).toBe(true);
  });

  it('does not go to the network for a link that already names the video', () => {
    // This is the point of localEmbed: asking a server to tell us what the URL
    // already says would add a round-trip and a failure mode for nothing.
    expect(needsResolution({ external_url: WATCH })).toBe(false);
    expect(localEmbed({ external_url: WATCH })).not.toBeNull();
  });

  it('leaves a camera alone when it already has a playable feed', () => {
    expect(needsResolution({ external_url: SKY, stream_url: 'https://x/live.m3u8' })).toBe(false);
    expect(needsResolution({ external_url: SKY, feed_url: 'https://x/snap.jpg' })).toBe(false);
  });

  it('leaves operators we cannot open alone', () => {
    // Off-platform and not resolvable are two different facts: the viewer shows
    // the external panel for these, but must not call the resolver.
    for (const url of [
      'https://www.earthcam.com/usa/kentucky/covington/?cam=covington',
      'https://voyage.aprr.fr/carte-itineraires?type=webcam',
      'https://www.windy.com/webcams/12345',
    ]) {
      expect(isHostedOffPlatform({ external_url: url }), url).toBe(true);
      expect(needsResolution({ external_url: url }), url).toBe(false);
    }
  });

  it('is safe on a missing or empty camera', () => {
    expect(needsResolution(null)).toBe(false);
    expect(needsResolution(undefined)).toBe(false);
    expect(needsResolution({})).toBe(false);
  });
});

describe('offPlatformView', () => {
  const v = (o: Partial<Parameters<typeof offPlatformView>[0]>) =>
    offPlatformView({ hostedOffPlatform: true, resolving: false, resolvedEmbed: null, ...o });

  it('plays a camera that has its own feed, without consulting anything', () => {
    expect(v({ hostedOffPlatform: false })).toBe('inline');
  });

  it('shows the resolving state while looking, not the external panel', () => {
    // Otherwise a camera that is about to play inline flashes up 'requires
    // external clearance' first, which reads as a failure.
    expect(v({ resolving: true })).toBe('resolving');
  });

  it('plays inline once a feed is found', () => {
    expect(v({ resolvedEmbed: 'https://www.youtube-nocookie.com/embed/GrEEoEmmrKs' })).toBe('inline');
  });

  it('says a camera is off air rather than sending the operator after it', () => {
    // 'external' would offer an ACCESS TERMINAL button leading to a page that
    // is itself showing an offline banner — a wild goose chase.
    expect(v({ offline: true })).toBe('offline');
  });

  it('still plays a feed that was found, even if offline was set', () => {
    expect(v({ offline: true, resolvedEmbed: 'https://x/embed/y' })).toBe('inline');
  });

  it('reports resolving before offline, since the answer is not in yet', () => {
    expect(v({ offline: true, resolving: true })).toBe('resolving');
  });

  it('treats a withdrawn camera the same as an off-air one', () => {
    // Both mean "nothing to show and nowhere to send you". The viewer varies
    // only the wording; offering a link would lead to a 404 or an offline page.
    expect(v({ offline: true })).toBe('offline');
  });

  it('falls back to the external link when nothing was found', () => {
    expect(v({ resolving: false, resolvedEmbed: null })).toBe('external');
  });

  it('shows a snapshot straight away, without waiting on the lookup', () => {
    // The picture is already in hand; blocking it behind a network round-trip
    // would make a working camera feel slower than before.
    expect(v({ hostedOffPlatform: false, resolving: true })).toBe('inline');
  });

  it('withdraws a snapshot once the source says the camera is gone', () => {
    // SkylineWebcams reuses its numeric snapshot ids. live341.jpg is captioned
    // 'Rome - Trevi Fountain' in our data and currently shows a Canarian beach,
    // because that camera was withdrawn and the id was reassigned.
    expect(v({ hostedOffPlatform: false, offline: true })).toBe('offline');
  });

  it('prefers a found feed over a still-running lookup', () => {
    // Both true is reachable: resolvedEmbed lands before `resolving` clears.
    expect(v({ resolving: true, resolvedEmbed: 'https://x/embed/y' })).toBe('inline');
  });
});

describe('liveFeedAtSource', () => {
  const JPG = 'https://cdn.skylinewebcams.com/live5368.jpg';

  it('offers the source page for a Skyline camera we only get stills from', () => {
    // Cochabamba: a snapshot here, live video on their page behind a token,
    // a watermark and an ad break. We link to it rather than reproduce it.
    expect(liveFeedAtSource({ external_url: SKY, feed_url: JPG })).toBe(SKY);
  });

  it('offers nothing when the camera already plays here', () => {
    // A resolved YouTube camera has no still and needs no way out.
    expect(liveFeedAtSource({ external_url: SKY })).toBeNull();
    expect(liveFeedAtSource({ external_url: SKY, feed_url: JPG, stream_url: 'https://x/y.m3u8' })).toBeNull();
  });

  it('does not claim live video exists behind other operators', () => {
    // Only SkylineWebcams is known to keep a live stream behind the still.
    expect(liveFeedAtSource({ external_url: 'https://www.earthcam.com/x', feed_url: JPG })).toBeNull();
    expect(liveFeedAtSource({ external_url: 'https://voyage.aprr.fr/x', feed_url: JPG })).toBeNull();
  });

  it('is safe on a missing or empty camera', () => {
    expect(liveFeedAtSource(null)).toBeNull();
    expect(liveFeedAtSource(undefined)).toBeNull();
    expect(liveFeedAtSource({})).toBeNull();
    expect(liveFeedAtSource({ feed_url: JPG })).toBeNull();
  });
});

/**
 * These labels were two nested ternaries at two call sites. Every one of them
 * overstated what was actually on screen at some point this session, and the
 * two had already drifted apart over mjpeg, so the rules are pinned here.
 */
describe('describeFeed', () => {
  const base: FeedState = {
    streamType: 'hls',
    streamFailed: false,
    watchLive: false,
    externalOnly: false,
    offline: false,
    gone: false,
  };
  const f = (over: Partial<FeedState> = {}) => describeFeed({ ...base, ...over });

  it('never calls a timed still live', () => {
    // "LIVE SAT-LINK" was wrong twice: no satellite link, and a still on a
    // timer is not live video. Ontario serves its own outage notice as a valid
    // JPEG, so this label sat over a picture saying the camera was down.
    const l = f({ streamType: 'jpg' });
    expect(l.badge).toBe('SNAPSHOT');
    expect(l.status).toBe('STILL / REFRESHES ~20s');
    expect(l.badge).not.toMatch(/LIVE/);
  });

  it('never calls a finite clip live', () => {
    const l = f({ streamType: 'mp4' });
    expect(l.badge).toBe('RECENT CLIP');
    expect(l.badge).not.toMatch(/LIVE/);
  });

  it('does call genuinely continuous streams live', () => {
    expect(f({ streamType: 'hls' }).badge).toBe('LIVE FEED');
    expect(f({ streamType: 'mjpeg' }).badge).toBe('LIVE MJPEG');
  });

  // The drift this function exists to prevent: the badge knew about mjpeg and
  // the status line did not, so LIVE MJPEG sat above ACTIVE / RECORDING.
  it('keeps badge and status consistent for every stream kind', () => {
    for (const streamType of ['jpg', 'mp4', 'mjpeg', 'hls']) {
      const l = f({ streamType });
      const badgeSaysLive = /LIVE/.test(l.badge);
      const statusSaysContinuous = l.status === 'CONTINUOUS STREAM';
      expect(badgeSaysLive, `${streamType}: badge and status disagree`).toBe(statusSaysContinuous);
    }
  });

  it('reports a failed stream as a snapshot, naming the reason', () => {
    const l = f({ streamType: 'jpg', streamFailed: true });
    expect(l.badge).toBe('SNAPSHOT · STREAM OFFLINE');
    expect(l.status).toBe('STREAM 404 AT SOURCE');
  });

  it('distinguishes withdrawn from merely off air', () => {
    expect(f({ offline: true, gone: false }).status).toBe('OFF AIR AT SOURCE');
    expect(f({ offline: true, gone: true }).status).toBe('REMOVED BY SOURCE');
  });

  it('puts offline ahead of every other state', () => {
    // A camera the source has withdrawn is not "a snapshot with a dead stream".
    const l = f({ offline: true, gone: true, streamFailed: true, watchLive: true, streamType: 'mp4' });
    expect(l.badge).toBe('WITHDRAWN');
  });

  it('says nothing is received locally for an external feed', () => {
    const l = f({ externalOnly: true, streamType: 'jpg' });
    expect(l.badge).toBe('EXTERNAL');
    expect(l.status).toBe('HOSTED OFF-PLATFORM');
  });

  it('points at the source when live video exists only on its own page', () => {
    const l = f({ watchLive: true, streamType: 'jpg' });
    expect(l.badge).toBe('SNAPSHOT');
    expect(l.status).toBe('LIVE VIDEO AT SOURCE');
  });

  it('falls back to a safe pair for an unrecognised kind', () => {
    const l = f({ streamType: 'rtsp' });
    expect(l.badge).toBeTruthy();
    expect(l.status).toBeTruthy();
  });
});
