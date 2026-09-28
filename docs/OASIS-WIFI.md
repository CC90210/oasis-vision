# OASIS WIFI

A second view of the console, next to WORLD VIEW in the bar at the top of the screen
(route `/wifi`). It turns WiFi signals into a 3D picture of a room. The 3D observatory and the
simulation scenarios come from [RuView](https://github.com/ruvnet/RuView) (MIT, © rUv),
rebranded and rebuilt around sources that each say exactly what they measured.

## What it can see depends on the hardware

| Source (top-right switch) | Hardware | Real today | Not possible from this source |
|---|---|---|---|
| **THIS COMPUTER** (default) | This machine's own WiFi adapter. Nothing to buy. | Movement that disturbs the link between this computer and its access point, live, at ~4 readings/s | A person sitting still, who or where anyone is, heart rate, breathing |
| **SENSOR NODE** | A RuView sensing server fed by ESP32-S3 boards (~US$9 each) that capture Channel State Information (CSI) | Presence, motion, a person count and a rough position, breathing rate and heart rate when the node reports them | A measured body pose. The figures are avatars placed where the node locates people. |
| **SIMULATION** | None | Nothing is measured. RuView's scripted scenarios, badged SIMULATION on every panel | Everything |

"See through walls" needs CSI hardware. A laptop's WiFi reports one signal-strength number
(RSSI) per reading, which is enough to notice movement near the link and not enough for
anything more. RuView's own README states the same limit.

The view never switches to the simulation by itself. If the adapter or the node stops
answering, the panels say so.

## THIS COMPUTER: how the motion verdict works

`src/lib/wifi-sensing/motion.ts`, fed by `host-sampler.ts`:

1. Read RSSI about four times a second.
2. Median-of-3 filter. On the Windows 11 / Realtek 8852BE link this was built on, single reads
   jump 9 dB and come straight back, about once every six seconds. Real disturbances hold for
   2 to 13 reads. The filter removes the first kind and keeps the second.
3. Spread (standard deviation) of the last 3 s, compared with the link's quiet spread: the
   10th percentile of the last three minutes of spreads, with a 0.6 dB floor.
4. Spread 1.8x quiet or more is MOTION, 3.2x or more is STRONG, held for 3 reads before the
   label changes. The first 10 s are LEARNING ROOM.

Replayed over a recorded 5-minute session (`motion.recorded.test.ts`), stretches with only
glitches stay QUIET, and a sustained disturbance is reported within a few seconds. Before the
filter, 42% of that recording was flagged.

Things that also disturb the link and read as motion: doors, fans, the laptop being moved, a
microwave on 2.4 GHz. Roaming to another access point restarts the learning.

This computer's own network traffic does not. Tested on the same link on 2026-09-27: 15 s idle,
then a 15 s download at ~66 Mbps, then 15 s idle. RSSI spread was 0.79 dB, 1.01 dB and
1.36 dB, and the download produced no high-band reads. Beamformed data frames were the
suspected cause of the -61 dBm band. The test ruled that out.

If the reader stops producing without reporting an error, the API reports `stalled` after 10 s
instead of serving the last reading as live.

## Platforms

| OS | How the link is read | Status |
|---|---|---|
| Windows 10/11 | `netsh wlan show interfaces`. Uses the `Rssi` line (dBm). Older builds print only `Signal %`, which is converted and marked coarse. English output only. | Verified live on CC's PC |
| macOS | CoreWLAN through one long-lived `osascript` (JavaScript for Automation) loop. Falls back to `system_profiler SPAirPortDataType -json` (one read per ~3 s) if CoreWLAN gives nothing. No Xcode tools needed. | Parsers unit-tested. Not yet run on a Mac. |
| Linux | `/proc/net/wireless` | Parser unit-tested |

Windows 11 24H2 can withhold WLAN data until Location is allowed. The view then shows that
error with a link to the setting (Settings → Privacy & security → Location → Location
services on, and "Let desktop apps access your location").

## SENSOR NODE: adding CSI hardware

1. Flash ESP32-S3 boards with RuView's `firmware/esp32-csi-node`, and run its sensing server
   (`cargo run -p wifi-densepose-sensing-server`, or the `ruvnet/wifi-densepose` Docker image).
   See RuView's README.
2. In OASIS WIFI, open the gear (top right), enter the server's address (e.g.
   `192.168.1.20:8765`) and an API token if the server has auth on, then **Connect to node**.

The node's own `source` field decides how its data is labelled
(`src/lib/wifi-sensing/frames.ts: classifyRuviewSource`):

- `esp32`, `*_csi`: live CSI. Figures and the floor field are drawn.
- `wifi:*`: the node is reading a laptop's RSSI. Its server still fills in persons, a person
  count and a field, synthesised from one number. These are dropped on arrival and never drawn.
- `simulated`: badged NODE SIMULATING.

## Files

```
src/app/wifi/page.tsx                 the route
src/components/ViewSwitcher.tsx       WORLD VIEW / OASIS WIFI bar (both views)
src/components/oasis-wifi/
  OasisWifi.tsx                       HUD, source switch, node settings, labels
  node-client.ts                      RuView /ws/sensing client (tickets, backoff)
  engine/scene.ts                     Three.js scene, adapted from RuView main.js
  engine/*.js                         RuView modules, vendored unmodified (MIT header)
src/app/api/wifi-sensing/route.ts     GET this computer's link state
src/lib/wifi-sensing/                 sampler, parsers, motion detector, frame rules, tests
public/licenses/ruview-LICENSE.txt    RuView's MIT licence, shipped with the app
```

`three` is pinned to 0.160.1, the version RuView's observatory was built against.

## Known gaps

- macOS reading is written and unit-tested, but has not run on a Mac yet. Check the badge
  says `LIVE · THIS COMPUTER` there after the first rebuild.
- `netsh` output is parsed in English only. A translated Windows gets a clear "unparsed" error,
  not a guess.
- The SENSOR NODE path was tested against a stand-in server speaking RuView's v2
  `sensing_update` format, not against real ESP32 hardware.
