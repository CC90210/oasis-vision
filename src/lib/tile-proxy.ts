/**
 * OASIS VISION — routing map tiles through the internal proxy.
 *
 * Two upstreams the map needs cannot be fetched from the browser directly:
 * CARTO (the basemap style and its vector tiles) and AWS Terrain Tiles (the DEM
 * behind real 3D terrain), which serves no Access-Control-Allow-Origin at all.
 * `/api/proxy-tiles` fronts both behind a strict host allowlist.
 *
 * This lives in lib rather than inline in the map component because building
 * the URL is not as obvious as it looks, and getting it wrong fails silently —
 * see `proxiedTileTemplate`.
 */

/** Where the proxy lives. Absolute in the browser, relative under SSR. */
function proxyBase(): string {
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/**
 * Proxy a concrete tile or asset URL — one that names an actual resource.
 *
 * Use this from `transformRequest`, which is handed real URLs the style has
 * already resolved.
 */
export function proxiedTileUrl(url: string): string {
  return `${proxyBase()}/api/proxy-tiles?url=${encodeURIComponent(url)}`;
}

/**
 * Proxy a tile URL *template* — one still containing `{z}`, `{x}`, `{y}`.
 *
 * MapLibre substitutes those placeholders by literal string match, so they have
 * to survive encoding. `encodeURIComponent` turns `{z}` into `%7Bz%7D`, which
 * matches nothing: the source is created without complaint, requests zero
 * tiles, and the layer silently renders nothing while every build and test
 * stays green. That is exactly how the DEM source shipped broken the first
 * time. Everything else is encoded — the `/` separators become `%2F`, which is
 * what keeps the whole upstream URL inside one query parameter — and only the
 * braces are restored.
 */
export function proxiedTileTemplate(template: string): string {
  return `${proxyBase()}/api/proxy-tiles?url=${encodeURIComponent(template)
    .replace(/%7B/g, '{')
    .replace(/%7D/g, '}')}`;
}

/** Hosts `/api/proxy-tiles` will fetch. Kept beside the callers that rely on it. */
export const PROXIED_HOSTS = ['cartocdn.com', 'elevation-tiles-prod.s3.amazonaws.com', 's3.amazonaws.com'] as const;

/** True when a URL needs to go through the proxy rather than straight out. */
export function needsProxy(url: string): boolean {
  return url.includes('cartocdn.com') || url.includes('elevation-tiles-prod');
}

/**
 * AWS Terrain Tiles — keyless global elevation (SRTM, GMTED, ETOPO1).
 *
 * Terrarium encoding, not Mapbox's: height is (R * 256 + G + B / 256) - 32768.
 * Declaring the wrong encoding renders a plausible but entirely wrong landscape
 * rather than failing, so it is pinned here next to the URL it belongs to.
 */
export const AWS_TERRAIN_TEMPLATE =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const AWS_TERRAIN_ENCODING = 'terrarium' as const;
export const AWS_TERRAIN_ATTRIBUTION = 'Elevation: AWS Terrain Tiles · SRTM, GMTED, ETOPO1';
