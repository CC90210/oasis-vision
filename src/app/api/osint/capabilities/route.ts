import { NextResponse } from 'next/server';

/**
 * OASIS VISION — Which RECON tools can actually run right now.
 *
 * This route exists because of a specific defect: six tools in the
 * RECON panel (`scanner`, `vuln`, `ssl`, `subdomains`, `headers`,
 * `tech`) present a normal input box and then fail with 503, because
 * they proxy to a scanner backend that does not ship with this repo
 * and that no key enables. The analyst only found out after typing.
 *
 * The panel now asks this endpoint first and greys out what cannot
 * answer, with the reason. No capability is inferred from a guess —
 * each one reports the env var it actually needs.
 *
 * Reports only whether a variable is SET. Never its value.
 */

export const dynamic = 'force-dynamic';

type Tier = 1 | 2 | 3;

interface Capability {
  id: string;
  tier: Tier;
  available: boolean;
  /** Shown on the greyed-out tool. */
  reason: string | null;
  /** Env var names required. Names only, never values. */
  requires: string[];
}

function keyed(id: string, vars: string[], label: string): Capability {
  const missing = vars.filter((v) => !process.env[v]);
  return {
    id,
    tier: 2,
    available: missing.length === 0,
    reason: missing.length ? `${label} needs ${missing.join(' and ')}` : null,
    requires: vars,
  };
}

export async function GET() {
  const scannerConfigured = Boolean(process.env.SCANNER_URL && process.env.SCANNER_KEY);
  const scannerReason = scannerConfigured
    ? null
    : 'Active scanning needs a separate scanner backend, which does not ship with OASIS VISION. Set SCANNER_URL and SCANNER_KEY to enable.';

  // Tier 1 tools are keyless and always available. Listing them
  // explicitly means the panel never has to assume.
  const nativeIds = [
    'email', 'exif', 'bin', 'dns', 'whois', 'certs', 'ip', 'bgp', 'mac',
    'phone', 'username', 'github', 'leaks', 'threats', 'infostealer',
    'crypto', 'sanctions', 'cve', 'sweep', 'shodan',
  ];

  const capabilities: Capability[] = [
    ...nativeIds.map((id): Capability => ({ id, tier: 1, available: true, reason: null, requires: [] })),

    keyed('wigle', ['WIGLE_API_KEY'], 'WiFi geolocation'),
    keyed('virustotal', ['VIRUSTOTAL_API_KEY'], 'File/URL reputation'),

    // The six that share the scanner backend.
    ...['scanner', 'vuln', 'ssl', 'subdomains', 'headers', 'tech'].map((id): Capability => ({
      id,
      tier: 3,
      available: scannerConfigured,
      reason: scannerReason,
      requires: ['SCANNER_URL', 'SCANNER_KEY'],
    })),

    {
      id: 'darkweb',
      tier: 3,
      available: Boolean(process.env.TORBOT_URL),
      reason: process.env.TORBOT_URL
        ? null
        : 'Dark-web crawling runs in a separate opt-in container. Set TORBOT_URL to enable.',
      requires: ['TORBOT_URL'],
    },
    {
      id: 'mailaccess',
      tier: 3,
      available: Boolean(process.env.MAILACCESS_URL),
      reason: process.env.MAILACCESS_URL
        ? null
        : 'Deep email investigation runs in a separate container. The keyless Tier-1 investigation works without it.',
      requires: ['MAILACCESS_URL'],
    },
  ];

  const byId: Record<string, Capability> = {};
  for (const c of capabilities) byId[c.id] = c;

  return NextResponse.json(
    {
      capabilities: byId,
      summary: {
        total: capabilities.length,
        available: capabilities.filter((c) => c.available).length,
        unavailable: capabilities.filter((c) => !c.available).map((c) => c.id),
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
