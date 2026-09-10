import { NextResponse } from 'next/server';

/**
 * OASIS VISION — which providers are configured, and nothing else.
 *
 * The vendored God's Eye View client (public/globe, built from
 * keySetupCore.mjs / keySetup.js) renders its POWER UP chip and dialog
 * ENTIRELY from this response — it never asks a second endpoint and it
 * never has its own copy of the registry. The shape below is not a house
 * envelope; it is the exact object `keySetupStatus()` produces upstream and
 * `render()`/`buildRow()` destructure downstream:
 *
 *   { keys: [{ id, title, unlocks, getUrl, envVars[], tier, clientExposed,
 *              set }], setCount, total }
 *
 * `buildRow` does `for (const envVar of key.envVars)` with no guard, and
 * `main.js` awaits `initKeySetup()` with no catch — so any other
 * shape (the previous `{id, label, configured}` + `{writable,
 * writableReason}` house envelope) throws an unhandled TypeError and leaves
 * the chip frozen on its last rendered label, which defaults to "POWERED
 * UP" — the UI asserting the opposite of the truth on a zero-key install.
 *
 * This route reports PRESENCE ONLY. It never returns, logs or hints at a
 * value. Their own /api/setup/keys, which writes keys from a browser form to
 * disk, is deliberately not implemented here: it is fine on localhost and
 * wrong the moment --lan or Tailscale is used, both of which OASIS supports.
 * The vendored client has no field in this contract that says "saving is
 * unavailable" (checked: neither keySetupCore.mjs nor keySetup.js reads any
 * such flag) — a POST there is simply answered 405 by Next.js, the panel's
 * existing `if (!response.ok || !payload.ok)` branch reports "Save failed
 * (405)." to the user, and no credential is ever accepted or written.
 */

export const dynamic = 'force-dynamic';

export interface KeyStatus {
  id: string;
  title: string;
  unlocks: string;
  getUrl: string;
  envVars: string[];
  tier: 'metered' | 'free';
  clientExposed: boolean;
  set: boolean;
}

interface ProviderDef {
  id: string;
  title: string;
  unlocks: string;
  getUrl: string;
  env: string[];
  tier: 'metered' | 'free';
  /**
   * True only for the two providers whose token is baked into the browser
   * bundle at public/globe/assets/*.js by design (Cesium ion + Google Maps
   * both need the token client-side to draw 3D tiles). Every other provider
   * here is proxied server-side by this app's own /api/* routes and the key
   * never reaches the browser.
   */
  clientExposed?: boolean;
}

/**
 * `env` is a LIST because a capability is only real when every variable it
 * needs is present. OpenSky's OAuth client-credentials grant needs both the
 * id and the secret; reporting "configured" on the id alone advertised a
 * higher rate limit the runtime could not obtain.
 *
 * Worse, until this fix nothing read either one: `src/app/api/opensky/states.ts`
 * called /states/all anonymously while this panel said the credential raised
 * limits. A panel that reports a capability the code lacks is its own small
 * lie, and it is the kind that gets believed during an incident. states.ts now
 * performs the same OAuth grant `src/app/api/flights/route.ts:259-286` uses,
 * so the claim below is true.
 */
const PROVIDERS: ProviderDef[] = [
  {
    id: 'cesium-ion',
    title: 'CESIUM ION',
    unlocks: 'Photorealistic 3D terrain + imagery',
    getUrl: 'https://ion.cesium.com/tokens',
    env: ['CESIUM_ION_TOKEN'],
    tier: 'free',
    clientExposed: true,
  },
  {
    id: 'google-maps',
    title: 'GOOGLE MAPS',
    unlocks: '3D tiles, place search, and geocoding',
    getUrl: 'https://developers.google.com/maps/documentation/tile/get-api-key',
    env: ['GOOGLE_MAPS_API_KEY'],
    tier: 'metered',
    clientExposed: true,
  },
  {
    id: 'openai',
    title: 'OPENAI',
    unlocks: 'Voice control — talk to the planet',
    getUrl: 'https://platform.openai.com/api-keys',
    env: ['OPENAI_API_KEY'],
    tier: 'metered',
  },
  {
    id: 'firms',
    title: 'NASA FIRMS',
    unlocks: 'Live active-fire detections',
    getUrl: 'https://firms.modaps.eosdis.nasa.gov/api/map_key/',
    env: ['FIRMS_API_KEY'],
    tier: 'free',
  },
  {
    id: 'tomtom',
    title: 'TOMTOM',
    unlocks: 'Real live traffic (keyless runs a simulation)',
    getUrl: 'https://developer.tomtom.com',
    env: ['TOMTOM_API_KEY'],
    tier: 'free',
  },
  {
    id: 'opensky',
    title: 'OPENSKY',
    unlocks: 'Higher flight-polling rate limits — needs BOTH id and secret',
    getUrl: 'https://opensky-network.org',
    env: ['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET'],
    tier: 'free',
  },
  {
    id: 'launch-library',
    title: 'LAUNCH LIBRARY',
    unlocks: 'Higher space-launch request allowance',
    getUrl: 'https://thespacedevs.com',
    env: ['LL2_API_TOKEN'],
    tier: 'free',
  },
  {
    id: 'ais',
    title: 'AISSTREAM',
    unlocks: 'Live vessel tracking, worldwide',
    getUrl: 'https://aisstream.io',
    env: ['AIS_API_KEY'],
    tier: 'free',
  },
];

/** Pure, and exported so a test can prove no value ever escapes. */
export function describeKeys(env: Record<string, string | undefined>): KeyStatus[] {
  return PROVIDERS.map(({ id, title, unlocks, getUrl, env: names, tier, clientExposed }) => ({
    id,
    title,
    unlocks,
    getUrl,
    envVars: [...names],
    tier,
    clientExposed: Boolean(clientExposed),
    set: names.every(name => Boolean(env[name]?.trim())),
  }));
}

export async function GET() {
  const keys = describeKeys(process.env as Record<string, string | undefined>);
  const setCount = keys.filter(k => k.set).length;
  console.log(`[OSIRIS] setup/status — ${setCount}/${keys.length} providers configured`);
  return NextResponse.json({ keys, setCount, total: keys.length });
}
