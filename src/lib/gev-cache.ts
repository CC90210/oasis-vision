import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

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
 * Fix round 1 / Finding C: writes to disk used to be fire-and-forget
 * (`void writeDisk(...)`), so `cachedJson` could resolve — and a test could
 * finish `await`ing it — while the mkdir+writeFile were still in progress.
 * `clearGevCache`'s `rm()` could then land BEFORE that write, and the write
 * would finish AFTER, recreating the directory with residue right after a
 * clear: the exact defect R5 exists to close, just moved into a timing
 * window instead of removed. Every write is tracked here from the instant it
 * starts (synchronously, before its first internal await), and
 * `clearGevCache` drains this set before it removes the directory — so an
 * already-started write is always finished-and-reflected-or-discarded before
 * the directory disappears, regardless of whether the caller awaited the
 * `cachedJson` call that triggered it.
 */
const pendingWrites = new Set<Promise<void>>();

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
 *
 * Fix round 1 / Finding C: drains `pendingWrites` before touching disk, so an
 * already-in-flight write can never lose the race with this removal — see
 * the comment on `pendingWrites` above.
 */
export function clearGevCache(): Promise<void> {
  mem.clear();
  inflight.clear();
  const drain = pendingWrites.size > 0 ? Promise.allSettled([...pendingWrites]) : Promise.resolve();
  return drain.then(async () => {
    await rm(CACHE_DIR, { recursive: true, force: true }).catch((e) => {
      console.warn('[OSIRIS] gev-cache clear: failed to remove disk cache dir:', e instanceof Error ? e.message : e);
    });
  });
}

/**
 * Test-only. Clears only the in-memory tiers (`mem` + `inflight`), leaving
 * the disk tier untouched.
 *
 * Fix round 1 / Finding B: every test used `clearGevCache()`, which (correctly,
 * per R5) also wipes disk — so every fallback the suite ever exercised came
 * from memory, and `readDisk`'s TTL comparison and JSON parse were dead code
 * as far as the suite could tell. This lets a test force `cachedJson` past
 * the memory tier deliberately, so the disk-fallback path actually runs.
 */
export function clearGevMemoryOnly(): void {
  mem.clear();
  inflight.clear();
}

const safeKey = (key: string): string => {
  if (!key) throw new Error('gev-cache: empty key');
  return key;
};

/**
 * Fix round 1 / Finding A: the charset allowlist alone is many-to-one — 'a/b'
 * and 'a:b' both sanitise to 'a_b', so two distinct keys used to collapse
 * onto the same disk file (memory was never at risk, since it keys on the
 * original string, but disk keyed only on the sanitised one). A short hash of
 * the ORIGINAL key is appended so distinct keys can never share a file, while
 * the sanitised prefix keeps filenames legible. The sanitised half alone
 * already blocks path escape (no '/', '..', or path separators survive it);
 * the hash is hex-only, so that property is unaffected.
 */
const diskPath = (key: string) => {
  const raw = safeKey(key);
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, '_') || '_';
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return join(CACHE_DIR, `${sanitized}.${hash}.json`);
};

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

async function performWriteDisk<T>(key: string, entry: Entry<T>): Promise<void> {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(diskPath(key), JSON.stringify(entry), 'utf8');
  } catch (e) {
    console.warn(`[OSIRIS] gev-cache disk write failed for ${key}:`, e instanceof Error ? e.message : e);
  }
}

/**
 * Registers the write in `pendingWrites` synchronously, in the same tick it
 * starts — before `performWriteDisk`'s first internal `await` — so a
 * `clearGevCache()` call that lands on the very next tick still finds it and
 * waits for it. See the comment on `pendingWrites`.
 */
function trackedWriteDisk<T>(key: string, entry: Entry<T>): Promise<void> {
  const p = performWriteDisk(key, entry);
  pendingWrites.add(p);
  const untrack = () => {
    pendingWrites.delete(p);
  };
  p.then(untrack, untrack);
  return p;
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
      // Awaited (not fire-and-forget, per Finding C): the common case — a
      // caller that awaits `cachedJson` — should never see disk state that
      // is still catching up with memory.
      await trackedWriteDisk(key, entry);
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
