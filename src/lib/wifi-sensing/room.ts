/**
 * The operator's room, as OASIS WIFI draws it in THIS COMPUTER mode.
 * Kept free of three.js so the page can read and validate it without loading
 * the 3D engine.
 */
export interface HomeRoom {
  /** Metres, wall to wall across the view. */
  width: number;
  /** Metres, from the wall the desk stands against to the opposite wall. */
  depth: number;
  height: number;
}

export const DEFAULT_HOME_ROOM: HomeRoom = { width: 6, depth: 5, height: 2.7 };

/** Default horizontal field of view assumed for a webcam, degrees. */
export const DEFAULT_WEBCAM_HFOV = 78;

/** Clamp a room to sizes the scene can frame (a closet to a hall). */
export function sanitizeRoom(r: Partial<HomeRoom> | null | undefined): HomeRoom {
  const num = (v: unknown, lo: number, hi: number, dflt: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : dflt;
  return {
    width: num(r?.width, 2, 15, DEFAULT_HOME_ROOM.width),
    depth: num(r?.depth, 2, 15, DEFAULT_HOME_ROOM.depth),
    height: num(r?.height, 2.2, 4, DEFAULT_HOME_ROOM.height),
  };
}

/** A webcam field of view the placement math can use, degrees. */
export function sanitizeFov(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 40), 130) : DEFAULT_WEBCAM_HFOV;
}
