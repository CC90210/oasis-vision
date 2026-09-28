/**
 * Reads this computer's own WiFi link, server-side, while someone is watching.
 *
 * One sampler per server process, whatever the number of open views: every
 * GET /api/wifi-sensing reads the same ring buffer, so ten tabs cost the same
 * as one. It starts on the first request and stops after IDLE_STOP_MS without
 * one, so a closed view leaves nothing polling the adapter.
 *
 *   Windows  `netsh wlan show interfaces`, ~4 reads/s (a read takes ~120 ms).
 *   macOS    CoreWLAN through one long-lived `osascript` JXA loop, 4 reads/s;
 *            falls back to `system_profiler`, one read per ~3 s, if the bridge
 *            produces nothing.
 *   Linux    /proc/net/wireless, 4 reads/s.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parseNetshInterfaces, type ParsedLink } from './netsh';
import { coreWlanScript, parseCoreWlanLine, parseSystemProfiler } from './macos';
import { parseProcNetWireless } from './linux';
import { RssiMotionDetector } from './motion';
import type { HostPlatform, HostSensorError, HostSnapshot, LinkSample } from './types';

const HISTORY_MS = 60_000;
const IDLE_STOP_MS = 20_000;
const FAST_INTERVAL_MS = 250;
const PROFILER_INTERVAL_MS = 3_000;
/** A CoreWLAN loop that has printed nothing by now is not going to. */
const JXA_FIRST_LINE_MS = 8_000;
/** Consecutive failed CoreWLAN reads (~3 s at 4/s) before handing over to system_profiler. */
const JXA_MAX_FAILURES = 12;
/**
 * A "live" reading older than this means the reader died without failing
 * (the slowest path, system_profiler, reads every ~3 s and can take ~3 s).
 * Judged by the age of the last reading, not by counting errors: a dead
 * producer raises no errors, so an error count would stay green.
 */
const STALL_MS = 10_000;

