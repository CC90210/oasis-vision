# OASIS VISION

Global intelligence and reconnaissance console for OASIS AI. Private fork of
[simplifaisoul/osiris](https://github.com/simplifaisoul/osiris) (MIT, LICENSE
retained). Owner: CC.

Next.js 16 (App Router) · React 19 · TypeScript 5 · MapLibre GL · Node 20+.
Runs as a **local desktop app** — a standalone Next server plus a chromeless
browser window. Not deployed to a host; the data stays on the machine.

---

## Install it (fresh machine)

```bash
git clone https://github.com/CC90210/oasis-vision.git
cd oasis-vision
npm install
npm run build
node launcher/sync-standalone.js
```

Then make it a real app:

| Platform | Command | Result |
|---|---|---|
| **macOS** | `chmod +x launcher/*.sh && ./launcher/install-macos.sh` | `~/Applications/OASIS VISION.app`, in Launchpad and Spotlight |
| **Windows** | `powershell -ExecutionPolicy Bypass -File launcher\install-shortcuts.ps1` | Desktop + Start Menu shortcut |

Node 20+ required (24 is what it is developed on). macOS: `brew install node`.

**No API keys are needed.** ~50 of the 69 API routes are live and keyless.

---

## Run it

| Task | macOS / Linux | Windows |
|---|---|---|
| Start | `launcher/oasis-vision.sh` | `launcher\OASIS-VISION.cmd` |
| Server only | `launcher/oasis-vision.sh --no-window` | `...\oasis-vision-launch.ps1 -NoWindow` |
| Phone / LAN | `launcher/oasis-vision.sh --lan` | `launcher\OASIS-VISION-mobile.cmd` |
| Stop | `launcher/oasis-vision.sh --stop` | `launcher\stop.cmd` |
| Rebuild | `launcher/rebuild.sh` | `launcher\rebuild.cmd` |
| Update from GitHub | `launcher/update.sh` | `launcher\update.cmd` |

Serves on **port 3177**, bound to `127.0.0.1` by default. Port 3000 is avoided
deliberately — it collides with common local dev servers.

**Always stop the server before rebuilding.** It executes out of
`.next/standalone`, so a build that replaces that directory while it is running
fails on Windows (EBUSY) and, worse, silently keeps serving stale code on macOS.
`rebuild.sh` / `rebuild.cmd` handle this; a bare `npm run build` does not.

---

## Working on it

```bash
npx tsc --noEmit      # must be clean
npx vitest run        # 782 tests, must pass
npm run build         # must exit 0
```

`npm run lint` OOMs at 8 GB on this codebase — a known upstream problem, not
something you broke. Use `tsc` as the gate.

### Non-negotiables

**Never label a feed as more than it is.** This codebase's recurring defect is
confident nonsense: a refreshing JPEG badged `LIVE SAT-LINK`, a 10-second clip
looped under a pulsing "LIVE" dot, a phone number plotted at the geographic
centre of Canada, 15 hardcoded ports reported as an open-port scan. All were
real and all shipped. `lib/camera-feed.ts:describeFeed` is the single place feed
wording is decided — change it there, not at a call site.

The same holds in OASIS WIFI: `lib/wifi-sensing/frames.ts` is where a
source's claims are decided. A laptop's RSSI shows motion, never people or
vitals, and simulated frames are badged SIMULATION on every panel.

**A silent catch hides a dead source.** `catch { return [] }` makes a retired
endpoint indistinguishable from a region with no cameras. Three sources were
dead for months behind exactly that (WSDOT 404, Ville de Montréal 403, Ontario
511 reading `latitude` off a `Latitude` API). Log the failure; the count line
every source prints is how the next one gets noticed.

**Verify a source before building on it.** Fetch the endpoint, count the
records, check the field casing. The Ontario bug was a capital letter. Building
the email tools caught three wrong assumptions this way before they shipped:
Gravatar's `.json` returns 200 for a hash that does not exist, Keybase dropped
email lookup entirely, and GitHub's `in:email` matches profile text rather than
verified ownership.

**A refusal is not an absence.** HTTP 401/403/407/429/451/503 mean "we were
blocked", never "no such account", and a source that failed must be named in the
output rather than silently contributing nothing. `sherlock.ts` measured this:
conflating the two produced 8 of 12 false negatives. Every probe in
`email-intel/` reports `blocked` separately and the response carries a
`sources.failed` ledger.

**Test the mapping, not the network.** Each camera source exports `mapRecord`
and has a `.test.ts` beside it with a real trimmed record. Follow that pattern.

---

## Where things are

