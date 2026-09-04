# Security Policy — OASIS VISION

OASIS VISION is a private intelligence and reconnaissance console maintained by
OASIS AI. It runs locally and is not a public service.

## Deployment posture

The server binds to `127.0.0.1` by default. That is deliberate: the dashboard
proxies arbitrary external URLs and ships a reconnaissance toolkit, so it should
not be reachable from a network unless someone asks for it.

- `--lan` / `OASIS-VISION-mobile.cmd` exposes it on the local network. Plain
  HTTP, no authentication — use it on a trusted network only.
- Reaching it from elsewhere should go through Tailscale (private to your own
  devices, real HTTPS) rather than a public tunnel. A public tunnel puts the
  recon toolkit and everything the console can query in front of anyone holding
  the URL.
- No credentials are required to run it. Optional API keys, where used, are read
  from the environment and never committed.

## Responsible use

The RECON toolkit's passive tools — DNS, WHOIS, certificate transparency, IP
intelligence, breach exposure, sanctions and chain lookups — query public
registries and are unrestricted.

Active scanning is a different matter and is disabled by default (`/api/scanner`
returns 503 unless a separate scanner backend is configured).

**Port scanning and vulnerability scanning against infrastructure you do not own
or have written authorisation to test is a criminal offence** in Canada under
s.342.1 of the Criminal Code, and under comparable statutes elsewhere. Point
active tooling only at your own assets, or at systems whose owner has given you
written permission.

The same applies to the camera layers. They aggregate publicly published feeds
from transport authorities and webcam operators. Use them for situational
awareness, not for surveilling identifiable individuals.

## Data handling

- Everything runs on the local machine; no telemetry is sent to OASIS AI.
- Upstream's analytics and funding surfaces were removed in this fork.
- The launcher's browser profile (`launcher/.appwindow/`) holds cookies and
  cache for the app window and is gitignored. Do not commit it.

## Reporting

This is a private repository. Raise anything you find directly with the
maintainer rather than opening a public issue.

## Attribution

OASIS VISION began as a fork of [simplifaisoul/osiris](https://github.com/simplifaisoul/osiris)
(MIT). See [LICENSE](LICENSE) — the original copyright notice is retained as
that licence requires.
