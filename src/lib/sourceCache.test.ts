import { describe, it, expect, beforeEach } from 'vitest';
import { cachedSource, clearSourceCache, peekSource } from './sourceCache';

type Cam = { id: string };
const cam = (id: string): Cam => ({ id });

beforeEach(() => clearSourceCache());

describe('cachedSource', () => {
  it('fetches once and serves the cached list afterwards', async () => {
    let calls = 0;
    const load = cachedSource<Cam>('t1', async () => { calls++; return [cam('a')]; });

    expect(await load()).toEqual([cam('a')]);
    expect(await load()).toEqual([cam('a')]);
    expect(calls).toBe(1);
  });

  it('refetches once the TTL has elapsed', async () => {
    let calls = 0;
    const load = cachedSource<Cam>('t2', async () => { calls++; return [cam(`v${calls}`)]; }, 10);

    await load();
    await new Promise((r) => setTimeout(r, 25));
    expect(await load()).toEqual([cam('v2')]);
    expect(calls).toBe(2);
  });

  // region=all fans out to every source at once — a cold cache must not
  // multiply into N concurrent upstream requests.
  it('collapses concurrent misses into a single upstream call', async () => {
    let calls = 0;
    const load = cachedSource<Cam>('t3', async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return [cam('a')];
    });

    const all = await Promise.all([load(), load(), load(), load()]);
    expect(calls).toBe(1);
    for (const r of all) expect(r).toEqual([cam('a')]);
  });

  it('keeps serving the last good list when a refresh throws', async () => {
    let mode: 'ok' | 'fail' = 'ok';
    const load = cachedSource<Cam>('t4', async () => {
      if (mode === 'fail') throw new Error('upstream down');
      return [cam('good')];
    }, 10);

    expect(await load()).toEqual([cam('good')]);
    mode = 'fail';
    await new Promise((r) => setTimeout(r, 25));
    // stale data rather than an empty layer
    expect(await load()).toEqual([cam('good')]);
  });

  it('treats an empty refresh as a failed one and holds the previous list', async () => {
    let mode: 'ok' | 'empty' = 'ok';
    const load = cachedSource<Cam>('t5', async () => (mode === 'ok' ? [cam('good')] : []), 10);

    await load();
    mode = 'empty';
    await new Promise((r) => setTimeout(r, 25));
    expect(await load()).toEqual([cam('good')]);
  });

  it('returns empty when the first fetch fails with nothing cached', async () => {
    const load = cachedSource<Cam>('t6', async () => { throw new Error('down'); });
    expect(await load()).toEqual([]);
  });

  it('keeps separate keys independent', async () => {
    const a = cachedSource<Cam>('t7a', async () => [cam('a')]);
    const b = cachedSource<Cam>('t7b', async () => [cam('b')]);
    expect(await a()).toEqual([cam('a')]);
    expect(await b()).toEqual([cam('b')]);
  });
});

/**
 * The CCTV route gives each region a 12s budget and, when it lapses, serves
 * whatever peekSource still holds. Canada aggregates three highway authorities
 * and reliably overruns that budget on a cold refresh, so a peek taken during
 * an in-flight refresh returning [] would blink its 2,505 cameras off the map
 * at every TTL boundary — the bug these tests exist to hold shut.
 */
describe('peekSource', () => {
  it('returns empty for a key that was never fetched', () => {
    expect(peekSource<Cam>('unfetched-key')).toEqual([]);
  });

  it('still holds the previous cameras while a slow refresh is in flight', async () => {
    let release!: () => void;
    let calls = 0;
    const load = cachedSource<Cam>('t8', async () => {
      calls++;
      if (calls === 1) return [cam('first')];
      // The second call models the refresh that overruns the caller's budget.
      await new Promise<void>((r) => { release = r; });
      return [cam('second')];
    }, 10);

    expect(await load()).toEqual([cam('first')]);
    await new Promise((r) => setTimeout(r, 25));   // let the TTL lapse

    const slow = load();                            // refresh starts, does not settle
    expect(peekSource<Cam>('t8')).toEqual([cam('first')]);

    release();
    expect(await slow).toEqual([cam('second')]);
    expect(peekSource<Cam>('t8')).toEqual([cam('second')]);
  });
});
