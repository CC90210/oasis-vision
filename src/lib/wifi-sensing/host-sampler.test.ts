import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostWifiSampler, detectPlatform } from './host-sampler';
import type { ParsedLink } from './netsh';
import type { HostSensorError } from './types';

// accept/fail are the sampler's only state transitions; the platform loops just
// feed them. Driving them directly tests the bookkeeping without an adapter.
type Internals = { accept(l: ParsedLink): void; fail(e: HostSensorError): void };
const internals = (s: HostWifiSampler) => s as unknown as Internals;

const link = (rssiDbm: number, ssid = 'HomeNet', channel = 104): ParsedLink => ({
  rssiDbm,
  rssiKind: 'dbm',
  ssid,
  channel,
  interfaceName: 'Wi-Fi',
});

afterEach(() => vi.useRealTimers());

describe('detectPlatform', () => {
  it('maps Node platforms to the readers that exist', () => {
    expect(detectPlatform('win32')).toBe('windows');
    expect(detectPlatform('darwin')).toBe('macos');
    expect(detectPlatform('linux')).toBe('linux');
    expect(detectPlatform('freebsd')).toBe('unsupported');
  });
});

describe('HostWifiSampler bookkeeping', () => {
  it('records readings into the snapshot, with the achieved rate', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const s = new HostWifiSampler('windows');
    for (let i = 0; i < 9; i++) {
      internals(s).accept(link(-65 - (i % 2)));
      vi.advanceTimersByTime(250);
    }
    const snap = s.snapshot();
    expect(snap.status).toBe('live');
    expect(snap.latest?.rssiDbm).toBe(-65);
    expect(snap.history).toHaveLength(9);
    expect(snap.rateHz).toBe(4);
    expect(snap.motion?.level).toBe('calibrating');
  });

  it('returns only newer history when asked', () => {
    vi.useFakeTimers({ now: 2_000_000 });
    const s = new HostWifiSampler('windows');
    internals(s).accept(link(-60));
    vi.advanceTimersByTime(250);
    internals(s).accept(link(-61));
    expect(s.snapshot(2_000_000).history.map((h) => h.rssiDbm)).toEqual([-61]);
  });

  it('stops showing the last value as current once the link fails', () => {
    const s = new HostWifiSampler('windows');
    internals(s).accept(link(-60));
    internals(s).fail({ code: 'not-connected', message: 'gone' });
    const snap = s.snapshot();
    expect(snap.status).toBe('error');
    expect(snap.latest).toBeNull();
    expect(snap.motion).toBeNull();
    expect(snap.error?.code).toBe('not-connected');
  });

  it('forgets the old baseline and history when the link changes network', () => {
    vi.useFakeTimers({ now: 3_000_000 });
    const s = new HostWifiSampler('windows');
    for (let i = 0; i < 60; i++) {
      internals(s).accept(link(-65));
      vi.advanceTimersByTime(250);
    }
    expect(s.snapshot().motion?.level).toBe('quiet');
    internals(s).accept(link(-50, 'Cafe', 6));
    const snap = s.snapshot();
    expect(snap.history).toHaveLength(1);
    expect(snap.motion?.level).toBe('calibrating');
  });

  it('reports a reader that stopped producing as stalled, not live', () => {
    vi.useFakeTimers({ now: 4_000_000 });
    const s = new HostWifiSampler('windows');
    internals(s).accept(link(-60));
    expect(s.snapshot().status).toBe('live');
    vi.advanceTimersByTime(11_000);
    const snap = s.snapshot();
    expect(snap.status).toBe('error');
    expect(snap.latest).toBeNull();
    expect(snap.motion).toBeNull();
    expect(snap.error).toMatchObject({ code: 'stalled' });
    expect(snap.error?.message).toMatch(/11 s/);
  });

  it('passes on netsh\'s own explanation when it exits with an error', async () => {
    const refusal = Object.assign(new Error('Command failed: netsh wlan show interfaces'), {
      stdout: 'Network shell commands need location permission to access WLAN information.',
    });
    const s = new HostWifiSampler('windows', () => Promise.reject(refusal));
    s.touch();
    await vi.waitFor(() => expect(s.snapshot().error?.code).toBe('location-permission'));
    s.stop();
  });

  it('names the reason netsh gave when it is not one it recognises', async () => {
    const down = Object.assign(new Error('Command failed: netsh wlan show interfaces'), {
      stdout: 'The Wireless AutoConfig Service (wlansvc) is not running.\r\n',
    });
    const s = new HostWifiSampler('windows', () => Promise.reject(down));
    s.touch();
    await vi.waitFor(() => expect(s.snapshot().error?.message).toBe('netsh failed: The Wireless AutoConfig Service (wlansvc) is not running.'));
    s.stop();
  });

  it('reads through the injected runner when the command succeeds', async () => {
    const out = '    Name : Wi-Fi\n    State : connected\n    SSID : Home\n    Channel : 6\n    Signal : 90%\n    Rssi : -52\n';
    const s = new HostWifiSampler('windows', async () => out);
    s.touch();
    await vi.waitFor(() => expect(s.snapshot().latest?.rssiDbm).toBe(-52));
    expect(s.snapshot().method).toBe('netsh wlan show interfaces');
    s.stop();
  });

  it('says so on a platform with no reader', () => {
    const s = new HostWifiSampler('unsupported');
    s.touch();
    expect(s.snapshot()).toMatchObject({ status: 'unsupported', error: { code: 'unsupported-platform' } });
    s.stop();
  });
});

