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
 * Fix round 1 / Finding C, corrected in round 2 (RULING R15): writes to disk
 * are fire-and-forget from `cachedJson`'s point of view (see the comment on
 * `trackedWriteDisk`), so one can still be running after `cachedJson`
 * resolves. `clearGevCache`'s `rm()` must never land while that is true, or
 * the write finishes afterward and recreates the directory with residue —
 * the R5 defect moved into a timing window instead of removed.
 *
 * Round 1's fix drained this set with a single `Promise.allSettled` snapshot
 * taken once, up front. That leaves a gap: a write that STARTS during the
 * drain — after the snapshot was taken, before `rm()` runs — is not in it,
 * and slips through untouched. `clearBarrier` closes that gap by refusing
 * new writes outright once a clear has been requested (see
 * `trackedWriteDisk`), and `clearGevCache` loops on this set's live size
 * instead of a one-shot snapshot, so it keeps waiting until it is genuinely
 * empty. With no new entries possible once the barrier is up, that loop is
 * guaranteed to terminate.
 */
const pendingWrites = new Set<Promise<void>>();
let clearBarrier = false;

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
 * RULING R15 (round 2): raises `clearBarrier` for the duration — synchronously,
 * before the first `await`, so it is in effect for any write attempted from
 * the very next tick onward — and loops on `pendingWrites`'s live size
 * (never a snapshot) until it is empty, before touching disk. See the
 * comment on `pendingWrites`.
 */
export async function clearGevCache(): Promise<void> {
  mem.clear();
  inflight.clear();
  clearBarrier = true;
  try {
    while (pendingWrites.size > 0) {
      await Promise.allSettled([...pendingWrites]);
    }
    await rm(CACHE_DIR, { recursive: true, force: true }).catch((e) => {
      console.warn('[OSIRIS] gev-cache clear: failed to remove disk cache dir:', e instanceof Error ? e.message : e);
    });
  } finally {
    clearBarrier = false;
  }
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

/**
 * Test-only. Resolves once every disk write registered at the moment of the
 * call has settled — a plain wait, no barrier, no removal.
 *
 * RULING R15 (round 2) restored fire-and-forget writes on the `cachedJson`
 * response path (see `trackedWriteDisk`), which is correct for production —
 * seven routes should not each pay disk latency on every fresh fetch for a
 * race that a barrier already closes — but it means a test can no longer
 * infer "the write has landed" from "`cachedJson` resolved". A test that
 * deliberately wants to exercise the disk-fallback path (`clearGevMemoryOnly`
 * then re-fetch) needs a deterministic way to know the write it just
 * triggered is actually on disk, rather than guessing with a timer.
 */
export async function flushGevWrites(): Promise<void> {
  while (pendingWrites.size > 0) {
    await Promise.allSettled([...pendingWrites]);
  }
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
 *
 * RULING R15 (round 2): if a clear has already been requested (`clearBarrier`
 * is up), this refuses to start a new write at all rather than risk racing
 * the removal — dropping it is safe, since a clear discards disk state on
 * purpose and the next successful fetch will persist it again if it is still
 * wanted. This is what makes `clearGevCache`'s drain loop terminate without
 * needing a snapshot: no write can appear in `pendingWrites` after the
 * barrier goes up, so the set can only shrink from here.
 */
function trackedWriteDisk<T>(key: string, entry: Entry<T>): Promise<void> {
  if (clearBarrier) {
    return Promise.resolve();
  }
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
      // Fire-and-forget (restored in round 2, RULING R15): the barrier in
      // `trackedWriteDisk`/`clearGevCache` closes the residue race without
      // making every fresh fetch, across all seven routes that consume
      // this, pay disk latency on its response path. A test that needs to
      // know the write has landed uses `flushGevWrites()`.
      void trackedWriteDisk(key, entry);
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
