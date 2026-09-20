# RECON setup — unlocking the four gated tools

Four RECON tools need a credential. Everything else in OASIS VISION works
without one and always will.

**The one thing that catches people:** the built app does **not** read
`.env.local` from the project folder. It runs out of `.next/standalone` and
Next loads env from the server's own directory, so a credential that works
under `npm run dev` is simply absent in the real app until it is copied
across. The last step below is not optional.

---

## 1. Where they go

One file, in the project root:

```
C:\Users\User\APPS\osiris\.env.local
```

It already exists. Open it in a text editor and add the lines you want:

```ini
WIGLE_API_KEY=<the encoded token, see below>
VIRUSTOTAL_API_KEY=<your token>
HIBP_API_KEY=<your token>
```

Then — **this is the step that matters** — copy it into the built app and
restart:

```powershell
cd C:\Users\User\APPS\osiris
launcher\stop.cmd
node launcher\sync-standalone.js
launcher\OASIS-VISION.cmd
```

`sync-standalone.js` copies `.env.local` into `.next\standalone\`. It logs
the filename and byte count only — it never reads or prints the contents.

### Did it work?

Open <http://127.0.0.1:3177/api/osint/capabilities>. The `unavailable` list
should have shrunk. Or just look at the RECON panel: a tool that was greyed
out with a padlock is now at full brightness.

That endpoint reports whether a variable is **set**, never its value. Safe
to screenshot.

---

## 2. WIFI GEOLOCATE — WiGLE

Turns an SSID or BSSID into map pins from crowd-sourced sightings.

**Free.** Small daily query budget.

1. Make an account at <https://wigle.net/> and confirm the email.
2. Go to <https://wigle.net/account>.
3. Find **"API Token"**. You want the field labelled something like
   **"Encoded for use"** — a long base64 string.

> **Take the encoded token, not the API Name.** The route sends it as
> `Authorization: Basic <token>`, which is what that encoded value already
> is. Pasting the API Name instead produces a 401, and the tool says so
> explicitly rather than failing silently.

```ini
WIGLE_API_KEY=QWxhZGRpbjpvcGVuIHNlc2FtZQ==
```

---

## 3. FILE / URL REP — VirusTotal

Reputation for a file hash, URL, domain or IP across ~90 engines.

**Free.** 4 lookups/minute, 500/day. OASIS VISION limits itself to 3/minute
so you hit a clear message here instead of an opaque 429 from them.

1. Make an account at <https://www.virustotal.com/>.
2. Go to <https://www.virustotal.com/gui/my-apikey>.
3. Copy the token.

```ini
VIRUSTOTAL_API_KEY=your64charactertokenhere
```

---

## 4. EMAIL INVESTIGATION (deeper) — Have I Been Pwned

Adds HIBP's breach corpus at `depth=deep`. This is the one that materially
improves breach coverage — a much larger and better-curated corpus than the
keyless source.

**Paid**, around **US$3.95/month**, monthly, cancel any time.

1. <https://haveibeenpwned.com/API/Key>
2. Buy access, verify the email.

```ini
HIBP_API_KEY=your-token-here
```

Without it the investigation still runs. HIBP is reported as *skipped*, not
*failed*, so a thin result is never mistaken for a clean subject.

---

## 5. DARK WEB — not a credential

This one needs a **Tor daemon and a container**, not a token. TorBot is
GPL-3.0, so nothing is bundled into OASIS VISION; the route talks to a
separate service over HTTP.

```ini
TORBOT_URL=http://127.0.0.1:8080
```

Ask before setting this up — it is a different kind of work from pasting a
token, and worth deciding whether you actually want it.

---

## 6. PORT SCAN and VULN SWEEP — deliberately still off

These two are not waiting on a credential. They send traffic **at** the
target, which is a different activity from everything else in the toolkit:
the passive checks observe what a host already publishes, while these probe
it.

They need a separate scanner backend (`SCANNER_URL` + `SCANNER_KEY`), and
they should only ever be pointed at hosts you are authorised to test.

The passive equivalents work now and cover most of what you would want a
port scan for: **SSL/TLS**, **HEADERS**, **TECH DETECT**, **SUBDOMAINS**.

---

## What each one actually buys you

| Variable | Unlocks | Cost | Worth it? |
|---|---|---|---|
| `VIRUSTOTAL_API_KEY` | FILE / URL REP | Free | Yes — 2 minutes, no downside |
| `WIGLE_API_KEY` | WIFI GEOLOCATE | Free | Yes if you care about mapping networks |
| `HIBP_API_KEY` | Deeper breach data | ~$4/mo | Yes if email investigation is a real workflow |
| `TORBOT_URL` | DARK WEB | Free, but setup | Only if you need onion crawling |

Start with the two free ones. Together they take about five minutes and
cost nothing.

---

## Security notes

- `.env.local` is gitignored. Do not commit it, and do not paste a
  credential into a chat, an issue, or a screenshot of a terminal.
- Credentials are read **server-side only**. None is ever sent to the
  browser — the routes proxy the request and return sanitised JSON.
- If one leaks, revoke it at the provider **first**, then replace it here.
  Rotating your copy without revoking theirs leaves the old one live.
- `capabilities` reports presence, never values, precisely so you can check
  a setup without exposing anything.
- There is one more optional variable worth knowing about: `OASIS_AUDIT_DIR`.
  The RECON audit trail defaults to `runs/` **inside** `.next/standalone`,
  which `sync-standalone` replaces on every rebuild. Point this somewhere
  stable if you want the trail to survive:
  `OASIS_AUDIT_DIR=C:\Users\User\APPS\osiris\runs`
