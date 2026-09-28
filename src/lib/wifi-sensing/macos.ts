/**
 * macOS link readers.
 *
 * Apple removed the `airport` CLI (Sonoma 14.4+) and `wdutil` needs sudo, so the
 * supported read is CoreWLAN. Rather than ship a compiled Swift helper (RuView's
 * route, which needs the Xcode command-line tools), OASIS WIFI drives CoreWLAN
 * through JavaScript for Automation: `osascript` ships with every macOS, and its
 * ObjC bridge can load the framework. One long-lived process loops and writes a
 * JSON line per reading, so there is no process spawn per sample.
 *
 * RSSI and noise need no permission. The SSID comes back nil unless Location
 * Services has been granted to the host process, so it is optional throughout.
 *
 * `system_profiler SPAirPortDataType -json` is the fallback when the bridge
 * fails: permission-free and stable, but 1-3 s per call, so it samples slowly.
 */
import type { HostSensorError } from './types';
import type { ParsedLink } from './netsh';

/** JXA script: emits one JSON object per line on stdout every `intervalMs`. */
export function coreWlanScript(intervalMs: number): string {
  const seconds = Math.max(0.05, intervalMs / 1000);
  return `
ObjC.import('Foundation');
ObjC.import('CoreWLAN');
var out = $.NSFileHandle.fileHandleWithStandardOutput;
function emit(o) {
  var s = $.NSString.alloc.initWithUTF8String(JSON.stringify(o) + "\\n");
  out.writeData(s.dataUsingEncoding($.NSUTF8StringEncoding));
}
function str(o) {
  try {
    if (o === undefined || o === null) return null;
    if (typeof o.isNil === 'function' && o.isNil()) return null;
    var v = ObjC.unwrap(o);
    return typeof v === 'string' ? v : null;
  } catch (e) { return null; }
}
for (;;) {
  try {
    var iface = $.CWWiFiClient.sharedWiFiClient.interface;
    if (!iface || (typeof iface.isNil === 'function' && iface.isNil())) {
      emit({ error: 'no-wifi-interface' });
    } else if (!iface.powerOn) {
      emit({ error: 'not-connected', detail: 'WiFi is turned off' });
    } else {
      var rssi = iface.rssiValue;
      if (!rssi) {
        emit({ error: 'not-connected' });
      } else {
        var ch = iface.wlanChannel;
        var hasCh = ch && !(typeof ch.isNil === 'function' && ch.isNil());
        emit({
          rssi: rssi,
          noise: iface.noiseMeasurement,
          tx: iface.transmitRate,
          ssid: str(iface.ssid),
          name: str(iface.interfaceName),
          channel: hasCh ? ch.channelNumber : null,
          band: hasCh ? ch.channelBand : null
        });
      }
    }
  } catch (e) {
    emit({ error: 'command-failed', detail: String(e) });
  }
  $.NSThread.sleepForTimeInterval(${seconds});
}
`;
}

/** CWChannelBand: 1 = 2.4 GHz, 2 = 5 GHz, 3 = 6 GHz. */
const BANDS: Record<number, string> = { 1: '2.4 GHz', 2: '5 GHz', 3: '6 GHz' };

export type LineParse = { link: ParsedLink } | { error: HostSensorError } | null;

/** One line of the JXA loop's output. Non-JSON lines (osascript chatter) return null. */
export function parseCoreWlanLine(line: string): LineParse {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(s);
  } catch {
    return null;
  }
  if (typeof o.error === 'string') {
    const code = o.error === 'no-wifi-interface' || o.error === 'not-connected' ? o.error : 'command-failed';
    const detail = typeof o.detail === 'string' ? o.detail : '';
    const message =
      code === 'no-wifi-interface'
        ? 'This Mac has no WiFi interface.'
        : code === 'not-connected'
          ? `The Mac's WiFi is not connected to a network${detail ? ` (${detail})` : ''}.`
          : `CoreWLAN read failed${detail ? `: ${detail}` : ''}.`;
    return { error: { code, message } };
  }
  const rssi = typeof o.rssi === 'number' ? o.rssi : NaN;
  // CoreWLAN reports 0 when there is no association; real links sit well below.
  if (!Number.isFinite(rssi) || rssi >= 0 || rssi < -120) return null;
  const noise = typeof o.noise === 'number' && o.noise < 0 ? o.noise : undefined;
  return {
    link: {
      rssiDbm: rssi,
      rssiKind: 'dbm',
      noiseDbm: noise,
      ssid: typeof o.ssid === 'string' && o.ssid ? o.ssid : undefined,
      channel: typeof o.channel === 'number' && o.channel > 0 ? o.channel : undefined,
      band: typeof o.band === 'number' ? BANDS[o.band] : undefined,
      txRateMbps: typeof o.tx === 'number' && o.tx > 0 ? o.tx : undefined,
      interfaceName: typeof o.name === 'string' ? o.name : undefined,
    },
  };
}

type SpInterface = {
  _name?: string;
  spairport_status_information?: string;
  spairport_current_network_information?: {
    _name?: string;
    spairport_network_channel?: string | number;
    spairport_network_phymode?: string;
    spairport_network_rate?: number | string;
    spairport_signal_noise?: string;
  };
};

/** `system_profiler SPAirPortDataType -json` output. */
export function parseSystemProfiler(json: string): { link: ParsedLink | null; error: HostSensorError | null } {
  let root: { SPAirPortDataType?: Array<{ spairport_airport_interfaces?: SpInterface[] }> };
  try {
    root = JSON.parse(json);
  } catch {
    return { link: null, error: { code: 'unparsed-output', message: 'system_profiler returned output that is not JSON.' } };
  }
  const ifaces = (root.SPAirPortDataType || []).flatMap((d) => d.spairport_airport_interfaces || []);
  if (!ifaces.length) {
    return { link: null, error: { code: 'no-wifi-interface', message: 'This Mac reports no WiFi interface.' } };
  }
  for (const i of ifaces) {
    const net = i.spairport_current_network_information;
    const sn = net?.spairport_signal_noise;
    if (!net || typeof sn !== 'string') continue;
    // "-52 dBm / -93 dBm"
    const m = sn.match(/(-?\d+)\s*dBm\s*\/\s*(-?\d+)\s*dBm/i);
    if (!m) continue;
    const rssi = Number(m[1]);
    if (!(rssi < 0)) continue;
    const chRaw = String(net.spairport_network_channel ?? '');
    const ch = chRaw.match(/^\s*(\d+)/);
    const band = chRaw.match(/(2(?:\.4)?|5|6)\s*GHz/i);
    const rate = Number(net.spairport_network_rate);
    const ssid = net._name && !/redacted/i.test(net._name) ? net._name : undefined;
    return {
      link: {
        rssiDbm: rssi,
        rssiKind: 'dbm',
        noiseDbm: Number(m[2]) < 0 ? Number(m[2]) : undefined,
        ssid,
        channel: ch ? Number(ch[1]) : undefined,
        band: band ? `${band[1] === '2' ? '2.4' : band[1]} GHz` : undefined,
        radioType: net.spairport_network_phymode,
        txRateMbps: Number.isFinite(rate) && rate > 0 ? rate : undefined,
        interfaceName: i._name,
      },
      error: null,
    };
  }
  return { link: null, error: { code: 'not-connected', message: "The Mac's WiFi is not connected to a network." } };
}
