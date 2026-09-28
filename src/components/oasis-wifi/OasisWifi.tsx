'use client';

/**
 * OASIS WIFI — WiFi sensing view.
 *
 * The 3D observatory is RuView's (MIT), recoloured and rebuilt around three
 * sources that are kept visibly apart (see lib/wifi-sensing/types.ts):
 *
 *   THIS COMPUTER  this machine's own WiFi link, read live from the OS. Sees
 *                  movement that disturbs the link. Default.
 *   SENSOR NODE    a RuView sensing server with ESP32 CSI hardware. Presence,
 *                  vitals and person positions — whatever the node measured.
 *   SIMULATION     RuView's scripted scenarios, badged SIMULATION everywhere.
 *
 * The rule, from CLAUDE.md: never label a feed as more than it is. A panel
 * with nothing measured shows a dash and says what would measure it; it never
 * shows a plausible number. The view never falls back to the simulation on its
 * own — a dead sensor reads as a dead sensor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Cpu, Laptop, Minus, Pause, Play, Radio, RotateCcw, Settings2, SkipForward, X } from 'lucide-react';
import ViewSwitcher from '@/components/ViewSwitcher';
import { applySettings, loadSavedSettings } from '@/lib/style-tokens';
import { hostFrame } from '@/lib/wifi-sensing/frames';
import { DEFAULT_NODE_URL, toSensingSocketUrl } from '@/lib/wifi-sensing/node-url';
import type { HostSnapshot, SensingFrame, SourceKind } from '@/lib/wifi-sensing/types';
import type { SceneTick, WifiObservatoryScene } from './engine/scene';
import { RuviewNodeClient, type NodeStatus } from './node-client';

const KEY_SOURCE = 'oasis-wifi-source';
const KEY_NODE_URL = 'oasis-wifi-node-url';
const KEY_NODE_TOKEN = 'oasis-wifi-node-token';
/** A node that has gone this long without a frame is shown as stale, not live. */
const NODE_STALE_MS = 5_000;

const SCENARIOS: Array<[string, string]> = [
  ['auto', 'Auto-cycle all'],
  ['empty_room', 'Empty room'],
  ['single_breathing', 'Vital signs'],
  ['two_walking', 'Multi-person'],
  ['fall_event', 'Fall detection'],
  ['sleep_monitoring', 'Sleep monitoring'],
  ['intrusion_detect', 'Intrusion'],
  ['gesture_control', 'Gesture control'],
  ['crowd_occupancy', 'Crowd (4 people)'],
  ['search_rescue', 'Search & rescue'],
  ['elderly_care', 'Elderly care'],
  ['fitness_tracking', 'Fitness'],
  ['security_patrol', 'Security patrol'],
];
const SCENARIO_LABEL = Object.fromEntries(SCENARIOS);

function readStore(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string | null) {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: settings just do not persist */
  }
}

type Tone = 'live' | 'warn' | 'dead' | 'sim';
const TONE: Record<Tone, string> = {
  live: 'var(--alert-green)',
  warn: 'var(--alert-orange)',
  dead: 'var(--alert-red)',
  sim: 'var(--alert-orange)',
};

