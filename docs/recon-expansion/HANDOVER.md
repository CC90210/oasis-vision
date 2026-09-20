# HANDOVER — RECON Expansion

**For:** the AI/engineer implementing this.
**From:** Bravo, 2026-09-19.
**Read [PLAN.md](PLAN.md) first** — it carries the research, the licence findings and the
reasoning. This document is *how to execute*.

---

## 0. Start here

```bash
cd ~/APPS/osiris            # Windows: C:\Users\User\APPS\osiris
git log --oneline -1        # expect 696ea08
git status                  # expect clean
git worktree list           # expect one entry
```

**Baseline is `main` @ `696ea08`, clean.** Verified 2026-09-19.

**There is no prior work to resume.** A previous session (Kimi Code) is believed to
have started this task. It left **nothing on disk** — no branch, no worktree, no
stash, no untracked file. A filesystem search for `mailaccess|torbot|horus` across
`APPS/` and `Business-Empire-Agent/` returned only browser-cache blobs. Every
`src/` file dates 2026-09-03 → 09-07. **Start from clean `main`. Do not go looking
for half-finished code; there isn't any.**

Work on a branch:

```bash
git checkout -b feat/recon-email-identity
```

---

## 1. Non-negotiables you are inheriting

From `CLAUDE.md` in this repo. These are not style preferences — each one is a bug
that already shipped here.

1. **Never label a feed as more than it is.** An inferred email is `unverified`
   forever. A `403` is `blocked`, not `not_found`. A one-source name is `possible`,
   not `confirmed`. This codebase's named recurring defect is confident nonsense;
   every tool in this plan is a machine for producing it.
2. **A silent catch hides a dead source.** No `catch { return [] }`. Log the source
   name and the failure. Every module prints its count line.
3. **Verify a source before building on it.** Fetch it, count the records, check the
   field casing. An earlier bug here was a capital letter (`Latitude` vs `latitude`).
4. **Test the mapping, not the network.** Every new lib module gets a `.test.ts`
   beside it with a real trimmed record. Follow `src/lib/sherlock.ts` +
   `src/lib/*.test.ts`.

**Read `src/lib/sherlock.ts` (405 lines) before writing any probe code.** It is the
reference implementation for exactly this class of work and it already solved the
false-negative problem you are about to hit.

### Gates — all three must pass before you claim anything is done

```bash
npx tsc --noEmit      # must be clean
npx vitest run        # 575 tests, must pass
npm run build         # must exit 0
```

`npm run lint` OOMs at 8 GB. Known upstream problem, not yours. `tsc` is the gate.

**Stop the server before rebuilding.** It runs out of `.next/standalone`; rebuilding
under it fails on Windows (EBUSY) and silently serves stale code on macOS. Use
`launcher/rebuild.cmd` / `rebuild.sh`, never a bare `npm run build`.

---

## 2. Do NOT do these

- **Do not copy source from `6abd/horus` or `DedSecInside/TorBot`.** Both are
  **GPL-3.0**. This repo is MIT-derived and ships as a desktop app. Reimplement
  natively against the same public APIs (Horus) or run out-of-process (TorBot).
  Details in PLAN.md §3.
- **Do not vendor MailAccess data files yet.** It declares MIT in `pyproject.toml`
  but **has no `LICENSE` file** and GitHub reports `license: null`. Ask the
  maintainer first. Code you write yourself is unaffected — this blocks only the
  bundled corpora.
- **Do not add a mandatory Python or Docker dependency to Tier 1.** `npm install &&
  npm run build` must still produce a working email investigation.
- **Do not copy the `/api/scanner` pattern.** A configured-or-503 route behind a
  normal-looking input box is why 6 tools are currently dead. Gate in the UI.
- **Do not call third-party APIs from the browser.** Two tools already do
  (`OsintPanel.tsx:261`, `:272`); Phase 0 removes them. Do not add a third.
- **Do not refactor `OsintPanel.tsx` beyond what these tasks need.** It is 1,815
  lines. Surgical changes only.

---

## 3. Phase 0 — repair first (~45 min)

Independently valuable, proves the seams, and ships even if everything else slips.

### 3.1 Route the two browser-side calls through their own server routes

`src/components/OsintPanel.tsx`:

```ts
// :261  before
case 'leaks': url = `https://api.xposedornot.com/v1/breach-analytics?email=${encodeURIComponent(query)}`; break;
// after
case 'leaks': url = `/api/osint/leaks?email=${encodeURIComponent(query)}`; break;

