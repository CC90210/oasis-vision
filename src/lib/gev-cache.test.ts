import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import { cachedJson, clearGevCache, clearGevMemoryOnly } from './gev-cache';

// Real implementation kept aside so the one deliberately-mocked test below can
// still perform the actual disk operation once it releases its gate — every
// other test in this file uses the real fs untouched.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual };
});

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

  // Fix round 1 / Finding A: the charset allowlist that guards the disk
  // filename is many-to-one — 'region:a/b' and 'region:a:b' both sanitise to
  // 'region_a_b'. Without a per-key hash in the filename, the second write
  // would silently overwrite the first key's disk entry, and the first key's
  // stale fallback would come back with the SECOND key's data — a
  // cross-route cache leak, since seven later route tasks each pick their
  // own key strings. Force both through the disk tier (clearGevMemoryOnly)
  // so this actually proves the disk file, not memory, is distinct.
  it('keeps disk entries distinct for keys that sanitize to the same filename', async () => {
    await cachedJson({ key: 'region:a/b', ttlMs: -1, fetcher: async () => ({ tag: 'first' }) });
    await cachedJson({ key: 'region:a:b', ttlMs: -1, fetcher: async () => ({ tag: 'second' }) });
    clearGevMemoryOnly();

    const a = await cachedJson({
      key: 'region:a/b', ttlMs: -1,
      fetcher: async () => { throw new Error('down'); },
    });
    const b = await cachedJson({
      key: 'region:a:b', ttlMs: -1,
      fetcher: async () => { throw new Error('down'); },
    });
    expect(a.data).toEqual({ tag: 'first' });
    expect(b.data).toEqual({ tag: 'second' });
  });

  // Fix round 1 / Finding B: clearGevCache() (correctly, per R5) wipes disk
  // too, so every fallback in the suite above comes from memory and
  // readDisk's TTL check + JSON.parse are never actually exercised. This
  // uses clearGevMemoryOnly to force cachedJson past the memory tier
  // deliberately, so the disk-fallback path — the one that makes serve-stale
  // survive a process restart — genuinely runs.
  it('serves a disk-only entry as stale once the memory tier is cleared', async () => {
    await cachedJson({ key: 'k6', ttlMs: 10_000, fetcher: async () => ({ n: 42 }) });
    clearGevMemoryOnly();

    const r = await cachedJson({
      key: 'k6', ttlMs: 10_000,
      fetcher: async () => { throw new Error('upstream down'); },
    });
    expect(r.data).toEqual({ n: 42 });
    expect(r.age).toBe('stale');
  });

  // Fix round 1 / Finding B (second half): an inverted TTL comparison in
  // readDisk would serve an expired entry instead of refusing it, and the
  // test above alone would not catch that. diskTtlMs: -1 makes the just-written
  // entry immediately "too old" to serve.
  it('refuses an expired disk entry rather than serving it as a stale fallback', async () => {
    await cachedJson({ key: 'k7', ttlMs: 10_000, diskTtlMs: -1, fetcher: async () => ({ n: 1 }) });
    clearGevMemoryOnly();

    await expect(cachedJson({
      key: 'k7', ttlMs: 10_000, diskTtlMs: -1,
      fetcher: async () => { throw new Error('upstream down'); },
    })).rejects.toThrow('upstream down');
  });

  // Fix round 1 / Finding C: a disk write used to be fire-and-forget, so it
  // could still be running after cachedJson's promise resolved. A
  // clearGevCache() landing in that window used to be able to run rm()
  // BEFORE the write's mkdir+writeFile executed, letting the write recreate
  // the directory with residue AFTER the clear completed — the R5 defect
  // moved into a timing window instead of removed.
  //
  // This is deliberately mocked rather than raced on real fs timing: an
  // earlier version of this test relied on real disk speed to land the
  // interleaving and passed even against the vulnerable fire-and-forget
  // code (the write happened to finish before rm() by luck), which made it
  // worthless as a regression test. Blocking mkdir with a gate we control
  // means the write is provably still in flight — has not even created the
  // directory yet — at the exact moment the clear is issued, and we decide
  // exactly when it resumes, matching the finding's ordering precisely:
  // mkdir/writeFile land AFTER clearGevCache's rm() has already run.
  it('drains an in-flight disk write before wiping the cache dir, so no residue survives a concurrent clear', async () => {
    const realMkdir = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).mkdir;
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const mkdirSpy = vi
      .spyOn(fsp, 'mkdir')
      .mockImplementationOnce(async (...args: Parameters<typeof realMkdir>) => {
        await writeGate;
        return realMkdir(...args);
      });

    const writeInFlight = cachedJson({ key: 'k8', ttlMs: 10_000, fetcher: async () => ({ n: 7 }) });
    // Let the fetch settle and the write reach (and block on) the mocked
    // mkdir — it is now provably "in flight": registered, but has not
    // touched disk at all yet.
    await Promise.resolve();
    await Promise.resolve();

    const clearPromise = clearGevCache();
    // Only now — after the clear has been issued against the in-flight
    // write — let mkdir (and the writeFile after it) actually run.
    releaseWrite();
    await clearPromise;
    await writeInFlight;

    await expect(cachedJson({
      key: 'k8', ttlMs: 10_000,
      fetcher: async () => { throw new Error('nothing should have survived the clear'); },
    })).rejects.toThrow('nothing should have survived the clear');

    mkdirSpy.mockRestore();
  });
});