export default function OasisWifi() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<WifiObservatoryScene | null>(null);
  const latestFrame = useRef<SensingFrame | null>(null);

  const [source, setSource] = useState<SourceKind>('host');
  const sourceRef = useRef<SourceKind>('host');
  // Sources start only once the saved choice is known; otherwise the default
  // would open the WiFi adapter for a moment on every visit.
  const [restored, setRestored] = useState(false);
  const [ready, setReady] = useState(false);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const [tick, setTick] = useState<SceneTick | null>(null);
  const [autopilot, setAutopilot] = useState(false);

  const [host, setHost] = useState<HostSnapshot | null>(null);
  const [hostUnreachable, setHostUnreachable] = useState<string | null>(null);

  const [nodeUrl, setNodeUrl] = useState(DEFAULT_NODE_URL);
  const [nodeToken, setNodeToken] = useState('');
  const [nodeStatus, setNodeStatus] = useState<NodeStatus>('stopped');
  const [nodeDetail, setNodeDetail] = useState<string | null>(null);
  const [nodeFrame, setNodeFrame] = useState<SensingFrame | null>(null);
  const [nodeAgeMs, setNodeAgeMs] = useState<number | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_NODE_URL);
  const [draftToken, setDraftToken] = useState('');
  const [scenario, setScenario] = useState('auto');

  // RSSI trace for the sparkline when the source is not the host (the host
  // snapshot carries its own history).
  const trace = useRef<number[]>([]);

  // ---- settings restore --------------------------------------------------
  useEffect(() => {
    const saved = loadSavedSettings();
    if (saved) applySettings(saved);
    const s = readStore(KEY_SOURCE);
    if (s === 'host' || s === 'node' || s === 'sim') {
      setSource(s);
      sourceRef.current = s;
    }
    const u = readStore(KEY_NODE_URL);
    if (u) {
      setNodeUrl(u);
      setDraftUrl(u);
    }
    const t = readStore(KEY_NODE_TOKEN);
    if (t) {
      setNodeToken(t);
      setDraftToken(t);
    }
    setRestored(true);
  }, []);

  // ---- scene -------------------------------------------------------------
  const onTick = useCallback((t: SceneTick) => {
    if (sourceRef.current === 'sim') {
      const r = t.frame?.features?.mean_rssi;
      if (typeof r === 'number') {
        trace.current.push(r);
        if (trace.current.length > 300) trace.current.shift();
      }
    }
    setTick(t);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let scene: WifiObservatoryScene | null = null;
    import('./engine/scene')
      .then(({ WifiObservatoryScene }) => {
        if (cancelled || !canvasRef.current || !containerRef.current) return;
        try {
          scene = new WifiObservatoryScene(canvasRef.current, containerRef.current, onTick);
        } catch (e) {
          setSceneError(`3D view unavailable: ${(e as Error).message}. The readings below still work.`);
          return;
        }
        scene.setMode(sourceRef.current);
        scene.setFrame(latestFrame.current);
        sceneRef.current = scene;
        setReady(true);
      })
      .catch((e) => setSceneError(`3D view failed to load: ${(e as Error).message}`));
    return () => {
      cancelled = true;
      sceneRef.current = null;
      scene?.dispose();
    };
  }, [onTick]);

  const pushFrame = useCallback((f: SensingFrame | null) => {
    latestFrame.current = f;
    sceneRef.current?.setFrame(f);
  }, []);

  const chooseSource = useCallback(
    (s: SourceKind) => {
      sourceRef.current = s;
      setSource(s);
      writeStore(KEY_SOURCE, s);
      trace.current = [];
      pushFrame(null);
      sceneRef.current?.setMode(s);
    },
    [pushFrame],
  );

  // Mode restored from storage before the scene existed.
  useEffect(() => {
    sceneRef.current?.setMode(source);
  }, [source, ready]);

  // ---- THIS COMPUTER -----------------------------------------------------
  useEffect(() => {
    if (!restored || source !== 'host') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let since = 0;
    let history: HostSnapshot['history'] = [];
    let linkKey = '';

    const poll = async () => {
      try {
        // Bounded: one hung request must not freeze the panels on old numbers.
        const r = await fetch(`/api/wifi-sensing${since ? `?since=${since}` : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(4_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const snap = (await r.json()) as HostSnapshot;
        if (stopped) return;
        const key = snap.latest ? `${snap.latest.interfaceName ?? ''}|${snap.latest.ssid ?? ''}|${snap.latest.channel ?? ''}` : linkKey;
        if (key !== linkKey) {
          // A different link (roamed, reconnected): its trace starts fresh, as the server's does.
          history = [];
          linkKey = key;
        }
        if (snap.history.length) {
          history = history.concat(snap.history);
          const newest = history[history.length - 1].t;
          history = history.filter((h) => h.t > newest - 60_000);
          since = newest;
        }
        const full: HostSnapshot = { ...snap, history };
        setHost(full);
        setHostUnreachable(null);
        pushFrame(hostFrame(full));
      } catch (e) {
        if (stopped) return;
        setHostUnreachable(`The OASIS server did not answer (${(e as Error).message}).`);
        // Clear the readings too, not just the scene: the panels must not keep
        // showing the last RSSI and verdict under an OFFLINE badge.
        setHost(null);
        pushFrame(null);
      }
      if (!stopped) timer = setTimeout(poll, 400);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [restored, source, pushFrame]);

  // ---- SENSOR NODE -------------------------------------------------------
  useEffect(() => {
    if (!restored || source !== 'node') return;
    const url = toSensingSocketUrl(nodeUrl);
    if (!url) {
      setNodeStatus('stopped');
      setNodeDetail('That is not a sensing-server address. Use host:port, e.g. 192.168.1.20:8765.');
      return;
    }
    let lastAt = 0;
    let current: SensingFrame | null = null;
    const client = new RuviewNodeClient(url, nodeToken || null, {
      onStatus: (s, d) => {
        setNodeStatus(s);
        setNodeDetail(d);
        if (s !== 'live') {
          current = null;
          // The trace is "the last minute"; after a disconnect it is not.
          trace.current = [];
          setNodeFrame(null);
          pushFrame(null);
        }
      },
      onFrame: (f) => {
        current = f;
        lastAt = Date.now();
        pushFrame(f);
      },
    });
    client.start();
    const hud = setInterval(() => {
      const age = lastAt ? Date.now() - lastAt : null;
      setNodeAgeMs(age);
      if (current && age != null && age > NODE_STALE_MS) {
        // Socket open, data stopped: stop drawing the last frame as "now".
        current = null;
        pushFrame(null);
      }
      setNodeFrame(current);
      const r = current?.features?.mean_rssi;
      if (typeof r === 'number') {
        trace.current.push(r);
        if (trace.current.length > 300) trace.current.shift();
      }
    }, 200);
    return () => {
      clearInterval(hud);
      client.stop();
      setNodeFrame(null);
      setNodeAgeMs(null);
    };
  }, [restored, source, nodeUrl, nodeToken, pushFrame]);

  // ---- keyboard ----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = sceneRef.current;
      if (!s) return;
      const k = e.key.toLowerCase();
      if (k === 'a') setAutopilot(s.toggleAutopilot());
      else if (k === 'r') s.resetCamera();
      else if (k === 'd' && sourceRef.current === 'sim') s.nextScenario();
      else if (k === ' ' && sourceRef.current === 'sim') {
        e.preventDefault();
        s.setPaused(!s.paused);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- derived view model -------------------------------------------------
  const frame: SensingFrame | null =
    source === 'host' ? (host ? hostFrame(host) : null) : source === 'node' ? nodeFrame : tick?.frame ?? null;
  // Simulated is a property of the data, not of the button pressed: a node can
  // be replaying RuView's simulator, and its numbers must be badged the same.
  const simulated = frame?.provenance === 'simulated';

  const badge = useMemo((): { label: string; tone: Tone; note: string } => {
    if (source === 'sim') {
      return { label: 'SIMULATION', tone: 'sim', note: 'Scripted by the RuView demo generator. Nothing on screen is measured.' };
    }
    if (source === 'host') {
      if (hostUnreachable) return { label: 'OFFLINE', tone: 'dead', note: hostUnreachable };
      if (!host || host.status === 'starting') return { label: 'STARTING', tone: 'warn', note: 'Opening this computer’s WiFi adapter…' };
      if (host.status !== 'live' || !host.latest) return { label: 'NO SIGNAL', tone: 'dead', note: host.error?.message ?? 'No reading from the WiFi adapter.' };
      return { label: 'LIVE · THIS COMPUTER', tone: 'live', note: `Reading ${host.method ?? 'the adapter'} at ${host.rateHz} Hz.` };
    }
    if (nodeStatus !== 'live') {
      return { label: nodeStatus === 'stopped' ? 'NO NODE' : 'CONNECTING', tone: nodeStatus === 'stopped' ? 'dead' : 'warn', note: nodeDetail ?? 'Connecting to the sensing node…' };
    }
    if (!nodeFrame) {
      return { label: 'NODE SILENT', tone: 'warn', note: nodeAgeMs == null ? 'Connected; waiting for the first frame.' : `Connected, but no frame for ${Math.round(nodeAgeMs / 1000)} s.` };
    }
    switch (nodeFrame.provenance) {
      case 'csi':
        return { label: 'LIVE · CSI NODE', tone: 'live', note: `Channel State Information from ${nodeFrame.source}.` };
      case 'rssi-derived':
        return { label: 'LIVE · NODE (RSSI)', tone: 'warn', note: 'This node is reading a laptop’s RSSI, not CSI. Its person and field output is synthesised, so it is not drawn.' };
      case 'simulated':
        return { label: 'NODE SIMULATING', tone: 'sim', note: 'The node itself reports simulated data (no CSI frames have arrived).' };
      case 'offline':
        return { label: 'NODE OFFLINE', tone: 'dead', note: 'The node reports its ESP32 sensors offline.' };
      default:
        return { label: 'LIVE · NODE', tone: 'warn', note: `Unrecognised node source "${nodeFrame.source}" — treating its figures as unverified.` };
    }
  }, [source, host, hostUnreachable, nodeStatus, nodeDetail, nodeFrame, nodeAgeMs]);

  const capabilities = useMemo((): Array<[string, boolean]> => {
    if (source === 'host') {
      return [
        ['Motion along this computer’s WiFi link', true],
        ['A person sitting still', false],
        ['Who or where', false],
        ['Heart / breathing', false],
      ];
    }
    if (source === 'node' && nodeFrame?.provenance === 'csi') {
      return [
        ['Presence & motion', true],
        ['Person count & rough position', true],
        ['Breathing / heart rate (when reported)', true],
        ['Measured body pose', false],
      ];
    }
    if (source === 'node') {
      return [
        ['Needs an ESP32 CSI sensor node', false],
      ];
    }
    return [['Demonstration only — no measurement', false]];
  }, [source, nodeFrame]);

  const sparkValues = source === 'host' ? (host?.history ?? []).map((h) => h.rssiDbm) : trace.current;

  const applyNode = () => {
    const url = toSensingSocketUrl(draftUrl);
    if (!url) {
      setNodeDetail('That is not a sensing-server address. Use host:port, e.g. 192.168.1.20:8765.');
      return;
    }
    setDraftUrl(url);
    setNodeUrl(url);
    setNodeToken(draftToken.trim());
    writeStore(KEY_NODE_URL, url);
    writeStore(KEY_NODE_TOKEN, draftToken.trim() || null);
    if (source !== 'node') chooseSource('node');
  };

  return (
    <main className="fixed inset-0 w-full h-full bg-[var(--bg-void)] overflow-hidden text-[var(--text-primary)] select-none">
      <div ref={containerRef} className="absolute inset-0">
        <canvas ref={canvasRef} className="block w-full h-full outline-none" aria-label="OASIS WIFI 3D room view" />
      </div>
      <div className="vignette absolute inset-0 pointer-events-none z-[2]" />

      {/* ── TOP BAR ── */}
      <header className="absolute top-0 inset-x-0 z-20 px-4 md:px-6 pt-3 md:pt-4 flex items-start justify-between gap-3 pointer-events-none">
        <div className="flex flex-col gap-2 min-w-0">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/oasis-tree-128.png" alt="OASIS AI" className="w-9 h-9 md:w-11 md:h-11 shrink-0 object-contain drop-shadow-[0_0_10px_rgba(124,214,255,0.45)]" />
            <div className="flex flex-col items-start gap-0.5 min-w-0">
              <h1 className="text-lg md:text-xl font-bold tracking-[0.4em] text-[#D4AF37] font-mono whitespace-nowrap">OASIS WIFI</h1>
              <span className="text-[9px] md:text-[10px] font-mono tracking-[0.2em] opacity-80 uppercase text-[#D4AF37] truncate">WiFi sensing observatory · OASIS AI</span>
            </div>
          </div>
          <div className="md:hidden">
            <ViewSwitcher active="wifi" compact />
          </div>
        </div>

        <div className="hidden md:block absolute left-1/2 -translate-x-1/2 top-4">
          <ViewSwitcher active="wifi" compact />
        </div>

        <div className="pointer-events-auto flex flex-col items-end gap-2 max-w-[min(420px,60vw)]">
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-[3px] p-[3px] rounded-xl border border-[var(--border-primary)] bg-[var(--bg-panel)] backdrop-blur-2xl" role="radiogroup" aria-label="Data source">
              <SourceButton on={source === 'host'} onClick={() => chooseSource('host')} icon={Laptop} label="THIS COMPUTER" title="This computer’s own WiFi link, read live from the operating system" />
              <SourceButton on={source === 'node'} onClick={() => chooseSource('node')} icon={Cpu} label="SENSOR NODE" title="A RuView sensing server with ESP32 CSI hardware" />
              <SourceButton on={source === 'sim'} onClick={() => chooseSource('sim')} icon={Play} label="SIMULATION" title="RuView’s scripted demo scenarios — not measured" />
            </div>
            <button
              onClick={() => setShowSettings((v) => !v)}
              className={`w-8 h-8 rounded-full flex items-center justify-center border border-[var(--border-primary)] bg-[var(--bg-panel)] backdrop-blur-2xl transition-colors ${showSettings ? 'text-[var(--gold-light)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              title="Sensor node settings"
              aria-label="Sensor node settings"
              aria-expanded={showSettings}
            >
              <Settings2 className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 px-2.5 py-1 rounded-full border bg-[var(--bg-panel)] backdrop-blur-2xl" style={{ borderColor: `color-mix(in srgb, ${TONE[badge.tone]} 45%, transparent)` }}>
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: TONE[badge.tone], boxShadow: `0 0 8px ${TONE[badge.tone]}` }} />
            <span className="text-[10px] font-mono font-bold tracking-[0.2em]" style={{ color: TONE[badge.tone] }}>{badge.label}</span>
          </div>
          <p className="text-[10px] font-mono leading-relaxed text-right text-[var(--text-secondary)] italic">{badge.note}</p>
          {source === 'sim' && (
            <div className="flex items-center gap-1.5">
              <select
                value={tick?.autoCycle ? 'auto' : tick?.scenario ?? scenario}
                onChange={(e) => {
                  setScenario(e.target.value);
                  sceneRef.current?.setScenario(e.target.value);
                }}
                className="bg-[var(--bg-panel)] border border-[var(--border-primary)] rounded-md px-2 py-1 text-[10px] font-mono tracking-wider text-[var(--gold-light)] outline-none"
                aria-label="Simulation scenario"
              >
                {SCENARIOS.map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              <IconButton title={tick?.paused ? 'Resume (Space)' : 'Pause (Space)'} onClick={() => sceneRef.current?.setPaused(!sceneRef.current.paused)} icon={tick?.paused ? Play : Pause} />
              <IconButton title="Next scenario (D)" onClick={() => sceneRef.current?.nextScenario()} icon={SkipForward} />
            </div>
          )}
        </div>
      </header>

      {/* ── SIMULATION BANNER ── */}
      {simulated && (
        <div className="absolute top-[118px] md:top-20 left-1/2 -translate-x-1/2 z-10 pointer-events-none">
          <div className="px-4 py-1.5 rounded-full border border-[var(--alert-orange)]/50 bg-black/60 backdrop-blur text-[10px] font-mono font-bold tracking-[0.25em] text-[var(--alert-orange)] whitespace-nowrap">
            {source === 'sim'
              ? `SIMULATION${tick?.scenario ? ` · ${(SCENARIO_LABEL[tick.scenario] ?? tick.scenario).toUpperCase()}` : ''}`
              : 'SENSOR NODE IS SIMULATING'}{' '}
            — NOT A SENSOR READING
          </div>
        </div>
      )}

      {/* ── SETTINGS ── */}
      {showSettings && (
        <div className="absolute z-30 right-4 md:right-6 top-40 w-[min(92vw,360px)] glass-panel p-4 pointer-events-auto">
          <div className="flex items-center justify-between mb-3">
            <span className="hud-text text-[10px] text-[var(--gold-primary)]">Sensor node</span>
            <button onClick={() => setShowSettings(false)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]" aria-label="Close settings">
              <X className="w-4 h-4" />
            </button>
          </div>
          <p className="text-[10px] leading-relaxed text-[var(--text-secondary)] mb-3">
            For presence, breathing and person positions, OASIS WIFI reads a RuView sensing server fed by ESP32-S3 boards (about $9 each) that capture Channel State Information. Run the server, then point this at it.
          </p>
          <label className="block hud-label mb-1" htmlFor="oasis-wifi-node-url">Server address</label>
          <input
            id="oasis-wifi-node-url"
            value={draftUrl}
            onChange={(e) => setDraftUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyNode()}
            placeholder="192.168.1.20:8765"
            spellCheck={false}
            className="w-full mb-2 bg-black/40 border border-[var(--border-primary)] rounded-md px-2 py-1.5 text-[11px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--border-active)]"
          />
          <label className="block hud-label mb-1" htmlFor="oasis-wifi-node-token">API token (only if the server has auth on)</label>
          <input
            id="oasis-wifi-node-token"
            type="password"
            value={draftToken}
            onChange={(e) => setDraftToken(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applyNode()}
            autoComplete="off"
            className="w-full mb-3 bg-black/40 border border-[var(--border-primary)] rounded-md px-2 py-1.5 text-[11px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--border-active)]"
          />
          <button
            onClick={applyNode}
            className="w-full px-3 py-2 rounded-md bg-[var(--gold-primary)]/15 hover:bg-[var(--gold-primary)]/25 border border-[var(--gold-primary)]/40 hud-text text-[10px] text-[var(--gold-primary)] transition-colors"
          >
            Connect to node
          </button>
          {source === 'node' && nodeDetail && <p className="mt-2 text-[10px] font-mono text-[var(--text-secondary)] break-all">{nodeDetail}</p>}
          <p className="mt-3 text-[9px] leading-relaxed text-[var(--text-muted)]">
            The token is kept in this browser only. Sensing engine adapted from RuView{' '}
            <a href="/licenses/ruview-LICENSE.txt" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-[var(--text-secondary)]">(MIT © rUv)</a>.
          </p>
        </div>
      )}

      {/* ── LEFT: VITALS ── */}
      <aside className="hidden md:block absolute left-6 top-1/2 -translate-y-1/2 z-10 w-[220px] glass-panel p-3.5 pointer-events-auto">
        <PanelTitle>Vital signs</PanelTitle>
        {source === 'host' ? (
          <Unmeasured>
            Not measurable from this computer. One signal-strength reading every quarter second cannot resolve a heartbeat or a breath — that needs a CSI sensor node.
          </Unmeasured>
        ) : source === 'node' && frame?.provenance === 'rssi-derived' ? (
          <Unmeasured>This node reads a laptop’s RSSI, not CSI, so it cannot measure vital signs.</Unmeasured>
        ) : (
          <>
            {/* Each vital carries its own confidence from the source. The
                presence classifier's confidence says nothing about a heart
                rate, so it is shown under Presence instead. */}
            <Vital label="Heart rate" unit="BPM" value={frame?.vital_signs?.heart_rate_bpm ?? null} confidence={frame?.vital_signs?.heartbeat_confidence} max={120} sim={simulated} />
            <Vital label="Respiration" unit="RPM" value={frame?.vital_signs?.breathing_rate_bpm ?? null} confidence={frame?.vital_signs?.breathing_confidence} max={30} sim={simulated} />
            {source === 'node' && nodeFrame && !nodeFrame.vital_signs && (
              <p className="mt-1 text-[9px] leading-relaxed text-[var(--text-muted)]">This node sent no vital signs.</p>
            )}
          </>
        )}
      </aside>

      {/* ── RIGHT: SIGNAL ── */}
      <aside className="absolute right-3 md:right-6 bottom-24 md:bottom-auto md:top-1/2 md:-translate-y-1/2 z-10 w-[min(88vw,250px)] glass-panel p-3.5 pointer-events-auto">
        <PanelTitle>WiFi signal</PanelTitle>
        {source === 'host' ? (
          <HostSignal host={host} />
        ) : (
          <>
            <Row label="RSSI" value={fmt(frame?.features?.mean_rssi, 0, ' dBm')} sim={simulated} />
            <Row label="Variance" value={fmt(frame?.features?.variance, 2)} sim={simulated} />
            <Row label="Motion power" value={fmt(frame?.features?.motion_band_power, 3)} sim={simulated} />
            <Row label="Persons" value={personCount(frame)} sim={simulated} />
          </>
        )}
        <Sparkline values={sparkValues} />

        <div className="mt-3">
          <PanelTitle>{source === 'host' ? 'Motion' : 'Presence'}</PanelTitle>
          {source === 'host' ? <MotionState host={host} /> : <Presence frame={frame} sim={simulated} />}
        </div>
      </aside>

      {/* ── HOST ERROR ── */}
      {source === 'host' && host?.error && host.status !== 'live' && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-28 z-20 w-[min(92vw,460px)] glass-panel p-3.5 pointer-events-auto">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-[var(--alert-orange)] shrink-0 mt-0.5" />
            <div className="text-[11px] leading-relaxed">
              <div className="hud-text text-[10px] text-[var(--alert-orange)] mb-1">{host.error.code.replace(/-/g, ' ')}</div>
              <p className="text-[var(--text-secondary)]">{host.error.message}</p>
              {host.error.code === 'location-permission' && host.platform === 'windows' && (
                <a href="ms-settings:privacy-location" className="inline-block mt-2 text-[var(--gold-primary)] underline underline-offset-2">Open Location settings</a>
              )}
            </div>
          </div>
        </div>
      )}
      {sceneError && (
        <div className="absolute left-1/2 -translate-x-1/2 top-1/3 z-20 w-[min(92vw,420px)] glass-panel p-3.5 text-[11px] text-[var(--alert-orange)]">{sceneError}</div>
      )}

      {/* ── BOTTOM: WHAT THIS SOURCE CAN SEE ── */}
      <footer className="absolute bottom-4 md:bottom-6 inset-x-0 z-10 flex flex-col items-center gap-2 px-4 pointer-events-none">
        <div className="flex flex-wrap justify-center gap-1.5">
          {capabilities.map(([label, ok]) => (
            <span
              key={label}
              className="flex items-center gap-1 px-2 py-1 rounded-md border text-[9px] font-mono tracking-[0.12em] uppercase bg-black/50 backdrop-blur"
              style={{ borderColor: ok ? 'color-mix(in srgb, var(--alert-green) 40%, transparent)' : 'var(--border-secondary)', color: ok ? 'var(--alert-green)' : 'var(--text-muted)' }}
            >
              {ok ? <Check className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
              {label}
            </span>
          ))}
        </div>
        <div className="hidden md:flex items-center gap-3 text-[9px] font-mono tracking-widest text-[var(--text-muted)] opacity-70">
          <span>[A] {autopilot ? 'Stop orbit' : 'Orbit'}</span>
          <span>[R] Reset view</span>
          {source === 'sim' && <span>[D] Next scenario</span>}
          {source === 'sim' && <span>[Space] Pause</span>}
          <button onClick={() => sceneRef.current?.resetCamera()} className="pointer-events-auto flex items-center gap-1 hover:text-[var(--text-primary)]" title="Reset view (R)">
            <RotateCcw className="w-3 h-3" />
          </button>
          {tick && <span>{tick.fps} FPS</span>}
        </div>
      </footer>
    </main>
  );
}

// ---- pieces ---------------------------------------------------------------

function fmt(v: number | null | undefined, digits: number, suffix = ''): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(digits)}${suffix}` : '—';
}

function SourceButton({ on, onClick, icon: Icon, label, title }: { on: boolean; onClick: () => void; icon: typeof Laptop; label: string; title: string }) {
  return (
    <button
      role="radio"
      aria-checked={on}
      onClick={onClick}
      title={title}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[9px] font-mono font-bold tracking-[0.16em] border transition-colors ${
        on ? 'text-[var(--gold-light)] border-[var(--border-active)] bg-[var(--gold-primary)]/10' : 'text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)]'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      <span className="hidden lg:inline">{label}</span>
    </button>
  );
}

function IconButton({ title, onClick, icon: Icon }: { title: string; onClick: () => void; icon: typeof Play }) {
  return (
    <button onClick={onClick} title={title} aria-label={title} className="w-7 h-7 rounded-md flex items-center justify-center border border-[var(--border-primary)] bg-[var(--bg-panel)] text-[var(--text-secondary)] hover:text-[var(--gold-light)]">
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}

function PanelTitle({ children }: { children: React.ReactNode }) {
  return <div className="hud-text text-[9px] text-[var(--gold-primary)] opacity-90 mb-2">{children}</div>;
}

function Unmeasured({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      {['Heart rate', 'Respiration'].map((l) => (
        <div key={l} className="flex items-baseline justify-between">
          <span className="text-[9px] font-mono tracking-[0.15em] uppercase text-[var(--text-muted)]">{l}</span>
          <span className="text-[16px] font-mono text-[var(--text-muted)]">—</span>
        </div>
      ))}
      <p className="text-[9px] leading-relaxed text-[var(--text-muted)]">{children}</p>
    </div>
  );
}

function Vital({ label, unit, value, confidence, max, sim }: { label: string; unit: string; value: number | null; confidence?: number; max: number; sim: boolean }) {
  const has = typeof value === 'number' && value > 0;
  const pct = has ? Math.min(100, (value / max) * 100) : 0;
  const conf = has && typeof confidence === 'number' && Number.isFinite(confidence) ? Math.round(confidence * 100) : null;
  return (
    <div className="mb-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] font-mono tracking-[0.15em] uppercase text-[var(--text-muted)]">{label}</span>
        {sim && has && <span className="text-[8px] font-mono tracking-[0.2em] text-[var(--alert-orange)]">SIM</span>}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="text-[20px] font-mono font-bold tabular-nums" style={{ color: has ? (sim ? 'var(--alert-orange)' : 'var(--cyan-primary)') : 'var(--text-muted)' }}>
          {has ? Math.round(value) : '—'}
        </span>
        <span className="text-[9px] font-mono text-[var(--text-muted)]">{unit}</span>
        {conf != null && <span className="ml-auto text-[9px] font-mono tabular-nums text-[var(--text-secondary)]" title="The source's own confidence in this reading">conf {conf}%</span>}
      </div>
      <div className="h-[3px] rounded-full bg-white/5 overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: sim ? 'var(--alert-orange)' : 'var(--cyan-primary)' }} />
      </div>
    </div>
  );
}

function Row({ label, value, title, sim = false }: { label: string; value: string; title?: string; sim?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-[3px]" title={title}>
      <span className="text-[9px] font-mono tracking-[0.15em] uppercase text-[var(--text-muted)]">{label}</span>
      <span className="text-[11px] font-mono font-semibold tabular-nums" style={{ color: sim ? 'var(--alert-orange)' : 'var(--cyan-primary)' }}>
        {value}
        {sim && value !== '—' && <span className="ml-1 text-[8px] tracking-[0.2em]">SIM</span>}
      </span>
    </div>
  );
}

/** A count only when the source can count; never "0" for a source that cannot. */
function personCount(frame: SensingFrame | null): string {
  if (!frame || frame.provenance === 'rssi-derived') return '—';
  if (frame.estimated_persons != null) return String(frame.estimated_persons);
  return frame.persons ? String(frame.persons.length) : '—';
}

function HostSignal({ host }: { host: HostSnapshot | null }) {
  const l = host?.latest;
  const m = host?.motion;
  const link = [l?.ssid, l?.band, l?.channel ? `ch ${l.channel}` : null].filter(Boolean).join(' · ');
  return (
    <>
      <Row label="RSSI" value={fmt(l?.rssiDbm, 0, ' dBm')} title="Received signal strength of this computer’s link to its access point" />
      <Row label="Spread (3 s)" value={fmt(m?.shortStdDb, 2, ' dB')} title="Standard deviation of RSSI over the last few seconds" />
      <Row label="Quiet spread" value={fmt(m?.baselineStdDb, 2, ' dB')} title="How much this link wanders when nothing moves, learned over the last three minutes" />
      <Row label="Rate" value={host?.rateHz ? `${host.rateHz} Hz` : '—'} />
      {l?.noiseDbm != null && <Row label="Noise" value={fmt(l.noiseDbm, 0, ' dBm')} />}
      {link && <div className="mt-1 text-[9px] font-mono text-[var(--text-secondary)] truncate" title={link}>{link}</div>}
      {l?.rssiKind === 'quality-derived' && (
        <p className="mt-1 text-[9px] leading-relaxed text-[var(--alert-orange)]">
          This Windows build reports only a signal percentage; RSSI is converted from it and is coarse, so small movements may not register.
        </p>
      )}
    </>
  );
}

function MotionState({ host }: { host: HostSnapshot | null }) {
  const m = host?.motion;
  if (!host?.latest || !m) {
    return <StateChip label="NO READING" color="var(--text-muted)" />;
  }
  if (m.level === 'calibrating') {
    return (
      <>
        <StateChip label={`LEARNING ROOM ${Math.min(10, Math.floor(m.learnedSeconds))}/10 s`} color="var(--alert-orange)" />
        <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--text-muted)]">Measuring how this link behaves when nothing moves. Keep still for a moment.</p>
      </>
    );
  }
  const label = m.level === 'strong' ? 'STRONG MOTION' : m.level === 'motion' ? 'MOTION' : 'QUIET';
  const color = m.level === 'strong' ? 'var(--alert-orange)' : m.level === 'motion' ? 'var(--gold-primary)' : 'var(--cyan-primary)';
  return (
    <>
      <StateChip label={label} color={color} />
      <div className="mt-2 h-[3px] rounded-full bg-white/5 overflow-hidden">
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.round(m.index * 100)}%`, background: color }} />
      </div>
      <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--text-muted)]">
        Something is {m.level === 'quiet' ? 'not ' : ''}disturbing the link between this computer and its access point. RSSI cannot say what, or where.
      </p>
    </>
  );
}

