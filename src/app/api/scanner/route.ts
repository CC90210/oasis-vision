import { NextResponse } from 'next/server';
import { validateHost, isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import {
  toHostname,
  inspectTls,
  auditHeaders,
  fingerprint,
  enumerateSubdomains,
  fetchForAnalysis,
} from '@/lib/websec';

/**
 * OASIS VISION — Scanner Proxy (Hardened)
 * Rate-limited, target-validated, scope-restricted
 */

const SCANNER_URL = process.env.SCANNER_URL || '';
const SCANNER_KEY = process.env.SCANNER_KEY || '';

// The string-based regex previously here matched only literal dotted-quad
// IPv4, missed every IPv6 form, and never resolved hostnames — so an attacker
// could bypass it with `target=metadata.example.com` (DNS A → 169.254.169.254),
// `target=2130706433` (decimal 127.0.0.1), or `target=::1`. Validation now
// canonicalises the input and resolves hostnames before deciding. See
// `src/lib/ssrf-guard.ts`.

// ── ALLOWED SCAN TYPES (safe subset only) ──
const ALLOWED_SCANS: Record<string, { endpoint: string; timeout: number }> = {
  quick:      { endpoint: '/scan/quick',      timeout: 15000 },
  ssl:        { endpoint: '/scan/ssl',        timeout: 10000 },
  headers:    { endpoint: '/scan/headers',    timeout: 10000 },
  rdns:       { endpoint: '/scan/rdns',       timeout: 8000  },
  subdomains: { endpoint: '/scan/subdomains', timeout: 15000 },
  tech:       { endpoint: '/scan/tech',       timeout: 15000 },
  whois:      { endpoint: '/scan/whois',      timeout: 10000 },
  geoloc:     { endpoint: '/scan/geoloc',     timeout: 8000  },
  vuln:       { endpoint: '/scan/vuln',       timeout: 90000 },
};

// REMOVED from public access: deep, ports, banner, traceroute
// These are dangerous in an unauthenticated context:
//   deep     → scans 65,535 ports (DDoS amplifier)
//   banner   → harvests software versions from targets using our IP
//   traceroute → reveals hosting infrastructure
//   ports    → arbitrary port range scanning

/**
 * Scan types served natively, with no backend.
 *
 * These four used to 503 on every install because they proxied to a
 * scanner service that does not ship with this repo. None of them
 * needed one: each is a passive observation a browser makes anyway —
 * a TLS handshake, one GET, or a read of public certificate
 * transparency logs. They now work out of the box.
 *
 * `quick` and `vuln` are NOT here. Port sweeps and vulnerability
 * probing are active scanning against someone else's host, which is a
 * different activity with different authorisation needs, and they
 * still require the separate backend.
 */
const NATIVE_SCANS = new Set(['ssl', 'headers', 'tech', 'subdomains']);

export async function GET(req: Request) {
  const early = new URL(req.url).searchParams;
  const earlyType = early.get('type') || 'quick';

  // 1. The backend is only needed for the active scans. Checking the
  //    key before the native branch is what made ssl/headers/tech/
  //    subdomains unreachable even though they never used it.
  if (!SCANNER_KEY && !NATIVE_SCANS.has(earlyType)) {
    return NextResponse.json(
      {
        error: 'Active scanning is not configured',
        detail:
          'Port and vulnerability scanning need a separate scanner backend, which does not ship with OASIS VISION. ' +
          'SSL/TLS, HEADERS, TECH DETECT and SUBDOMAINS work without it.',
        hint: 'Set SCANNER_URL and SCANNER_KEY to enable active scanning.',
        native_scans: [...NATIVE_SCANS],
      },
      { status: 503 },
    );
  }

  // 2. Rate limit by client IP
  const clientIp = getClientIp(req);
  if (isRateLimited(clientIp, 5, 60_000, 'scanner')) {
    return NextResponse.json({
      error: 'Rate limit exceeded',
      detail: `Maximum 5 scans per minute. Please wait before scanning again.`,
    }, { status: 429 });
  }

  // 3. Validate params
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('target')?.trim();
  const scanType = searchParams.get('type') || 'quick';

  if (!target) {
    return NextResponse.json({ error: 'Missing target parameter' }, { status: 400 });
  }

  // 4. Block private/internal targets (DNS-resolves before deciding so a
  //    hostname pointing at a reserved range is rejected, and IPv6 + non-
  //    canonical IPv4 forms are no longer free bypasses).
  const guard = await validateHost(target);
  if (!guard.ok) {
    return NextResponse.json({
      error: 'Target blocked',
      detail: `Target validation failed: ${guard.reason}`,
    }, { status: 403 });
  }

  // 5a. Native scans: answered here, no backend involved.
  if (NATIVE_SCANS.has(scanType)) {
    const host = toHostname(target);
    if (!host) {
      return NextResponse.json({ error: 'Could not read a hostname from that input' }, { status: 400 });
    }
    try {
      if (scanType === 'ssl') {
        return NextResponse.json(await inspectTls(host), { headers: { 'Cache-Control': 'no-store' } });
      }
      if (scanType === 'subdomains') {
        return NextResponse.json(await enumerateSubdomains(host), { headers: { 'Cache-Control': 'no-store' } });
      }
      const page = await fetchForAnalysis(target);
      if (scanType === 'headers') {
        return NextResponse.json(auditHeaders(page.url, page.status, page.headers), {
          headers: { 'Cache-Control': 'no-store' },
        });
      }
      return NextResponse.json(fingerprint(page.url, page.status, page.headers, page.html), {
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (e) {
      // Named, not swallowed: a TLS failure and an unreachable host are
      // different answers and the analyst needs to tell them apart.
      console.error(`[OASIS] native ${scanType} scan failed for ${host}:`, e);
      return NextResponse.json(
        { error: `${scanType} check failed`, detail: e instanceof Error ? e.message : 'unknown', target: host },
        { status: 502 },
      );
    }
  }

  // 5b. Validate scan type (only safe scans allowed)
  const scanConfig = ALLOWED_SCANS[scanType];
  if (!scanConfig) {
    return NextResponse.json({
      error: 'Scan type not available',
      detail: `"${scanType}" is restricted. Available: ${Object.keys(ALLOWED_SCANS).join(', ')}`,
      available_scans: Object.keys(ALLOWED_SCANS),
    }, { status: 403 });
  }

  // 6. Execute scan with tight timeout
  try {
    const params = new URLSearchParams({ key: SCANNER_KEY, target });
    const res = await fetch(`${SCANNER_URL}${scanConfig.endpoint}?${params.toString()}`, {
      signal: AbortSignal.timeout(scanConfig.timeout),
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (e: any) {
    return NextResponse.json({
      error: 'Scanner unreachable',
      detail: e.message,
    }, { status: 502 });
  }
}
