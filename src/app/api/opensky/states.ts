import { cachedJson, type CacheAge } from '@/lib/gev-cache';

/**
 * OASIS VISION — OpenSky state vectors for the God's Eye View globe.
 *
 * ── What this returns ──────────────────────────────────────────────────────
 * The RAW upstream payload: `{ time, states }` where every state is OpenSky's
 * positional array. The vendored client requires exactly that:
 *
 *   gods-eye-view src/data/flights.js:4136  !Array.isArray(data.states) → 'Malformed OpenSky response'
 *   gods-eye-view src/data/flights.js:4143  data.states.filter(_isUsableOpenSkyState)
 *   gods-eye-view src/data/flights.js:3216-3221
 *                                           Array.isArray(state) && typeof state[0] === 'string'
 *                                           && Number.isFinite(state[5]) && Number.isFinite(state[6])
 *   gods-eye-view src/data/flights.js:4152  Number(data.time) * 1000 → snapshot age
 *   gods-eye-view src/data/flights.js:4186  state[17] emitter category — needs upstream ?extended=1
 *
 * Index 5 is longitude and index 6 is latitude — that order, the reverse of
 * how they are usually written. `mapStateVector` below still encodes that,
 * and is still pinned by its own test, but it is now a VALIDATOR: it decides
 * whether the rows we are about to forward are usable, and never replaces
 * them. A mapped-object envelope made every row fail the client predicate.
 *
 * ── Rate discipline, and why it is not a performance knob ──────────────────
 * `src/app/api/flights/route.ts` (PRE-EXISTING, serves the MapLibre console)
 * already paces this same upstream from this same egress IP and, when
 * credentials are set, the same OpenSky account:
 *
 *   flights/route.ts:236-237  90s authenticated / 900s anonymous
 *   flights/route.ts:250-251  15-minute cooldown after a 429
 *   flights/route.ts:239-244  the last good snapshot is reused between calls
 *
 * Its comments record that exhausting the anonymous per-IP pool is what
 * previously emptied its map. An unbounded `/states/all` costs 4 credits
 * against 400/day anonymous — 100 calls — so the console at 900s already
 * accounts for essentially the whole anonymous budget on its own.
 *
 * This route therefore does NOT take an equal share. It is additive; the
 * console is not. Its intervals are deliberately the longer ones (1800s
 * anonymous, 300s authenticated), it honours the same 15-minute post-429
 * cooldown, and between refreshes it serves the last good snapshot instead of
 * refetching. The 9-second TTL this replaced burned the day's anonymous
 * allowance in about a quarter of an hour and took the console's flight layer
 * with it.
 *
 * With NO credentials the two consumers still contend for one 400-credit
 * pool, and no pacing on this side alone can fully fix that. The real remedy
 * is OPENSKY_CLIENT_ID/OPENSKY_CLIENT_SECRET — which this file now actually
 * reads (it previously did not, while /api/setup/status advertised that it
 * raised limits) and which moves both consumers onto the 4,000-credit account
 * pool.
 */

const STATES_URL = 'https://opensky-network.org/api/states/all';
const TRACK_URL = 'https://opensky-network.org/api/tracks/all';
const TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

/** Mirrors flights/route.ts:251. Exported so a test can prove it exists. */
export const openSkyCooldownMs = () => 15 * 60_000;

/**
 * Deliberately slower than flights/route.ts:237 (90s). See the header: the
 * console is pre-existing and holds the larger share of a shared budget.
 */
export const authenticatedIntervalMs = () => 300_000;

/** Deliberately slower than flights/route.ts:237 (900s), for the same reason. */
export const anonymousIntervalMs = () => 1_800_000;

export const hasOpenSkyCreds = () =>
  Boolean(process.env.OPENSKY_CLIENT_ID?.trim() && process.env.OPENSKY_CLIENT_SECRET?.trim());

const refreshIntervalMs = () =>
  hasOpenSkyCreds() ? authenticatedIntervalMs() : anonymousIntervalMs();

export type AuthMode = 'oauth' | 'anon';

export interface StatesPayload {
  /** Upstream snapshot time, epoch SECONDS. Forwarded verbatim. */
  time: number | null;
  /** Raw OpenSky positional state vectors, forwarded verbatim. */
  states: unknown[][];
}

