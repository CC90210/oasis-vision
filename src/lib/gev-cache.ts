import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Memory + disk cache with single-flight and serve-stale, shared by the God's
 * Eye View routes.
 *
 * Every result says which it is. A cached answer that presents as live is the
 * defect this codebase names first in CLAUDE.md, so `age` is not optional and
 * callers forward it to the client.
 *
 * Distinct from `sourceCache.ts`, which is memory-only, array-typed and does
 * not report age. Both exist on purpose; neither should grow into the other.
 */

const CACHE_DIR = join(process.cwd(), '.oasis-cache', 'gev');
const DEFAULT_DISK_TTL_MS = 7 * 24 * 3600_000;

export type CacheAge = 'fresh' | 'cached' | 'stale';

export interface CachedResult<T> {
  data: T;
  age: CacheAge;
  fetchedAt: number;
}

export interface CacheOptions<T> {
  key: string;
  ttlMs: number;
  fetcher: () => Promise<T>;
  /** How long a stale entry stays usable as a fallback. Default 7 days. */
  diskTtlMs?: number;
}

interface Entry<T> {
  data: T;
  fetchedAt: number;
}

const mem = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/**
 * Test-only. Drops both tiers of state: the in-memory maps AND the on-disk
 * cache directory.
 *
 * RULING R5: the brief's original version cleared only `mem`/`inflight`. That
 * left disk entries behind, so a test asserting "a failed fetch is never
 * cached as data" would pass once and then fail on re-run — a second suite
 * run would find yesterday's disk entry under the same key and serve it as a
 * stale fallback. A test that only works once is worse than none, so this
 * clears the disk tier too.
 *
 * The removal itself is unavoidably async (fs.rm), so this returns the
 * pending promise rather than firing it and forgetting it — a fire-and-forget
 * delete would race the very next `cachedJson` call in a test and reintroduce
 * the bug this exists to close. `beforeEach(() => clearGevCache())`, exactly
 * as every consuming test writes it, awaits that returned promise because the
 * arrow function's return value is it. Never throws: `force: true` makes a
 * missing directory a no-op, and any other removal error is logged, not
 * raised, because a cleanup helper failing must not fail the test it is
 * cleaning up for.
 */
export function clearGevCache(): Promise<void> {
  mem.clear();
  inflight.clear();
  return rm(CACHE_DIR, { recursive: true, force: true }).catch((e) => {
    console.warn('[OSIRIS] gev-cache clear: failed to remove disk cache dir:', e instanceof Error ? e.message : e);
  });
}

const safeKey = (key: string): string => {
  // Charset allowlist before the value reaches a filesystem path.
  const clean = key.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!clean) throw new Error('gev-cache: empty key');
  return clean;
};

const diskPath = (key: string) => join(CACHE_DIR, `${safeKey(key)}.json`);

async function readDisk<T>(key: string, maxAgeMs: number): Promise<Entry<T> | null> {
  try {
    const parsed = JSON.parse(await readFile(diskPath(key), 'utf8')) as Entry<T>;
    if (!Number.isFinite(parsed?.fetchedAt)) return null;
    if (Date.now() - parsed.fetchedAt > maxAgeMs) return null;
    return parsed;
  } catch {
    return null; // no disk cache yet, or unreadable — not an error condition
  }
}

async function writeDisk<T>(key: string, entry: Entry<T>): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(diskPath(key), JSON.stringify(entry), 'utf8');
  } catch (e) {
    console.warn(`[OSIRIS] gev-cache disk write failed for ${key}:`, e instanceof Error ? e.message : e);
  }
}

export async function cachedJson<T>(opts: CacheOptions<T>): Promise<CachedResult<T>> {
  const { key, ttlMs, fetcher } = opts;
  const diskTtlMs = opts.diskTtlMs ?? DEFAULT_DISK_TTL_MS;
  const now = Date.now();

  const warm = mem.get(key) as Entry<T> | undefined;
  if (warm && now - warm.fetchedAt < ttlMs) {
    return { data: warm.data, age: 'cached', fetchedAt: warm.fetchedAt };
  }

  const pending = inflight.get(key) as Promise<CachedResult<T>> | undefined;
  if (pending) return pending;

  const run = (async (): Promise<CachedResult<T>> => {
    try {
      const data = await fetcher();
      const entry: Entry<T> = { data, fetchedAt: Date.now() };
      mem.set(key, entry as Entry<unknown>);
      void writeDisk(key, entry);
      return { data, age: 'fresh', fetchedAt: entry.fetchedAt };
    } catch (e) {
      const fallback = warm ?? (await readDisk<T>(key, diskTtlMs));
      if (!fallback) {
        // Nothing to serve. Surface the real reason — never an empty success.
        console.warn(`[OSIRIS] gev-cache ${key} failed with no fallback:`, e instanceof Error ? e.message : e);
        throw e;
      }
      console.warn(
        `[OSIRIS] gev-cache ${key} refresh failed — serving a copy from ${new Date(fallback.fetchedAt).toISOString()}:`,
        e instanceof Error ? e.message : e,
      );
      mem.set(key, fallback as Entry<unknown>);
      return { data: fallback.data, age: 'stale', fetchedAt: fallback.fetchedAt };
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, run);
  return run;
}
