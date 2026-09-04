import { describe, it, expect } from 'vitest';
import {
  proxiedTileUrl,
  proxiedTileTemplate,
  needsProxy,
  AWS_TERRAIN_TEMPLATE,
  AWS_TERRAIN_ENCODING,
} from './tile-proxy';

/**
 * The DEM source shipped broken once because the tile template was wrapped
 * whole in encodeURIComponent: {z} became %7Bz%7D, MapLibre matched no
 * placeholder, zero tiles were requested, and the layer rendered nothing while
 * typecheck, tests and build all stayed green. These pin the encoding.
 */
describe('proxiedTileTemplate', () => {
  it('keeps {z}/{x}/{y} literal so MapLibre can substitute them', () => {
    const t = proxiedTileTemplate(AWS_TERRAIN_TEMPLATE);
    expect(t).toContain('{z}');
    expect(t).toContain('{x}');
    expect(t).toContain('{y}');
    // The exact failure mode, named.
    expect(t).not.toContain('%7B');
    expect(t).not.toContain('%7D');
  });

  it('still encodes the separators, so the upstream URL stays one parameter', () => {
    const t = proxiedTileTemplate(AWS_TERRAIN_TEMPLATE);
    expect(t).toContain('https%3A%2F%2Fs3.amazonaws.com');
    // A bare "/" here would end the url parameter and truncate the target.
    expect(t).not.toContain('url=https://');
  });

  it('round-trips to the real upstream URL once placeholders are filled', () => {
    // This is the whole contract: what the proxy finally receives must be the
    // tile that was asked for.
    const filled = proxiedTileTemplate(AWS_TERRAIN_TEMPLATE)
      .replace('{z}', '10').replace('{x}', '196').replace('{y}', '365');
    const parsed = new URL(filled, 'http://localhost:3177');
    expect(parsed.pathname).toBe('/api/proxy-tiles');
    expect(parsed.searchParams.get('url'))
      .toBe('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/196/365.png');
  });

  it('handles a template whose upstream already carries a query string', () => {
    const filled = proxiedTileTemplate('https://tiles.example/{z}/{x}/{y}.png?v=2&key=abc')
      .replace('{z}', '3').replace('{x}', '1').replace('{y}', '2');
    const parsed = new URL(filled, 'http://localhost:3177');
    // The upstream's own & and = must not leak into our query string.
    expect(parsed.searchParams.get('url')).toBe('https://tiles.example/3/1/2.png?v=2&key=abc');
  });
});

describe('proxiedTileUrl', () => {
  it('encodes a concrete URL whole, placeholders being irrelevant', () => {
    const u = proxiedTileUrl('https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json');
    const parsed = new URL(u, 'http://localhost:3177');
    expect(parsed.searchParams.get('url'))
      .toBe('https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json');
  });

  it('does not mangle a URL that legitimately contains braces', () => {
    // Unlike the template form, nothing here should be un-encoded.
    const u = proxiedTileUrl('https://x.cartocdn.com/a{b}c.png');
    expect(u).toContain('%7B');
  });
});

describe('needsProxy', () => {
  it('routes the two upstreams that cannot be fetched directly', () => {
    expect(needsProxy('https://basemaps.cartocdn.com/gl/style.json')).toBe(true);
    expect(needsProxy('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/1/1/1.png')).toBe(true);
  });

  it('leaves everything else alone', () => {
    // OpenFreeMap and ArcGIS are CORS-open and must not pay a proxy hop.
    expect(needsProxy('https://tiles.openfreemap.org/planet')).toBe(false);
    expect(needsProxy('https://server.arcgisonline.com/ArcGIS/rest/x/1/2/3')).toBe(false);
  });
});

describe('AWS terrain constants', () => {
  it('declares terrarium encoding, which is what AWS actually publishes', () => {
    // Mapbox encoding on a terrarium tile renders a plausible but entirely
    // wrong landscape rather than failing, so this is worth pinning.
    expect(AWS_TERRAIN_ENCODING).toBe('terrarium');
    expect(AWS_TERRAIN_TEMPLATE).toContain('/terrarium/');
  });

  it('points at the elevation bucket the proxy allowlist permits', () => {
    expect(AWS_TERRAIN_TEMPLATE).toContain('s3.amazonaws.com/elevation-tiles-prod/');
  });
});
