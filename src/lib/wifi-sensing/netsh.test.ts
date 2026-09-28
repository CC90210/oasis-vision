import { describe, expect, it } from 'vitest';
import { parseNetshInterfaces, qualityToDbm } from './netsh';

// Captured from Windows 11 (Realtek 8852BE) on 2026-09-27; addresses and names replaced.
const WIN11 = `
There is 1 interface on the system:

    Name                   : Wi-Fi 2
    Description            : Realtek 8852BE Wireless LAN WiFi 6 PCI-E NIC
    GUID                   : 00000000-1111-2222-3333-444444444444
    Physical address       : 02:11:22:33:44:55
    Interface type         : Primary
    State                  : connected
    SSID                   : HomeNet-5G
    AP BSSID               : 02:11:22:33:44:55
    Band                   : 5 GHz
    Channel                : 104
    Connected Akm-cipher   : [ akm = 00-0f-ac:02, cipher =  00-0f-ac:04 ]
    Network type           : Infrastructure
    Radio type             : 802.11ac
    Authentication         : WPA2-Personal
    Cipher                 : CCMP
    Connection mode        : Auto Connect
    Receive rate (Mbps)    : 520
    Transmit rate (Mbps)   : 520
    Signal                 : 75%
    Rssi                   : -69
    Profile                : HomeNet-5G
    QoS MSCS Configured         : 0
    QoS Map Configured          : 0
    QoS Map Allowed by Policy   : 0

`.replace(/\n/g, '\r\n');

describe('parseNetshInterfaces', () => {
  it('reads the dBm Rssi line on Windows 11, not the coarse percentage', () => {
    const r = parseNetshInterfaces(WIN11);
    expect(r.error).toBeNull();
    expect(r.links).toHaveLength(1);
    expect(r.links[0]).toMatchObject({
      rssiDbm: -69,
      rssiKind: 'dbm',
      signalPct: 75,
      ssid: 'HomeNet-5G',
      band: '5 GHz',
      channel: 104,
      radioType: '802.11ac',
      rxRateMbps: 520,
      txRateMbps: 520,
      interfaceName: 'Wi-Fi 2',
    });
  });

  it('does not take the AP BSSID line for the SSID', () => {
    const r = parseNetshInterfaces(WIN11);
    expect(r.links[0].ssid).not.toMatch(/:/);
  });

  it('converts the percentage on builds without an Rssi line, and says so', () => {
    const old = WIN11.replace(/\s*Rssi\s*:\s*-69/, '');
    const r = parseNetshInterfaces(old);
    expect(r.links[0].rssiKind).toBe('quality-derived');
    expect(r.links[0].rssiDbm).toBe(qualityToDbm(75));
    expect(r.links[0].rssiDbm).toBe(-62.5);
  });

  it('skips a disconnected adapter and reports why there is no link', () => {
    const r = parseNetshInterfaces(WIN11.replace('State                  : connected', 'State                  : disconnected'));
    expect(r.links).toHaveLength(0);
    expect(r.error?.code).toBe('not-connected');
  });

  it('picks the connected adapter when several are listed', () => {
    const second = `
    Name                   : Wi-Fi 3
    Description            : USB dongle
    State                  : disconnected
`;
    const r = parseNetshInterfaces(`There are 2 interfaces on the system:\n${second}\n${WIN11}`);
    expect(r.links.map((l) => l.interfaceName)).toEqual(['Wi-Fi 2']);
  });

  it('names a machine with no WiFi adapter', () => {
    expect(parseNetshInterfaces('There is no wireless interface on the system.').error?.code).toBe('no-wifi-interface');
  });

  it('surfaces the Windows 11 location-permission refusal instead of reading it as "no WiFi"', () => {
    const msg =
      'Network shell commands need location permission to access WLAN information. Turn on Location services on the Location page in Privacy & security settings.';
    const r = parseNetshInterfaces(msg);
    expect(r.error?.code).toBe('location-permission');
    expect(r.error?.message).toMatch(/Location/);
  });

  it('refuses to guess at a translated output', () => {
    const german = `
    Name                   : WLAN
    Beschreibung           : Intel(R) Wi-Fi 6 AX201
    Status                 : Verbunden
    SSID                   : Zuhause
    Signal                 : 90%
`;
    expect(parseNetshInterfaces(german).error?.code).toBe('unparsed-output');
  });

  it('clamps the quality conversion to the documented range', () => {
    expect(qualityToDbm(0)).toBe(-100);
    expect(qualityToDbm(100)).toBe(-50);
    expect(qualityToDbm(140)).toBe(-50);
  });
});
