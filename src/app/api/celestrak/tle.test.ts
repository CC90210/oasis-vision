import { describe, it, expect } from 'vitest';
import { parseTle, isValidGroup } from './tle';

// A real trimmed response from
// https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle
const sample = [
  'ISS (ZARYA)             ',
  '1 25544U 98067A   26251.54791667  .00016717  00000-0  30777-3 0  9004',
  '2 25544  51.6394 339.0574 0004449  62.5936 297.5623 15.49814294 12345',
  'CSS (TIANHE)            ',
  '1 48274U 21035A   26251.47916667  .00012345  00000-0  14567-3 0  9998',
  '2 48274  41.4740 123.4567 0006789  12.3456 347.7654 15.61234567 54321',
  '',
].join('\n');

describe('parseTle', () => {
  it('parses each three-line block into a record', () => {
    const out = parseTle(sample);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      name: 'ISS (ZARYA)',
      line1: '1 25544U 98067A   26251.54791667  .00016717  00000-0  30777-3 0  9004',
      line2: '2 25544  51.6394 339.0574 0004449  62.5936 297.5623 15.49814294 12345',
      noradId: '25544',
    });
    expect(out[1].name).toBe('CSS (TIANHE)');
    expect(out[1].noradId).toBe('48274');
  });

  it('drops a trailing partial block rather than emitting a half record', () => {
    const truncated = sample.split('\n').slice(0, 4).join('\n');
    expect(parseTle(truncated)).toHaveLength(1);
  });

  it('returns nothing for an HTML error page served with status 200', () => {
    expect(parseTle('<html><body>Rate limited</body></html>')).toHaveLength(0);
  });

  it('ignores blank lines between blocks', () => {
    expect(parseTle(`\n\n${sample}\n\n`)).toHaveLength(2);
  });
});

describe('isValidGroup', () => {
  it('accepts CelesTrak group names', () => {
    expect(isValidGroup('stations')).toBe(true);
    expect(isValidGroup('last-30-days')).toBe(true);
    expect(isValidGroup('active')).toBe(true);
  });

  it('rejects anything that could alter the upstream query', () => {
    expect(isValidGroup('stations&FORMAT=json')).toBe(false);
    expect(isValidGroup('../../etc/passwd')).toBe(false);
    expect(isValidGroup('')).toBe(false);
    expect(isValidGroup('a'.repeat(65))).toBe(false);
  });
});
