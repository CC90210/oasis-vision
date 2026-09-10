import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { assertBbox, overpassQuery, OVERPASS_MIRRORS } from './overpass';
import { clearGevCache } from './gev-cache';

const okBody = JSON.stringify({ elements: [{ type: 'node', id: 1, lat: 45.5, lon: -73.6, tags: { military: 'base' } }] });

describe('assertBbox', () => {
  it('accepts a small box', () => {
    expect(() => assertBbox(45.6, 45.4, -73.5, -73.7)).not.toThrow();
  });

  it('rejects a span wider than 12 degrees', () => {
    expect(() => assertBbox(50, 30, 10, 0)).toThrow(/12/);
  });

  it('rejects a box crossing the antimeridian', () => {
    expect(() => assertBbox(10, -10, -179, 179)).toThrow(/antimeridian/i);
  });
});

describe('overpassQuery', () => {
  beforeEach(() => clearGevCache());
  afterEach(() => vi.unstubAllGlobals());

  it('rotates to the next mirror when the first refuses', async () => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url));
      if (seen.length === 1) return new Response('rate limited', { status: 429 });
      return new Response(okBody, { status: 200 });
    }));

    const r = await overpassQuery('node(1);out;');
    expect(seen[0]).toBe(OVERPASS_MIRRORS[0]);
    expect(seen[1]).toBe(OVERPASS_MIRRORS[1]);
    expect(r.elements).toHaveLength(1);
    expect(r.provenance.mirror).toBe(OVERPASS_MIRRORS[1]);
  });

  it('never caches a refusal as data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    await expect(overpassQuery('node(2);out;')).rejects.toThrow(/every overpass mirror refused/i);

    // A second attempt must go back upstream rather than replay the refusal.
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return new Response(okBody, { status: 200 });
    }));
    const r = await overpassQuery('node(2);out;');
    expect(calls.length).toBeGreaterThan(0);
    expect(r.elements).toHaveLength(1);
    expect(r.provenance.age).toBe('fresh');
  });

  it('serves a stale copy when every mirror refuses after a good answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(okBody, { status: 200 })));
    await overpassQuery('node(3);out;', { ttlMs: -1 });

    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const r = await overpassQuery('node(3);out;', { ttlMs: -1 });
    expect(r.provenance.age).toBe('stale');
    expect(r.elements).toHaveLength(1);
  });

  it('coalesces identical concurrent queries into one upstream call', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls++;
      await new Promise(r => setTimeout(r, 10));
      return new Response(okBody, { status: 200 });
    }));
    await Promise.all([overpassQuery('node(4);out;'), overpassQuery('node(4);out;')]);
    expect(calls).toBe(1);
  });

  it('gives queries differing only inside a quoted literal separate cache entries', async () => {
    // Two spaces vs. one space, both INSIDE the quoted tag value — a real,
    // semantically different Overpass query, not cosmetic whitespace.
    const qTwoSpaces = 'node["name"="New  York"];out;';
    const qOneSpace = 'node["name"="New York"];out;';

    const bodyTwoSpaces = JSON.stringify({ elements: [{ type: 'node', id: 500, lat: 1, lon: 1 }] });
    const bodyOneSpace = JSON.stringify({ elements: [{ type: 'node', id: 501, lat: 2, lon: 2 }] });

    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const sentQuery = new URLSearchParams(String(init?.body ?? '')).get('data');
      if (sentQuery === qTwoSpaces) return new Response(bodyTwoSpaces, { status: 200 });
      if (sentQuery === qOneSpace) return new Response(bodyOneSpace, { status: 200 });
      throw new Error(`test double received an unexpected query: ${JSON.stringify(sentQuery)}`);
    }));

    const rTwoSpaces = await overpassQuery(qTwoSpaces);
    const rOneSpace = await overpassQuery(qOneSpace);

    expect(rTwoSpaces.elements[0].id).toBe(500);
    expect(rOneSpace.elements[0].id).toBe(501);
  });
});
