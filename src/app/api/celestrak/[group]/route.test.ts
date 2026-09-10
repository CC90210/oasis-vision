import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from './route';
import { clearGevCache } from '@/lib/gev-cache';

/**
 * The vendored globe client (gods-eye-view src/data/satellites.js,
 * rocketLaunches.js) requests satellite groups path-style —
 * `/api/celestrak/<group>` — never the query-string form. Before this route
 * existed, every group but the static `active` sibling 404d and the
 * satellite layer stayed empty.
 *
 * These pin the path RESOLUTION and the group allowlist. The response
 * CONTRACT (raw TLE text, provenance in headers) is pinned separately in
 * ../contract.test.ts — the two are different failures and neither test
 * catches the other's.
 */

const TLE_SAMPLE = [
  'ISS (ZARYA)             ',
  '1 25544U 98067A   26251.54791667  .00016717  00000-0  30777-3 0  9004',
  '2 25544  51.6394 339.0574 0004449  62.5936 297.5623 15.49814294 12345',
  '',
].join('\n');

function callGet(group: string) {
  return GET(new Request(`http://localhost/api/celestrak/${group}`), {
    params: Promise.resolve({ group }),
  });
}

describe('GET /api/celestrak/[group] — path-style resolution', () => {
  beforeEach(async () => {
    await clearGevCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a path-style group request and returns its TLE', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => TLE_SAMPLE,
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callGet('stations');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(TLE_SAMPLE);
    // The parsed object count is reported alongside the text, not instead of it.
    expect(res.headers.get('x-oasis-count')).toBe('1');
    expect(res.headers.get('x-oasis-group')).toBe('stations');

    // Confirms the route actually forwarded the path segment as the upstream
    // GROUP, not a hardcoded value.
    const calledUrl = new URL(String(fetchMock.mock.calls[0][0]));
    expect(calledUrl.searchParams.get('GROUP')).toBe('stations');
  });

  it('rejects an invalid group on the path-style route without calling upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // The decoded path segment Next would hand this route for a group name
    // crafted to alter the upstream query string.
    const res = await callGet('stations&FORMAT=json');

    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves an upstream throttle page as a 502, never as zero satellites', async () => {
    // CelesTrak answers 200 with HTML when throttling. Forwarding that body
    // would reach the client's parseTLE as an empty catalogue.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<html><body>Rate limited</body></html>',
    }));

    const res = await callGet('stations');
    expect(res.status).toBe(502);
  });
});
