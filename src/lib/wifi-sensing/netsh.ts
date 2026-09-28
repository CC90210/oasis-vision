/**
 * Parser for `netsh wlan show interfaces` (Windows).
 *
 * Windows 11 prints an `Rssi` line in dBm beside the old `Signal` percentage.
 * The percentage is the one to avoid: measured on this build it sat at 80% for
 * 25 consecutive reads while Rssi moved between -64 and -70 dBm, so a detector
 * fed the percentage sees a flat line. Rssi is used whenever it is present; the
 * percentage is converted only on older builds that do not print it, and the
 * sample is marked `quality-derived` so the view can say so.
 *
 * English labels only. A localised Windows prints translated keys, which this
 * reports as `unparsed-output` rather than guessing.
 */
import type { HostSensorError, LinkSample } from './types';

export type ParsedLink = Omit<LinkSample, 't'>;

export interface NetshParse {
  /** Every interface in the output that is connected and reported a signal. */
  links: ParsedLink[];
  error: HostSensorError | null;
}

/** Windows' documented WLAN_SIGNAL_QUALITY mapping: 0 = -100 dBm, 100 = -50 dBm. */
export function qualityToDbm(pct: number): number {
  return Math.max(0, Math.min(100, pct)) / 2 - 100;
}

function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const m = v.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

export function parseNetshInterfaces(output: string): NetshParse {
  const text = output.replace(/\r/g, '');

  if (/location permission|location services/i.test(text)) {
    return {
      links: [],
      error: {
        code: 'location-permission',
        message:
          'Windows is withholding WiFi signal data until Location is allowed. Settings → Privacy & security → Location: turn on Location services and "Let desktop apps access your location".',
      },
    };
  }
  if (/There is no wireless interface/i.test(text)) {
    return { links: [], error: { code: 'no-wifi-interface', message: 'This computer has no WiFi adapter.' } };
  }

  // One block per interface; each starts at its "Name" line.
  const blocks: Array<Record<string, string>> = [];
  let cur: Record<string, string> | null = null;
  for (const raw of text.split('\n')) {
    const idx = raw.indexOf(':');
    if (idx < 0) continue;
    const key = raw.slice(0, idx).trim().toLowerCase();
    const value = raw.slice(idx + 1).trim();
    if (key === 'name') {
      cur = {};
      blocks.push(cur);
    }
    if (cur && key) cur[key] = value;
  }

  const links: ParsedLink[] = [];
  // "Name" is spelled the same in German and French netsh, so a translated
  // output still yields blocks; only a recognised "State" key proves the
  // labels were understood.
  let sawState = false;
  for (const b of blocks) {
    if (!('state' in b)) continue;
    sawState = true;
    if (b['state'].toLowerCase() !== 'connected') continue;
    const rssi = num(b['rssi']);
    const pct = num(b['signal']);
    if (rssi == null && pct == null) continue;
    links.push({
      rssiDbm: rssi ?? qualityToDbm(pct as number),
      rssiKind: rssi != null ? 'dbm' : 'quality-derived',
      signalPct: pct,
      ssid: b['ssid'] || undefined,
      band: b['band'] || undefined,
      channel: num(b['channel']),
      radioType: b['radio type'] || undefined,
      rxRateMbps: num(b['receive rate (mbps)']),
      txRateMbps: num(b['transmit rate (mbps)']),
      interfaceName: b['name'] || undefined,
    });
  }

  if (links.length) return { links, error: null };
  if (sawState) {
    return { links, error: { code: 'not-connected', message: 'The WiFi adapter is not connected to a network, so there is no link to read.' } };
  }
  return {
    links,
    error: {
      code: 'unparsed-output',
      message: 'netsh answered in a format this build does not recognise (a non-English Windows prints translated labels).',
    },
  };
}