export interface OpenSkyState {
  hex: string;
  callsign: string | null;
  country: string | null;
  lat: number;
  lng: number;
  altM: number | null;
  onGround: boolean;
  speedMs: number | null;
  headingDeg: number | null;
  verticalRateMs: number | null;
  squawk: string | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The index meanings, in one place, pinned by states.test.ts.
 *
 * No longer the response — the client needs the raw row. Kept because it is
 * the gate that answers "is this upstream body still OpenSky?": it is the
 * server-side twin of the client's `_isUsableOpenSkyState`, and a body that
 * yields zero usable rows must fail loudly here (serving the stale copy)
 * rather than reach the client as a plausible-looking empty sky.
 */
export function mapStateVector(row: unknown[]): OpenSkyState | null {
  if (!Array.isArray(row) || row.length < 15) return null;

  const hex = str(row[0]);
  const lng = num(row[5]);
  const lat = num(row[6]);
  if (!hex || lat === null || lng === null) return null;

  return {
    hex,
    callsign: str(row[1]),
    country: str(row[2]),
    lat,
    lng,
    altM: num(row[7]),
    onGround: row[8] === true,
    speedMs: num(row[9]),
    headingDeg: num(row[10]),
    verticalRateMs: num(row[11]),
    squawk: str(row[14]),
  };
}

let cooldownUntil = 0;
let osToken: string | null = null;
let osTokenExpiry = 0;

/** Test-only: drops the pacing state this module holds outside the cache. */
export function resetOpenSkyPacing(): void {
  cooldownUntil = 0;
  osToken = null;
  osTokenExpiry = 0;
}

/**
 * OAuth2 client-credentials, the same grant flights/route.ts:259-286 uses.
 * A failure returns null and the call proceeds anonymously — loudly logged,
 * never silently, because anonymous is the mode that exhausts the pool.
 */
async function getToken(): Promise<string | null> {
  const id = process.env.OPENSKY_CLIENT_ID?.trim();
  const secret = process.env.OPENSKY_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  if (osToken && Date.now() < osTokenExpiry) return osToken;

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn('[OSIRIS] opensky (globe) token failed:', res.status);
      return null;
    }
    const data = await res.json();
    if (!data?.access_token) {
      console.warn('[OSIRIS] opensky (globe) token response missing access_token');
      return null;
    }
    osToken = String(data.access_token);
    osTokenExpiry = Date.now() + ((Number(data.expires_in) || 1800) - 60) * 1000;
    return osToken;
  } catch (e) {
    console.warn('[OSIRIS] opensky (globe) token error:', e instanceof Error ? e.message : e);
    return null;
  }
}

export async function fetchStates(): Promise<{
  payload: StatesPayload;
  age: CacheAge;
  fetchedAt: number;
  authMode: AuthMode;
  rateLimited: boolean;
}> {
  let rateLimited = false;
  let authMode: AuthMode = hasOpenSkyCreds() ? 'oauth' : 'anon';

  const result = await cachedJson<StatesPayload>({
    key: 'opensky-states-raw',
    ttlMs: refreshIntervalMs(),
    fetcher: async () => {
      // Cooldown is checked INSIDE the fetcher so a cache miss during the
      // window never touches the network — cachedJson then serves the last
      // good snapshot as `stale`, which is the honest answer.
      if (Date.now() < cooldownUntil) {
        rateLimited = true;
        const secs = Math.round((cooldownUntil - Date.now()) / 1000);
        throw new Error(`OpenSky in post-429 cooldown for another ${secs}s`);
      }

      const token = await getToken();
      authMode = token ? 'oauth' : 'anon';

      const url = new URL(STATES_URL);
      // extended=1 appends the ADS-B emitter category as an 18th field. The
      // client reads state[17] (flights.js:4186); without it that field is
      // silently undefined. It does not change the credit cost.
      url.searchParams.set('extended', '1');

      const res = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(25_000),
      });

      if (res.status === 429) {
        rateLimited = true;
        cooldownUntil = Date.now() + openSkyCooldownMs();
        console.warn(
          `[OSIRIS] opensky (globe) 429 — cooling down ${Math.round(openSkyCooldownMs() / 60_000)} min ` +
          `(mode=${authMode}); the pre-existing /api/flights console shares this budget`,
        );
        throw new Error('OpenSky rate limited (429)');
      }
      if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);

      const body = await res.json();
      const rows: unknown[] = Array.isArray(body?.states) ? body.states : [];

      // Contribution check, not a presence check: if upstream sent rows and
      // NONE of them are usable state vectors, the shape changed. Fail so the
      // stale copy is served and the reason is named, rather than forwarding
      // rows the client will reject as 'Malformed OpenSky aircraft rows'.
      const usable = rows.filter(r => mapStateVector(r as unknown[]) !== null);
      if (rows.length > 0 && usable.length === 0) {
        throw new Error(`OpenSky returned ${rows.length} rows, none of them usable state vectors`);
      }

      const time = Number(body?.time);
      return {
        time: Number.isFinite(time) ? time : null,
        states: usable as unknown[][],
      };
    },
  });

  console.log(
    `[OSIRIS] opensky states (globe) — ${result.data.states.length} aircraft ` +
    `(${result.age}, mode=${authMode}, interval=${Math.round(refreshIntervalMs() / 1000)}s)`,
  );
  if (result.data.states.length === 0) {
    console.warn('[OSIRIS] opensky states (globe) — zero aircraft; the globe flights layer will be empty');
  }

  return { payload: result.data, age: result.age, fetchedAt: result.fetchedAt, authMode, rateLimited };
}

export async function fetchTrack(icao: string): Promise<{ data: unknown; age: CacheAge; fetchedAt: number }> {
  if (!/^[0-9a-fA-F]{6}$/.test(icao)) throw new Error(`opensky: rejected icao "${icao}"`);

  const result = await cachedJson<unknown>({
    key: `opensky-track-${icao.toLowerCase()}`,
    ttlMs: 60_000,
    fetcher: async () => {
      const token = await getToken();
      const url = new URL(TRACK_URL);
      url.searchParams.set('icao24', icao.toLowerCase());
      url.searchParams.set('time', '0');
      const res = await fetch(url.toString(), {
        headers: {
          'User-Agent': 'OasisVision/1.0 (+https://oasisai.work)',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429) {
        cooldownUntil = Date.now() + openSkyCooldownMs();
        throw new Error(`OpenSky track rate limited (429) for ${icao}`);
      }
      if (!res.ok) throw new Error(`OpenSky track HTTP ${res.status} for ${icao}`);
      return res.json();
    },
  });
  return { data: result.data, age: result.age, fetchedAt: result.fetchedAt };
}