// :272  before
case 'shodan': url = `https://internetdb.shodan.io/${encodeURIComponent(query)}`; break;
// after
case 'shodan': url = `/api/osint/shodan?ip=${encodeURIComponent(query)}`; break;
```

Both routes already exist and are hardened. **Check the response shape** — the panel's
render path was written against the upstream JSON, and `/api/osint/leaks` normalises
to `{ email, breached, breaches[], data_exposed[] }`. Adjust the renderer, and add a
`.test.ts` fixing the shape so this cannot silently regress.

### 3.2 Badge unavailable tools

Add `tier` and an availability probe to the tool registry (`OsintPanel.tsx:44-67`).
The six `/api/scanner` tools (`scanner`, `vuln`, `ssl`, `subdomains`, `headers`,
`tech`) render greyed with `SCANNER OFFLINE` until `/api/scanner` answers something
other than 503. The analyst learns this **before** typing, not after.

### 3.3 Resolve `sanctions`

`/api/osint/sanctions` works and is referenced only by `src/app/docs/apiCatalog.ts`.
The README advertises OFAC sanctions as a shipped RECON capability. Either add the
tool to the `threat` group (preferred — it works) or correct the README. Do not
leave the claim standing with no tool behind it.

**Gate:** `tsc` clean · `vitest` green · no `https://` literal remains in
`OsintPanel.tsx`'s URL switch · the six scanner tools visibly badged.

---

## 4. Phase 1 — Tier-1 email investigation (~3 h)

The flagship. Keyless, native TypeScript, always works.

### 4.1 New files

```
src/lib/email-intel/
  index.ts            orchestrator — bounded fan-out, per-source timeouts
  index.test.ts
  validity.ts         syntax, MX, disposable, role-account, catch-all
  validity.test.ts
  consensus.ts        Name Consensus — confirmed/probable/possible/unknown
  consensus.test.ts
  patterns.ts         company email pattern inference
  patterns.test.ts
  accounts.ts         account existence probes (reuse sherlock.ts rules)
  accounts.test.ts
  risk.ts             Credential Risk Score 0-100 + named drivers
  risk.test.ts
  types.ts            shared result shapes
src/app/api/osint/email/route.ts
```

### 4.2 Route contract

`GET /api/osint/email?email=<addr>&depth=<quick|standard|deep>`

```ts
{
  email: string,
  timestamp: string,
  identity: {
    name: string | null,
    confidence: 'confirmed' | 'probable' | 'possible' | 'unknown',
    sources: string[],          // the independent sources that agreed
    reasoning: string           // "4 independent sources agree"
  },
  accounts: Array<{
    platform: string,
    url: string | null,
    status: 'found' | 'not_found' | 'blocked' | 'inconclusive' | 'error',
    evidence: string            // WHY we concluded this
  }>,
  breaches: Array<{ name: string, date: string | null, classes: string[] }>,
  risk: { score: number, band: string, drivers: string[], nextAction: string },
  geo: Array<{ lat: number, lng: number, label: string, provenance: string }>,
  sources: { queried: number, answered: number, failed: Array<{name, reason}> }
}
```

Three things this contract enforces, on purpose:

- **`evidence` per account** — not a bare boolean. The codebase's recurring defect is
  unexplained confidence.
- **`sources.failed` with reasons** — a dead upstream must be visible, per
  non-negotiable #2. Never let a failure look like an absence.
- **`geo[]` with `provenance`** — feeds the map, and every pin says where it came from.

### 4.3 Route conventions — match the house style

Copy the shape of `src/app/api/osint/username/route.ts`:

```ts
import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';

export const maxDuration = 60;

// Email investigation fans out to dozens of upstreams — use the stricter
// budget the username route uses, not the default 20.
if (isRateLimited(getClientIp(req), 6, 60_000)) {
  return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
}
```

Log with the existing prefix: `console.error('[OASIS] email investigation failed:', e)`.

### 4.4 Inherit the false-negative fixes

From `src/lib/sherlock.ts` — do not re-derive these:

```ts
// 401/403/407/429/451/503 mean "we were refused", NOT "no account".
// Treating these as absence produced 8 of 12 false negatives upstream.
const BLOCKED_CODES = new Set([401, 403, 407, 429, 451, 503]);

// 200 responses that are actually interstitials
const CHALLENGE_MARKERS = ['just a moment', 'attention required', /* ... */];
```

