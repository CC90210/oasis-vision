/**
 * Linux link reader: `/proc/net/wireless`, which every wext/cfg80211 driver
 * fills. The `level` column is dBm on those drivers (a trailing '.' is part of
 * the format). A noise of -256 means the driver does not report one.
 *
 *   Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE
 *    face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22
 *    wlan0: 0000   54.  -56.  -256        0      0      0      0     63        0
 */
import type { HostSensorError } from './types';
import type { ParsedLink } from './netsh';

export function parseProcNetWireless(text: string): { link: ParsedLink | null; error: HostSensorError | null } {
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^\s:|]+):\s+\S+\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
    if (!m) continue;
    const level = parseFloat(m[3]);
    const noise = parseFloat(m[4]);
    if (!(level < 0)) continue;
    return {
      link: {
        rssiDbm: level,
        rssiKind: 'dbm',
        noiseDbm: noise < 0 && noise > -200 ? noise : undefined,
        interfaceName: m[1],
      },
      error: null,
    };
  }
  return { link: null, error: { code: 'not-connected', message: 'No associated wireless interface in /proc/net/wireless.' } };
}
