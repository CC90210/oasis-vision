/**
 * OASIS VISION — sensor-look vision modes for the map.
 *
 * WHAT THESE ARE, STATED ONCE SO THE UI NEVER OVERSELLS THEM: a false-colour
 * pass over the already-rendered frame. THERMAL maps the picture's luminance
 * onto a FLIR ironbow ramp; a white roof therefore reads "hot" and black
 * asphalt at noon reads "cold". There is no thermal band, no radiometry and no
 * sensor behind it. It is the same thing God's Eye View does — its
 * src/styles/thermal.js is a Cesium post-process shader on exactly this
 * principle — and the palette stops below are taken from that shader so the
 * look matches rather than being invented.
 *
 * Real thermal data does exist in the app and is a separate thing: NASA FIRMS
 * VIIRS fire detections, on the fires layer.
 *
 * Implementation note. MapLibre has no post-process hook, so this cannot be a
 * shader stage the way Cesium does it. An SVG filter does the job properly:
 * feColorMatrix collapses the frame to luminance, then feComponentTransfer
 * applies a genuine per-channel lookup table with linear interpolation between
 * stops — a real LUT, not a hue-rotate approximation. It composites on the GPU
 * and costs nothing per frame in JS.
 */

export type VisionModeId = 'none' | 'thermal' | 'nightvision' | 'sar';

export interface VisionMode {
  id: VisionModeId;
  label: string;
  /** One line under the control. Says what it is, not what it pretends to be. */
  blurb: string;
  /** Per-channel LUT stops, 0..1, applied to frame luminance. */
  table?: { r: number[]; g: number[]; b: number[] };
  /** Extra CSS filter applied after the LUT. */
  css?: string;
}

/**
 * FLIR ironbow, from God's Eye View src/styles/thermal.js:40-46.
 * black → deep purple → magenta → red → orange → yellow → white.
 */
const IRONBOW = {
  r: [0.0, 0.13, 0.49, 0.86, 1.0, 1.0, 1.0],
  g: [0.0, 0.0, 0.0, 0.10, 0.55, 0.91, 1.0],
  b: [0.0, 0.30, 0.45, 0.18, 0.0, 0.32, 1.0],
};

/** PVS-14 style green phosphor — GEV's surveillance.js works the same way. */
const PHOSPHOR = {
  r: [0.0, 0.05, 0.10],
  g: [0.0, 0.80, 1.00],
  b: [0.0, 0.10, 0.20],
};

/** Single-channel radar-style grey, hot on the bright end. */
const SAR_GREY = {
  r: [0.0, 0.55, 1.0],
  g: [0.0, 0.60, 1.0],
  b: [0.0, 0.52, 0.95],
};

export const VISION_MODES: VisionMode[] = [
  { id: 'none', label: 'NORMAL', blurb: 'Map as rendered' },
  {
    id: 'thermal',
    label: 'THERMAL',
    blurb: 'False colour on brightness — a look, not a sensor',
    table: IRONBOW,
    css: 'contrast(1.15) saturate(1.1)',
  },
  {
    id: 'nightvision',
    label: 'NIGHT VISION',
    blurb: 'Green phosphor, image-intensifier look',
    table: PHOSPHOR,
    css: 'brightness(1.25) contrast(1.2)',
  },
  {
    id: 'sar',
    label: 'MONO',
    blurb: 'Single-channel greyscale, radar-style',
    table: SAR_GREY,
    css: 'contrast(1.3)',
  },
];

export function visionMode(id: VisionModeId): VisionMode {
  return VISION_MODES.find(m => m.id === id) ?? VISION_MODES[0];
}

/** The DOM id of a mode's SVG filter, referenced by `filter: url(#…)`. */
export function filterId(id: VisionModeId): string {
  return `oasis-vision-${id}`;
}

/**
 * The CSS `filter` value for a mode.
 *
 * Returns '' for 'none' rather than 'url(#oasis-vision-none)': an SVG filter
 * reference forces the map canvas onto its own compositing layer even when the
 * filter is an identity, which costs a full-screen readback every frame for
 * nothing.
 */
export function visionFilterCss(id: VisionModeId): string {
  const mode = visionMode(id);
  if (mode.id === 'none' || !mode.table) return '';
  return `url(#${filterId(mode.id)})${mode.css ? ' ' + mode.css : ''}`;
}

/**
 * The `<defs>` markup for every mode that needs one.
 *
 * `color-interpolation-filters="sRGB"` is not optional: the default is
 * linearRGB, which silently shifts every stop and turns the ironbow ramp muddy.
 */
export function visionFilterDefs(): string {
  return VISION_MODES.filter(m => m.table)
    .map(m => {
      const t = m.table!;
      return `<filter id="${filterId(m.id)}" color-interpolation-filters="sRGB" x="0%" y="0%" width="100%" height="100%">
  <feColorMatrix type="matrix" values="
    0.2126 0.7152 0.0722 0 0
    0.2126 0.7152 0.0722 0 0
    0.2126 0.7152 0.0722 0 0
    0      0      0      1 0"/>
  <feComponentTransfer>
    <feFuncR type="table" tableValues="${t.r.join(' ')}"/>
    <feFuncG type="table" tableValues="${t.g.join(' ')}"/>
    <feFuncB type="table" tableValues="${t.b.join(' ')}"/>
  </feComponentTransfer>
</filter>`;
    })
    .join('\n');
}
