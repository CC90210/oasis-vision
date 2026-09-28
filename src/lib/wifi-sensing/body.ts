/**
 * Placing a webcam-tracked body in the OASIS WIFI room.
 *
 * MediaPipe's pose landmarker (BlazePose GHUM 3D) returns, per frame, 33
 * landmarks twice over:
 *   - `image`: normalized to the frame (x, y in 0..1, y down);
 *   - `world`: metres, origin midway between the hips, x to the image's
 *     right, y down, z away from the camera.
 *
 * The world landmarks give the body's SHAPE in real units; they carry no
 * position. Where the person stands is estimated separately:
 *   - direction, from where the hips sit across the frame and the lens's
 *     field of view;
 *   - distance, from how tall the torso appears (pinhole camera, average
 *     adult torso).
 * Google's model card lists metric-accurate depth as out of scope, so the
 * distance is an estimate. The view says "approximate" and never shows it
 * to the centimetre.
 */

export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** BlazePose index for each COCO-17 keypoint, the order the figure engine uses. */
export const COCO_FROM_BLAZEPOSE = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28] as const;

const L_SHOULDER = 11, R_SHOULDER = 12, L_HIP = 23, R_HIP = 24, L_ANKLE = 27, R_ANKLE = 28;

/** Adult shoulder-midpoint to hip-midpoint distance, metres. */
export const TORSO_M = 0.5;
/** Ankle joint height above the floor, metres. */
const ANKLE_HEIGHT_M = 0.08;
/** Hip height used when both ankles are out of frame. */
const DEFAULT_HIP_HEIGHT_M = 0.95;

export type Vec3 = [number, number, number];

export interface CameraRig {
  /** Camera position in the room, metres (y is its height). */
  position: Vec3;
  /** Horizontal viewing direction; normalized internally. */
  forward: [number, number];
  /** Horizontal field of view, degrees. */
  hfovDeg: number;
  /** Frame width / height. */
  aspect: number;
}

export interface Placement {
  /** Metres to the camera's right (negative = left). */
  lateral: number;
  /** Metres in front of the camera, along its view. */
  distance: number;
}

const visible = (l: Landmark | undefined, min = 0.5) => !!l && (l.visibility ?? 1) >= min;

/** Both shoulders and both hips seen clearly enough to place and pose a body. */
export function isTrackable(image: Landmark[] | undefined): boolean {
  if (!image || image.length < 33) return false;
  return [L_SHOULDER, R_SHOULDER, L_HIP, R_HIP].every((i) => visible(image[i]));
}

function mid(a: Landmark, b: Landmark): { x: number; y: number } {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Where the person stands relative to the camera, or null if untrackable. */
export function estimatePlacement(image: Landmark[], rig: CameraRig): Placement | null {
  if (!isTrackable(image)) return null;
  const aspect = rig.aspect > 0 ? rig.aspect : 16 / 9;
  const hfov = (Math.min(Math.max(rig.hfovDeg, 30), 150) * Math.PI) / 180;
  // Focal length in units of frame HEIGHT, so vertical and horizontal distances share a unit.
  const f = (aspect / 2) / Math.tan(hfov / 2);

  const shoulders = mid(image[L_SHOULDER], image[R_SHOULDER]);
  const hips = mid(image[L_HIP], image[R_HIP]);
  const torso = Math.hypot((shoulders.x - hips.x) * aspect, shoulders.y - hips.y);
  if (!(torso > 0.01)) return null;

  const distance = Math.min(Math.max((f * TORSO_M) / torso, 0.4), 8);
  const lateral = (distance * (hips.x - 0.5) * aspect) / f;
  return { lateral, distance };
}

function basis(rig: CameraRig): { F: Vec3; R: Vec3 } {
  const [fx, fz] = rig.forward;
  const len = Math.hypot(fx, fz) || 1;
  const F: Vec3 = [fx / len, 0, fz / len];
  // right = forward x up, in three.js's right-handed frame.
  const R: Vec3 = [-F[2], 0, F[0]];
  return { F, R };
}

export interface RoomBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface RoomBody {
  /** 17 COCO keypoints in room coordinates, metres. */
  keypoints: Vec3[];
  /** Where the body stands on the floor. */
  anchor: Vec3;
}

/**
 * The body in room coordinates: the world-landmark shape, turned to the
 * camera's frame, stood on the floor at the estimated placement.
 */
export function toRoomBody(
  world: Landmark[],
  image: Landmark[],
  placement: Placement,
  rig: CameraRig,
  bounds?: RoomBounds,
): RoomBody | null {
  if (!world || world.length < 33) return null;
  const { F, R } = basis(rig);
  let ax = rig.position[0] + F[0] * placement.distance + R[0] * placement.lateral;
  let az = rig.position[2] + F[2] * placement.distance + R[2] * placement.lateral;
  if (bounds) {
    // Keep a body the estimate overshoots inside the walls (0.3 m in).
    ax = Math.min(Math.max(ax, bounds.minX + 0.3), bounds.maxX - 0.3);
    az = Math.min(Math.max(az, bounds.minZ + 0.3), bounds.maxZ - 0.3);
  }

  // Hip-relative shape, turned into the room: image-right -> R, image-down -> -up,
  // away-from-camera -> F.
  const shape: Vec3[] = COCO_FROM_BLAZEPOSE.map((bi) => {
    const w = world[bi];
    return [R[0] * w.x + F[0] * w.z, -w.y, R[2] * w.x + F[2] * w.z];
  });

  // Stand it on the floor: the lower visible ankle at ankle height; if the
  // ankles are out of frame, a typical hip height.
  const ankles = [L_ANKLE, R_ANKLE].filter((i) => visible(image[i], 0.4)).map((i) => -world[i].y);
  const lift = ankles.length ? ANKLE_HEIGHT_M - Math.min(...ankles) : DEFAULT_HIP_HEIGHT_M;

  const keypoints = shape.map(([x, y, z]) => [ax + x, y + lift, az + z] as Vec3);
  return { keypoints, anchor: [ax, 0, az] };
}

/** Exponential smoothing for a placement, so distance jitter does not shake the figure. */
export function smoothPlacement(prev: Placement | null, next: Placement, alpha = 0.3): Placement {
  if (!prev) return next;
  return {
    lateral: prev.lateral + (next.lateral - prev.lateral) * alpha,
    distance: prev.distance + (next.distance - prev.distance) * alpha,
  };
}
