/**
 * ═══════════════════════════════════════════════════════════════
 *  OASIS VISION — Email investigation, shared types
 *
 *  Every shape here is built to make an honest answer easier to
 *  express than a confident one. The recurring defect in this
 *  codebase is confident nonsense, and an email investigation is a
 *  machine for producing it: dozens of weak signals that look like
 *  proof once they are stacked in a list.
 *
 *  So: a probe reports WHY, not just WHAT. A name carries the count
 *  of independent sources that agreed. A failed upstream is a named
 *  failure, never an empty array.
 * ═══════════════════════════════════════════════════════════════
 */

/**
 * The outcome of a single probe.
 *
 * `blocked` exists because HTTP 401/403/429/451/503 mean "we were
 * refused", not "no such account". `src/lib/sherlock.ts` learned this
 * the expensive way — conflating the two produced 8 of 12 false
 * negatives against known-good handles.
 */
export type ProbeStatus =
  | 'found'
  | 'not_found'
  | 'blocked'
  | 'inconclusive'
  | 'error'
  | 'skipped';

/** How much of the subject's name we are willing to claim. */
export type NameConfidence = 'confirmed' | 'probable' | 'possible' | 'unknown';

/** Deliverability verdict for the address itself. */
export type DeliverabilityStatus =
  | 'deliverable'
  | 'undeliverable'
  | 'risky'
  | 'unknown';

export interface AccountFinding {
  /** Human-readable service name, e.g. "GitHub". */
  platform: string;
  /** Profile URL when we have one. Null when the source gives no link. */
  url: string | null;
  status: ProbeStatus;
  /**
   * Why we concluded this, in one clause. Rendered to the analyst.
   * "HTTP 200 on avatar?d=404" beats a bare green tick.
   */
  evidence: string;
}

/** One name observation from one source, before consensus. */
export interface NameSignal {
  name: string;
  source: string;
  /** 0..1 — how much this source's naming is worth on its own. */
  weight: number;
}

export interface IdentitySummary {
  name: string | null;
  confidence: NameConfidence;
  /** The distinct sources that agreed on the reported name. */
  sources: string[];
  /** Plain sentence an analyst can paste into a report. */
  reasoning: string;
  /** Every candidate seen, including the ones that lost. */
  candidates: Array<{ name: string; sources: string[]; score: number }>;
}

export interface BreachFinding {
  name: string;
  date: string | null;
  /** Data classes exposed, e.g. ["Passwords", "Email addresses"]. */
  classes: string[];
  source: string;
}

export interface ValidityReport {
  syntaxValid: boolean;
  domain: string;
  localPart: string;
  /** MX hosts in priority order. Empty with mxChecked=true means no MX. */
  mx: string[];
  mxChecked: boolean;
  disposable: boolean;
  roleAccount: boolean;
  freeProvider: boolean;
  status: DeliverabilityStatus;
  /** Why `status` is what it is. */
  reasoning: string;
}

export interface RiskReport {
  /** 0-100. Higher is worse. */
  score: number;
  band: 'critical' | 'high' | 'moderate' | 'low' | 'minimal';
  /** Named contributors, largest first. Never an unexplained number. */
  drivers: string[];
  /** One concrete thing to do next. */
  nextAction: string;
}

/**
 * A finding that carries coordinates.
 *
 * This is the reason OASIS VISION is a better home for these tools than
 * a CLI: the console already renders a globe, so evidence with a
 * position becomes a pin instead of a table row. `provenance` is
 * mandatory — a pin whose origin is unknown is worse than no pin.
 */
export interface GeoFinding {
  lat: number;
  lng: number;
  label: string;
  provenance: string;
  kind: 'exif' | 'wifi' | 'infrastructure' | 'registration' | 'organisation';
}

/** A source we asked that did not answer, and why. */
export interface SourceFailure {
  name: string;
  reason: string;
}

export interface SourceLedger {
  queried: number;
  answered: number;
  failed: SourceFailure[];
  /** Sources deliberately not run (missing key, depth setting). */
  skipped: SourceFailure[];
}

export interface EmailInvestigation {
  email: string;
  timestamp: string;
  depth: InvestigationDepth;
  validity: ValidityReport;
  identity: IdentitySummary;
  accounts: AccountFinding[];
  breaches: BreachFinding[];
  risk: RiskReport;
  geo: GeoFinding[];
  sources: SourceLedger;
}

export type InvestigationDepth = 'quick' | 'standard' | 'deep';

/** Result of one source module, before the orchestrator merges it. */
export interface SourceResult {
  source: string;
  accounts?: AccountFinding[];
  names?: NameSignal[];
  breaches?: BreachFinding[];
  geo?: GeoFinding[];
  /** Set when the source could not answer. */
  failure?: string;
}
