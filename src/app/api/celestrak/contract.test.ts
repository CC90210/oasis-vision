import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as groupGet } from './[group]/route';
import { GET as activeGet } from './active/route';
import { clearGevCache } from '@/lib/gev-cache';

/**
 * CONTRACT test — what the vendored globe client actually parses.
 *
 * A mapper test cannot catch a wrong envelope. These assert the RESPONSE the
 * client consumes, not the shape of an internal helper.
 *
 * Client source of truth (C:/Users/echel/JARVIS/_ingested/gods-eye-view):
 *   src/data/satellites.js:1096   const res = await fetch(`/api/celestrak/${DENSE_GROUP_PATH}`, …)
 *   src/data/satellites.js:1104   const text = await res.text();
 *   src/data/satellites.js:1108   const entries = parseTLE(text);
 *   src/data/satellites.js:1635-1637
 *                                 const res = await fetch(`/api/celestrak/${groupDef.path}`, …)
 *                                 const entries = parseTLE(await res.text());
 *   src/data/rocketLaunches.js:3258-3262
 *                                 fetch('/api/celestrak/active').then(r => r.text())
 *
 * The client never calls res.json() on this endpoint. It reads RAW TLE TEXT.
 * A JSON envelope parses to zero entries and the satellite layer goes empty
 * with a 200 and no error anywhere — the silent failure this file exists for.
 */

/**
 * Verbatim copy of the client's parser (satellites.js:458-470). Copied rather
 * than described so this test fails for exactly the reason the client would.
 */
function parseTLE(text: string) {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const result: Array<{ name: string; line1: string; line2: string }> = [];
  for (let i = 0; i < lines.length - 2; i += 3) {
    const name = lines[i];
    const line1 = lines[i + 1];
    const line2 = lines[i + 2];
    if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
      result.push({ name, line1, line2 });
    }
  }
  return result;
}

/** A real trimmed CelesTrak `FORMAT=tle` body (two objects from `stations`). */
const TLE_SAMPLE = [
  'ISS (ZARYA)             ',
  '1 25544U 98067A   26251.54791667  .00016717  00000-0  30777-3 0  9004',
  '2 25544  51.6394 339.0574 0004449  62.5936 297.5623 15.49814294 12345',
  'CSS (TIANHE)            ',
  '1 48274U 21035A   26251.51234568  .00021613  00000-0  24581-3 0  9995',
  '2 48274  41.4712 176.1223 0006123  25.4404 334.6668 15.61234567 54321',
  '',
].join('\n');

function stubUpstream() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => TLE_SAMPLE,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('CONTRACT /api/celestrak/[group] — raw TLE text, not JSON', () => {
  beforeEach(async () => {
    await clearGevCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers text/plain so res.text() is the TLE the client parses', async () => {
    stubUpstream();
    const res = await groupGet(new Request('http://localhost/api/celestrak/stations'), {
      params: Promise.resolve({ group: 'stations' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/^text\/plain/);

    const entries = parseTLE(await res.text());
    expect(entries).toHaveLength(2);
    expect(entries[0].name).toBe('ISS (ZARYA)');
    expect(entries[0].line1.startsWith('1 25544U')).toBe(true);
    expect(entries[0].line2.startsWith('2 25544')).toBe(true);
  });

  it('carries provenance in headers, never in a body the client would choke on', async () => {
    stubUpstream();
    const res = await groupGet(new Request('http://localhost/api/celestrak/stations'), {
      params: Promise.resolve({ group: 'stations' }),
    });

    const body = await res.text();
    expect(body).not.toContain('provenance');
    expect(body).not.toContain('"count"');
    expect(res.headers.get('x-oasis-age')).toMatch(/^(fresh|cached|stale)$/);
    expect(Number(res.headers.get('x-oasis-fetched-at'))).toBeGreaterThan(0);
  });
});

describe('CONTRACT /api/celestrak/active — raw TLE text, not JSON', () => {
  beforeEach(async () => {
    await clearGevCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers text/plain for the launches layer TLE lookup', async () => {
    stubUpstream();
    const res = await activeGet();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toMatch(/^text\/plain/);
    expect(parseTLE(await res.text())).toHaveLength(2);
  });
});
