/**
 * OASIS VISION — North American Numbering Plan area codes.
 *
 * WHAT AN AREA CODE ACTUALLY TELLS YOU, because the UI must not overstate it:
 * it identifies the Numbering Plan Area a number was ISSUED in, not where the
 * handset is. Wireless number portability has been mandatory across Canada and
 * the US since 2007, so a 705 number belongs to someone who obtained it in
 * northeastern Ontario and may now live anywhere on earth. The coordinate below
 * is the centre of that numbering area — useful for context, worthless as a
 * position fix, and labelled as such wherever it is rendered.
 *
 * Complete for Canada. The US table covers the major metropolitan codes; an
 * unlisted US code resolves to state-level via `US_AREA_STATE` rather than
 * falling back to the geographic centre of the country, which is what put a
 * Northern Ontario number in the middle of Saskatchewan.
 */

export interface NanpArea {
  /** Principal city or the area's common name. */
  city: string;
  /** Province or state, two-letter. */
  region: string;
  /** 'CA' | 'US' | other NANP member. */
  country: string;
  lat: number;
  lng: number;
}

/** Canadian area codes — complete as of 2026. */
const CANADA: Record<string, NanpArea> = {
  // Newfoundland & Labrador
  '709': { city: "St. John's", region: 'NL', country: 'CA', lat: 47.5615, lng: -52.7126 },
  '879': { city: "St. John's", region: 'NL', country: 'CA', lat: 47.5615, lng: -52.7126 },
  // Nova Scotia & PEI
  '902': { city: 'Halifax', region: 'NS/PE', country: 'CA', lat: 44.6488, lng: -63.5752 },
  '782': { city: 'Halifax', region: 'NS/PE', country: 'CA', lat: 44.6488, lng: -63.5752 },
  // New Brunswick
  '506': { city: 'Moncton', region: 'NB', country: 'CA', lat: 46.0878, lng: -64.7782 },
  '428': { city: 'Moncton', region: 'NB', country: 'CA', lat: 46.0878, lng: -64.7782 },
  // Quebec — Montreal
  '514': { city: 'Montréal', region: 'QC', country: 'CA', lat: 45.5017, lng: -73.5673 },
  '438': { city: 'Montréal', region: 'QC', country: 'CA', lat: 45.5017, lng: -73.5673 },
  // Quebec — Montérégie / Laval / Laurentides (Montreal suburbs)
  '450': { city: 'Longueuil', region: 'QC', country: 'CA', lat: 45.5312, lng: -73.5182 },
  '579': { city: 'Longueuil', region: 'QC', country: 'CA', lat: 45.5312, lng: -73.5182 },
  '263': { city: 'Longueuil', region: 'QC', country: 'CA', lat: 45.5312, lng: -73.5182 },
  // Quebec — Quebec City & east
  '418': { city: 'Québec City', region: 'QC', country: 'CA', lat: 46.8139, lng: -71.2080 },
  '581': { city: 'Québec City', region: 'QC', country: 'CA', lat: 46.8139, lng: -71.2080 },
  '367': { city: 'Québec City', region: 'QC', country: 'CA', lat: 46.8139, lng: -71.2080 },
  '354': { city: 'Québec City', region: 'QC', country: 'CA', lat: 46.8139, lng: -71.2080 },
  // Quebec — Gatineau / Sherbrooke / Trois-Rivières
  '819': { city: 'Gatineau', region: 'QC', country: 'CA', lat: 45.4765, lng: -75.7013 },
  '873': { city: 'Gatineau', region: 'QC', country: 'CA', lat: 45.4765, lng: -75.7013 },
  '468': { city: 'Gatineau', region: 'QC', country: 'CA', lat: 45.4765, lng: -75.7013 },
  // Ontario — Ottawa
  '613': { city: 'Ottawa', region: 'ON', country: 'CA', lat: 45.4215, lng: -75.6972 },
  '343': { city: 'Ottawa', region: 'ON', country: 'CA', lat: 45.4215, lng: -75.6972 },
  '753': { city: 'Ottawa', region: 'ON', country: 'CA', lat: 45.4215, lng: -75.6972 },
  // Ontario — Toronto
  '416': { city: 'Toronto', region: 'ON', country: 'CA', lat: 43.6532, lng: -79.3832 },
  '647': { city: 'Toronto', region: 'ON', country: 'CA', lat: 43.6532, lng: -79.3832 },
  '437': { city: 'Toronto', region: 'ON', country: 'CA', lat: 43.6532, lng: -79.3832 },
  '387': { city: 'Toronto', region: 'ON', country: 'CA', lat: 43.6532, lng: -79.3832 },
  // Ontario — GTA fringe (Hamilton, Niagara, Peel, York, Durham)
  '905': { city: 'Hamilton / GTA', region: 'ON', country: 'CA', lat: 43.2557, lng: -79.8711 },
  '289': { city: 'Hamilton / GTA', region: 'ON', country: 'CA', lat: 43.2557, lng: -79.8711 },
  '365': { city: 'Hamilton / GTA', region: 'ON', country: 'CA', lat: 43.2557, lng: -79.8711 },
  '742': { city: 'Hamilton / GTA', region: 'ON', country: 'CA', lat: 43.2557, lng: -79.8711 },
  // Ontario — Southwestern (London, Windsor, Kitchener)
  '519': { city: 'London', region: 'ON', country: 'CA', lat: 42.9849, lng: -81.2453 },
  '226': { city: 'London', region: 'ON', country: 'CA', lat: 42.9849, lng: -81.2453 },
  '548': { city: 'London', region: 'ON', country: 'CA', lat: 42.9849, lng: -81.2453 },
  // Ontario — Northeastern (Sudbury, Barrie, Sault Ste. Marie, North Bay)
  '705': { city: 'Sudbury / Barrie', region: 'ON', country: 'CA', lat: 46.4917, lng: -80.9930 },
  '249': { city: 'Sudbury / Barrie', region: 'ON', country: 'CA', lat: 46.4917, lng: -80.9930 },
  '683': { city: 'Sudbury / Barrie', region: 'ON', country: 'CA', lat: 46.4917, lng: -80.9930 },
  // Ontario — Northwestern (Thunder Bay)
  '807': { city: 'Thunder Bay', region: 'ON', country: 'CA', lat: 48.3809, lng: -89.2477 },
  // Manitoba
  '204': { city: 'Winnipeg', region: 'MB', country: 'CA', lat: 49.8951, lng: -97.1384 },
  '431': { city: 'Winnipeg', region: 'MB', country: 'CA', lat: 49.8951, lng: -97.1384 },
  '584': { city: 'Winnipeg', region: 'MB', country: 'CA', lat: 49.8951, lng: -97.1384 },
  // Saskatchewan
  '306': { city: 'Regina / Saskatoon', region: 'SK', country: 'CA', lat: 50.4452, lng: -104.6189 },
  '639': { city: 'Regina / Saskatoon', region: 'SK', country: 'CA', lat: 50.4452, lng: -104.6189 },
  '474': { city: 'Regina / Saskatoon', region: 'SK', country: 'CA', lat: 50.4452, lng: -104.6189 },
  // Alberta
  '403': { city: 'Calgary', region: 'AB', country: 'CA', lat: 51.0447, lng: -114.0719 },
  '587': { city: 'Alberta', region: 'AB', country: 'CA', lat: 51.0447, lng: -114.0719 },
  '825': { city: 'Alberta', region: 'AB', country: 'CA', lat: 51.0447, lng: -114.0719 },
  '368': { city: 'Alberta', region: 'AB', country: 'CA', lat: 51.0447, lng: -114.0719 },
  '780': { city: 'Edmonton', region: 'AB', country: 'CA', lat: 53.5461, lng: -113.4938 },
  // British Columbia
  '604': { city: 'Vancouver', region: 'BC', country: 'CA', lat: 49.2827, lng: -123.1207 },
  '778': { city: 'Vancouver', region: 'BC', country: 'CA', lat: 49.2827, lng: -123.1207 },
  '236': { city: 'British Columbia', region: 'BC', country: 'CA', lat: 49.2827, lng: -123.1207 },
  '672': { city: 'British Columbia', region: 'BC', country: 'CA', lat: 49.2827, lng: -123.1207 },
  '250': { city: 'Victoria / Interior BC', region: 'BC', country: 'CA', lat: 48.4284, lng: -123.3656 },
  // Territories
  '867': { city: 'Yukon / NWT / Nunavut', region: 'YT/NT/NU', country: 'CA', lat: 62.4540, lng: -114.3718 },
};

