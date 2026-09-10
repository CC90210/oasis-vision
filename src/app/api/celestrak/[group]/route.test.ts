import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from './route';
import { clearGevCache } from '@/lib/gev-cache';

/**
 * The vendored globe client (gods-eye-view src/data/satellites.js,
 * rocketLaunches.js) requests satellite groups path-style —
 * `/api/celestrak/<group>` — never the query-string form. Before this route
 * existed, every group but the static `active` sibling 404d and the
 * satellite layer stayed empty. These tests pin the path resolving to real
 * data, and an invalid group still being rejected on this path too.
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

  it('resolves a path-style group request and returns TLE records', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => TLE_SAMPLE,
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callGet('stations');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.group).toBe('stations');
    expect(body.count).toBe(1);
    expect(body.records[0].noradId).toBe('25544');

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
});
