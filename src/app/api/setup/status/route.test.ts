import { describe, it, expect } from 'vitest';
import { describeKeys } from './route';

describe('describeKeys', () => {
  it('reports presence without ever returning a value', () => {
    const out = describeKeys({ CESIUM_ION_TOKEN: 'super-secret-value', TOMTOM_API_KEY: '' });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('super-secret-value');
    expect(out.find(k => k.id === 'cesium-ion')?.configured).toBe(true);
    expect(out.find(k => k.id === 'tomtom')?.configured).toBe(false);
  });

  it('treats whitespace-only as absent', () => {
    expect(describeKeys({ OPENAI_API_KEY: '   ' }).find(k => k.id === 'openai')?.configured).toBe(false);
  });

  it('lists every provider even when nothing is configured', () => {
    const out = describeKeys({});
    expect(out.length).toBeGreaterThanOrEqual(7);
    expect(out.every(k => k.configured === false)).toBe(true);
  });
});
