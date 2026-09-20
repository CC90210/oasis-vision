/**
 * ═══════════════════════════════════════════════════════════════
 *  OASIS VISION — Passive web-surface checks, no backend required
 *
 *  SSL/TLS, security headers, technology fingerprint and subdomain
 *  enumeration used to proxy to an external scanner service that does
 *  not ship with this repo, so all four returned 503 on every install.
 *
 *  None of them actually need one. Each is a passive observation an
 *  ordinary browser makes anyway:
 *    ssl         one TLS handshake, read the certificate
 *    headers     one GET, read the response headers
 *    tech        the same GET, read headers + a little HTML
 *    subdomains  certificate transparency logs (crt.sh), same source
 *                the CERTS tool already uses
 *
 *  Nothing here probes a port, sends a payload, or touches anything a
 *  visitor would not. Active scanning (port sweeps, vulnerability
 *  probing) still requires the separate backend, because that genuinely
 *  is a different activity with different authorisation needs.
 * ═══════════════════════════════════════════════════════════════
 */

import tls from 'tls';
import { safeFetch, validateHost } from './ssrf-guard';
import { PROBE_UA as UA } from './probe-semantics';

/** Strip scheme/path/port down to a bare hostname. */
export function toHostname(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let host = raw;
  try {
    if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^\/+|\/+$/g, '').split('/')[0].split(':')[0];
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) return null;
  if (!host.includes('.')) return null;
  return host.toLowerCase();
}

// ── SSL / TLS ──────────────────────────────────────────────────

export interface SslReport {
  host: string;
  port: number;
  protocol: string | null;
  cipher: { name: string; version: string } | null;
  issuer: string | null;
  subject: string | null;
  validFrom: string | null;
  validTo: string | null;
  daysRemaining: number | null;
  expired: boolean;
  selfSigned: boolean;
  authorized: boolean;
  authorizationError: string | null;
  altNames: string[];
  serialNumber: string | null;
  findings: string[];
}

/**
 * One TLS handshake against port 443.
 *
 * `rejectUnauthorized: false` so a broken certificate is REPORTED
 * rather than throwing — a self-signed or expired cert is exactly the
 * finding an analyst wants, and refusing to connect would hide it.
 * Nothing is sent over the socket; it is closed after the handshake.
 */
export function inspectTls(host: string, port = 443, timeoutMs = 10000): Promise<SslReport> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const cert = socket.getPeerCertificate(true);
        const cipher = socket.getCipher();
        const authorized = socket.authorized;
        const authError = socket.authorizationError ? String(socket.authorizationError) : null;

        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
        const validFrom = cert?.valid_from ? new Date(cert.valid_from) : null;
        const now = Date.now();
        const daysRemaining =
          validTo && !Number.isNaN(validTo.getTime())
            ? Math.floor((validTo.getTime() - now) / 86_400_000)
            : null;

        // Node types these as string | string[] — a multi-valued RDN is
        // legal — so flatten rather than assume the common case.
        const flat = (v: string | string[] | undefined): string | null =>
          Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
        const issuerCn = flat(cert?.issuer?.CN) || flat(cert?.issuer?.O);
        const subjectCn = flat(cert?.subject?.CN);
        const selfSigned =
          Boolean(issuerCn && subjectCn && issuerCn === subjectCn) || authError === 'DEPTH_ZERO_SELF_SIGNED_CERT';

        const altNames = (cert?.subjectaltname || '')
          .split(',')
          .map((s) => s.trim().replace(/^DNS:/, ''))
          .filter(Boolean);

        const findings: string[] = [];
        if (daysRemaining !== null && daysRemaining < 0) findings.push(`Certificate EXPIRED ${Math.abs(daysRemaining)} days ago.`);
        else if (daysRemaining !== null && daysRemaining < 14) findings.push(`Certificate expires in ${daysRemaining} days.`);
        if (selfSigned) findings.push('Certificate is self-signed — no public CA vouches for it.');
        if (!authorized && authError && !selfSigned) findings.push(`Chain not trusted: ${authError}`);
        const proto = socket.getProtocol();
        if (proto && /TLSv1(\.[01])?$/.test(proto)) findings.push(`Negotiated ${proto}, which is deprecated.`);
        if (findings.length === 0) findings.push('No certificate problems observed.');

        const report: SslReport = {
          host,
          port,
          protocol: proto,
          cipher: cipher ? { name: cipher.name, version: cipher.version } : null,
          issuer: issuerCn,
          subject: subjectCn,
          validFrom: validFrom && !Number.isNaN(validFrom.getTime()) ? validFrom.toISOString() : null,
          validTo: validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString() : null,
          daysRemaining,
          expired: daysRemaining !== null && daysRemaining < 0,
          selfSigned,
          authorized,
          authorizationError: authError,
          altNames: altNames.slice(0, 100),
          serialNumber: cert?.serialNumber || null,
          findings,
        };
        socket.end();
        resolve(report);
      },
    );

    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      reject(new Error(`TLS handshake timed out after ${timeoutMs}ms`));
    });
    socket.on('error', (e) => {
      socket.destroy();
      reject(e instanceof Error ? e : new Error('TLS connection failed'));
    });
  });
}

