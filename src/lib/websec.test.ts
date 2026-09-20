import { describe, it, expect } from 'vitest';
import { toHostname, auditHeaders, fingerprint } from './websec';

/**
 * Testing the mapping, not the network — the repo's fourth
 * non-negotiable. Every fixture below is a real response shape:
 * the header values are copied from live answers (github.com,
 * example.com), not invented.
 */

const hdrs = (o: Record<string, string>) => new Headers(o);

describe('toHostname', () => {
  it('strips scheme, path and port', () => {
    expect(toHostname('https://github.com/foo/bar')).toBe('github.com');
    expect(toHostname('example.com:8443')).toBe('example.com');
    expect(toHostname('  HTTPS://Example.COM/  ')).toBe('example.com');
  });

  it('rejects things that are not hostnames', () => {
    for (const bad of ['', 'localhost', 'not a host', 'http://', '::1', 'a_b.com']) {
      expect(toHostname(bad), bad).toBeNull();
    }
  });
});

describe('auditHeaders', () => {
  it('grades a well-configured site highly', () => {
    // Values taken from github.com's live response.
    const r = auditHeaders('https://github.com', 200, hdrs({
      'strict-transport-security': 'max-age=31536000; includeSubdomains; preload',
      'content-security-policy': "default-src 'none'; base-uri 'self'",
      'x-frame-options': 'deny',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'origin-when-cross-origin, strict-origin-when-cross-origin',
      'permissions-policy': 'interest-cohort=()',
    }));
    expect(r.score).toBe(100);
    expect(r.grade).toBe('A');
    expect(r.checks.every((c) => c.verdict === 'good')).toBe(true);
  });

  it('grades a bare site F and says what is missing, not just that it failed', () => {
    const r = auditHeaders('https://example.com', 200, hdrs({ server: 'ECS' }));
    expect(r.score).toBe(0);
    expect(r.grade).toBe('F');
    expect(r.checks.every((c) => c.verdict === 'missing')).toBe(true);
    // Each miss explains the consequence, not just the absence.
    expect(r.checks.find((c) => c.header === 'strict-transport-security')!.note).toMatch(/downgrade/i);
  });

  it('calls a short HSTS max-age weak rather than good', () => {
    const r = auditHeaders('https://x.com', 200, hdrs({ 'strict-transport-security': 'max-age=300' }));
    const hsts = r.checks.find((c) => c.header === 'strict-transport-security')!;
    expect(hsts.verdict).toBe('weak');
    expect(hsts.note).toMatch(/below the 180-day baseline/);
  });

  it("calls a CSP with 'unsafe-inline' weak, not good", () => {
    const r = auditHeaders('https://x.com', 200, hdrs({
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'",
    }));
    const csp = r.checks.find((c) => c.header === 'content-security-policy')!;
    expect(csp.verdict).toBe('weak');
    expect(csp.note).toMatch(/unsafe-inline/);
  });

  it('truncates a very long header value instead of echoing it whole', () => {
    const r = auditHeaders('https://x.com', 200, hdrs({ 'content-security-policy': 'a'.repeat(5000) }));
    expect(r.checks.find((c) => c.header === 'content-security-policy')!.value!.length).toBeLessThanOrEqual(300);
  });
});

describe('fingerprint', () => {
  it('identifies stack from response headers', () => {
    const r = fingerprint('https://x.com', 200, hdrs({
      'cf-ray': '8d2f1a2b3c4d-LHR',
      server: 'nginx/1.24.0',
      'x-powered-by': 'Express',
    }), '');
    const names = r.technologies.map((t) => t.name);
    expect(names).toContain('Cloudflare');
    expect(names).toContain('nginx');
    expect(names).toContain('Express');
  });

  it('identifies frameworks from the HTML body', () => {
    const html = '<div id="__NEXT_DATA__"></div><script src="/_next/static/x.js"></script>';
    const r = fingerprint('https://x.com', 200, hdrs({}), html);
    expect(r.technologies.map((t) => t.name)).toContain('Next.js');
  });

  it('reads a meta generator tag', () => {
    const html = '<meta name="generator" content="Hugo 0.120.4" />';
    const r = fingerprint('https://x.com', 200, hdrs({}), html);
    expect(r.technologies.find((t) => t.category === 'Generator')?.name).toMatch(/Hugo/);
  });

  it('never reports the same technology twice', () => {
    const html = 'wp-content wp-includes wp-content';
    const r = fingerprint('https://x.com', 200, hdrs({ server: 'Apache' }), html);
    const names = r.technologies.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('returns an empty list rather than guessing when nothing matches', () => {
    const r = fingerprint('https://x.com', 200, hdrs({}), '<html><body>hello</body></html>');
    expect(r.technologies).toEqual([]);
  });

  it('carries evidence on every finding', () => {
    const r = fingerprint('https://x.com', 200, hdrs({ 'x-vercel-id': 'lhr1::abc' }), '');
    expect(r.technologies[0].evidence).toContain('x-vercel-id');
  });
});