function Presence({ frame, sim }: { frame: SensingFrame | null; sim: boolean }) {
  const c = frame?.classification;
  const noData = <StateChip label="NO DATA" color="var(--text-muted)" />;
  if (!frame || !c) return noData;
  if (frame.provenance === 'rssi-derived') {
    // The node's "presence" here is its RSSI motion score renamed. Say motion —
    // and say nothing when the node sent no motion level at all.
    if (!c.motion_level) return noData;
    const moving = c.motion_level !== 'absent';
    return (
      <>
        <StateChip label={moving ? 'MOTION' : 'QUIET'} color={moving ? 'var(--gold-primary)' : 'var(--cyan-primary)'} />
        <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--text-muted)]">From RSSI: the link is {moving ? '' : 'not '}being disturbed. It cannot tell presence from motion.</p>
      </>
    );
  }
  // An omitted field is unknown, not a negative reading: only an explicit
  // `presence: false` may say ABSENT.
  const label = c.motion_level === 'active' ? 'ACTIVE' : c.presence === true ? 'PRESENT' : c.presence === false ? 'ABSENT' : null;
  if (!label) return noData;
  const color = sim ? 'var(--alert-orange)' : label === 'ACTIVE' ? 'var(--alert-orange)' : label === 'PRESENT' ? 'var(--alert-green)' : 'var(--text-secondary)';
  return (
    <>
      <StateChip label={sim ? `${label} · SIM` : label} color={color} />
      {typeof c.confidence === 'number' && (
        <Row label="Detection confidence" value={`${Math.round(c.confidence * 100)}%`} sim={sim} title="The node's confidence in its presence classification" />
      )}
      {c.fall_detected && <StateChip label={sim ? 'FALL · SIM' : 'FALL DETECTED'} color="var(--alert-red)" />}
      {frame.provenance === 'csi' && (frame.persons?.length ?? 0) > 0 && (
        <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--text-muted)]">Figures stand where the node places people. Their posture is an avatar, not a measured pose.</p>
      )}
    </>
  );
}

