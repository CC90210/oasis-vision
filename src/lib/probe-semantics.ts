/**
 * ═══════════════════════════════════════════════════════════════
 *  OASIS VISION — What an HTTP answer actually means to a probe
 *
 *  Extracted from `sherlock.ts`, which discovered these the expensive
 *  way and then had them copied into `email-intel/sources.ts`. Two
 *  copies of a rule this load-bearing is how one of them drifts.
 *
 *  Any module that decides "does this account exist?" from a status
 *  code imports from here.
 * ═══════════════════════════════════════════════════════════════
 */

/**
 * Codes that mean "we were refused", not "no such account".
 *
 * Measured against Sherlock's own known-good handles: treating these
 * as absence produced 8 of 12 false negatives — the single largest
 * source of wrong answers in this class of tool.
 */
export const BLOCKED_CODES: ReadonlySet<number> = new Set([401, 403, 407, 429, 451, 503]);

/** Interstitials that return 200 while showing no profile data. */
export const CHALLENGE_MARKERS: readonly string[] = [
  'just a moment',
  'attention required',
  'cf-browser-verification',
  'enable javascript and cookies',
  'checking your browser',
  'access denied',
  'unusual traffic',
  'are you a robot',
  'px-captcha',
];

/** Identifies this app on every outbound probe. */
export const PROBE_UA = 'OASIS-VISION/1.0 (+https://github.com/CC90210/oasis-vision)';

export function isBlockedStatus(status: number): boolean {
  return BLOCKED_CODES.has(status);
}

/** True when a 200 body is actually a bot-check interstitial. */
export function looksLikeChallenge(body: string): boolean {
  const lower = body.slice(0, 4000).toLowerCase();
  return CHALLENGE_MARKERS.some((m) => lower.includes(m));
}
