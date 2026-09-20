/**
 * ═══════════════════════════════════════════════════════════════
 *  OASIS VISION — Keyless probes for an email address
 *
 *  Every discriminator below was verified live on 2026-09-19 before a
 *  line of this was written, because guessing one is how you ship a
 *  tool that reports "no account" for every address:
 *
 *    Gravatar   avatar/<md5>?d=404  -> 200 exists, 404 none.   VERIFIED
 *               The `.json` profile endpoint is NOT usable as an
 *               existence check: it answered 200 with an empty body
 *               for a random hash.                             VERIFIED
 *    openpgp    vks/v1/by-email/... -> 200 key, 404 none.      VERIFIED
 *    GitHub     q="<email>" in:email. Unauthenticated search is
 *               capped at 10 requests/minute.                  VERIFIED
 *    Keybase    email lookup is GONE — the API answers
 *               MISSING_PARAMETER. Not implemented here.       VERIFIED
 *
 *  Every probe returns a SourceResult rather than throwing, and a
 *  failure is always a named `failure`, never an empty result. A source
 *  that is down must not be indistinguishable from a source that found
 *  nothing.
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import type { SourceResult, AccountFinding, BreachFinding, NameSignal } from './types';

const UA = 'OASIS-VISION/1.0 (+https://github.com/CC90210/oasis-vision)';

/**
 * Refusals. Reading any of these as "no account" is the single largest
 * source of wrong answers in this class of tool — see the measurement
 * in `src/lib/sherlock.ts`.
 */
const BLOCKED_CODES = new Set([401, 403, 407, 429, 451, 503]);

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { 'User-Agent': UA, Accept: 'application/json', ...extra };
}

/** Gravatar keys on the md5 of the lowercased, trimmed address. */
export function gravatarHash(email: string): string {
  return crypto.createHash('md5').update(email.trim().toLowerCase()).digest('hex');
}

/**
 * Gravatar — does this address have an avatar, and a public profile name?
 *
 * Existence is decided by `?d=404` on the avatar endpoint. The profile
 * JSON is fetched only for a name, and only when the avatar confirmed
 * the account exists.
 */