/** Major US metropolitan area codes. Not exhaustive — see US_AREA_STATE. */
const UNITED_STATES: Record<string, NanpArea> = {
  '212': { city: 'New York', region: 'NY', country: 'US', lat: 40.7128, lng: -74.0060 },
  '646': { city: 'New York', region: 'NY', country: 'US', lat: 40.7128, lng: -74.0060 },
  '332': { city: 'New York', region: 'NY', country: 'US', lat: 40.7128, lng: -74.0060 },
  '718': { city: 'New York (Outer Boroughs)', region: 'NY', country: 'US', lat: 40.6782, lng: -73.9442 },
  '917': { city: 'New York', region: 'NY', country: 'US', lat: 40.7128, lng: -74.0060 },
  '310': { city: 'Los Angeles', region: 'CA', country: 'US', lat: 34.0522, lng: -118.2437 },
  '213': { city: 'Los Angeles', region: 'CA', country: 'US', lat: 34.0522, lng: -118.2437 },
  '323': { city: 'Los Angeles', region: 'CA', country: 'US', lat: 34.0522, lng: -118.2437 },
  '424': { city: 'Los Angeles', region: 'CA', country: 'US', lat: 34.0522, lng: -118.2437 },
  '415': { city: 'San Francisco', region: 'CA', country: 'US', lat: 37.7749, lng: -122.4194 },
  '628': { city: 'San Francisco', region: 'CA', country: 'US', lat: 37.7749, lng: -122.4194 },
  '408': { city: 'San Jose', region: 'CA', country: 'US', lat: 37.3382, lng: -121.8863 },
  '650': { city: 'Palo Alto', region: 'CA', country: 'US', lat: 37.4419, lng: -122.1430 },
  '619': { city: 'San Diego', region: 'CA', country: 'US', lat: 32.7157, lng: -117.1611 },
  '312': { city: 'Chicago', region: 'IL', country: 'US', lat: 41.8781, lng: -87.6298 },
  '773': { city: 'Chicago', region: 'IL', country: 'US', lat: 41.8781, lng: -87.6298 },
  '305': { city: 'Miami', region: 'FL', country: 'US', lat: 25.7617, lng: -80.1918 },
  '786': { city: 'Miami', region: 'FL', country: 'US', lat: 25.7617, lng: -80.1918 },
  '407': { city: 'Orlando', region: 'FL', country: 'US', lat: 28.5383, lng: -81.3792 },
  '813': { city: 'Tampa', region: 'FL', country: 'US', lat: 27.9506, lng: -82.4572 },
  '702': { city: 'Las Vegas', region: 'NV', country: 'US', lat: 36.1699, lng: -115.1398 },
  '206': { city: 'Seattle', region: 'WA', country: 'US', lat: 47.6062, lng: -122.3321 },
  '202': { city: 'Washington', region: 'DC', country: 'US', lat: 38.9072, lng: -77.0369 },
  '404': { city: 'Atlanta', region: 'GA', country: 'US', lat: 33.7490, lng: -84.3880 },
  '470': { city: 'Atlanta', region: 'GA', country: 'US', lat: 33.7490, lng: -84.3880 },
  '617': { city: 'Boston', region: 'MA', country: 'US', lat: 42.3601, lng: -71.0589 },
  '857': { city: 'Boston', region: 'MA', country: 'US', lat: 42.3601, lng: -71.0589 },
  '214': { city: 'Dallas', region: 'TX', country: 'US', lat: 32.7767, lng: -96.7970 },
  '469': { city: 'Dallas', region: 'TX', country: 'US', lat: 32.7767, lng: -96.7970 },
  '713': { city: 'Houston', region: 'TX', country: 'US', lat: 29.7604, lng: -95.3698 },
  '832': { city: 'Houston', region: 'TX', country: 'US', lat: 29.7604, lng: -95.3698 },
  '512': { city: 'Austin', region: 'TX', country: 'US', lat: 30.2672, lng: -97.7431 },
  '602': { city: 'Phoenix', region: 'AZ', country: 'US', lat: 33.4484, lng: -112.0740 },
  '303': { city: 'Denver', region: 'CO', country: 'US', lat: 39.7392, lng: -104.9903 },
  '215': { city: 'Philadelphia', region: 'PA', country: 'US', lat: 39.9526, lng: -75.1652 },
  '313': { city: 'Detroit', region: 'MI', country: 'US', lat: 42.3314, lng: -83.0458 },
  '503': { city: 'Portland', region: 'OR', country: 'US', lat: 45.5152, lng: -122.6784 },
  '801': { city: 'Salt Lake City', region: 'UT', country: 'US', lat: 40.7608, lng: -111.8910 },
  '615': { city: 'Nashville', region: 'TN', country: 'US', lat: 36.1627, lng: -86.7816 },
  '504': { city: 'New Orleans', region: 'LA', country: 'US', lat: 29.9511, lng: -90.0715 },
};

/** Toll-free and special NANP prefixes, which have no geography at all. */
const NON_GEOGRAPHIC = new Set(['800', '833', '844', '855', '866', '877', '888', '900', '976', '211', '311', '411', '511', '611', '711', '811', '911']);

const TABLE: Record<string, NanpArea> = { ...CANADA, ...UNITED_STATES };

/**
 * Resolve a NANP area code (the first 3 digits of a 10-digit national number).
 *
 * Returns null for an unlisted or non-geographic code rather than guessing —
 * a wrong pin reads as intelligence, an absent one reads as absent.
 */
export function lookupAreaCode(areaCode: string): NanpArea | null {
  if (!/^[2-9]\d{2}$/.test(areaCode)) return null;
  if (NON_GEOGRAPHIC.has(areaCode)) return null;
  return TABLE[areaCode] ?? null;
}

/** True for toll-free / service codes, which are deliberately location-free. */
export function isNonGeographic(areaCode: string): boolean {
  return NON_GEOGRAPHIC.has(areaCode);
}

/** How many area codes the table knows — surfaced in the API response. */
export const NANP_AREA_COUNT = Object.keys(TABLE).length;