// ── Security headers ───────────────────────────────────────────

export interface HeaderCheck {
  header: string;
  present: boolean;
  value: string | null;
  verdict: 'good' | 'weak' | 'missing';
  note: string;
}

export interface HeadersReport {
  url: string;
  status: number;
  server: string | null;
  checks: HeaderCheck[];
  score: number;
  grade: string;
}

const HEADER_RULES: Array<{
  header: string;
  missing: string;
  assess: (v: string) => { verdict: 'good' | 'weak'; note: string };
}> = [
  {
    header: 'strict-transport-security',
    missing: 'No HSTS — a downgrade to plain HTTP is not prevented.',
    assess: (v) => {
      const age = Number((v.match(/max-age=(\d+)/i) || [])[1] || 0);
      if (age < 15552000) return { verdict: 'weak', note: `max-age=${age} is below the 180-day baseline.` };
      return { verdict: 'good', note: `max-age=${age}${/includeSubDomains/i.test(v) ? ', includes subdomains' : ''}.` };
    },
  },
  {
    header: 'content-security-policy',
    missing: 'No CSP — nothing constrains where scripts may load from.',
    assess: (v) => {
      if (/unsafe-inline|unsafe-eval/i.test(v)) return { verdict: 'weak', note: "Present, but allows 'unsafe-inline' or 'unsafe-eval'." };
      return { verdict: 'good', note: 'Present and does not allow unsafe inline script.' };
    },
  },
  {
    header: 'x-frame-options',
    missing: 'No X-Frame-Options — clickjacking is not blocked (CSP frame-ancestors may still cover this).',
    assess: (v) => (/deny|sameorigin/i.test(v) ? { verdict: 'good', note: v } : { verdict: 'weak', note: `Unrecognised value: ${v}` }),
  },
  {
    header: 'x-content-type-options',
    missing: 'No X-Content-Type-Options — browsers may MIME-sniff responses.',
    assess: (v) => (/nosniff/i.test(v) ? { verdict: 'good', note: 'nosniff' } : { verdict: 'weak', note: v }),
  },
  {
    header: 'referrer-policy',
    missing: 'No Referrer-Policy — full URLs may leak to third parties.',
    assess: (v) => ({ verdict: 'good', note: v }),
  },
  {
    header: 'permissions-policy',
    missing: 'No Permissions-Policy — camera, mic and geolocation are not restricted.',
    assess: (v) => ({ verdict: 'good', note: v.slice(0, 120) }),
  },
];

export function auditHeaders(url: string, status: number, headers: Headers): HeadersReport {
  const checks: HeaderCheck[] = HEADER_RULES.map((rule) => {
    const value = headers.get(rule.header);
    if (!value) {
      return { header: rule.header, present: false, value: null, verdict: 'missing' as const, note: rule.missing };
    }
    const { verdict, note } = rule.assess(value);
    return { header: rule.header, present: true, value: value.slice(0, 300), verdict, note };
  });

  const points = checks.reduce((sum, c) => sum + (c.verdict === 'good' ? 2 : c.verdict === 'weak' ? 1 : 0), 0);
  const score = Math.round((points / (HEADER_RULES.length * 2)) * 100);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 55 ? 'C' : score >= 35 ? 'D' : 'F';

  return { url, status, server: headers.get('server'), checks, score, grade };
}

// ── Technology fingerprint ─────────────────────────────────────

export interface TechReport {
  url: string;
  status: number;
  technologies: Array<{ name: string; category: string; evidence: string }>;
}

const HTML_SIGNATURES: Array<{ name: string; category: string; re: RegExp }> = [
  { name: 'Next.js', category: 'Framework', re: /__NEXT_DATA__|\/_next\/static/ },
  { name: 'React', category: 'Library', re: /data-reactroot|react(?:-dom)?(?:\.min)?\.js/ },
  { name: 'Vue.js', category: 'Library', re: /data-v-[a-f0-9]{8}|vue(?:\.min)?\.js/ },
  { name: 'Angular', category: 'Framework', re: /ng-version=|angular(?:\.min)?\.js/ },
  { name: 'Svelte', category: 'Framework', re: /svelte-[a-z0-9]{6}/ },
  { name: 'WordPress', category: 'CMS', re: /wp-content|wp-includes/ },
  { name: 'Shopify', category: 'E-commerce', re: /cdn\.shopify\.com|Shopify\.theme/ },
  { name: 'Squarespace', category: 'CMS', re: /squarespace\.com|static1\.squarespace/ },
  { name: 'Wix', category: 'CMS', re: /wix\.com|wixstatic/ },
  { name: 'Drupal', category: 'CMS', re: /Drupal\.settings|sites\/default\/files/ },
  { name: 'jQuery', category: 'Library', re: /jquery(?:-|\.)\d|jquery(?:\.min)?\.js/ },
  { name: 'Tailwind CSS', category: 'CSS', re: /tailwindcss|tw-[a-z]+-/ },
  { name: 'Bootstrap', category: 'CSS', re: /bootstrap(?:\.min)?\.(?:css|js)/ },
  { name: 'Google Analytics', category: 'Analytics', re: /google-analytics\.com|gtag\/js|googletagmanager/ },
  { name: 'Cloudflare Insights', category: 'Analytics', re: /cloudflareinsights\.com/ },
  { name: 'HubSpot', category: 'Marketing', re: /js\.hs-scripts\.com|hubspot/ },
  { name: 'Stripe', category: 'Payments', re: /js\.stripe\.com/ },
];

