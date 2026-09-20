/**
 * ═══════════════════════════════════════════════════════════════
 *  OASIS VISION — Email investigation orchestrator
 *
 *  Fans out to the keyless probes, merges what comes back, and grades
 *  it. Tier 1: no API key, no Python, no Docker. A fresh clone runs
 *  this.
 *
 *  Two design rules carried from the rest of the codebase:
 *
 *   - A source that fails is NAMED in the ledger. `sources.failed`
 *     is the difference between "this subject has no GitHub" and "we
 *     were rate-limited and never found out".
 *   - Nothing here waits on everything. Probes run concurrently and a
 *     slow one cannot hold the request budget hostage.
 * ═══════════════════════════════════════════════════════════════
 */

import { checkValidity } from './validity';
import { buildConsensus } from './consensus';
import { scoreRisk } from './risk';
import {
  probeGravatar,
  probePgp,
  probeGitHub,
  probeBreaches,
  probeHibp,
} from './sources';
import type {
  EmailInvestigation,
  InvestigationDepth,
  SourceResult,
  AccountFinding,
  BreachFinding,
  NameSignal,
  GeoFinding,
  SourceFailure,
} from './types';

export * from './types';
export { checkValidity } from './validity';
export { buildConsensus, normaliseName, looksLikeName } from './consensus';
export { scoreRisk } from './risk';
export { gravatarHash } from './sources';

/**
 * Which probes run at which depth.
 *
 * `quick` exists so an analyst triaging a list is not forced to pay
 * for the GitHub search, which is capped at 10 requests/minute
 * unauthenticated and is the first thing to rate-limit.
 */
function plan(depth: InvestigationDepth) {
  const base = [
    { name: 'Gravatar', run: probeGravatar },
    { name: 'XposedOrNot', run: probeBreaches },
  ];
  if (depth === 'quick') return base;

  const standard = [...base, { name: 'PGP keyserver', run: probePgp }];
  if (depth === 'standard') return standard;

  return [
    ...standard,
    { name: 'GitHub', run: probeGitHub },
    { name: 'HaveIBeenPwned', run: probeHibp },
  ];
}

/** Dedupe accounts by platform+url, preferring the most informative status. */
function mergeAccounts(all: AccountFinding[]): AccountFinding[] {
  const rank: Record<string, number> = {
    found: 5, blocked: 4, inconclusive: 3, error: 2, not_found: 1, skipped: 0,
  };
  const byKey = new Map<string, AccountFinding>();
  for (const a of all) {
    const key = `${a.platform}::${a.url ?? ''}`;
    const prev = byKey.get(key);
    if (!prev || (rank[a.status] ?? 0) > (rank[prev.status] ?? 0)) byKey.set(key, a);
  }
  return [...byKey.values()].sort(
    (a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0) || a.platform.localeCompare(b.platform),
  );
}

/** Dedupe breaches by normalised name, keeping the richest record. */
function mergeBreaches(all: BreachFinding[]): BreachFinding[] {
  const byName = new Map<string, BreachFinding>();
  for (const b of all) {
    const key = b.name.trim().toLowerCase();
    const prev = byName.get(key);
    if (!prev || b.classes.length > prev.classes.length) byName.set(key, b);
  }
  return [...byName.values()].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
}

export async function investigateEmail(
  email: string,
  depth: InvestigationDepth = 'standard',
): Promise<EmailInvestigation> {
  const timestamp = new Date().toISOString();
  const validity = await checkValidity(email);

  // A malformed address has nothing to investigate. Returning early is
  // honest; fanning out to a dozen upstreams with garbage is not.
  if (!validity.syntaxValid) {
    return {
      email,
      timestamp,
      depth,
      validity,
      identity: {
        name: null,
        confidence: 'unknown',
        sources: [],
        reasoning: 'Address does not parse, so no source was queried.',
        candidates: [],
      },
      accounts: [],
      breaches: [],
      risk: {
        score: 0,
        band: 'minimal',
        drivers: [],
        nextAction: 'Correct the address and re-run.',
      },
      geo: [],
      sources: { queried: 0, answered: 0, failed: [], skipped: [] },
    };
  }

  const probes = plan(depth);

  // allSettled, not all: one probe throwing must not void the others.
  const settled = await Promise.allSettled(probes.map((p) => p.run(email)));

  const results: SourceResult[] = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          source: probes[i].name,
          failure: s.reason instanceof Error ? s.reason.message : 'probe rejected',
        },
  );

  const accounts: AccountFinding[] = [];
  const breaches: BreachFinding[] = [];
  const names: NameSignal[] = [];
  const geo: GeoFinding[] = [];
  const failed: SourceFailure[] = [];
  const skipped: SourceFailure[] = [];
  let answered = 0;

  for (const r of results) {
    if (r.failure) {
      // "skipped:" is the agreed prefix for a deliberate no-run (no
      // API key). It is not a failure and must not be reported as one.
      if (r.failure.startsWith('skipped:')) {
        skipped.push({ name: r.source, reason: r.failure.slice('skipped:'.length).trim() });
      } else {
        console.error(`[OASIS] email-intel: ${r.source} failed: ${r.failure}`);
        failed.push({ name: r.source, reason: r.failure });
      }
      continue;
    }
    answered++;
    if (r.accounts) accounts.push(...r.accounts);
    if (r.breaches) breaches.push(...r.breaches);
    if (r.names) names.push(...r.names);
    if (r.geo) geo.push(...r.geo);
  }

  const mergedAccounts = mergeAccounts(accounts);
  const mergedBreaches = mergeBreaches(breaches);

  return {
    email,
    timestamp,
    depth,
    validity,
    identity: buildConsensus(names),
    accounts: mergedAccounts,
    breaches: mergedBreaches,
    risk: scoreRisk({ breaches: mergedBreaches, accounts: mergedAccounts, validity }),
    geo,
    sources: { queried: probes.length, answered, failed, skipped },
  };
}
