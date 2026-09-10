import { describe, it, expect, beforeEach } from 'vitest';
import { cachedJson, clearGevCache } from './gev-cache';

describe('cachedJson', () => {
  beforeEach(() => clearGevCache());

  it('reports a first fetch as fresh', async () => {
    const r = await cachedJson({ key: 'k1', ttlMs: 1000, fetcher: async () => ({ n: 1 }) });
    expect(r.data).toEqual({ n: 1 });
    expect(r.age).toBe('fresh');
  });

  it('serves a warm entry as cached without calling upstream again', async () => {
    let calls = 0;
    const f = async () => { calls++; return { n: calls }; };
    await cachedJson({ key: 'k2', ttlMs: 10_000, fetcher: f });
    const second = await cachedJson({ key: 'k2', ttlMs: 10_000, fetcher: f });
    expect(calls).toBe(1);
    expect(second.age).toBe('cached');
    expect(second.data).toEqual({ n: 1 });
  });

  it('serves the stale copy when a refresh throws, and says it is stale', async () => {
    await cachedJson({ key: 'k3', ttlMs: -1, fetcher: async () => ({ n: 1 }) });
    const r = await cachedJson({
      key: 'k3', ttlMs: -1,
      fetcher: async () => { throw new Error('upstream 502'); },
    });
    expect(r.data).toEqual({ n: 1 });
    expect(r.age).toBe('stale');
  });

  it('rethrows when there is nothing cached to fall back to', async () => {
    await expect(cachedJson({
      key: 'k4', ttlMs: 1000,
      fetcher: async () => { throw new Error('upstream 502'); },
    })).rejects.toThrow('upstream 502');
  });

  it('coalesces concurrent requests for the same key into one upstream call', async () => {
    let calls = 0;
    const f = async () => { calls++; await new Promise(r => setTimeout(r, 10)); return { n: calls }; };
    const [a, b] = await Promise.all([
      cachedJson({ key: 'k5', ttlMs: 10_000, fetcher: f }),
      cachedJson({ key: 'k5', ttlMs: 10_000, fetcher: f }),
    ]);
    expect(calls).toBe(1);
    expect(a.data).toEqual(b.data);
  });
});
