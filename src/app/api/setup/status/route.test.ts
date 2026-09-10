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

  /**
   * The panel used to report OpenSky as configured on OPENSKY_CLIENT_ID
   * alone, while src/app/api/opensky/states.ts read neither variable and
   * called OpenSky anonymously. Two separate untruths: the credential could
   * not be used, and half of it would not have been enough anyway.
   * states.ts now performs the OAuth client-credentials grant, which needs
   * both.
   */
  it('reports OpenSky configured only when BOTH the id and the secret are set', () => {
    const openSky = (env: Record<string, string | undefined>) =>
      describeKeys(env).find(k => k.id === 'opensky')?.configured;

    expect(openSky({ OPENSKY_CLIENT_ID: 'abc' })).toBe(false);
    expect(openSky({ OPENSKY_CLIENT_SECRET: 'def' })).toBe(false);
    expect(openSky({ OPENSKY_CLIENT_ID: 'abc', OPENSKY_CLIENT_SECRET: '  ' })).toBe(false);
    expect(openSky({ OPENSKY_CLIENT_ID: 'abc', OPENSKY_CLIENT_SECRET: 'def' })).toBe(true);
  });
});
