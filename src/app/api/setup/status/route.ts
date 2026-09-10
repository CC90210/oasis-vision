import { NextResponse } from 'next/server';

/**
 * OASIS VISION — which providers are configured, and nothing else.
 *
 * The God's Eye View client asks this so its panels can say why a layer is
 * unavailable instead of failing silently.
 *
 * This route reports PRESENCE ONLY. It never returns, logs or hints at a value.
 * Their own /api/setup/keys, which writes keys from a browser form to disk, is
 * deliberately not implemented here: it is fine on localhost and wrong the
 * moment --lan or Tailscale is used, both of which OASIS supports.
 */

export const dynamic = 'force-dynamic';

export interface KeyStatus {
  id: string;
  label: string;
  configured: boolean;
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
const PROVIDERS: Array<{ id: string; label: string; env: string[] }> = [
  { id: 'cesium-ion', label: 'Cesium ion (photorealistic 3D)', env: ['CESIUM_ION_TOKEN'] },
  { id: 'google-maps', label: 'Google Maps (3D tiles, places, geocoding)', env: ['GOOGLE_MAPS_API_KEY'] },
  { id: 'openai', label: 'OpenAI (voice control)', env: ['OPENAI_API_KEY'] },
  { id: 'firms', label: 'NASA FIRMS (active fires)', env: ['FIRMS_API_KEY'] },
  { id: 'tomtom', label: 'TomTom (live traffic flow)', env: ['TOMTOM_API_KEY'] },
  {
    id: 'opensky',
    label: 'OpenSky (higher flight rate limits — needs BOTH id and secret)',
    env: ['OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET'],
  },
  { id: 'launch-library', label: 'Launch Library 2 (higher launch rate limits)', env: ['LL2_API_TOKEN'] },
  { id: 'ais', label: 'aisstream.io (live vessels)', env: ['AIS_API_KEY'] },
];

/** Pure, and exported so a test can prove no value ever escapes. */
export function describeKeys(env: Record<string, string | undefined>): KeyStatus[] {
  return PROVIDERS.map(({ id, label, env: names }) => ({
    id,
    label,
    configured: names.every(name => Boolean(env[name]?.trim())),
  }));
}

export async function GET() {
  const keys = describeKeys(process.env as Record<string, string | undefined>);
  console.log(`[OSIRIS] setup/status — ${keys.filter(k => k.configured).length}/${keys.length} providers configured`);
  return NextResponse.json({
    keys,
    // Their panel offers to save keys. Tell it plainly that it cannot here.
    writable: false,
    writableReason: 'Keys are set in the environment file by hand. This app does not accept credentials over HTTP.',
  });
}
