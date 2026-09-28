/**
 * Turning each source's output into the one frame shape the view draws.
 *
 * The rule the whole module exists for: a frame never claims more than its
 * source measured. A host frame has no persons, no vitals and no signal field,
 * because one RSSI number cannot supply them. A RuView node running on a
 * laptop's RSSI (`source: "wifi:..."`) still sends persons and a field — its
 * server synthesises them — so those frames are marked `rssi-derived`, and the
 * view refuses to draw them as people.
 */
import type { HostSnapshot, NodePerson, Provenance, SensingFrame } from './types';

/** Map a RuView server's `source` string to what its numbers are worth. */
export function classifyRuviewSource(source: unknown): Provenance {
  if (typeof source !== 'string' || !source) return 'unknown';
  const s = source.toLowerCase();
  // realtek_csi:simulated, simulated, demo, test — the server's own admission.
  if (s.includes('simulat') || s === 'demo' || s === 'test') return 'simulated';
  if (s.endsWith(':offline')) return 'offline';
  if (s === 'wifi' || s.startsWith('wifi:')) return 'rssi-derived';
  if (s === 'esp32' || s.startsWith('esp32') || /_csi$/.test(s)) return 'csi';
  return 'unknown';
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optNum = (v: unknown): number | undefined => (finite(v) ? v : undefined);

function vec3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  const [x, y, z] = v;
  return finite(x) && finite(y) && finite(z) ? [x, y, z] : null;
}

/**
 * Validate one message from a RuView `/ws/sensing` socket. Returns null for
 * anything that is not a `sensing_update` (the server sends other types too).
 * Unknown fields are dropped; malformed ones are omitted rather than zeroed,
 * so a missing heart rate shows as a gap, not as 0 BPM.
 */
export function normalizeRuviewMessage(raw: unknown): SensingFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'sensing_update') return null;

  const source = typeof m.source === 'string' ? m.source : '';
  const provenance = classifyRuviewSource(source);
  const f = (m.features ?? {}) as Record<string, unknown>;
  const c = (m.classification ?? {}) as Record<string, unknown>;
  const vs = m.vital_signs && typeof m.vital_signs === 'object' ? (m.vital_signs as Record<string, unknown>) : null;
  const sf = m.signal_field && typeof m.signal_field === 'object' ? (m.signal_field as Record<string, unknown>) : null;

  const persons: NodePerson[] = [];
  if (Array.isArray(m.persons)) {
    for (const p of m.persons.slice(0, 8)) {
      if (!p || typeof p !== 'object') continue;
      const q = p as Record<string, unknown>;
      const pos = vec3(q.position);
      if (!pos) continue;
      persons.push({
        id: finite(q.id) ? q.id : persons.length,
        position: pos,
        confidence: finite(q.confidence) ? q.confidence : 0,
        pose: typeof q.pose === 'string' ? q.pose.toLowerCase() : undefined,
        motion_score: optNum(q.motion_score),
      });
    }
  }

  let signalField: SensingFrame['signal_field'];
  if (sf && Array.isArray(sf.values) && Array.isArray(sf.grid_size)) {
    const values = (sf.values as unknown[]).slice(0, 4096).map((v) => (finite(v) ? v : 0));
    const g = sf.grid_size as unknown[];
    if (values.length && g.length === 3 && g.every(finite)) {
      signalField = { grid_size: [g[0] as number, g[1] as number, g[2] as number], values };
    }
  }

  const positiveOrNull = (v: unknown) => (finite(v) && v > 0 ? v : null);
  // A node on laptop RSSI still fills persons, a person count and a field —
  // synthesised from one scalar by its server. Dropped here, at the one place
  // node data enters, so no panel downstream can show them as sensed.
  const synthesised = provenance === 'rssi-derived';

  return {
    provenance,
    source,
    timestamp: finite(m.timestamp) ? m.timestamp : Date.now() / 1000,
    features: {
      mean_rssi: optNum(f.mean_rssi),
      variance: optNum(f.variance),
      motion_band_power: optNum(f.motion_band_power),
      breathing_band_power: optNum(f.breathing_band_power),
      dominant_freq_hz: optNum(f.dominant_freq_hz),
    },
    classification: {
      motion_level: typeof c.motion_level === 'string' ? c.motion_level : undefined,
      presence: typeof c.presence === 'boolean' ? c.presence : undefined,
      confidence: optNum(c.confidence),
      fall_detected: c.fall_detected === true,
    },
    vital_signs:
      vs && !synthesised
        ? {
            breathing_rate_bpm: positiveOrNull(vs.breathing_rate_bpm),
            heart_rate_bpm: positiveOrNull(vs.heart_rate_bpm),
            breathing_confidence: optNum(vs.breathing_confidence),
            heartbeat_confidence: optNum(vs.heartbeat_confidence),
          }
        : undefined,
    signal_field: synthesised ? undefined : signalField,
    // Undefined when the node sent no list, so the panel shows a gap, not "0".
    persons: !synthesised && Array.isArray(m.persons) ? persons : undefined,
    estimated_persons:
      !synthesised && finite(m.estimated_persons) ? Math.max(0, Math.round(m.estimated_persons)) : undefined,
  };
}

/**
 * The frame for this computer's own link. Deliberately thin: presence is left
 * undefined (RSSI cannot tell an empty room from a still one) and there are no
 * persons, vitals or field.
 */
export function hostFrame(snap: HostSnapshot): SensingFrame | null {
  if (!snap.latest || !snap.motion) return null;
  return {
    provenance: 'host-rssi',
    source: `host:${snap.platform}`,
    timestamp: snap.latest.t / 1000,
    features: {
      mean_rssi: Number.isFinite(snap.motion.meanDbm) ? snap.motion.meanDbm : snap.latest.rssiDbm,
      variance: snap.motion.shortStdDb ** 2,
    },
    // motion_level only. `presence` stays unset: a moving fan disturbs the
    // link as well as a person does, and a still person does not disturb it.
    classification: { motion_level: snap.motion.level },
    motion: snap.motion,
  };
}

/**
 * True when a frame's persons may be drawn as figures: CSI (the node located
 * them) or the simulation (labelled as such). Never for RSSI-derived frames,
 * whose "persons" are synthesised from one scalar.
 */
export function personsMayBeDrawn(frame: SensingFrame | null): boolean {
  return !!frame && (frame.provenance === 'csi' || frame.provenance === 'simulated');
}
