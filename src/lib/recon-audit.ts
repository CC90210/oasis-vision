/**
 * ═══════════════════════════════════════════════════════════════
 *  OASIS VISION — RECON audit ledger
 *
 *  Every subject-identifying query gets one line in
 *  `runs/recon-audit.jsonl`. This is what makes the identity tooling
 *  defensible rather than merely capable: if someone asks what this
 *  console was used to look up and on whose authority, there is an
 *  answer.
 *
 *  Its own file, deliberately. `runs/ledger.jsonl` already belongs to
 *  the forecast engine, and interleaving two subsystems in one
 *  append-only log makes both harder to read and impossible to rotate
 *  or hand to an auditor independently.
 *
 *  The subject is stored as a SHA-256 hash, never in clear. That is
 *  deliberate and it costs something real: you cannot read the ledger
 *  to find out who was investigated. You CAN confirm whether a
 *  specific address was investigated, by hashing it and searching —
 *  which is the question an audit actually needs to answer, without
 *  the ledger itself becoming a store of personal data.
 *
 *  Writes are append-only, best-effort, and never block or fail a
 *  request the analyst is authorised to make.
 * ═══════════════════════════════════════════════════════════════
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface ReconQuery {
  /** Tool id as the panel knows it, e.g. 'email', 'exif'. */
  tool: string;
  /** The raw subject. Hashed before it touches disk. */
  subject: string;
  /** Declared purpose from the authorisation gate. */
  purpose: string;
  /** 1 native, 2 keyed, 3 sidecar. */
  tier: 1 | 2 | 3;
}

export interface LedgerEntry {
  ts: string;
  tool: string;
  subject_sha256: string;
  /** Kept so a human can sanity-check a match without storing the value. */
  subject_hint: string;
  purpose: string;
  tier: number;
}

const LEDGER_DIR = 'runs';
const LEDGER_FILE = 'recon-audit.jsonl';

/**
 * The server executes out of `.next/standalone`, so `process.cwd()` is
 * the bundle directory, not the repo. OASIS_AUDIT_DIR overrides the
 * location so the audit trail can be pointed somewhere that survives a
 * rebuild — `sync-standalone` replaces that directory wholesale.
 */
function ledgerDir(): string {
  return process.env.OASIS_AUDIT_DIR || path.join(process.cwd(), LEDGER_DIR);
}

export function hashSubject(subject: string): string {
  return crypto.createHash('sha256').update(subject.trim().toLowerCase()).digest('hex');
}

/**
 * A non-reversing hint: first character and the domain for an address,
 * first two characters otherwise. Enough for a human reading the
 * ledger to recognise a match they already suspect, not enough to
 * enumerate subjects from the file.
 */
export function subjectHint(subject: string): string {
  const s = subject.trim();
  const at = s.lastIndexOf('@');
  if (at > 0) return `${s[0]}***@${s.slice(at + 1)}`;
  if (s.length <= 2) return '**';
  return `${s.slice(0, 2)}***`;
}

export function buildEntry(q: ReconQuery, now: Date): LedgerEntry {
  return {
    ts: now.toISOString(),
    tool: q.tool,
    subject_sha256: hashSubject(q.subject),
    subject_hint: subjectHint(q.subject),
    purpose: q.purpose || 'unspecified',
    tier: q.tier,
  };
}

/**
 * Append one line. Synchronous on purpose: the write is tiny, and an
 * async fire-and-forget would let the process exit between the call and
 * the flush, silently losing exactly the record an audit needs.
 */
export function recordReconQuery(q: ReconQuery, now: Date = new Date()): void {
  try {
    const dir = ledgerDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, LEDGER_FILE),
      `${JSON.stringify(buildEntry(q, now))}\n`,
      'utf8',
    );
  } catch (e) {
    // Logged, never thrown. Losing an audit line must not deny a
    // legitimate result — but it must be visible that it happened.
    console.error('[OASIS] recon-audit: ledger write failed:', e instanceof Error ? e.message : e);
  }
}
