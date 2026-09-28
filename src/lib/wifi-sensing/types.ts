/**
 * Shared shapes for OASIS WIFI.
 *
 * Three sources can drive the view, and they are not equal:
 *
 *   host  — this computer's own WiFi link, read from the operating system.
 *           Real, but one number (RSSI) per reading: it can see that the link is
 *           being disturbed, never who disturbed it or where they are.
 *   node  — a RuView sensing server fed by ESP32 CSI hardware. Real per-subcarrier
 *           data; presence, vitals and person positions come from it.
 *   sim   — RuView's scripted scenarios. Nothing in it is measured.
 *
 * Every frame carries its provenance so no panel can present one as another.
 */

export type HostPlatform = 'windows' | 'macos' | 'linux' | 'unsupported';

/** One reading of this computer's own WiFi link. */
export interface LinkSample {
  /** ms since epoch when the reading was taken */
  t: number;
  /** Received signal strength in dBm. */
  rssiDbm: number;
  /**
   * `dbm` when the OS reported a dBm figure itself. `quality-derived` when all
   * it gave was a 0-100% quality and the dBm was converted from it (Windows'
   * documented mapping, 0% = -100 dBm .. 100% = -50 dBm), which is ~0.5 dB
   * coarse and smoothed by the OS — worse for motion, and labelled as such.
   */
  rssiKind: 'dbm' | 'quality-derived';
  noiseDbm?: number;
  signalPct?: number;
  ssid?: string;
  band?: string;
  channel?: number;
  radioType?: string;
  rxRateMbps?: number;
  txRateMbps?: number;
  interfaceName?: string;
}

/** Why the host link could not be read, in terms the operator can act on. */
export interface HostSensorError {
  code:
    | 'no-wifi-interface'   // the machine has no wireless adapter
    | 'not-connected'       // adapter present but not associated with an AP
    | 'location-permission' // Windows 11 withholds WLAN data without Location access
    | 'command-failed'      // netsh / osascript / system_profiler failed
    | 'unparsed-output'     // the command ran but its output was not understood
    | 'stalled'             // the reader stopped producing readings without reporting why
    | 'unsupported-platform';
  message: string;
}

export type MotionLevel = 'calibrating' | 'quiet' | 'motion' | 'strong';

/**
 * What the RSSI detector concluded from the recent readings. Every number here
 * is derived from real samples; none is a presence or vital-sign claim.
 */
export interface MotionState {
  level: MotionLevel;
  /** 0..1 — how far the short-window spread sits above the quiet baseline. */
  index: number;
  /** Mean RSSI over the short window, dBm. */
  meanDbm: number;
  /** Standard deviation of RSSI over the short window, dB. */
  shortStdDb: number;
  /** The learned standard deviation of this link when nothing is moving, dB. */
  baselineStdDb: number;
  /** Seconds of readings the baseline has learned from so far. */
  learnedSeconds: number;
}

export type SourceKind = 'host' | 'node' | 'sim';

/**
 * Where the numbers in a frame actually came from. `rssi-derived` marks a
 * RuView node running on a laptop's RSSI rather than CSI hardware: its server
 * still emits persons and a signal field, but those are synthesised from a
 * single scalar and are drawn as such.
 */
export type Provenance = 'host-rssi' | 'csi' | 'rssi-derived' | 'simulated' | 'offline' | 'unknown';

/** A person as reported by a RuView node. Position is the server's field-peak estimate. */
export interface NodePerson {
  id: number;
  position: [number, number, number];
  confidence: number;
  /** Pose label, when the node sends one. The figure is an avatar posed from it. */
  pose?: string;
  motion_score?: number;
}

/**
 * The subset of RuView's `sensing_update` message the view reads. Also the
 * frame the scene consumes, so the host and simulation paths build the same
 * shape. Everything but `provenance` and `source` is optional because a node
 * omits what it did not measure, and the view must render a gap as a gap.
 */
export interface SensingFrame {
  provenance: Provenance;
  /** The producer's own source string (`esp32`, `wifi:Home`, `simulated`, `host:windows` ...). */
  source: string;
  timestamp: number;
  features?: {
    mean_rssi?: number;
    variance?: number;
    motion_band_power?: number;
    breathing_band_power?: number;
    dominant_freq_hz?: number;
  };
  classification?: {
    motion_level?: string;
    presence?: boolean;
    confidence?: number;
    fall_detected?: boolean;
  };
  vital_signs?: {
    breathing_rate_bpm?: number | null;
    heart_rate_bpm?: number | null;
    breathing_confidence?: number;
    heartbeat_confidence?: number;
  };
  signal_field?: { grid_size: [number, number, number]; values: number[] };
  persons?: NodePerson[];
  estimated_persons?: number;
  /** Present on host frames only. */
  motion?: MotionState;
  /** Scenario key, present on simulation frames only. */
  scenario?: string;
}

/** The response of GET /api/wifi-sensing. */
export interface HostSnapshot {
  platform: HostPlatform;
  status: 'starting' | 'live' | 'error' | 'unsupported';
  latest: LinkSample | null;
  /** Oldest first, at most the last ~60 s. */
  history: Array<{ t: number; rssiDbm: number }>;
  motion: MotionState | null;
  /** Readings per second actually achieved over the history window. */
  rateHz: number;
  error: HostSensorError | null;
  /** How the samples are being read, e.g. `netsh wlan show interfaces`. */
  method: string | null;
}
