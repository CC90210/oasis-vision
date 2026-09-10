import { describe, it, expect } from 'vitest';
import { describeKeys, GET } from './route';

describe('describeKeys', () => {
  it('reports presence without ever returning a value', () => {
    const out = describeKeys({ CESIUM_ION_TOKEN: 'super-secret-value', TOMTOM_API_KEY: '' });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('super-secret-value');
    expect(out.find(k => k.id === 'cesium-ion')?.set).toBe(true);
    expect(out.find(k => k.id === 'tomtom')?.set).toBe(false);
  });

  it('treats whitespace-only as absent', () => {
    expect(describeKeys({ OPENAI_API_KEY: '   ' }).find(k => k.id === 'openai')?.set).toBe(false);
  });

  it('lists every provider even when nothing is configured', () => {
    const out = describeKeys({});
    expect(out.length).toBeGreaterThanOrEqual(7);
    expect(out.every(k => k.set === false)).toBe(true);
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
      describeKeys(env).find(k => k.id === 'opensky')?.set;

    expect(openSky({ OPENSKY_CLIENT_ID: 'abc' })).toBe(false);
    expect(openSky({ OPENSKY_CLIENT_SECRET: 'def' })).toBe(false);
    expect(openSky({ OPENSKY_CLIENT_ID: 'abc', OPENSKY_CLIENT_SECRET: '  ' })).toBe(false);
    expect(openSky({ OPENSKY_CLIENT_ID: 'abc', OPENSKY_CLIENT_SECRET: 'def' })).toBe(true);
  });
});

/**
 * Contract test pinned to the shape the vendored client actually parses
 * (gods-eye-view's keySetupCore.mjs keySetupStatus() / keySetup.js render()+
 * buildRow()). buildRow does `for (const envVar of key.envVars)` with no
 * guard — a missing envVars array throws TypeError there, and main.js awaits
 * initKeySetup() with no catch, so that throw is an unhandled rejection that
 * freezes the chip on its default "POWERED UP" label. Confirmed FAILING
 * against the pre-fix route (`body.setCount` was `undefined`, the response
 * carried `writable`/`writableReason` and each key carried `label`/
 * `configured` instead of the fields below) before the fix landed.
 */
describe('GET /api/setup/status — vendored-client contract', () => {
  it('returns { keys:[{id,title,unlocks,getUrl,envVars,tier,clientExposed,set}], setCount, total }', async () => {
    const response = await GET();
    const body = await response.json();
    expect(typeof body.setCount).toBe('number');
    expect(typeof body.total).toBe('number');
    expect(body.total).toBe(body.keys.length);
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys.length).toBeGreaterThan(0);
    for (const key of body.keys) {
      expect(typeof key.id).toBe('string');
      expect(typeof key.title).toBe('string');
      expect(typeof key.unlocks).toBe('string');
      expect(typeof key.getUrl).toBe('string');
      expect(Array.isArray(key.envVars)).toBe(true);
      expect(key.envVars.length).toBeGreaterThan(0);
      expect(['metered', 'free']).toContain(key.tier);
      expect(typeof key.clientExposed).toBe('boolean');
      expect(typeof key.set).toBe('boolean');
    }
  });

  it('a zero-key install: setCount is 0 and every key.set is false (chip stays visible)', async () => {
    const savedEnv = { ...process.env };
    for (const key of describeKeys(process.env as Record<string, string | undefined>)) {
      for (const name of key.envVars) delete process.env[name];
    }
    try {
      const body = await (await GET()).json();
      expect(body.setCount).toBe(0);
      expect(body.setCount < body.total).toBe(true);
      expect(body.keys.every((k: { set: boolean }) => k.set === false)).toBe(true);
    } finally {
      process.env = savedEnv;
    }
  });

  it('never puts a secret value in title, unlocks, or getUrl', async () => {
    const secret = 'super-secret-value-should-never-surface';
    const savedEnv = { ...process.env };
    try {
      for (const key of describeKeys(process.env as Record<string, string | undefined>)) {
        for (const name of key.envVars) process.env[name] = secret;
      }
      const body = await (await GET()).json();
      expect(JSON.stringify(body)).not.toContain(secret);
    } finally {
      process.env = savedEnv;
    }
  });
});
