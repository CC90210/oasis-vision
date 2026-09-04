import { describe, it, expect } from 'vitest';
import { describePlace, categorize, buildOverpass, rankArticles, isSpeakableInEnglish } from './route';

describe('isSpeakableInEnglish', () => {
  it('accepts Latin text, including accents and digits', () => {
    expect(isSpeakableInEnglish('Boulevard René-Lévesque Ouest')).toBe(true);
    expect(isSpeakableInEnglish('SZR1064')).toBe(true);
    expect(isSpeakableInEnglish('Espace 67')).toBe(true);
  });

  it('rejects a name an English voice would turn into noise', () => {
    expect(isSpeakableInEnglish('Заслон на маркировачите')).toBe(false);
    expect(isSpeakableInEnglish('東京タワー')).toBe(false);
    expect(isSpeakableInEnglish('برج خليفة')).toBe(false);
  });

  it('treats a mostly-Latin name with a stray glyph as speakable', () => {
    expect(isSpeakableInEnglish('Café Zürich №1')).toBe(true);
  });

  it('does not choke on a string with no letters at all', () => {
    expect(isSpeakableInEnglish('1250')).toBe(true);
    expect(isSpeakableInEnglish('')).toBe(true);
  });
});

describe('describePlace', () => {
  /**
   * The reported bug in one assertion. At zoom 5 Nominatim returned only
   * { state, country } for the Montreal Biosphere, so every assessment
   * described Canada. At zoom 18 the fine levels exist and this must use them.
   */
  it('names the street and settlement, not the country', () => {
    expect(describePlace({
      road: 'Chemin Macdonald', suburb: 'Ville-Marie', city: 'Montréal',
      state: 'Québec', country: 'Canada', postcode: 'H3C 4G8',
    })).toBe('Chemin Macdonald, Ville-Marie');
  });

  it('leads with the named feature when Nominatim has one', () => {
    expect(describePlace({ road: 'Chemin Macdonald', city: 'Montréal' }, 'Espace 67'))
      .toBe('Espace 67, Chemin Macdonald');
  });

  /**
   * Measured at Times Square: Nominatim returns name "7th Avenue" AND
   * road "7th Avenue", which naively joined reads "7th Avenue, 7th Avenue".
   */
  it('does not repeat a level that appears twice', () => {
    expect(describePlace({ road: '7th Avenue', city: 'New York' }, '7th Avenue'))
      .toBe('7th Avenue, New York');
  });

  /**
   * Measured at Times Square: Nominatim's suburb is "Manhattan Community
   * Board 5" — accurate, and meaningless to an operator. The next level that
   * names a real place should win.
   */
  it('skips administrative districts that name no real place', () => {
    expect(describePlace({
      road: '7th Avenue', suburb: 'Manhattan Community Board 5',
      city: 'New York', country: 'United States',
    })).toBe('7th Avenue, New York');
  });

  it('prefers the neighbourhood when there is a real one', () => {
    expect(describePlace({
      road: '7th Avenue', neighbourhood: 'Times Square',
      suburb: 'Manhattan Community Board 5', city: 'New York',
    })).toBe('7th Avenue, Times Square');
  });

  /**
   * Live case from Bulgaria: accept-language=en translated the address but not
   * the feature name, and namedetails had no English form because none exists.
   * The read-out must use the English address rather than hand Cyrillic to an
   * English voice.
   */
  it('skips a name in another script and uses the English address chain', () => {
    expect(describePlace(
      { road: 'SZR1064', village: 'Dolno Izvorovo', state: 'Stara Zagora', country: 'Bulgaria' },
      'Заслон на маркировачите',
    )).toBe('SZR1064, Dolno Izvorovo');
  });

  it('falls back level by level rather than inventing precision', () => {
    expect(describePlace({ state: 'Nunavut', country: 'Canada' })).toBe('Nunavut');
    expect(describePlace({ country: 'Canada' })).toBe('Canada');
    expect(describePlace({})).toBe('Unnamed location');
  });
});

