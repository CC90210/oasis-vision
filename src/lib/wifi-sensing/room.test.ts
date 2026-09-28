import { describe, expect, it } from 'vitest';
import { DEFAULT_HOME_ROOM, DEFAULT_WEBCAM_HFOV, sanitizeFov, sanitizeRoom } from './room';

describe('sanitizeRoom', () => {
  it('keeps a sensible room as given', () => {
    expect(sanitizeRoom({ width: 4.5, depth: 3.8, height: 2.5 })).toEqual({ width: 4.5, depth: 3.8, height: 2.5 });
  });

  it('clamps a room the scene cannot frame', () => {
    expect(sanitizeRoom({ width: 0.5, depth: 90, height: 12 })).toEqual({ width: 2, depth: 15, height: 4 });
  });

  it('falls back to the default for missing or junk values', () => {
    expect(sanitizeRoom(null)).toEqual(DEFAULT_HOME_ROOM);
    expect(sanitizeRoom({ width: Number.NaN, depth: '5' as unknown as number })).toEqual(DEFAULT_HOME_ROOM);
  });
});

describe('sanitizeFov', () => {
  it('clamps to lenses webcams actually have', () => {
    expect(sanitizeFov(90)).toBe(90);
    expect(sanitizeFov(10)).toBe(40);
    expect(sanitizeFov(200)).toBe(130);
    expect(sanitizeFov('wide')).toBe(DEFAULT_WEBCAM_HFOV);
  });
});
