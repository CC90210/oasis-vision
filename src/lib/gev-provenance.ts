import type { CacheAge } from '@/lib/gev-cache';

/**
 * OASIS VISION — provenance for the God's Eye View proxy routes.
 *
 * The rule that a cached answer must never present as live is not negotiable.
 * Where it LIVES is negotiable, and the body turned out to be the wrong place:
 * every one of these endpoints feeds a vendored client that parses the raw
 * upstream shape, so a `provenance` field in the body is not honesty, it is a
 * parse failure. The same claim rides in headers instead, where it is
 * readable by an operator, by curl, and by any consumer that wants it, and
 * invisible to a parser that does not.
 *
 * `X-Oasis-Age`        fresh | cached | stale — never omitted.
 * `X-Oasis-Fetched-At` epoch ms of the upstream fetch this answer came from.
 * `X-Oasis-Source`     the upstream and its licence, where one is owed.
 *
 * `Access-Control-Expose-Headers` is set because a cross-origin reader cannot
 * see custom headers without it; the globe is same-origin today, but a
 * provenance header nobody can read is the same lie in a different place.
 */
/**
 * Header values are ByteStrings. A single code point above 255 — an em dash
 * in a source credit, an accent in a place name — makes `new Response()`
 * throw, which surfaces as the route 502ing for a reason that looks nothing
 * like the cause. Provenance must never be the thing that breaks a response,
 * so every value is folded to ASCII here rather than trusted.
 */
function asciiSafe(value: string): string {
  return value
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, '?');
}

export function provenanceHeaders(p: {
  age: CacheAge;
  fetchedAt?: number;
  source?: string;
  extra?: Record<string, string>;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Oasis-Age': p.age,
    ...(p.extra ?? {}),
  };
  if (Number.isFinite(p.fetchedAt)) headers['X-Oasis-Fetched-At'] = String(p.fetchedAt);
  if (p.source) headers['X-Oasis-Source'] = p.source;

  for (const [k, v] of Object.entries(headers)) headers[k] = asciiSafe(String(v));

  headers['Access-Control-Expose-Headers'] = Object.keys(headers).join(', ');
  return headers;
}