describe('categorize', () => {
  it('sorts the tags an operator would actually ask about', () => {
    expect(categorize({ amenity: 'police' })?.category).toBe('emergency');
    expect(categorize({ amenity: 'hospital' })?.category).toBe('emergency');
    expect(categorize({ military: 'base' })?.category).toBe('security');
    expect(categorize({ landuse: 'military' })?.category).toBe('security');
    expect(categorize({ power: 'substation' })?.category).toBe('power');
    expect(categorize({ aeroway: 'aerodrome' })?.kind).toBe('airport');
    expect(categorize({ railway: 'station' })?.category).toBe('transport');
    expect(categorize({ office: 'diplomatic' })?.kind).toBe('diplomatic mission');
  });

  it('returns null for tags that carry no assessment value', () => {
    expect(categorize({ shop: 'bakery' })).toBeNull();
    expect(categorize({})).toBeNull();
  });

  it('puts emergency before landmark when an element is both', () => {
    // A historic hospital is an emergency service first.
    expect(categorize({ amenity: 'hospital', historic: 'building' })?.category).toBe('emergency');
  });
});

describe('buildOverpass', () => {
  it('is a syntactically closed query with the point and radius bound in', () => {
    const q = buildOverpass(45.5, -73.5, 1200);
    expect(q).toMatch(/^\[out:json\]\[timeout:25\];\(/);
    expect(q).toMatch(/\);out center tags 120;$/);
    expect(q).toContain('(around:1200,45.5,-73.5)');
    // Balanced parens — an unbalanced query is a 400 from Overpass, which the
    // route would surface as "infrastructure unavailable" forever.
    const open = (q.match(/\(/g) || []).length;
    const close = (q.match(/\)/g) || []).length;
    expect(open).toBe(close);
  });

  it('asks for every category the read-out can report', () => {
    const q = buildOverpass(0, 0, 500);
    for (const tag of ['police', 'aerodrome', 'substation', 'military', 'embassy', 'tourism']) {
      expect(q, tag).toContain(tag);
    }
  });
});

describe('rankArticles', () => {
  const TIMES_SQUARE = [
    { title: '2017 Times Square car attack', distanceM: 6 },
    { title: 'Morosco Theatre', distanceM: 14 },
    { title: 'Times Square', distanceM: 120 },
  ];

  /**
   * Measured live: geosearch ranks purely by distance, so the nearest article
   * to Times Square is a vehicle-ramming attack six metres away. Real record,
   * wrong opening line for "what is this area".
   */
  it('opens with the place, not the nearest incident', () => {
    expect(rankArticles(TIMES_SQUARE, 'Times Square, Manhattan')[0].title).toBe('Times Square');
  });

  it('keeps the incident in the list rather than hiding it', () => {
    expect(rankArticles(TIMES_SQUARE, 'Times Square, Manhattan').map(a => a.title))
      .toContain('2017 Times Square car attack');
  });

  /**
   * The haystack is the FULL address chain, not the headline name. At Times
   * Square the headline resolves to "7th Avenue, Manhattan"; only display_name
   * carries "Times Square", and without it the ranker led with a theatre that
   * happened to be 14 m closer than the square the operator clicked on.
   */
  it('recognises the place from the full address chain, not just the headline', () => {
    const chain = '7th Avenue, Manhattan, 7th Avenue, Times Square, Manhattan Community Board 5, New York';
    expect(rankArticles(TIMES_SQUARE, chain)[0].title).toBe('Times Square');
  });

  it('falls back to distance when nothing matches the place name', () => {
    expect(rankArticles(TIMES_SQUARE, 'Somewhere Else')[0].title).toBe('Morosco Theatre');
  });

  it('does not reorder when there is nothing to demote', () => {
    const plain = [{ title: 'A', distanceM: 10 }, { title: 'B', distanceM: 20 }];
    expect(rankArticles(plain, 'Nowhere').map(a => a.title)).toEqual(['A', 'B']);
  });

  it('leaves the caller’s array untouched', () => {
    const input = [...TIMES_SQUARE];
    rankArticles(input, 'Times Square');
    expect(input[0].title).toBe('2017 Times Square car attack');
  });
});