/** A stand-in `osascript` whose stdout the test writes to. */
function fakeOsascript() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: () => boolean;
    killed: boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    if (!child.killed) {
      child.killed = true;
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    }
    return true;
  };
  return child;
}

const PROFILER_JSON = JSON.stringify({
  SPAirPortDataType: [
    {
      spairport_airport_interfaces: [
        { _name: 'en0', spairport_current_network_information: { _name: 'Home', spairport_signal_noise: '-58 dBm / -94 dBm' } },
      ],
    },
  ],
});

describe('HostWifiSampler on macOS', () => {
  it('reads CoreWLAN lines from the osascript loop', async () => {
    const child = fakeOsascript();
    const s = new HostWifiSampler('macos', async () => PROFILER_JSON, () => child as unknown as ChildProcess);
    s.touch();
    child.stdout.write('{"rssi":-61,"noise":-92,"tx":400,"ssid":null,"name":"en0","channel":36,"band":2}\n');
    await vi.waitFor(() => expect(s.snapshot().latest?.rssiDbm).toBe(-61));
    expect(s.snapshot().method).toBe('CoreWLAN via osascript');
    s.stop();
  });

  it('hands over to system_profiler when CoreWLAN only ever reports failures', async () => {
    const child = fakeOsascript();
    const exec = vi.fn(async () => PROFILER_JSON);
    const s = new HostWifiSampler('macos', exec, () => child as unknown as ChildProcess);
    s.touch();
    for (let i = 0; i < 12; i++) child.stdout.write('{"error":"command-failed","detail":"Error: not authorised"}\n');
    await vi.waitFor(() => expect(s.snapshot().latest?.rssiDbm).toBe(-58));
    expect(child.killed).toBe(true);
    expect(exec).toHaveBeenCalledWith('system_profiler', ['SPAirPortDataType', '-json'], expect.any(Number));
    expect(s.snapshot().method).toBe('system_profiler SPAirPortDataType');
    s.stop();
  });

  it('keeps CoreWLAN when it reports a real adapter state, which system_profiler would only repeat', async () => {
    const child = fakeOsascript();
    const exec = vi.fn(async () => PROFILER_JSON);
    const s = new HostWifiSampler('macos', exec, () => child as unknown as ChildProcess);
    s.touch();
    for (let i = 0; i < 20; i++) child.stdout.write('{"error":"not-connected","detail":"WiFi is turned off"}\n');
    await vi.waitFor(() => expect(s.snapshot().error?.code).toBe('not-connected'));
    expect(child.killed).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    s.stop();
  });
});