Also copy its caching posture: TTL cache with **stale-beats-nothing** on fetch
failure (`sherlock.ts:103-141`).

### 4.5 Panel integration

Add to the tool registry (`OsintPanel.tsx:44-67`), group `identity`:

```ts
{ id: 'email', label: 'EMAIL INVESTIGATION', icon: Mail,
  placeholder: 'Email address to investigate', color: '#00E676',
  group: 'identity', blurb: 'Identity, accounts, breaches and risk' },
```

Add the switch case, then build a **sectioned report renderer** — identity →
accounts → breaches → risk → map. Not a JSON dump. Follow the existing
`SectionHeader` pattern (`OsintPanel.tsx:635`).

**Gate:** keyless investigation returns graded findings · every account carries
`evidence` · a killed upstream shows in `sources.failed` · no finding claims
`confirmed` on one source.

---

## 5. Phase 2 — forensics group (~1 h)

New group `forensics` in `OsintPanel.tsx:23-27`.

| Tool | Tier | Implementation |
|---|---|---|
| `exif` | 1 | Parse client-side or in-route; surface GPS, camera, timestamps. **GPS → map pin** |
| `bin` | 1 | BIN → issuer, brand, country, type |
| `wigle` | 2 | wigle.net API, key required, badged when absent |
| `virustotal` | 2 | VT API v3, key required, badged when absent |

Write all four natively. **Do not read Horus's source** — they are thin wrappers over
public APIs and the repo is GPL-3.0.

**Gate:** an image with GPS EXIF produces a map pin carrying its provenance ·
keyless tools work · keyed tools badged before selection, never after.

---

## 6. Phases 3–5

Specified in PLAN.md §8. Do not start them until 0–2 pass their gates.

- **Phase 3 — map projection.** Extend the existing `onScanGeolocate` contract
  (`OsintPanel.tsx:70`). Do not invent a second map channel.
- **Phase 4 — lawful-use layer.** Purpose gate, `runs/ledger.jsonl` audit with
  **hashed** subjects, retention rules. PLAN.md §7.
- **Phase 5 — Tier-3 sidecars.** MailAccess and TorBot as containers, health-gated,
  opt-in. Sidecar-down must be a stated panel state, never a spinner.

---

## 7. Reference — what is already there

Do not rebuild these.

| Path | What |
|---|---|
| `src/lib/sherlock.ts` | Username enumeration, 481 sites. **The pattern to follow** |
| `src/lib/ssrf-guard.ts` | `validateHost`, `safeFetch`, `isRateLimited`, `getClientIp`, `parseIPv4` |
| `src/lib/httpJson.ts` | JSON fetch helper |
| `src/lib/sourceCache.ts` | 30-min TTL, stale-on-error, `peekSource` |
| `src/app/api/osint/*` | 17 routes: bgp, certs, crypto, cve, dns, github, hudsonrock, ip, leaks, mac, phone, sanctions, shodan, sweep, threats, username, whois |
| `src/components/OsintPanel.tsx` | RECON panel, 1,815 lines, 22 tools, 5 groups |
| `src/app/page.tsx:1356` | Right-rail RECON button (`showIntel`) |
| `src/app/page.tsx:1655` | Mobile RECON panel |
| `src/app/docs/apiCatalog.ts` | API catalogue — **add new routes here** |
| `runs/ledger.jsonl` | Existing audit-trail file. Reuse for Phase 4 |

---

## 8. Definition of done

Per `CLAUDE.md`: the gate passed and its output is in the report. Anything else is
"in progress", and you say so.

Report back in four lines:

- **Changed:** paths.
- **Why:** one plain sentence per change.
- **Proof:** the command and its **actual** output — `tsc`, `vitest`, `build`.
- **Needs from CC:** specific asks, or "nothing."

Then get an independent review. Do not self-certify a change this size — this
touches a 1,815-line component and adds a subject-identifying capability.

---

## 9. Open questions — do not block on these

Phases 0–2 need none of them answered. From PLAN.md §10:

1. Will OASIS VISION ever be distributed outside CC's machines? *(the only question
   that makes the GPL analysis urgent)*
2. Are the Tier-3 sidecars wanted at all?
3. Provision WiGLE / VirusTotal / HIBP free-tier keys now, or ship Tier 1 first?
4. Does investigation output ever feed OASIS outreach? *(CASL + Law 25 change the
   retention design)*
5. Where did the earlier Kimi Code session's work go? Nothing is in this repo.
