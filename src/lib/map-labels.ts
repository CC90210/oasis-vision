/**
 * OASIS VISION — keeping place names readable over satellite imagery.
 *
 * The basemap is CARTO dark-matter, whose label colours are chosen for a very
 * dark ground: countries are drawn around rgba(157,157,157) with a 1px #111
 * halo. That reads well on the dark style and is close to invisible once the
 * satellite raster is laid over it — a country name in mid-grey on sunlit
 * desert has almost no contrast, which is why "TURKMENISTAN" could not be read
 * at all on imagery.
 *
 * So the labels are re-painted when imagery is on and restored when it is off,
 * rather than being made permanently bright, which would blow out the dark
 * style they were designed for.
 */

/** Layers to re-paint, in the order CARTO defines them. */
export interface LabelClass {
  /** Style layer ids this rule applies to. */
  ids: string[];
  /** Text colour over imagery. */
  color: string;
  /** Halo width over imagery — this does more work than the colour. */
  haloWidth: number;
}

/**
 * Grouped by how prominent each class should be.
 *
 * Countries and continents get the most weight because they are what the map
 * is being read at when the imagery is most washed-out — zoomed out, where a
 * label sits over thousands of kilometres of varied terrain.
 */
export const LABEL_CLASSES: LabelClass[] = [
  {
    ids: ['place_continent', 'place_country_1', 'place_country_2'],
    color: '#FFFFFF',
    haloWidth: 2.0,
  },
  {
    ids: ['place_state', 'place_city_r5', 'place_city_r6', 'place_capital_dot_z7'],
    color: '#F2F6FA',
    haloWidth: 1.7,
  },
  {
    ids: [
      'place_town', 'place_villages', 'place_hamlet', 'place_suburbs',
      'place_city_dot_r2', 'place_city_dot_r4', 'place_city_dot_r7', 'place_city_dot_z7',
      'waterway_label',
    ],
    color: '#E4EAF0',
    haloWidth: 1.5,
  },
];

/** Every layer id this module touches. */
export function labelLayerIds(): string[] {
  return LABEL_CLASSES.flatMap(c => c.ids);
}

/** Minimal surface of the map object used here, so this stays testable. */
export interface LabelTarget {
  getLayer(id: string): unknown;
  setPaintProperty(id: string, prop: string, value: unknown): void;
}

/**
 * Re-paint place labels for imagery, or restore the style's own colours.
 *
 * Restoring passes `undefined`, which is how MapLibre is told to fall back to
 * the value in the loaded style — setting a hardcoded "original" here would
 * freeze the dark theme's colours and break the Style Studio, which repaints
 * these same properties.
 *
 * Layers absent from the style are skipped rather than throwing: CARTO revises
 * dark-matter, and a renamed layer should cost one unreadable label, not the
 * whole style switch.
 */
export function setLabelsForImagery(map: LabelTarget, imagery: boolean): void {
  for (const cls of LABEL_CLASSES) {
    for (const id of cls.ids) {
      if (!map.getLayer(id)) continue;
      map.setPaintProperty(id, 'text-color', imagery ? cls.color : undefined);
      map.setPaintProperty(id, 'text-halo-color', imagery ? '#000000' : undefined);
      map.setPaintProperty(id, 'text-halo-width', imagery ? cls.haloWidth : undefined);
      // A little blur softens the halo edge so heavy outlines do not read as
      // stickers pasted over the terrain.
      map.setPaintProperty(id, 'text-halo-blur', imagery ? 0.6 : undefined);
    }
  }
}