```
src/app/api/cctv/          43 camera sources; route.ts registers regions
   caltrans.ts             2,284 live HLS streams (the best continuous source)
   ontario.ts              1,660 Ontario views
   opencctv.ts             9 world regions off a 145k shared index
src/app/api/osint/         RECON toolkit routes
   email/                  email -> identity, keyless (Tier 1)
   capabilities/           what this install can actually run
   exif/ bin/              forensics, keyless
   wigle/ virustotal/      forensics, need an API key (Tier 2)
   darkweb/                onion crawl via opt-in sidecar (Tier 3)
src/app/wifi/              OASIS WIFI view (docs/OASIS-WIFI.md)
src/app/api/wifi-sensing/  this computer's WiFi link: RSSI + motion verdict
src/lib/wifi-sensing/      sampler, netsh/CoreWLAN/proc parsers, motion
                           detector, frame provenance rules (frames.ts),
                           webcam body placement (body.ts), room (room.ts)
src/components/
   ViewSwitcher.tsx        WORLD VIEW / OASIS WIFI bar
   oasis-wifi/             WiFi view + RuView-derived Three.js engine (MIT);
                           camera-tracker.ts + pose.worker.ts = MediaPipe
                           webcam tracking, off the main thread
   OasisMap.tsx           the MapLibre globe
   CameraViewer.tsx        full camera modal
   CctvPreviews.tsx        camera tiles on the map
   OsintPanel.tsx          RECON toolkit
src/lib/
   email-intel/            email investigation: probes, consensus, risk
   forensics/exif.ts       EXIF reader, GPS -> map pin
   recon-audit.ts          hashed audit trail for subject queries
   sherlock.ts             username enumeration - the pattern to copy
   camera-feed.ts          what a camera can show, and how it is described
   camera-preview.ts       tile media selection, preloadFrame
   sourceCache.ts          30-min TTL, stale-on-error, peekSource
launcher/                  desktop app: launchers, icons, installers
```

## Known gaps

- **RECON active scanning still needs a backend**, but it no longer lies about
  it. `/api/osint/capabilities` reports what this install can run, and the panel
  greys those six tools out with the reason BEFORE anything is typed. Standing
  one up (`SCANNER_URL` + `SCANNER_KEY`) remains the fix.
- **`us-central` is empty** — travelmidwest now answers 200 with zero records.
- **`us-east` serves 4 cameras.** Virginia 511 is live and keyless but unwired.
- **Washington needs a free WSDOT API key**; the old endpoint is retired.
- **~35% of Caltrans HLS playlists 404.** Handled — the viewer falls back to the
  camera's still — but there is no prefilter, so the badge is optimistic until a
  camera is opened.
- **No Canadian agency publishes continuous video.** Verified against Ontario
  511, DriveBC and Montréal. Quebec's short clips are the national ceiling.

## UI — route through the Oasis UI library BEFORE building (Adon 2026-09-28)

This section exists in this repo, not only in JARVIS, because that was the bug.
The rule was originally written into `JARVIS/CLAUDE.md` while the UI work happens
here, and this repo loads its own instructions. A rule that does not load where the
work happens does not exist.

Before writing or changing any visual surface here:

1. **`Skill(oasis-ui-library)`** — the router. Its `ROUTING.md` is a decision table:
   per build type (dashboard, data table, chart, form, motion, 3D, redesign, audit,
   anything touching auth or PII) it names which skills to invoke in what order, what
   to read, and which gate to run.
2. **60 installed UI skills** cover primitives, tables and grids, charts, motion,
   typography and colour, and production open-source products worth studying. Reach
   for one before searching the web: they carry verified licences and current APIs.
   TanStack Table's stable release is **v9**, and v8 written from memory does not
   compile. `react-window` v2 deleted `FixedSizeList`.
3. **`Skill(hallmark)`** for a new page, a redesign, or a design audit.
4. **Obey the design constitution** (`JARVIS/oasis-ui-library/doctrine/DESIGN_CONSTITUTION.md`),
   26 numbered rules with real numbers. Highest impact here:
   - `font-variant-numeric: tabular-nums` on every price, balance and table numeral
   - semantic tokens only; dark mode is a token swap, never a parallel component tree
   - the indigo/violet band is **banned** as a primary accent, the most diagnostic
     generated-UI tell (it was Tailwind's old default button colour)
   - WCAG 2.2 AA is the floor: 4.5:1 text, 3:1 large text and UI
   - a border separates, a shadow elevates; every shadow carries a y-offset
   - numeric columns right-align, with a right-aligned header
   - default row height 32-36px; sidebar 220-280px expanded
5. **Check licensing before adding any dependency or copying any component**
   (`doctrine/STACK_AND_LICENSING.md`). Several popular kits forbid building a
   reusable internal library from them. Some repos are AGPL, and some carry no
   licence at all, which grants no rights rather than meaning free.

**The gate runs in CI** (`.github/workflows/ui-gate.yml`) and fails on NEW AI-tell
patterns. Run it locally before pushing:

```
python .github/ui/ui_slop_lint.py --root . --baseline .github/ui/ui-slop-baseline.json
```

Baselines shrink, never grow. If you remove violations, regenerate with
`--update-baseline` and say so in the commit message.

**Functionality always outranks the constitution.** A beautiful screen that computes
the wrong number is a failure.
