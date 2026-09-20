import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';
import { investigateEmail } from '@/lib/email-intel';
import { splitAddress } from '@/lib/email-intel/validity';
import { recordReconQuery } from '@/lib/recon-audit';
import type { InvestigationDepth } from '@/lib/email-intel/types';

/**
 * OASIS VISION — Email investigation.
 *
 * Tier 1: keyless. Fans out to Gravatar, XposedOrNot, keys.openpgp.org
 * and (at depth=deep) the GitHub user search, then grades what comes
 * back into one identity claim, a breach list and a risk score.
 *
 *   ?email=   address to investigate (required)
 *   ?depth=   quick | standard | deep   (default: standard)
 *
 * Every subject-identifying query is written to the audit ledger with
 * the address HASHED, never in clear.
 */

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const DEPTHS = new Set<InvestigationDepth>(['quick', 'standard', 'deep']);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const email = (searchParams.get('email') || '').trim();

  if (!email) {
    return NextResponse.json({ error: 'Missing email parameter' }, { status: 400 });
  }
  if (email.length > 254) {
    return NextResponse.json({ error: 'Address exceeds the 254-character maximum' }, { status: 400 });
  }
  if (!splitAddress(email)) {
    return NextResponse.json(
      { error: 'Not a valid email address', detail: 'Expected local@domain.tld' },
      { status: 400 },
    );
  }

  // One investigation fans out to several upstreams, so this uses the
  // stricter budget the username route uses rather than the default 20.
  if (isRateLimited(getClientIp(req), 6, 60_000)) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', detail: 'Maximum 6 investigations per minute.' },
      { status: 429 },
    );
  }

  const depthParam = (searchParams.get('depth') || 'standard') as InvestigationDepth;
  const depth = DEPTHS.has(depthParam) ? depthParam : 'standard';
  const purpose = searchParams.get('purpose') || 'unspecified';

  try {
    const result = await investigateEmail(email, depth);

    // Audit is best-effort: a ledger write failure is logged but must
    // not deny the analyst a result they are authorised to have.
    recordReconQuery({ tool: 'email', subject: email, purpose, tier: 1 });

    return NextResponse.json(result, {
      headers: {
        // Subject data. Never cached by a shared proxy.
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (e) {
    console.error('[OASIS] email investigation failed:', e);
    return NextResponse.json(
      { error: 'Investigation failed', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 502 },
    );
  }
}
