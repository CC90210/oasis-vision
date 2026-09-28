import { describe, expect, it } from 'vitest';
import { classifyRuviewSource, hostFrame, normalizeRuviewMessage, personsMayBeDrawn } from './frames';
import type { HostSnapshot } from './types';

describe('classifyRuviewSource', () => {
  it.each([
    ['esp32', 'csi'],
    ['realtek_csi', 'csi'],
    ['qualcomm_csi', 'csi'],
    ['esp32:offline', 'offline'],
    ['wifi:HomeNet', 'rssi-derived'],
    ['wifi', 'rssi-derived'],
    ['simulated', 'simulated'],
    ['realtek_csi:simulated', 'simulated'],
    ['demo', 'simulated'],
    ['test', 'simulated'],
    ['', 'unknown'],
    [undefined, 'unknown'],
    ['mystery', 'unknown'],
  ])('%s -> %s', (source, expected) => {
    expect(classifyRuviewSource(source)).toBe(expected);
  });
});

// Shape of a RuView sensing-server `sensing_update` (v2 SensingUpdate, trimmed).
const ESP32_UPDATE = {
  type: 'sensing_update',
  timestamp: 1790000000.25,
  source: 'esp32',
  tick: 812,
  nodes: [{ node_id: 1, rssi_dbm: -48, position: [0, 0, 0], amplitude: [0.4, 0.5], subcarrier_count: 56 }],
  features: {
    mean_rssi: -48.2,
    variance: 1.9,
    motion_band_power: 0.21,
    breathing_band_power: 0.08,
    dominant_freq_hz: 0.27,
    change_points: 3,
    spectral_power: 0.4,
  },
  classification: { motion_level: 'present_still', presence: true, confidence: 0.81 },
  signal_field: { grid_size: [20, 1, 20], values: Array.from({ length: 400 }, (_, i) => (i % 7) / 10) },
  vital_signs: { breathing_rate_bpm: 15.2, heart_rate_bpm: null, breathing_confidence: 0.7, heartbeat_confidence: 0.1, signal_quality: 0.8 },
  persons: [
    { id: 1, confidence: 0.8, keypoints: [], bbox: { x: 0, y: 0, width: 1, height: 1 }, zone: 'zone_1', position: [1.2, 0, -0.5], motion_score: 0.3, pose: 'Sitting' },
    { id: 2, confidence: 0.5, zone: 'zone_1' },
  ],
  estimated_persons: 1,
};

describe('normalizeRuviewMessage', () => {
  it('keeps what an ESP32 node measured', () => {
    const f = normalizeRuviewMessage(ESP32_UPDATE)!;
    expect(f.provenance).toBe('csi');
    expect(f.features?.mean_rssi).toBe(-48.2);
    expect(f.classification).toMatchObject({ presence: true, motion_level: 'present_still', confidence: 0.81 });
    expect(f.vital_signs?.breathing_rate_bpm).toBe(15.2);
    expect(f.signal_field?.values).toHaveLength(400);
    expect(f.estimated_persons).toBe(1);
  });

  it('leaves an unmeasured heart rate as a gap, never as 0 BPM', () => {
    const f = normalizeRuviewMessage(ESP32_UPDATE)!;
    expect(f.vital_signs?.heart_rate_bpm).toBeNull();
  });

  it('drops a person with no usable position rather than placing it at the origin', () => {
    const f = normalizeRuviewMessage(ESP32_UPDATE)!;
    expect(f.persons).toHaveLength(1);
    expect(f.persons![0]).toMatchObject({ id: 1, position: [1.2, 0, -0.5], pose: 'sitting', motion_score: 0.3 });
  });

  it('ignores the other message types a node sends', () => {
    expect(normalizeRuviewMessage({ type: 'pose_data' })).toBeNull();
    expect(normalizeRuviewMessage('nope')).toBeNull();
    expect(normalizeRuviewMessage(null)).toBeNull();
  });

  it('marks a node that is replaying simulated data as simulated', () => {
    expect(normalizeRuviewMessage({ ...ESP32_UPDATE, source: 'simulated' })!.provenance).toBe('simulated');
  });

  it('keeps an RSSI node\'s motion verdict but drops what its server synthesised', () => {
    const f = normalizeRuviewMessage({ ...ESP32_UPDATE, source: 'wifi:HomeNet' })!;
    expect(f.provenance).toBe('rssi-derived');
    expect(f.features?.mean_rssi).toBe(-48.2);
    expect(f.classification?.motion_level).toBe('present_still');
    expect(f.persons).toEqual([]);
    expect(f.estimated_persons).toBeUndefined();
    expect(f.vital_signs).toBeUndefined();
    expect(f.signal_field).toBeUndefined();
  });

  it('caps an oversized field instead of trusting its length', () => {
    const big = { ...ESP32_UPDATE, signal_field: { grid_size: [100, 1, 100], values: new Array(10_000).fill(0.5) } };
    expect(normalizeRuviewMessage(big)!.signal_field!.values.length).toBe(4096);
  });
});

describe('personsMayBeDrawn', () => {
  it('draws CSI and (labelled) simulation figures, never RSSI-synthesised ones', () => {
    const csi = normalizeRuviewMessage(ESP32_UPDATE);
    const rssi = normalizeRuviewMessage({ ...ESP32_UPDATE, source: 'wifi:HomeNet' });
    const sim = normalizeRuviewMessage({ ...ESP32_UPDATE, source: 'simulated' });
    expect(personsMayBeDrawn(csi)).toBe(true);
    expect(personsMayBeDrawn(sim)).toBe(true);
    expect(personsMayBeDrawn(rssi)).toBe(false);
    expect(personsMayBeDrawn(null)).toBe(false);
  });
});

describe('hostFrame', () => {
  const snap: HostSnapshot = {
    platform: 'windows',
    status: 'live',
    latest: { t: 1_000_000, rssiDbm: -66, rssiKind: 'dbm', ssid: 'HomeNet' },
    history: [],
    motion: { level: 'motion', index: 0.4, meanDbm: -65.5, shortStdDb: 1.6, baselineStdDb: 0.7, learnedSeconds: 40 },
    rateHz: 4,
    error: null,
    method: 'netsh wlan show interfaces',
  };

  it('carries the link reading and the motion verdict', () => {
    const f = hostFrame(snap)!;
    expect(f.provenance).toBe('host-rssi');
    expect(f.source).toBe('host:windows');
    expect(f.features?.mean_rssi).toBe(-65.5);
    expect(f.classification?.motion_level).toBe('motion');
    expect(f.motion?.index).toBe(0.4);
  });

  it('claims nothing one RSSI number cannot support', () => {
    const f = hostFrame(snap)!;
    expect(f.persons).toBeUndefined();
    expect(f.vital_signs).toBeUndefined();
    expect(f.signal_field).toBeUndefined();
    expect(f.classification?.presence).toBeUndefined();
  });

  it('has no frame to give while the link is down', () => {
    expect(hostFrame({ ...snap, latest: null, status: 'error' })).toBeNull();
  });
});