const HEADER_SIGNATURES: Array<{ name: string; category: string; header: string; re?: RegExp }> = [
  { name: 'Cloudflare', category: 'CDN', header: 'cf-ray' },
  { name: 'Vercel', category: 'Hosting', header: 'x-vercel-id' },
  { name: 'Netlify', category: 'Hosting', header: 'x-nf-request-id' },
  { name: 'Fastly', category: 'CDN', header: 'x-served-by', re: /cache-/ },
  { name: 'Amazon CloudFront', category: 'CDN', header: 'x-amz-cf-id' },
  { name: 'nginx', category: 'Server', header: 'server', re: /nginx/i },
  { name: 'Apache', category: 'Server', header: 'server', re: /apache/i },
  { name: 'Microsoft IIS', category: 'Server', header: 'server', re: /iis|microsoft/i },
  { name: 'Express', category: 'Framework', header: 'x-powered-by', re: /express/i },
  { name: 'PHP', category: 'Language', header: 'x-powered-by', re: /php/i },
  { name: 'ASP.NET', category: 'Framework', header: 'x-powered-by', re: /asp\.net/i },
];

export function fingerprint(url: string, status: number, headers: Headers, html: string): TechReport {
  const technologies: TechReport['technologies'] = [];
  const seen = new Set<string>();

  for (const sig of HEADER_SIGNATURES) {
    const v = headers.get(sig.header);
    if (!v) continue;
    if (sig.re && !sig.re.test(v)) continue;
    if (seen.has(sig.name)) continue;
    seen.add(sig.name);
    technologies.push({ name: sig.name, category: sig.category, evidence: `${sig.header}: ${v.slice(0, 80)}` });
  }

  const head = html.slice(0, 250_000);
  for (const sig of HTML_SIGNATURES) {
    const m = head.match(sig.re);
    if (!m || seen.has(sig.name)) continue;
    seen.add(sig.name);
    technologies.push({ name: sig.name, category: sig.category, evidence: `matched "${m[0].slice(0, 60)}"` });
  }

  const generator = head.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
  if (generator?.[1] && !seen.has(generator[1])) {
    technologies.push({ name: generator[1].slice(0, 60), category: 'Generator', evidence: 'meta generator tag' });
  }

  return { url, status, technologies };
}

// ── Subdomains (certificate transparency) ──────────────────────

export interface SubdomainReport {
  domain: string;
  source: string;
  total: number;
  subdomains: string[];
  note: string;
}

/**
 * Subdomains observed in certificate transparency logs.
 *
 * This is passive: CT logs are a public append-only record of every
 * certificate a CA issued. Nothing is sent to the target. It therefore
 * finds only names that have had a public certificate — an internal
 * host with no cert will not appear, and the note says so rather than
 * letting an empty-ish list imply a small attack surface.
 */
export async function enumerateSubdomains(domain: string, timeoutMs = 20000): Promise<SubdomainReport> {
  const res = await fetch(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`crt.sh responded ${res.status}`);

  const rows = (await res.json()) as Array<{ name_value?: string }>;
  const set = new Set<string>();
  for (const row of rows) {
    for (const name of (row.name_value || '').split('\n')) {
      const n = name.trim().toLowerCase().replace(/^\*\./, '');
      if (n.endsWith(`.${domain}`) || n === domain) set.add(n);
    }
  }
  const subdomains = [...set].sort();
  return {
    domain,
    source: 'crt.sh certificate transparency',
    total: subdomains.length,
    subdomains,
    note:
      'Only names that have appeared in a public certificate. A host with no certificate will not show up here, ' +
      'so this is a floor on the attack surface, not a complete inventory.',
  };
}

// ── Shared fetch for the header/tech checks ────────────────────

export async function fetchForAnalysis(
  target: string,
  timeoutMs = 15000,
): Promise<{ url: string; status: number; headers: Headers; html: string }> {
  const host = toHostname(target);
  if (!host) throw new Error('Could not read a hostname from that input');

  const guard = await validateHost(host);
  if (!guard.ok) throw new Error(`Target not allowed: ${guard.reason}`);

  const url = /^https?:\/\//i.test(target) ? target : `https://${host}`;
  const res = await safeFetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeoutMs),
    maxRedirects: 3,
  });

  // Cap the body: we only fingerprint the head of the document, and an
  // unbounded read turns a large page into a memory problem.
  const raw = await res.text();
  return { url, status: res.status, headers: res.headers, html: raw.slice(0, 300_000) };
}
