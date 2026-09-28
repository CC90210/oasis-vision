import { describe, expect, it } from 'vitest';
import { coreWlanScript, parseCoreWlanLine, parseSystemProfiler } from './macos';

describe('parseCoreWlanLine', () => {
  it('reads a reading from the JXA loop', () => {
    const r = parseCoreWlanLine('{"rssi":-54,"noise":-92,"tx":866,"ssid":null,"name":"en0","channel":149,"band":2}');
    expect(r).toEqual({
      link: {
        rssiDbm: -54,
        rssiKind: 'dbm',
        noiseDbm: -92,
        ssid: undefined,
        channel: 149,
        band: '5 GHz',
        txRateMbps: 866,
        interfaceName: 'en0',
      },
    });
  });

  it('keeps the SSID when Location Services lets CoreWLAN return it', () => {
    const r = parseCoreWlanLine('{"rssi":-60,"noise":-90,"tx":144,"ssid":"Office","name":"en0","channel":6,"band":1}');
    expect(r && 'link' in r ? r.link.ssid : null).toBe('Office');
    expect(r && 'link' in r ? r.link.band : null).toBe('2.4 GHz');
  });

  it('reports the loop\'s own errors with an actionable message', () => {
    const off = parseCoreWlanLine('{"error":"not-connected","detail":"WiFi is turned off"}');
    expect(off && 'error' in off ? off.error.code : null).toBe('not-connected');
    expect(off && 'error' in off ? off.error.message : '').toMatch(/turned off/);
    const none = parseCoreWlanLine('{"error":"no-wifi-interface"}');
    expect(none && 'error' in none ? none.error.code : null).toBe('no-wifi-interface');
    const boom = parseCoreWlanLine('{"error":"command-failed","detail":"Error: bad"}');
    expect(boom && 'error' in boom ? boom.error.code : null).toBe('command-failed');
  });

  it('ignores osascript chatter and impossible readings', () => {
    expect(parseCoreWlanLine('osascript: warning')).toBeNull();
    expect(parseCoreWlanLine('{not json')).toBeNull();
    // CoreWLAN returns 0 with no association.
    expect(parseCoreWlanLine('{"rssi":0}')).toBeNull();
    expect(parseCoreWlanLine('{"rssi":-200}')).toBeNull();
  });
});

describe('coreWlanScript', () => {
  it('loads CoreWLAN, reads rssiValue and sleeps for the requested interval', () => {
    const s = coreWlanScript(250);
    expect(s).toContain("ObjC.import('CoreWLAN')");
    expect(s).toContain('rssiValue');
    expect(s).toContain('sleepForTimeInterval(0.25)');
  });
});

const PROFILER = JSON.stringify({
  SPAirPortDataType: [
    {
      spairport_airport_interfaces: [
        {
          _name: 'en0',
          spairport_current_network_information: {
            _name: '<redacted>',
            spairport_network_channel: '149 (5GHz, 80MHz)',
            spairport_network_phymode: '802.11ac',
            spairport_network_rate: 866,
            spairport_signal_noise: '-52 dBm / -93 dBm',
          },
          spairport_status_information: 'spairport_status_connected',
        },
        { _name: 'awdl0' },
      ],
    },
  ],
});

describe('parseSystemProfiler', () => {
  it('reads signal and noise from the current network', () => {
    const r = parseSystemProfiler(PROFILER);
    expect(r.error).toBeNull();
    expect(r.link).toMatchObject({
      rssiDbm: -52,
      noiseDbm: -93,
      channel: 149,
      band: '5 GHz',
      radioType: '802.11ac',
      txRateMbps: 866,
      interfaceName: 'en0',
    });
  });

  it('drops a redacted SSID rather than showing "<redacted>" as a network name', () => {
    expect(parseSystemProfiler(PROFILER).link?.ssid).toBeUndefined();
  });

  it('reports not-connected when no interface has a current network', () => {
    const r = parseSystemProfiler(JSON.stringify({ SPAirPortDataType: [{ spairport_airport_interfaces: [{ _name: 'en0' }] }] }));
    expect(r.link).toBeNull();
    expect(r.error?.code).toBe('not-connected');
  });

  it('reports unparsed output instead of throwing', () => {
    expect(parseSystemProfiler('<html>').error?.code).toBe('unparsed-output');
  });
});
