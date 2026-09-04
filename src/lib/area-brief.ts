/**
 * OASIS VISION — turning an area assessment into something worth hearing.
 *
 * This composes the spoken read-out from the assessment's own numbers. It is
 * deliberately deterministic rather than model-generated: a command centre that
 * invents a plausible sentence about what is on the ground is worse than one
 * that stays quiet, and every clause below traces to a field that was actually
 * measured — the reverse geocode, the Overpass count, the Open-Meteo reading.
 *
 * Where a source failed, it says so out loud ("infrastructure data unavailable")
 * instead of omitting the section, because an omitted section is heard as
 * "nothing there", which is the opposite of "not known".
 *
 * The output is written to be SPOKEN: expanded units, no glyphs a voice engine
 * mangles, sentences short enough to follow without a screen.
 */

export interface BriefPlace {
  name?: string;
  road?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

export interface BriefConditions {
  tempC?: number | null;
  feelsC?: number | null;
  windKph?: number | null;
  gustKph?: number | null;
  windDir?: number | null;
  visibilityM?: number | null;
  cloudPct?: number | null;
  precipMm?: number | null;
  isDay?: boolean | null;
}

export interface BriefInfra {
  counts?: Record<string, number>;
  items?: { category: string; name: string; kind: string }[];
  total?: number;
}

export interface BriefInput {
  coordinates: { lat: number; lng: number };
  radius?: number;
  place?: BriefPlace | null;
  conditions?: BriefConditions | null;
  infrastructure?: BriefInfra | null;
  wikipedia?: { title?: string; extract?: string } | null;
  country?: { name?: string; capital?: string; population?: number } | null;
  degraded?: string[];
  /** Cameras the operator's own map already holds within the radius. */
  camerasNearby?: number;
  /** Aircraft the operator's own map already holds overhead. */
  aircraftOverhead?: number;
}

/** Compass point for a meteorological wind direction, spoken in full. */
export function compass(deg: number): string {
  const names = [
    'north', 'north-northeast', 'northeast', 'east-northeast',
    'east', 'east-southeast', 'southeast', 'south-southeast',
    'south', 'south-southwest', 'southwest', 'west-southwest',
    'west', 'west-northwest', 'northwest', 'north-northwest',
  ];
  return names[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

/** Coordinates as a voice engine should read them, not as decimal soup. */
export function speakCoordinates(lat: number, lng: number): string {
  const f = (v: number, pos: string, neg: string) =>
    `${Math.abs(v).toFixed(3)} degrees ${v >= 0 ? pos : neg}`;
  return `${f(lat, 'north', 'south')}, ${f(lng, 'east', 'west')}`;
}

/** Human label for each infrastructure category, in reporting priority order. */
const CATEGORY_ORDER: [string, string, string][] = [
  ['emergency', 'emergency service', 'emergency services'],
  ['security', 'restricted or military site', 'restricted or military sites'],
  ['government', 'government or diplomatic site', 'government and diplomatic sites'],
  ['transport', 'transport hub', 'transport hubs'],
  ['power', 'power facility', 'power facilities'],
  ['medical', 'medical facility', 'medical facilities'],
  ['education', 'school or campus', 'schools and campuses'],
  ['landmark', 'named landmark', 'named landmarks'],
];

/** "three hospitals" reads better spoken than "3 hospitals". */
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
export function spokenCount(n: number): string {
  return n <= 10 ? SMALL[n] : String(n);
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

/** Where we are — the sentence the old dossier could never produce. */
function placeSentence(p: BriefPlace | null | undefined, lat: number, lng: number): string {
  if (!p || !p.name || p.name === 'Unknown location') {
    return `Assessing ${speakCoordinates(lat, lng)}. No named place is recorded at this coordinate.`;
  }
  // Levels the headline already names are dropped, or the sentence stutters:
  // "Assessment for SZR1064, Dolno Izvorovo, in Dolno Izvorovo, Stara Zagora".
  const headline = p.name.toLowerCase();
  const context = [p.suburb || p.neighbourhood, p.city, p.state, p.country]
    .filter(Boolean)
    .filter((v) => !headline.includes(String(v).toLowerCase()))
    .filter((v, i, a) => a.indexOf(v) === i);
  const where = context.length ? `, in ${joinList(context as string[])}` : '';
  const post = p.postcode ? ` Postal code ${p.postcode.split('').join(' ')}.` : '';
  return `Assessment for ${p.name}${where}.${post}`;
}

function infraSentence(infra: BriefInfra | null | undefined, radius: number, degradedInfra: boolean): string {
  if (degradedInfra) return 'Infrastructure data is unavailable for this area right now.';
  const counts = infra?.counts || {};
  const km = (radius / 1000).toFixed(radius % 1000 === 0 ? 0 : 1);

  const phrases: string[] = [];
  for (const [key, one, many] of CATEGORY_ORDER) {
    const n = counts[key] || 0;
    if (!n) continue;
    phrases.push(`${spokenCount(n)} ${n === 1 ? one : many}`);
  }
  if (!phrases.length) return `Nothing of note is mapped within ${km} kilometres.`;

  let out = `Within ${km} kilometres: ${joinList(phrases)}.`;

  // Name the specific ones an operator would want called out by name.
  const notable = (infra?.items || [])
    .filter((i) => i.category === 'emergency' || i.category === 'security' || i.category === 'transport')
    .filter((i) => !i.name.startsWith('Unnamed'))
    .slice(0, 3)
    .map((i) => i.name);
  if (notable.length) out += ` Nearest of note: ${joinList(notable)}.`;
  return out;
}

function conditionsSentence(c: BriefConditions | null | undefined, degradedCond: boolean): string {
  if (degradedCond || !c) return 'Local conditions are unavailable.';
  const bits: string[] = [];

  if (typeof c.tempC === 'number') {
    let t = `${Math.round(c.tempC)} degrees`;
    if (typeof c.feelsC === 'number' && Math.abs(c.feelsC - c.tempC) >= 3) {
      t += `, feeling like ${Math.round(c.feelsC)}`;
    }
    bits.push(t);
  }
  if (typeof c.windKph === 'number') {
    let w = `wind ${Math.round(c.windKph)} kilometres per hour`;
    if (typeof c.windDir === 'number') w += ` from the ${compass(c.windDir)}`;
    if (typeof c.gustKph === 'number' && c.gustKph >= c.windKph + 15) {
      w += `, gusting ${Math.round(c.gustKph)}`;
    }
    bits.push(w);
  }
  if (typeof c.cloudPct === 'number') {
    bits.push(c.cloudPct >= 80 ? 'overcast' : c.cloudPct >= 40 ? 'partly cloudy' : 'mostly clear');
  }
  if (!bits.length) return 'Local conditions are unavailable.';

  let out = `Conditions: ${joinList(bits)}.`;

  // Visibility only earns a sentence when it actually limits observation.
  if (typeof c.visibilityM === 'number' && c.visibilityM < 5000) {
    out += ` Visibility is reduced, about ${(c.visibilityM / 1000).toFixed(1)} kilometres.`;
  }
  if (c.isDay === false) out += ' It is currently night at this location.';
  return out;
}

/** What the operator's own map is holding over this spot. */
function coverageSentence(input: BriefInput): string {
  const bits: string[] = [];
  if (typeof input.camerasNearby === 'number' && input.camerasNearby > 0) {
    bits.push(`${spokenCount(input.camerasNearby)} camera${input.camerasNearby === 1 ? '' : 's'} in range`);
  }
  if (typeof input.aircraftOverhead === 'number' && input.aircraftOverhead > 0) {
    bits.push(`${spokenCount(input.aircraftOverhead)} aircraft overhead`);
  }
  if (!bits.length) return '';
  return `Live coverage: ${joinList(bits)}.`;
}

/** Trim an encyclopaedia extract to the first sentence or two, for speech. */
export function firstSentences(text: string, max = 2): string {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+/g);
  if (!parts) return text.slice(0, 220);
  // Each match carries the space that followed the previous full stop, so trim
  // before joining or the text doubles its spacing.
  return parts.slice(0, max).map((s) => s.trim()).join(' ');
}

/**
 * The full spoken assessment. Returns both the text to speak and the ordered
 * lines to display, so the screen and the voice can never disagree.
 */
export function buildAreaBrief(input: BriefInput): { speech: string; lines: string[] } {
  const { lat, lng } = input.coordinates;
  const radius = input.radius || 1200;
  const degraded = input.degraded || [];
  const failed = (what: string) => degraded.some((d) => d.startsWith(what));

  const lines = [
    placeSentence(input.place, lat, lng),
    infraSentence(input.infrastructure, radius, failed('infrastructure')),
    conditionsSentence(input.conditions, failed('conditions')),
    coverageSentence(input),
  ].filter(Boolean);

  if (input.wikipedia?.extract) {
    lines.push(`Background: ${firstSentences(input.wikipedia.extract)}`);
  }

  // The country is context, not the answer — one clause at the end, never the
  // headline it used to be. The name comes from the reverse geocode, so this
  // still reports the country when the Wikidata lookup is the source that
  // failed; requiring the richer record would drop a fact already known.
  const countryName = input.country?.name || input.place?.country;
  if (countryName) {
    const cap = input.country?.capital ? `, capital ${input.country.capital}` : '';
    lines.push(`This is inside ${countryName}${cap}.`);
  }

  if (degraded.length) {
    lines.push(`Note: ${degraded.length} source${degraded.length === 1 ? '' : 's'} did not respond.`);
  }

  return { speech: lines.join(' '), lines };
}
