/**
 * OASIS VISION — real infrared imagery from NASA GIBS.
 *
 * This is the genuine article, and it is deliberately separate from the THERMAL
 * vision mode in lib/vision-modes.ts. That one is false colour applied to the
 * rendered picture's brightness — a look. This is VIIRS band I5 brightness
 * temperature: an actual radiometric measurement from an instrument in orbit,
 * where a bright pixel means the ground under it is genuinely hot.
 *
 * God's Eye View's "infrared" is the former. Its shader also draws a
 * temperature readout invented from screen luminance
 * (`tempC = 20.0 + centerLuma * 30.0`), which is a fabricated instrument
 * reading. This module is the honest version of that feature.
 *
 * Keyless, CORS-open, and rendered by MapLibre as an ordinary raster source —
 * no Cesium, no key, no proxy.
 *
 * WHAT IT CAN AND CANNOT SHOW. Resolution is about 375 m per pixel at best, so
 * a wildfire front, an industrial heat source or an urban heat island are all
 * legible. An aircraft, a vehicle or a person is not, and never will be.
 */

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';

export interface ThermalLayerDef {
  id: string;
  label: string;
  /** GIBS layer identifier. */
  layer: string;
  /** The tile matrix set this specific layer is published in. */
  matrixSet: string;
  /** Highest zoom the source actually serves. */
  maxZoom: number;
  blurb: string;
}

/**
 * Available bands.
 *
 * The matrix set is per-layer and getting it wrong returns
 * `TILEMATRIXSET is invalid for LAYER` rather than a tile — VIIRS is published
 * at Level9 while the MODIS equivalents are at Level7, so these are pinned per
 * entry rather than assumed.
 */
export const THERMAL_LAYERS: ThermalLayerDef[] = [
  {
    id: 'viirs-day',
    label: 'IR · DAY',
    layer: 'VIIRS_NOAA20_Brightness_Temp_BandI5_Day',
    matrixSet: 'GoogleMapsCompatible_Level9',
    maxZoom: 9,
    blurb: 'VIIRS band I5 brightness temperature, daytime pass (~375 m/px)',
  },
  {
    id: 'viirs-night',
    label: 'IR · NIGHT',
    layer: 'VIIRS_NOAA20_Brightness_Temp_BandI5_Night',
    matrixSet: 'GoogleMapsCompatible_Level9',
    maxZoom: 9,
    blurb: 'VIIRS band I5 brightness temperature, night pass (~375 m/px)',
  },
  {
    id: 'modis-day',
    label: 'IR · MODIS',
    layer: 'MODIS_Aqua_Brightness_Temp_Band31_Day',
    matrixSet: 'GoogleMapsCompatible_Level7',
    maxZoom: 7,
    blurb: 'MODIS band 31 brightness temperature, coarser but longer archive',
  },
];

export function thermalLayer(id: string): ThermalLayerDef | undefined {
  return THERMAL_LAYERS.find(l => l.id === id);
}

/**
 * The date to request, as GIBS wants it.
 *
 * GIBS publishes a day's imagery some hours after the satellite passes, so
 * asking for today commonly yields a tile that is empty rather than an error —
 * data that silently is not there. Default to the previous day, which is
 * always complete.
 */
export function gibsDate(now: Date = new Date(), daysBack = 1): string {
  const d = new Date(now.getTime() - daysBack * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * A MapLibre raster tile template for a thermal band.
 *
 * GIBS REST order is {TileMatrixSet}/{z}/{y}/{x} — row before column. Swapping
 * them returns tiles of the wrong place rather than an error, so the layout is
 * asserted in the tests.
 */
export function thermalTileUrl(def: ThermalLayerDef, date: string): string {
  return `${GIBS}/${def.layer}/default/${date}/${def.matrixSet}/{z}/{y}/{x}.png`;
}

/** Attribution GIBS asks for, shown wherever the layer is. */
export const THERMAL_ATTRIBUTION =
  'Infrared: NASA EOSDIS GIBS · VIIRS/NOAA-20 · brightness temperature';
