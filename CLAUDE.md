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
| Server only | `launcher/oasis-vision.sh --no-window` | `...\osiris-launch.ps1 -NoWindow` |
| Phone / LAN | `launcher/oasis-vision.sh --lan` | `launcher\OASIS-VISION-mobile.cmd` |
| Stop | `launcher/oasis-vision.sh --stop` | `launcher\stop.cmd` |
| Rebuild | `launcher/rebuild.sh` | `launcher\rebuild.cmd` |

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
npx vitest run        # 575 tests, must pass
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

**A silent catch hides a dead source.** `catch { return [] }` makes a retired
endpoint indistinguishable from a region with no cameras. Three sources were
dead for months behind exactly that (WSDOT 404, Ville de Montréal 403, Ontario
511 reading `latitude` off a `Latitude` API). Log the failure; the count line
every source prints is how the next one gets noticed.

**Verify a source before building on it.** Fetch the endpoint, count the
records, check the field casing. The Ontario bug was a capital letter.

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
src/components/
   OsirisMap.tsx           the MapLibre globe
   CameraViewer.tsx        full camera modal
   CctvPreviews.tsx        camera tiles on the map
   OsintPanel.tsx          RECON toolkit
src/lib/
   camera-feed.ts          what a camera can show, and how it is described
   camera-preview.ts       tile media selection, preloadFrame
   sourceCache.ts          30-min TTL, stale-on-error, peekSource
launcher/                  desktop app: launchers, icons, installers
```

## Known gaps

- **RECON active scanning returns 503.** The scanner is a separate backend that
  does not ship with the code; no key enables it. The passive tools (DNS, WHOIS,
  IP, certs, sanctions, breach, chain) all work. A server-side scanner is the
  intended fix — the app already runs a local Node process.
- **`us-central` is empty** — travelmidwest now answers 200 with zero records.
- **`us-east` serves 4 cameras.** Virginia 511 is live and keyless but unwired.
- **Washington needs a free WSDOT API key**; the old endpoint is retired.
- **~35% of Caltrans HLS playlists 404.** Handled — the viewer falls back to the
  camera's still — but there is no prefilter, so the badge is optimistic until a
  camera is opened.
- **No Canadian agency publishes continuous video.** Verified against Ontario
  511, DriveBC and Montréal. Quebec's short clips are the national ceiling.
