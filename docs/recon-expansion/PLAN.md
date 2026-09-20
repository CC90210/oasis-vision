# RECON Expansion — Email-to-Identity, Forensics, Dark Web

**Status:** Plan. Nothing implemented.
**Author:** Bravo, 2026-09-19.
**Baseline:** `main` @ `696ea08`, clean tree, no worktrees, no stashes.
**Audience:** the engineer/AI who implements this. Execution steps are in [HANDOVER.md](HANDOVER.md).

---

## 1. What this is

Fold three public OSINT projects into the RECON toolkit so an analyst can type an
email address and get back a structured identity picture — and, where the evidence
carries coordinates, see it on the globe.

| Repo | Licence | Stars | What it actually gives us |
|---|---|---|---|
| [KatrielMoses/MailAccess](https://github.com/KatrielMoses/MailAccess) | MIT *(declared, unverified — see §3)* | 1,410 | Email → identity graph. 60+ modules, breach aggregation, company email patterns |
| [6abd/horus](https://github.com/6abd/horus) | **GPL-3.0** | 947 | ~4 net-new capabilities. The rest duplicates what we have |
| [DedSecInside/TorBot](https://github.com/DedSecInside/TorBot) | **GPL-3.0** | 4,904 | `.onion` crawling, versioned JSON crawl schemas |

The headline is MailAccess. Horus contributes a narrow but genuinely map-native
slice. TorBot is a specialist tool that should stay at arm's length.

---

## 2. Verified baseline — what RECON is today

Measured against the running code, not the README.

`src/components/OsintPanel.tsx` (1,815 lines) registers **22 tools in 5 groups**
(`network`, `domain`, `identity`, `threat`, `chain`). It mounts from the
right-hand rail at `src/app/page.tsx:1356` (`showIntel`) and on mobile via
`mobilePanel === 'recon'` (`page.tsx:1655`).

`src/app/api/osint/` holds **17 routes**; `/api/scanner` is a shared 18th.

### 2.1 The audit — 6 of 22 tools are dead, 2 more are wired wrong

This is the "out of date or nonfunctional" CC noticed. It is worse than it looks
from the UI, because nothing in the panel says a tool is unavailable until you run it.

**Dead by configuration (6 tools).** `scanner`, `vuln`, `ssl`, `subdomains`,
`headers`, `tech` all call `/api/scanner`, which returns **503** unless
`SCANNER_URL` + `SCANNER_KEY` point at a scanner backend **that does not ship with
this repo**. `CLAUDE.md` already concedes this under Known gaps; `docs/DocsClient.tsx:403`
calls it "by design". Design or not, that is 27% of the toolkit presenting a live
input box over a guaranteed error.

**Calling third parties straight from the browser (2 tools).**

| Tool | `OsintPanel.tsx` | Consequence |
|---|---|---|
| `leaks` | `:261` → `https://api.xposedornot.com/...` | Analyst's own IP and the target address go direct to a third party. No rate limit, no timeout, no error normalisation. CORS-dependent |
| `shodan` | `:272` → `https://internetdb.shodan.io/...` | Same |

Both already have hardened server routes — `/api/osint/leaks` and
`/api/osint/shodan` — which the panel never calls.

**Orphaned routes (3).** `osint/leaks`, `osint/shodan`, `osint/sanctions` are
referenced **only** by `src/app/docs/apiCatalog.ts`. `sanctions` has no UI tool at
all, while the README advertises "OFAC sanctions" as a shipped RECON capability.

> Fixing `leaks` is not scope creep. MailAccess **supersedes** it — the replacement
> is the integration. Do it in the same pass.

### 2.2 The precedent that decides the architecture

`src/lib/sherlock.ts` states the house doctrine in its own header:

> *"Sherlock itself is Python; shelling out to it is not an option in this runtime,
> but its `data.json` is the valuable part — 481 sites, each with the rule for
> deciding whether a profile exists. That rule set is what this module implements."*

That module is worth reading before writing any code. It also solved a problem this
work will hit immediately: it treats `401/403/407/429/451/503` as **`blocked`**, not
`not_found`, because conflating them produced 8 of 12 false negatives against known-good
handles. It carries a `CHALLENGE_MARKERS` list for interstitials that return 200 with no
profile. Any account-existence probe added here inherits both or repeats the bug.

**Take the data and the rules. Port the logic. Do not shell out to Python.**

---

## 3. Licence findings — read before copying a line

**Horus and TorBot are both GPL-3.0.** OASIS VISION is an MIT-derived fork
distributed as a desktop application. Copying GPL-3.0 source into it would place the
whole distributed work under GPL-3.0.

The nuance that matters: **GPL obligations attach on distribution, not on private
use.** If OASIS VISION stays an internal tool on CC's and Adon's machines, GPL-3.0
imposes essentially nothing. The moment a build goes to a client, a prospect, or a
public release, it does. Plan for the second case, because the first is not a
decision anyone has formally made.

This is a legal judgement, not a technical one. **It is CC's call, not mine and not
the implementer's.** The plan is built so the question never becomes urgent:

- **Horus — avoided entirely.** Overlap analysis (§4.2) shows only ~4 net-new
  capabilities, every one a thin wrapper over a public API. We implement those
  natively against the same APIs and never touch GPL source. Zero exposure.
- **TorBot — arm's length.** Separate process, its own container, spoken to over
  HTTP/JSON. Never imported, never bundled, never linked. This is the conventional
  "mere aggregation" posture, and it is also the only sane engineering choice given
  the Tor daemon dependency.

**MailAccess has a licence defect.** `pyproject.toml` declares
`license = { text = "MIT" }` and the README carries an MIT badge linking to
`LICENSE` — **but no `LICENSE` file exists in the repo** (`LICENSE`, `LICENSE.md`,
`LICENSE.txt` all 404), and the GitHub API reports `"license": null`. The intent is
clearly MIT. The artefact is missing.

**Action before vendoring any MailAccess data file:** open an issue asking the
maintainer to add the `LICENSE` file, and archive the reply. Until then, treat the
bundled corpora as unlicensed. Code we write from public API behaviour is unaffected.

---

## 4. Repo-by-repo

### 4.1 MailAccess — the one that earns its place

FastAPI backend (`backend/{api,core,modules,exporters,platforms,db}`), a CLI, a
frontend, Docker Compose, Alembic migrations. Roughly 60 modules under
`backend/modules/`. Exports JSON, CSV, PDF, Markdown, **STIX 2.1** and **Maltego XML**.

**Genuinely new to us.** Email→identity is a pivot RECON simply cannot do today.

- **Identity graph** — links accounts by shared username, avatar hash, display name
  and breach co-occurrence. We have `/api/entity/expand` and a globe; nobody has
  connected the two.
- **Name Consensus Engine** — grades a name `confirmed / probable / possible / unknown`
  by counting *independent* agreeing sources. This is the anti-"confident nonsense"
  discipline `CLAUDE.md` demands, already expressed as a data structure. Port the
  banding honestly or not at all.
- **Company email patterns** — `find-email --name --domain` against a bundled
  ~384k-domain index (`data/company_patterns.json.gz`, 3.8 MB), offline. Returns
  **one** graded candidate, explicitly labelled `unverified`. Directly useful to
  OASIS sales, not just RECON.
- **Domain harvesting** — Common Crawl, CT logs, GitHub, keyservers, PGP, registries.
- **Deep breach mode + Credential Risk Score (0–100)** with named drivers.
- **Defender's Brief** — a short risk summary with one concrete next action.

**Valuable data assets** (the sherlock.ts lesson — the corpus *is* the product):

| File | Size | Use |
|---|---|---|
| `data/mailaccess_sites.json` | 3.7 MB | 5,000+ platform definitions, two-marker detection |
| `data/company_patterns.json.gz` | 3.8 MB | 384k-domain email pattern index |
| `data/common_names.json` | 508 KB | Name classification |
| `data/disposable_domains.json` | 42 KB | Throwaway-address filter |
| `data/breach_aliases.json` | 8 KB | Breach name normalisation |

**Overlaps we already own:** `dns_lookup`, `hibp`, `hudson_rock` (we have
`osint/hudsonrock`), `phone_intel` (`osint/phone`), `github_*` (`osint/github`),
`gravatar`. Do not duplicate these — feed the existing routes into the new
aggregator.

### 4.2 Horus — four capabilities, and the reason to want them

Modules: `bankindex`, `cryptotrace`, `exif`, `falcon`, `flightinfo`, `geolock`,
`loki_*` (×7), `mactrace`, `numlook`, `onionshare`, `ovpn`, `pvpn`, `recpull`,
`shodan`, `vt`, `wigle`, `ytd`.

**Already covered here:** `flightinfo` (we render live aircraft), `geolock`
(`osint/ip`), `mactrace` (`osint/mac`), `numlook` (`osint/phone`), `shodan`
(`osint/shodan`), `cryptotrace` (`osint/crypto` + chain intel).

**Out of scope:** `loki_*` is a bespoke encryption toolset with no recon value;
`ovpn`/`pvpn` wrap VPN CLIs; `onionshare`, `ytd`, `recpull` are desktop utilities.
None belong in a mapping console.

**Net-new — and note what they have in common:**

| Capability | Source | Map-native? |
|---|---|---|
| **EXIF forensics** | Image metadata, local parse | **Yes** — GPS tags are a pin |
| **WiGLE** | wigle.net API (free tier, key) | **Yes** — BSSID/SSID → coordinates |
| **VirusTotal** | VT API v3 (free tier, key) | No |
| **BIN / bank index** | Public BIN lookup | Issuer country only |

Two of the four **produce coordinates**. That is the actual argument for taking them:
they are not generic OSINT bolt-ons, they are inputs to the thing this app already
does better than any CLI.

All four are thin HTTP/parse wrappers. Reimplementing them is hours, not days, and
sidesteps GPL entirely.

### 4.3 TorBot — real capability, real handling cost

Python 3.10+, `httpx[socks]`, `beautifulsoup4`, `igraph`. Crawls `.onion` over a
SOCKS5 proxy (default `127.0.0.1:9050`), builds a link tree, classifies pages,
emits JSON. Ships a `Dockerfile`. OWASP-listed.

Two things make it worth taking seriously: versioned output contracts
(`schemas/crawl-result.v1.schema.json`, `schemas/investigation-report.v1.schema.json`)
and an evidence-first analyst mode where **every finding must cite captured
evidence** and a provider outage still yields the deterministic bundle.

Two things make it a sidecar, not a library: it needs a **Tor daemon**, and it is
**GPL-3.0**.

Handling requirements, non-negotiable: opt-in per investigation, never part of a
default sweep, hard depth and page caps, its own audit trail, and a panel that says
plainly when Tor is unreachable rather than rendering an empty tree.

---

## 5. Architecture

### 5.1 The decision

> **Native TypeScript tier that always works, keyless. Optional Python sidecars
> that deepen it. A tool never appears unless its tier is actually available.**

This is chosen against the `/api/scanner` pattern, deliberately. That pattern is
how RECON ended up with six tools that render a live input box over a guaranteed
503. **Do not repeat it.** If a capability needs a sidecar, the panel must show it
as unavailable, with the reason, before the analyst types anything.

Three tiers:

| Tier | Runs | Needs | Covers |
|---|---|---|---|
| **1 — Native** | In Next.js, always | Nothing | Email validity/MX, disposable check, breach aggregation, gravatar/keybase/PGP, company pattern inference, account existence, EXIF, BIN |
| **2 — Keyed** | In Next.js | Free API key | WiGLE, VirusTotal, HIBP, IntelX |
| **3 — Sidecar** | Separate process | Docker | Full MailAccess (60 modules, STIX/Maltego), TorBot `.onion` |

Tier 1 is the product. Tiers 2 and 3 are upgrades. A fresh `git clone` gets a
working email investigation with no keys and no Docker — which is the promise the
README already makes for the rest of the app.

### 5.2 Why not just run the MailAccess sidecar and be done

It would be faster, and it is the wrong trade for this codebase. OASIS VISION
installs with `npm install && npm run build`. Adding a mandatory Python 3.11 +
Docker dependency to reach the flagship new feature breaks that promise on every
fresh machine, including CC's. Tier 1 keeps the install story intact; Tier 3 is
there for the deep case.

### 5.3 The idea that makes this ours

Every one of these tools prints a list. **We have a globe.**

The integration worth building is the one that plots identity evidence
geographically: EXIF GPS → pin; WiGLE BSSID → pin; breach-source infrastructure →
IP geolocation → pin; company domain → HQ → pin; onion service hosting → pin. Join
them and an email address becomes a *map* of where a subject's exposure physically
sits.

Existing seams: `onSweepVisualize` and `onScanGeolocate` (`OsintPanel.tsx:70`)
already push RECON results onto the map. Extend that contract; do not invent a
second one.

This is the difference between embedding three tools and building a feature.

---

## 6. UI placement

CC asked for the right-hand rail. The rail already opens RECON — the work belongs
*inside* the panel's group model, not as a new rail button competing with it.

**Group changes** (`OsintPanel.tsx:23-27`):

```
network    unchanged
domain     unchanged
identity   + EMAIL INVESTIGATION   ← flagship
threat     + DARK WEB              ← Tier 3, opt-in
chain      unchanged
forensics  NEW — EXIF, WIGLE, VT, BIN
```

**New tools** — same `{ id, label, icon, placeholder, color, group, blurb }` shape:

| id | label | group | tier | placeholder |
|---|---|---|---|---|
| `email` | EMAIL INVESTIGATION | identity | 1 | `Email address to investigate` |
| `findemail` | FIND EMAIL | identity | 1 | `Name @ company.com` |
| `harvest` | DOMAIN HARVEST | domain | 1 | `Company domain` |
| `exif` | IMAGE FORENSICS | forensics | 1 | `Drop an image or paste a URL` |
| `wigle` | WIFI GEOLOCATE | forensics | 2 | `SSID or BSSID` |
| `virustotal` | FILE / URL REP | forensics | 2 | `Hash, URL or domain` |
| `bin` | CARD BIN | forensics | 1 | `First 6–8 digits` |
| `darkweb` | DARK WEB | threat | 3 | `.onion address` |

`EMAIL INVESTIGATION` is not another row in a list — it is the panel's headline
tool, and should render as a multi-section report (identity → accounts → breaches →
risk → map pins), not a JSON blob.

**Tier badges are required.** A Tier 2/3 tool shows `KEY NEEDED` / `SIDECAR OFFLINE`
in the tool list, greyed, before it is selected. This is the direct fix for the
six-dead-tools problem and it applies retroactively: **badge the six `/api/scanner`
tools the same way** in the same pass.

---

## 7. Lawful-use layer — build it in, not on

This is what makes the feature shippable rather than a liability. It is cheap now
and expensive to retrofit.

1. **Authorisation gate.** First use of any subject-identifying tool (`email`,
   `findemail`, `darkweb`) requires acknowledging a purpose — *authorised
   engagement · own-asset audit · client-authorised*. Record the selection with the
   query. MailAccess ships `DISCLAIMER.md` and `backend/core/audit_log.py`; mirror
   the posture.
2. **Audit trail.** Append every subject-identifying query to `runs/ledger.jsonl`
   (the file already exists and is already the house pattern): timestamp, tool,
   query hash, purpose, tier. Hash the subject, do not store it in clear.
3. **Rate limits.** Reuse `isRateLimited` from `src/lib/ssrf-guard.ts`. Email
   investigation fans out to dozens of upstreams — use the `username` route's
   stricter budget (6/min), not the default 20.
4. **Retention.** Results are in-memory and per-session by default. Persisting an
   investigation is an explicit export.
5. **Jurisdiction.** OASIS operates from Québec: PIPEDA and Law 25 both bite on
   personal information, and Law 25 is stricter than most of what these upstream
   tools assume. If investigation output ever feeds outreach, CASL applies to the
   send. Keep RECON output and any outreach path separate by default.
6. **Respect upstream terms.** Several sources prohibit automated querying or
   commercial redistribution. Pin the source list, note each one's terms, and keep
   `robots.txt`/ToS compliance per source. A blanket "it's public data" is not a
   defence for redistribution.

None of this blocks a single legitimate investigation. It is the difference between
a tool CC can put in front of a client and one he cannot.

---

## 8. Phases

Estimates are human-team / CC+Bravo, with a completeness score.

| # | Phase | Human | Bravo | Score | Gate |
|---|---|---|---|---|---|
| 0 | Repair: badge the 6 dead tools, route `leaks`+`shodan` through their own server routes, wire or retire `sanctions` | 1 day | ~45 min | 9/10 | `tsc` clean, `vitest` green, the 2 bypasses gone |
| 1 | Tier-1 email investigation: `/api/osint/email` + `src/lib/email-intel/` + panel report view | 1 week | ~3 h | 8/10 | Investigation returns graded findings, keyless, no fabricated confidence |
| 2 | Forensics group: EXIF, BIN native; WiGLE, VT keyed + badged | 2 days | ~1 h | 9/10 | EXIF GPS lands as a map pin |
| 3 | Map projection: identity evidence → globe via `onScanGeolocate` | 3 days | ~1.5 h | 8/10 | Pins carry provenance, not just coordinates |
| 4 | Lawful-use layer: purpose gate, `runs/ledger.jsonl` audit, retention | 2 days | ~1 h | 9/10 | Every subject query is logged and hashed |
| 5 | Tier-3 sidecars: MailAccess + TorBot containers, health-gated, opt-in | 1 week | ~3 h | 7/10 | Sidecar-down is a clear panel state, never a spinner |

**Phases 0–2 are the real deliverable.** They produce a working, keyless
email-to-identity tool and repair a quarter of the existing toolkit. Phases 3–5 are
worth doing and should not gate the first ship.

---

## 9. Risks

| Risk | Handling |
|---|---|
| **GPL-3.0 contamination** (Horus, TorBot) | Never copy their source. Sidecar or native reimplementation only. §3 |
| **MailAccess `LICENSE` file missing** | Ask the maintainer before vendoring data. Own-written code is unaffected |
| **False confidence** — the codebase's named recurring defect | Port the Name Consensus *banding*, not just the name. `unverified` stays `unverified`. `CLAUDE.md` non-negotiable #1 |
| **`403` read as "no account"** | Inherit `BLOCKED_CODES` + `CHALLENGE_MARKERS` from `sherlock.ts`. This bug is already solved here — do not re-solve it wrong |
| **Silent catch hides a dead source** | Log every upstream failure with its name. `CLAUDE.md` non-negotiable #2 |
| **60 modules of upstream drift** | Pin data corpora with a recorded fetch date; cache with stale-beats-nothing, as `sherlock.ts` does |
| **Fan-out exhausts the request budget** | Bounded concurrency + per-source timeouts, following `scanUsername`'s shape |
| **Tor exposure** | Sidecar only, opt-in, capped depth, never in a default sweep |
| **Scope: this touches a 1,815-line component** | Phase 0 first. It is independently valuable and proves the seams before the big feature lands |

---

## 10. Open questions for CC

Implementation can start on Phases 0–2 without answers to any of these.

1. **Will OASIS VISION ever be distributed outside your machines** — to a client, a
   prospect, or publicly? This is the only question that makes the GPL analysis
   urgent. If the answer stays "no", §3 is precautionary.
2. **Do you want the sidecars at all?** Tier 1 covers the common case keylessly.
   Tier 3 costs a Docker dependency for depth you may never need.
3. **Free-tier keys** — want WiGLE / VirusTotal / HIBP provisioned now, or ship
   Tier 1 and add them later?
4. **Does investigation output ever feed OASIS outreach?** If yes, CASL and Law 25
   change the retention design and the two paths must stay separated.
5. **Where did Kimi Code's work go?** Nothing exists in this repo (§Baseline). If
   you expected partial work, it was elsewhere — a cloud sandbox or another machine.
   Point me at it and I will fold it in rather than duplicate it.
