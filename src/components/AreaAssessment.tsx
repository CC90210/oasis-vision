'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Volume2, Square, X, Loader2, AlertTriangle } from 'lucide-react';
import { buildAreaBrief, type BriefInput } from '@/lib/area-brief';

/**
 * OASIS VISION — the area assessment panel, and the voice that reads it.
 *
 * Two things it deliberately does NOT do:
 *
 * 1. It does not synthesise prose. The spoken text comes from lib/area-brief,
 *    which composes sentences out of measured fields only. A command centre
 *    that narrates a plausible-sounding guess about what is on the ground is
 *    worse than one that stays silent, so the screen and the speaker read from
 *    the same object and cannot disagree.
 *
 * 2. It does not hold the ElevenLabs key. Synthesis goes through
 *    /api/voice/speak on the server; a key in this file would be a key
 *    published to anyone who opens the network tab.
 */

export interface AssessmentData {
  coordinates: { lat: number; lng: number };
  radius?: number;
  place?: BriefInput['place'];
  conditions?: BriefInput['conditions'];
  infrastructure?: {
    counts?: Record<string, number>;
    items?: { category: string; name: string; kind: string; lat: number; lng: number }[];
    total?: number;
  } | null;
  nearby?: { title: string; distanceM: number }[];
  wikipedia?: { title?: string; extract?: string; thumbnail?: string } | null;
  country?: { name?: string; capital?: string; population?: number; languages?: string[] } | null;
  degraded?: string[];
}

interface VoiceOption { id: string; name: string; description: string }

interface Props {
  data: AssessmentData | null;
  loading: boolean;
  onClose: () => void;
  /** Cameras the map already holds, for the coverage line. */
  cameras?: { lat: number; lng: number }[];
  /** Aircraft the map already holds, for the coverage line. */
  aircraft?: { lat: number; lng: number }[];
  /** Fly the map to a facility the assessment found. */
  onFocus?: (lat: number, lng: number) => void;
}

/** Great-circle distance in metres — the map is global, so flat maths will not do. */
function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

const CATEGORY_LABEL: Record<string, string> = {
  emergency: 'EMERGENCY',
  security: 'RESTRICTED',
  government: 'GOVERNMENT',
  transport: 'TRANSPORT',
  power: 'POWER',
  medical: 'MEDICAL',
  education: 'EDUCATION',
  landmark: 'LANDMARKS',
};

/** Order matters: this is reporting priority, not alphabetical. */
const CATEGORY_ORDER = ['emergency', 'security', 'government', 'transport', 'power', 'medical', 'education', 'landmark'];