function StateChip({ label, color }: { label: string; color: string }) {
  return (
    <div className="mt-1 flex items-center justify-center gap-2 px-2 py-1.5 rounded-md border text-[11px] font-mono font-bold tracking-[0.25em]" style={{ color, borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, background: `color-mix(in srgb, ${color} 8%, transparent)` }}>
      <Radio className="w-3 h-3" />
      {label}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth * dpr;
    const h = c.clientHeight * dpr;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    ctx.clearRect(0, 0, w, h);
    if (values.length < 2) return;
    // Scale to the data, not a fixed -80..-20 band: a 3 dB wobble is the
    // signal here, and a fixed band would flatten it to a line.
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const pad = Math.max(1, (hi - lo) * 0.15);
    lo -= pad;
    hi += pad;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((v - lo) / (hi - lo)) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#00E5FF';
    ctx.lineWidth = 1.5 * dpr;
    ctx.stroke();
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(0,229,255,0.18)');
    g.addColorStop(1, 'rgba(0,229,255,0)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.fillStyle = 'rgba(155,151,142,0.8)';
    ctx.font = `${9 * dpr}px monospace`;
    ctx.fillText(`${Math.round(hi - pad)}`, 2 * dpr, 10 * dpr);
    ctx.fillText(`${Math.round(lo + pad)}`, 2 * dpr, h - 3 * dpr);
  });
  return <canvas ref={ref} className="mt-2 w-full h-12 block" aria-label="RSSI over the last minute" />;
}
