'use client';

import { useEffect } from 'react';
import { VISION_MODES, visionFilterCss, visionFilterDefs, type VisionModeId } from '@/lib/vision-modes';

/**
 * Sensor-look vision modes over the map.
 *
 * The filter is applied to the map's container rather than to the canvas
 * element: MapLibre owns the canvas and rewrites its style on resize, so a
 * filter set there is silently dropped the first time the window changes size.
 *
 * The SVG defs live in a zero-size, aria-hidden svg — it exists only to host
 * the filter definitions that `filter: url(#…)` points at.
 */
export function VisionFilterDefs() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="0"
      height="0"
      style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
      dangerouslySetInnerHTML={{ __html: `<defs>${visionFilterDefs()}</defs>` }}
    />
  );
}

/** Applies the active mode's filter to the map container. */
export function useVisionMode(mode: VisionModeId) {
  useEffect(() => {
    const container =
      document.querySelector<HTMLElement>('.maplibregl-map') ??
      document.querySelector<HTMLElement>('canvas.maplibregl-canvas')?.parentElement ??
      null;
    if (!container) return;

    const css = visionFilterCss(mode);
    container.style.filter = css;
    // A filtered element becomes its own stacking context; without this the
    // HUD panels layered over the map inherit the thermal palette too.
    container.style.willChange = css ? 'filter' : '';

    return () => {
      container.style.filter = '';
      container.style.willChange = '';
    };
  }, [mode]);
}

interface Props {
  mode: VisionModeId;
  onChange: (m: VisionModeId) => void;
}

/** The picker. Each mode carries its own honest one-line description. */
export default function VisionModePicker({ mode, onChange }: Props) {
  const active = VISION_MODES.find(m => m.id === mode) ?? VISION_MODES[0];

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {VISION_MODES.map(m => {
          const on = m.id === mode;
          return (
            <button
              key={m.id}
              onClick={() => onChange(m.id)}
              title={m.blurb}
              className="px-2 py-1 rounded text-[9px] font-mono font-bold tracking-wider transition-colors border"
              style={{
                color: on ? 'var(--gold-primary)' : 'var(--text-secondary)',
                background: on ? 'color-mix(in srgb, var(--gold-primary) 12%, transparent)' : 'transparent',
                borderColor: on ? 'color-mix(in srgb, var(--gold-primary) 45%, transparent)' : 'var(--border-secondary)',
              }}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      {/* Says what the mode is, so THERMAL is never mistaken for a sensor. */}
      <div className="text-[9px] font-mono leading-snug text-[var(--text-secondary)]">
        {active.blurb}
      </div>
    </div>
  );
}