export default function AreaAssessment({ data, loading, onClose, cameras, aircraft, onFocus }: Props) {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [voiceId, setVoiceId] = useState<string>('');
  const [quota, setQuota] = useState<{ remaining: number; limit: number } | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  // What the voice service can actually do, asked once. The picker is built
  // from the answer so it can never offer a voice the server would reject.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/voice')
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setVoices(j.voices || []);
        setQuota(j.quota ? { remaining: j.quota.remaining, limit: j.quota.limit } : null);
        if (!j.configured) setVoiceError(j.reason || 'Voice service unavailable.');
        const preferred = (j.voices || []).find((v: VoiceOption) => v.name === 'Alice');
        setVoiceId(preferred?.id || j.voices?.[0]?.id || '');
      })
      .catch(() => { if (!cancelled) setVoiceError('Voice service unreachable.'); });
    return () => { cancelled = true; };
  }, []);

  // One audio element for the panel's lifetime, and every object URL revoked.
  // Without this, each read-out leaks an MP3 the size of the briefing.
  useEffect(() => () => {
    generationRef.current += 1; // nothing in flight may play into a dead panel
    abortRef.current?.abort();
    audioRef.current?.pause();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const radius = data?.radius ?? 1200;

  /** Cameras and aircraft the operator's own map already holds in range. */
  const coverage = useMemo(() => {
    if (!data) return { camerasNearby: 0, aircraftOverhead: 0 };
    const { lat, lng } = data.coordinates;
    const inRange = (list: { lat: number; lng: number }[] | undefined, m: number) =>
      (list || []).filter((p) =>
        Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && distanceM(lat, lng, p.lat, p.lng) <= m,
      ).length;
    // Aircraft get a wider ring: "overhead" is not a street-level idea.
    return { camerasNearby: inRange(cameras, radius * 5), aircraftOverhead: inRange(aircraft, 25000) };
  }, [data, cameras, aircraft, radius]);

  const brief = useMemo(() => {
    if (!data) return null;
    return buildAreaBrief({ ...data, radius, ...coverage } as BriefInput);
  }, [data, radius, coverage]);

  /**
   * Which read-out is current. Incremented by stop() and by each new speak(),
   * and checked after every await.
   *
   * Without it, pressing STOP during synthesis did nothing at all: the audio
   * element has no source yet, so `pause()` is a no-op, and when the fetch
   * resolved the continuation still ran `audio.play()` — the briefing you
   * cancelled played anyway. `setSpeaking(false)` had meanwhile flipped the
   * button back to BRIEF ME, so the only way to get a STOP control back was to
   * press it, starting a SECOND synthesis and spending the quota twice.
   */
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    const audio = audioRef.current;
    if (audio) { audio.pause(); audio.currentTime = 0; }
    setSpeaking(false);
  }, []);

  const speak = useCallback(async () => {
    if (!brief?.speech) return;
    setVoiceError(null);
    setSpeaking(true);

    // Claim this generation. Anything older must not reach the speaker.
    const generation = ++generationRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    /**
     * Unlock audio SYNCHRONOUSLY, before any await.
     *
     * iOS Safari only allows playback that begins inside a user-gesture stack
     * frame. The synthesis round-trip below is an await, and by the time it
     * resolves the gesture has expired — so `play()` rejects with
     * NotAllowedError and the read-out is silent on the one device CC uses
     * most. Creating and starting the element here, while the click is still on
     * the stack, keeps it unlocked; the real source is attached afterwards.
     */
    const audio = audioRef.current || new Audio();
    audioRef.current = audio;
    audio.muted = false;
    try {
      audio.play().catch(() => { /* nothing loaded yet — the unlock is the point */ });
      audio.pause();
    } catch { /* non-iOS browsers may not need this and may not like it */ }

    try {
      const res = await fetch('/api/voice/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: brief.speech, voiceId: voiceId || undefined }),
        signal: controller.signal,
      });
      if (generationRef.current !== generation) return; // cancelled mid-flight
      if (!res.ok) {
        // Surface the server's actual reason. "Voice failed" hides the one
        // thing worth knowing, which is usually a spent character quota.
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `Voice service returned ${res.status}`);
      }
      const blob = await res.blob();
      if (generationRef.current !== generation) return;

      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(blob);

      audio.src = objectUrlRef.current;
      audio.onended = () => { if (generationRef.current === generation) setSpeaking(false); };
      audio.onerror = () => {
        if (generationRef.current !== generation) return;
        setVoiceError('Audio playback failed.');
        setSpeaking(false);
      };
      await audio.play();

      // The characters were spent the moment the server answered, whether or
      // not this generation is still current, so the balance is updated here
      // rather than behind the guard above.
      setQuota((q) => (q ? { ...q, remaining: Math.max(0, q.remaining - brief.speech.length) } : q));
    } catch (e) {
      // An abort is the operator pressing STOP, not a failure to report.
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (generationRef.current !== generation) return;
      setVoiceError(e instanceof Error ? e.message : 'Voice synthesis failed.');
      setSpeaking(false);
    }
  }, [brief, voiceId]);

  if (!data && !loading) return null;

  const counts = data?.infrastructure?.counts || {};
  const items = data?.infrastructure?.items || [];
  const notEnoughQuota = quota !== null && brief !== null && quota.remaining < brief.speech.length;

  return (
    <div className="glass-panel p-3 w-[340px] max-w-[92vw] max-h-[70vh] overflow-y-auto styled-scrollbar">
      <div className="flex items-center justify-between mb-2">
        <span className="hud-text text-[10px] text-[var(--gold-primary)]">AREA ASSESSMENT</span>
        <button onClick={() => { stop(); onClose(); }} className="text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-6 justify-center text-[var(--text-muted)]">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-[10px] hud-text">READING THE GROUND…</span>
        </div>
      )}

      {!loading && data && (
        <>
          <div className="mb-2">
            <div className="text-sm text-[var(--text-primary)] leading-tight">{data.place?.name}</div>
            <div className="text-[9px] text-[var(--text-muted)] mt-0.5">
              {data.coordinates.lat.toFixed(5)}, {data.coordinates.lng.toFixed(5)}
              {data.place?.postcode ? ` · ${data.place.postcode}` : ''}
            </div>
          </div>

          {/* Voice controls sit directly under the name — the read-out IS the feature. */}
          <div className="flex items-center gap-1.5 mb-3">
            <button
              onClick={speaking ? stop : speak}
              disabled={!brief || (!speaking && (!!voiceError && !voices.length)) || notEnoughQuota}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-[var(--gold-primary)]/15 hover:bg-[var(--gold-primary)]/25 disabled:opacity-40 disabled:cursor-not-allowed border border-[var(--gold-primary)]/40 transition-colors"
              title={notEnoughQuota ? 'Not enough voice quota remaining this month' : 'Read this assessment aloud'}
            >
              {speaking ? <Square className="w-3 h-3 text-[var(--gold-primary)]" /> : <Volume2 className="w-3 h-3 text-[var(--gold-primary)]" />}
              <span className="hud-text text-[9px] text-[var(--gold-primary)]">{speaking ? 'STOP' : 'BRIEF ME'}</span>
            </button>

            {voices.length > 1 && (
              <select
                value={voiceId}
                onChange={(e) => setVoiceId(e.target.value)}
                className="bg-[var(--bg-panel)] border border-[var(--border-subtle)] rounded text-[9px] text-[var(--text-secondary)] px-1.5 py-1.5 max-w-[130px]"
                title="Briefing voice"
              >
                {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            )}

            {quota && (
              <span className="text-[8px] text-[var(--text-muted)] ml-auto tabular-nums" title="Characters left in this month's voice allowance">
                {Math.round(quota.remaining / 1000)}k left
              </span>
            )}
          </div>

          {voiceError && (
            <div className="flex items-start gap-1.5 mb-3 text-[9px] text-[var(--accent-weather)]">
              <AlertTriangle className="w-3 h-3 flex-shrink-0 mt-px" />
              <span>{voiceError}</span>
            </div>
          )}

          {/* Exactly what will be spoken. No second, prettier version. */}
          {brief && (
            <div className="mb-3 space-y-1.5">
              {brief.lines.map((line, i) => (
                <p key={i} className="text-[10px] text-[var(--text-secondary)] leading-relaxed">{line}</p>
              ))}
            </div>
          )}

          {Object.keys(counts).length > 0 && (
            <div className="mb-3">
              <div className="hud-label mb-1">WITHIN {(radius / 1000).toFixed(radius % 1000 === 0 ? 0 : 1)} KM</div>
              <div className="grid grid-cols-4 gap-1">
                {CATEGORY_ORDER.filter((c) => counts[c]).map((c) => (
                  <div key={c} className="glass-panel-sm px-1 py-1 text-center">
                    <div className="hud-value text-[11px] tabular-nums">{counts[c]}</div>
                    <div className="text-[7px] text-[var(--text-muted)] leading-tight">{CATEGORY_LABEL[c]}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {items.length > 0 && (
            <div className="mb-3">
              <div className="hud-label mb-1">MAPPED HERE</div>
              <div className="space-y-0.5 max-h-[130px] overflow-y-auto styled-scrollbar">
                {items
                  .filter((i) => i.category !== 'landmark' || items.length < 12)
                  .slice(0, 24)
                  .map((i, n) => (
                    <button
                      key={`${i.name}-${n}`}
                      onClick={() => onFocus?.(i.lat, i.lng)}
                      className="w-full text-left flex items-baseline gap-1.5 hover:bg-[var(--bg-hover)] rounded px-1 py-0.5"
                    >
                      <span className="text-[7px] text-[var(--text-muted)] w-[52px] flex-shrink-0">{CATEGORY_LABEL[i.category]}</span>
                      <span className="text-[9px] text-[var(--text-primary)] truncate">{i.name}</span>
                      <span className="text-[8px] text-[var(--text-muted)] ml-auto flex-shrink-0">{i.kind}</span>
                    </button>
                  ))}
              </div>
            </div>
          )}

          {data.nearby && data.nearby.length > 0 && (
            <div className="mb-3">
              <div className="hud-label mb-1">RECORDED AT THIS POINT</div>
              {data.nearby.slice(0, 5).map((n) => (
                <a
                  key={n.title}
                  href={`https://en.wikipedia.org/wiki/${encodeURIComponent(n.title.replace(/ /g, '_'))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-baseline gap-2 hover:bg-[var(--bg-hover)] rounded px-1 py-0.5"
                >
                  <span className="text-[9px] text-[var(--text-secondary)] truncate">{n.title}</span>
                  <span className="text-[8px] text-[var(--text-muted)] ml-auto flex-shrink-0 tabular-nums">{n.distanceM} m</span>
                </a>
              ))}
            </div>
          )}

          {data.degraded && data.degraded.length > 0 && (
            <div className="text-[8px] text-[var(--text-muted)] border-t border-[var(--border-subtle)] pt-1.5">
              Unavailable: {data.degraded.join('; ')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
