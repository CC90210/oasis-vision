import { describe, expect, it } from 'vitest';
import { parseProcNetWireless } from './linux';

const PROC = `Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE
 face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22
 wlan0: 0000   54.  -56.  -256        0      0      0      0     63        0
`;

describe('parseProcNetWireless', () => {
  it('reads the dBm level and treats -256 as "no noise figure"', () => {
    const r = parseProcNetWireless(PROC);
    expect(r.link).toEqual({ rssiDbm: -56, rssiKind: 'dbm', noiseDbm: undefined, interfaceName: 'wlan0' });
  });

  it('reports not-connected when only the header is present', () => {
    const r = parseProcNetWireless(PROC.split('\n').slice(0, 2).join('\n'));
    expect(r.link).toBeNull();
    expect(r.error?.code).toBe('not-connected');
  });
});
