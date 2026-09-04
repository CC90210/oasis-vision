/**
 * OASIS VISION — making a typed address actually find the place.
 *
 * The reported failure was "I gave a very specific address and it didn't know
 * where to search", and the cause is not what it looks like. Measured against
 * both geocoders on 2026-09-04:
 *
 *   "1250 Rene-Levesque Blvd West Montreal"   Photon 0   Nominatim 0
 *   "1250 René-Lévesque Blvd West Montreal"   Photon 0   Nominatim 0   <- accents don't help
 *   "1250 Rene Levesque Montreal"             Photon 3   Nominatim 3   <- works, unaccented
 *
 * So diacritics are handled fine by both engines. What kills the query is the
 * English street-type and directional words: OSM holds this address as
 * "1250 Boulevard René-Lévesque Ouest", and `Blvd` and `West` are matched as
 * required terms that exist nowhere in the record. Two tokens the operator
 * added to be MORE precise are what drive the result set to empty.
 *
 * Overpass confirms the address is in OSM — five businesses are tagged at
 * housenumber 1250 on that block — so this was never missing data.
 *
 * The fix is a reduction pass: when the query as typed finds nothing, drop the
 * street-type and directional words and search the distinctive remainder. It is
 * language-neutral (English and French token lists, since Montréal is the home
 * city and mixes both) and it only runs when the first pass already failed, so
 * a query that works keeps its exact ranking.
 */

/** Street-type nouns, unambiguous ones only. English and French. */
const STREET_TYPES = new Set([
  // English
  'street', 'road', 'rd', 'avenue', 'ave', 'av', 'boulevard', 'blvd', 'blvd.',
  'drive', 'lane', 'ln', 'court', 'parkway', 'pkwy', 'highway', 'hwy',
  'terrace', 'ter', 'circle', 'cir', 'square', 'trail', 'trl', 'crescent',
  'cres', 'close', 'row', 'alley', 'expressway', 'freeway', 'route',
  // French — Montréal is the home city and OSM stores these natively
  'rue', 'chemin', 'allee', 'allée', 'impasse', 'quai', 'cours', 'rang',
  'montee', 'montée', 'cote', 'côte', 'ruelle', 'voie',
]);

/**
 * Ambiguous tokens: `st` is Street in "Sparks St" and Saint in "St Laurent",
 * `dr` is Drive or Doctor, `pl` is Place or Plaza. Stripped only in the suffix
 * position (see isStreetType) so "St Laurent" keeps its saint.
 */
const AMBIGUOUS = new Set(['st', 'st.', 'ste', 'ste.', 'dr', 'dr.', 'pl', 'pl.', 'ct', 'sq', 'way']);

/** Directional words and their abbreviations, English and French. */
const DIRECTIONALS = new Set([
  'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest',
  'ne', 'nw', 'se', 'sw', 'n', 's', 'e', 'w',
  'nord', 'sud', 'est', 'ouest', 'nord-est', 'nord-ouest', 'sud-est', 'sud-ouest',
]);

/** Unit/suite noise that no geocoder indexes. */
const UNIT_WORDS = new Set([
  'suite', 'ste', 'unit', 'apt', 'apartment', 'floor', 'fl', 'bureau', 'app',
  'no', 'number', '#',
]);

const strip = (t: string) => t.replace(/[.,;]+$/g, '').toLowerCase();

/**
 * Is this token a street type in the position it occupies?
 *
 * Unambiguous types always count. Ambiguous ones count only in the suffix slot:
 * last token, or immediately before a directional — the two places a street
 * type actually appears in an address. That keeps "St Laurent" intact while
 * still reducing "Sparks St West".
 */
export function isStreetType(tokens: string[], i: number): boolean {
  const t = strip(tokens[i]);
  if (STREET_TYPES.has(t)) return true;
  if (!AMBIGUOUS.has(t)) return false;
  if (i === 0) return false; // "St Laurent", "Dr Penfield" — a prefix, not a suffix
  const next = tokens[i + 1] ? strip(tokens[i + 1]) : null;
  return next === null || DIRECTIONALS.has(next);
}

/** A directional, but never as the first word — "West Island" is a place. */
export function isDirectional(tokens: string[], i: number): boolean {
  return i > 0 && DIRECTIONALS.has(strip(tokens[i]));
}

/**
 * Below this many surviving tokens the reduction has eaten the query rather
 * than cleaned it — "West Street" reduces to nothing at all — so the reduced
 * form is discarded and only the original is searched.
 */
const MIN_TOKENS = 2;

/**
 * Strip street-type, directional and unit noise, keeping the housenumber and
 * the distinctive name. Returns null when there is nothing to gain: the query
 * is unchanged, or reduction left too little to search on.
 */
export function reduceAddress(query: string): string | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null; // too short to carry noise worth stripping

  const kept: string[] = [];
  let dropNumber = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = strip(tokens[i]);

    // A unit word takes its number with it. Leaving the number behind is worse
    // than leaving the whole phrase: "350 Sparks Street Suite 400 Ottawa" would
    // reduce to "350 Sparks 400 Ottawa", handing the geocoder two housenumbers
    // for one address.
    if (UNIT_WORDS.has(t)) { dropNumber = true; continue; }
    if (dropNumber) {
      dropNumber = false;
      if (/^#?\d+[a-z]?$/i.test(t)) continue;
    }

    if (isStreetType(tokens, i)) continue;
    if (isDirectional(tokens, i)) continue;
    kept.push(tokens[i]);
  }

  if (kept.length < MIN_TOKENS) return null;
  const reduced = kept.join(' ');
  return reduced.toLowerCase() === query.trim().toLowerCase() ? null : reduced;
}

/**
 * The queries to try, in order. The first is always what the operator typed:
 * a query that works must keep its own ranking, so the fallback exists only for
 * the empty case.
 */
export function queryLadder(query: string): string[] {
  const q = query.trim();
  const reduced = reduceAddress(q);
  return reduced ? [q, reduced] : [q];
}