export function detectPlatform(p: NodeJS.Platform = process.platform): HostPlatform {
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'macos';
  if (p === 'linux') return 'linux';
  return 'unsupported';
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // windowsHide: the server runs from a hidden launcher; without it every
    // read would flash a console window on the desktop.
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // netsh explains a refusal (Location off, WLAN service stopped) on
      // stdout and exits non-zero, so the output rides along with the error.
      if (err) reject(Object.assign(err, { stdout: String(stdout ?? '') }));
      else resolve(String(stdout));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type CommandRunner = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;
export type ProcessSpawner = (cmd: string, args: string[]) => ChildProcess;

const spawnPiped: ProcessSpawner = (cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

export class HostWifiSampler {
  readonly platform: HostPlatform;
  private readonly exec: CommandRunner;
  private readonly spawnProcess: ProcessSpawner;
  private generation = 0;
  private running = false;
  private status: HostSnapshot['status'];
  private error: HostSensorError | null = null;
  private method: string | null = null;
  private latest: LinkSample | null = null;
  private history: Array<{ t: number; rssiDbm: number }> = [];
  private readonly detector = new RssiMotionDetector();
  private linkKey: string | null = null;
  private lastTouch = 0;
  private child: ChildProcess | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  /** `exec` and `spawnProcess` are injectable so the error and fallback paths can be tested off-platform. */
  constructor(platform: HostPlatform = detectPlatform(), exec: CommandRunner = run, spawnProcess: ProcessSpawner = spawnPiped) {
    this.platform = platform;
    this.exec = exec;
    this.spawnProcess = spawnProcess;
    this.status = platform === 'unsupported' ? 'unsupported' : 'starting';
  }

  /** Mark that a client is watching; starts the readers if they are idle. */
  touch(now = Date.now()): void {
    this.lastTouch = now;
    if (!this.running) this.start();
  }

  snapshot(since = 0, now = Date.now()): HostSnapshot {
    const lastT = this.history.length ? this.history[this.history.length - 1].t : 0;
    const recent = this.history.filter((h) => h.t > lastT - 10_000);
    const span = recent.length > 1 ? (recent[recent.length - 1].t - recent[0].t) / 1000 : 0;
    const age = this.latest ? now - this.latest.t : 0;
    const stalled = this.status === 'live' && age > STALL_MS;
    return {
      platform: this.platform,
      status: stalled ? 'error' : this.status,
      latest: stalled ? null : this.latest,
      history: since > 0 ? this.history.filter((h) => h.t > since) : this.history.slice(),
      motion: this.latest && !stalled ? this.detector.current : null,
      rateHz: span > 0 ? Math.round(((recent.length - 1) / span) * 10) / 10 : 0,
      error: stalled
        ? { code: 'stalled', message: `No new reading from ${this.method ?? 'the adapter'} for ${Math.round(age / 1000)} s.` }
        : this.error,
      method: this.method,
    };
  }

  private start(): void {
    const gen = ++this.generation;
    this.running = true;
    if (this.platform === 'unsupported') {
      this.fail({ code: 'unsupported-platform', message: `Reading the WiFi link is not implemented for ${process.platform}.` });
      return;
    }
    this.status = 'starting';
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastTouch > IDLE_STOP_MS) this.stop();
    }, 5_000);
    this.watchdog.unref?.();

    if (this.platform === 'windows') void this.loopWindows(gen);
    else if (this.platform === 'macos') this.startCoreWlan(gen);
    else void this.loopLinux(gen);
  }

  /** Stop reading. The history is kept so a returning view has context. */
  stop(): void {
    this.generation++;
    this.running = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.child?.kill();
    this.child = null;
    // Nothing is reading any more, so the last value is no longer "now".
    this.latest = null;
    if (this.platform !== 'unsupported') this.status = 'starting';
  }

  private accept(link: ParsedLink): void {
    const t = Date.now();
    // Roaming to another AP or network is a different link with its own quiet
    // spread; judging it against the old baseline would read as movement.
    const key = `${link.interfaceName ?? ''}|${link.ssid ?? ''}|${link.channel ?? ''}`;
    if (this.linkKey !== null && key !== this.linkKey) {
      this.detector.reset();
      this.history = [];
    }
    this.linkKey = key;
    this.latest = { t, ...link };
    this.history.push({ t, rssiDbm: link.rssiDbm });
    while (this.history.length && this.history[0].t < t - HISTORY_MS) this.history.shift();
    this.detector.push(t, link.rssiDbm);
    this.status = 'live';
    this.error = null;
  }

  private fail(err: HostSensorError): void {
    // A dead link must not keep showing its last number as if it were current.
    this.latest = null;
    this.status = this.platform === 'unsupported' ? 'unsupported' : 'error';
    if (!this.error || this.error.code !== err.code || this.error.message !== err.message) {
      console.warn(`[wifi-sensing] ${err.code}: ${err.message}`);
    }
    this.error = err;
  }

  private async loopWindows(gen: number): Promise<void> {
    this.method = 'netsh wlan show interfaces';
    while (gen === this.generation) {
      const started = Date.now();
      try {
        const parsed = parseNetshInterfaces(await this.exec('netsh', ['wlan', 'show', 'interfaces'], 5_000));
        if (gen !== this.generation) return;
        const link = parsed.links.find((l) => l.rssiKind === 'dbm') ?? parsed.links[0];
        if (link) this.accept(link);
        else if (parsed.error) this.fail(parsed.error);
      } catch (e) {
        if (gen !== this.generation) return;
        const said = parseNetshInterfaces((e as { stdout?: string }).stdout ?? '').error;
        if (said && said.code !== 'unparsed-output') this.fail(said);
        else {
          const text = ((e as { stdout?: string }).stdout ?? '').trim().split(/\r?\n/)[0];
          this.fail({ code: 'command-failed', message: `netsh failed: ${text || (e as Error).message}` });
        }
      }
      await sleep(Math.max(20, FAST_INTERVAL_MS - (Date.now() - started)));
    }
  }

  private async loopLinux(gen: number): Promise<void> {
    this.method = '/proc/net/wireless';
    while (gen === this.generation) {
      try {
        const r = parseProcNetWireless(await readFile('/proc/net/wireless', 'utf8'));
        if (gen !== this.generation) return;
        if (r.link) this.accept(r.link);
        else if (r.error) this.fail(r.error);
      } catch (e) {
        if (gen !== this.generation) return;
        this.fail({ code: 'command-failed', message: `/proc/net/wireless unreadable: ${(e as Error).message}` });
      }
      await sleep(FAST_INTERVAL_MS);
    }
  }

  private startCoreWlan(gen: number): void {
    this.method = 'CoreWLAN via osascript';
    let child: ChildProcess;
    try {
      // The script goes in on stdin: osascript reads its program from there
      // when given neither a file nor -e.
      child = this.spawnProcess('osascript', ['-l', 'JavaScript']);
    } catch (e) {
      console.warn(`[wifi-sensing] osascript unavailable (${(e as Error).message}); using system_profiler`);
      void this.loopProfiler(gen);
      return;
    }
    this.child = child;
    child.stdin?.end(coreWlanScript(FAST_INTERVAL_MS));

    // "Working" means the bridge can see the adapter: a reading, or a real
    // adapter state (no interface, not connected) that system_profiler would
    // only repeat. A bridge that only reports its own failures is not working,
    // and must hand over to system_profiler rather than hold the source.
    let gotReading = false;
    let failuresInARow = 0;
    let broken = false;
    let buf = '';
    let stderrTail = '';
    const firstLine = setTimeout(() => {
      if (!gotReading && gen === this.generation) child.kill();
    }, JXA_FIRST_LINE_MS);

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (gen !== this.generation) return;
        const r = parseCoreWlanLine(line);
        if (!r) continue;
        if ('link' in r) {
          gotReading = true;
          failuresInARow = 0;
          this.accept(r.link);
        } else if (r.error.code !== 'command-failed') {
          gotReading = true;
          failuresInARow = 0;
          this.fail(r.error);
        } else {
          this.fail(r.error);
          if (++failuresInARow >= JXA_MAX_FAILURES && !broken) {
            broken = true;
            child.kill();
          }
        }
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (c: string) => {
      stderrTail = (stderrTail + c).slice(-400);
    });
    let ended = false;
    const onEnd = (why: string) => {
      // 'error' and 'exit' can both fire for one child; act once.
      if (ended) return;
      ended = true;
      clearTimeout(firstLine);
      if (gen !== this.generation) return;
      if (this.child === child) this.child = null;
      if (!gotReading || broken) {
        const reason = broken ? `${JXA_MAX_FAILURES} failed reads in a row` : why;
        console.warn(`[wifi-sensing] CoreWLAN bridge gave no reading (${reason}${stderrTail ? `: ${stderrTail.trim()}` : ''}); using system_profiler`);
        void this.loopProfiler(gen);
      } else {
        // It worked and then died: restart it rather than drop to the slow path.
        setTimeout(() => {
          if (gen === this.generation) this.startCoreWlan(gen);
        }, 1_000);
      }
    };
    child.on('error', (e) => onEnd(e.message));
    child.on('exit', (code, signal) => onEnd(`exit ${code ?? signal}`));
  }

  private async loopProfiler(gen: number): Promise<void> {
    this.method = 'system_profiler SPAirPortDataType';
    while (gen === this.generation) {
      const started = Date.now();
      try {
        const r = parseSystemProfiler(await this.exec('system_profiler', ['SPAirPortDataType', '-json'], 20_000));
        if (gen !== this.generation) return;
        if (r.link) this.accept(r.link);
        else if (r.error) this.fail(r.error);
      } catch (e) {
        if (gen !== this.generation) return;
        this.fail({ code: 'command-failed', message: `system_profiler failed: ${(e as Error).message}` });
      }
      await sleep(Math.max(200, PROFILER_INTERVAL_MS - (Date.now() - started)));
    }
  }
}

const g = globalThis as unknown as { __oasisHostWifiSampler?: HostWifiSampler };

/** The process-wide sampler (survives dev-server module reloads). */
export function hostSampler(): HostWifiSampler {
  return (g.__oasisHostWifiSampler ??= new HostWifiSampler());
}
