/**
 * ═══════════════════════════════════════════════════════════════
 *  OASIS VISION — Credential exposure score
 *
 *  A 0-100 number is exactly the kind of output that invites false
 *  confidence, so two rules apply:
 *
 *   1. Every point is attributable. `drivers` names what produced the
 *      score, largest contributor first. A score with no drivers is a
 *      bug.
 *   2. Absence of evidence never lowers the score below `unknown`.
 *      A clean result on a blocked probe is not a clean subject.
 * ═══════════════════════════════════════════════════════════════
 */

import type { RiskReport, BreachFinding, AccountFinding, ValidityReport } from './types';

/** Data classes that mean a credential is in the wild. */
const CREDENTIAL_CLASSES = [
  'password', 'passwords', 'credential', 'credentials',
  'security question', 'security questions', 'auth token', 'private key',
];

/** Classes that support identity theft rather than account takeover. */
const SENSITIVE_CLASSES = [
  'social security', 'ssn', 'passport', 'bank account', 'credit card',
  'payment', 'government issued id', 'date of birth', 'physical address',
  'phone number',
];

function hasClass(classes: string[], needles: string[]): boolean {
  const lower = classes.map((c) => c.toLowerCase());
  return needles.some((n) => lower.some((c) => c.includes(n)));
}

function bandFor(score: number): RiskReport['band'] {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 35) return 'moderate';
  if (score >= 15) return 'low';
  return 'minimal';
}

export function scoreRisk(input: {
  breaches: BreachFinding[];
  accounts: AccountFinding[];
  validity: ValidityReport;
}): RiskReport {
  const { breaches, accounts, validity } = input;
  const drivers: Array<{ text: string; weight: number }> = [];
  let score = 0;

  const credentialBreaches = breaches.filter((b) => hasClass(b.classes, CREDENTIAL_CLASSES));
  const sensitiveBreaches = breaches.filter((b) => hasClass(b.classes, SENSITIVE_CLASSES));

  if (credentialBreaches.length) {
    // Credentials in the wild dominate everything else.
    const pts = Math.min(50, 25 + (credentialBreaches.length - 1) * 8);
    score += pts;
    drivers.push({
      text: `${credentialBreaches.length} breach${credentialBreaches.length > 1 ? 'es' : ''} exposed passwords or credentials (${credentialBreaches.map((b) => b.name).slice(0, 3).join(', ')})`,
      weight: pts,
    });
  }

  if (sensitiveBreaches.length) {
    const pts = Math.min(20, 10 + (sensitiveBreaches.length - 1) * 4);
    score += pts;
    drivers.push({
      text: `${sensitiveBreaches.length} breach${sensitiveBreaches.length > 1 ? 'es' : ''} exposed identity documents or financial data`,
      weight: pts,
    });
  }

  const otherBreaches = breaches.length - credentialBreaches.length - sensitiveBreaches.length;
  if (otherBreaches > 0) {
    const pts = Math.min(12, otherBreaches * 3);
    score += pts;
    drivers.push({ text: `${otherBreaches} further breach record${otherBreaches > 1 ? 's' : ''}`, weight: pts });
  }

  const found = accounts.filter((a) => a.status === 'found');
  if (found.length >= 3) {
    const pts = Math.min(15, found.length * 3);
    score += pts;
    drivers.push({
      text: `Address is publicly linked to ${found.length} services, widening the attack surface`,
      weight: pts,
    });
  }

  if (validity.roleAccount) {
    score += 8;
    drivers.push({ text: 'Shared role mailbox — compromise affects everyone behind it', weight: 8 });
  }

  if (validity.disposable) {
    score += 5;
    drivers.push({ text: 'Disposable provider — ownership cannot be established', weight: 5 });
  }

  // A blocked probe is uncertainty, not safety. It cannot raise the
  // score (we found nothing), but it must stop a clean-looking result
  // being read as an all-clear.
  const blocked = accounts.filter((a) => a.status === 'blocked');
  if (blocked.length) {
    drivers.push({
      text: `${blocked.length} source${blocked.length > 1 ? 's' : ''} refused to answer — coverage is incomplete`,
      weight: 0,
    });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const band = bandFor(score);

  let nextAction: string;
  if (credentialBreaches.length) {
    nextAction = 'Rotate the password for this address everywhere it is reused, and enforce MFA.';
  } else if (sensitiveBreaches.length) {
    nextAction = 'Warn the owner that identity documents were exposed and advise a credit freeze.';
  } else if (breaches.length) {
    nextAction = 'Confirm the address is not reused on critical systems, then monitor.';
  } else if (blocked.length) {
    nextAction = `Re-run when rate limits clear — ${blocked.length} source(s) never answered.`;
  } else if (found.length) {
    nextAction = 'No breach exposure found. Review the linked public profiles for over-sharing.';
  } else {
    nextAction = 'Nothing actionable surfaced from the keyless sources.';
  }

  return {
    score,
    band,
    drivers: drivers.sort((a, b) => b.weight - a.weight).map((d) => d.text),
    nextAction,
  };
}