export async function probeGravatar(email: string, timeoutMs = 7000): Promise<SourceResult> {
  const hash = gravatarHash(email);
  const source = 'Gravatar';

  try {
    const res = await fetch(`https://www.gravatar.com/avatar/${hash}?d=404`, {
      headers: headers({ Accept: 'image/*' }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });

    if (res.status === 404) {
      return {
        source,
        accounts: [{
          platform: 'Gravatar',
          url: null,
          status: 'not_found',
          evidence: 'Avatar endpoint returned 404 with d=404, meaning no Gravatar for this address.',
        }],
      };
    }

    if (BLOCKED_CODES.has(res.status)) {
      return {
        source,
        accounts: [{
          platform: 'Gravatar',
          url: null,
          status: 'blocked',
          evidence: `Gravatar refused the request (HTTP ${res.status}). This is not evidence of absence.`,
        }],
      };
    }

    if (!res.ok) {
      return { source, failure: `Gravatar avatar check returned HTTP ${res.status}` };
    }

    const profileUrl = `https://gravatar.com/${hash}`;
    const accounts: AccountFinding[] = [{
      platform: 'Gravatar',
      url: profileUrl,
      status: 'found',
      evidence: `Avatar endpoint returned HTTP ${res.status} with d=404, so an avatar is registered.`,
    }];

    // Name is a bonus, never a reason to fail the probe.
    const names: NameSignal[] = [];
    try {
      const pr = await fetch(`https://en.gravatar.com/${hash}.json`, {
        headers: headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (pr.ok) {
        const text = await pr.text();
        if (text.trim()) {
          const data = JSON.parse(text) as {
            entry?: Array<{ displayName?: string; name?: { formatted?: string } }>;
          };
          const entry = data.entry?.[0];
          const found = entry?.name?.formatted || entry?.displayName;
          if (found) names.push({ name: found, source, weight: 0.7 });
        }
      }
    } catch (e) {
      console.error('[OASIS] email-intel: Gravatar profile read failed:', e instanceof Error ? e.message : e);
    }

    return { source, accounts, names };
  } catch (e) {
    return { source, failure: e instanceof Error ? e.message : 'Gravatar probe failed' };
  }
}

/**
 * keys.openpgp.org — a published PGP key is a strong identity signal,
 * because publishing one is deliberate.
 */
export async function probePgp(email: string, timeoutMs = 7000): Promise<SourceResult> {
  const source = 'PGP keyserver';
  const url = `https://keys.openpgp.org/vks/v1/by-email/${encodeURIComponent(email)}`;

  try {
    const res = await fetch(url, {
      headers: headers({ Accept: 'application/pgp-keys' }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 404) {
      return {
        source,
        accounts: [{
          platform: 'PGP (keys.openpgp.org)',
          url: null,
          status: 'not_found',
          evidence: 'Keyserver has no verified key for this address (HTTP 404).',
        }],
      };
    }

    if (BLOCKED_CODES.has(res.status)) {
      return {
        source,
        accounts: [{
          platform: 'PGP (keys.openpgp.org)',
          url: null,
          status: 'blocked',
          evidence: `Keyserver refused the request (HTTP ${res.status}).`,
        }],
      };
    }

    if (!res.ok) return { source, failure: `Keyserver returned HTTP ${res.status}` };

    const body = await res.text();
    const names: NameSignal[] = [];
    // A key block carries User ID packets as "Name <email>" in the
    // armored comment headers on this server.
    const uid = body.match(/Comment:\s*([^\n<]+?)\s*<[^>]+>/);
    if (uid?.[1]) names.push({ name: uid[1].trim(), source, weight: 0.9 });

    return {
      source,
      accounts: [{
        platform: 'PGP (keys.openpgp.org)',
        url,
        status: 'found',
        evidence: 'Keyserver returned a verified public key bound to this address.',
      }],
      names,
    };
  } catch (e) {
    return { source, failure: e instanceof Error ? e.message : 'PGP probe failed' };
  }
}

/**
 * GitHub — users who made their address public in their profile.
 *
 * Unauthenticated search is 10 req/min. A 403/429 here is extremely
 * common and means "rate limited", so it is reported as `blocked`.
 */
export async function probeGitHub(email: string, timeoutMs = 8000): Promise<SourceResult> {
  const source = 'GitHub';
  const q = encodeURIComponent(`"${email}" in:email`);
  const url = `https://api.github.com/search/users?q=${q}&per_page=5`;

  try {
    const res = await fetch(url, {
      headers: headers({ Accept: 'application/vnd.github+json' }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (BLOCKED_CODES.has(res.status)) {
      return {
        source,
        accounts: [{
          platform: 'GitHub',
          url: null,
          status: 'blocked',
          evidence:
            `GitHub refused the search (HTTP ${res.status}) — unauthenticated search allows ` +
            `10 requests/minute. Not evidence of absence.`,
        }],
      };
    }

    if (!res.ok) return { source, failure: `GitHub search returned HTTP ${res.status}` };

    const data = (await res.json()) as {
      total_count?: number;
      items?: Array<{ login: string; html_url: string }>;
    };

    if (!data.items?.length) {
      return {
        source,
        accounts: [{
          platform: 'GitHub',
          url: null,
          status: 'not_found',
          evidence: 'No GitHub user exposes this address in their public profile.',
        }],
      };
    }

    // `in:email` searches the profile email FIELD, but GitHub matches
    // loosely and returns users who merely reference the address.
    // Measured 2026-09-19: searching a well-known address returned an
    // unrelated account as the top hit. So this is `inconclusive`, not
    // `found` — the link is a lead for the analyst to check, not proof
    // the account belongs to the subject.
    const single = data.items.length === 1;
    const accounts: AccountFinding[] = data.items.slice(0, 3).map((u) => ({
      platform: 'GitHub',
      url: u.html_url,
      status: 'inconclusive' as const,
      evidence:
        `Profile search matched @${u.login} on "${email}" in:email. GitHub matches profile text, ` +
        `not verified ownership${single ? '' : ` — ${data.items!.length} accounts matched`}. Open the profile to confirm.`,
    }));

    // The display name of a loosely-matched account is a weak signal,
    // and weighting it like a verified source is how a wrong name gets
    // promoted to "probable". Only take it on a single unambiguous
    // match, and even then at a low weight.
    const names: NameSignal[] = [];
    if (single) {
      try {
        const top = data.items[0];
        const ur = await fetch(`https://api.github.com/users/${encodeURIComponent(top.login)}`, {
          headers: headers({ Accept: 'application/vnd.github+json' }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (ur.ok) {
          const u = (await ur.json()) as { name?: string | null };
          if (u.name) names.push({ name: u.name, source, weight: 0.4 });
        }
      } catch (e) {
        console.error('[OASIS] email-intel: GitHub user read failed:', e instanceof Error ? e.message : e);
      }
    }

    return { source, accounts, names };
  } catch (e) {
    return { source, failure: e instanceof Error ? e.message : 'GitHub probe failed' };
  }
}

interface XonExposure { breach?: string; details?: string; xposed_data?: string; xposed_date?: string }

/**
 * XposedOrNot — keyless breach exposure.
 *
 * This replaces the browser-side call the RECON panel used to make
 * straight from the analyst's machine, which leaked the analyst's own
 * IP and the subject's address to a third party with no rate limit.
 */
export async function probeBreaches(email: string, timeoutMs = 15000): Promise<SourceResult> {
  const source = 'XposedOrNot';
  const url = `https://api.xposedornot.com/v1/breach-analytics?email=${encodeURIComponent(email)}`;

  try {
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });

    // The API answers 404 for a clean address — that is a real result.
    if (res.status === 404) return { source, breaches: [] };

    if (BLOCKED_CODES.has(res.status)) {
      return { source, failure: `XposedOrNot refused the request (HTTP ${res.status})` };
    }
    if (!res.ok) return { source, failure: `XposedOrNot returned HTTP ${res.status}` };

    const data = (await res.json()) as {
      ExposedBreaches?: { breaches_details?: XonExposure[] };
      BreachesSummary?: { site?: string };
    };

    const details = data.ExposedBreaches?.breaches_details ?? [];
    if (details.length) {
      const breaches: BreachFinding[] = details.map((b) => ({
        name: b.breach || 'Unknown breach',
        date: b.xposed_date || null,
        classes: (b.xposed_data || '').split(';').map((s) => s.trim()).filter(Boolean),
        source,
      }));
      return { source, breaches };
    }

    // Fall back to the summary list, which carries names but no detail.
    const summary = (data.BreachesSummary?.site || '').split(';').map((s) => s.trim()).filter(Boolean);
    return {
      source,
      breaches: summary.map((name) => ({ name, date: null, classes: [], source })),
    };
  } catch (e) {
    return { source, failure: e instanceof Error ? e.message : 'Breach probe failed' };
  }
}

/**
 * HIBP — Tier 2, requires a paid key. Skipped cleanly when absent
 * rather than failing, so its absence never looks like a dead source.
 */
export async function probeHibp(email: string, timeoutMs = 10000): Promise<SourceResult> {
  const source = 'HaveIBeenPwned';
  const key = process.env.HIBP_API_KEY;
  if (!key) return { source, failure: 'skipped: HIBP_API_KEY not set' };

  const url = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=false`;
  try {
    const res = await fetch(url, {
      headers: headers({ 'hibp-api-key': key }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { source, breaches: [] };
    if (!res.ok) return { source, failure: `HIBP returned HTTP ${res.status}` };

    const data = (await res.json()) as Array<{ Name: string; BreachDate?: string; DataClasses?: string[] }>;
    return {
      source,
      breaches: data.map((b) => ({
        name: b.Name,
        date: b.BreachDate || null,
        classes: b.DataClasses ?? [],
        source,
      })),
    };
  } catch (e) {
    return { source, failure: e instanceof Error ? e.message : 'HIBP probe failed' };
  }
}
