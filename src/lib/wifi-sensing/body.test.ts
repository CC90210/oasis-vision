import { describe, expect, it } from 'vitest';
import { COCO_FROM_BLAZEPOSE, MAX_RANGE_M, isTrackable, placeBody, smoothPlacement, toRoomBody, type CameraRig, type Landmark, type Placement } from './body';

/** 33 landmarks, all hidden, then the ones a test cares about set. */
function blank(): Landmark[] {
  return Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
}

/** A person standing square to the camera, centred at `cx`, torso `torso` of the frame height. */
function imageOf(cx = 0.5, torso = 0.2, anklesVisible = true): Landmark[] {
  const lm = blank();
  const hipY = 0.55;
  const set = (i: number, x: number, y: number, v = 0.99) => (lm[i] = { x, y, z: 0, visibility: v });
  set(11, cx + 0.04, hipY - torso); // left shoulder (appears on image right)
  set(12, cx - 0.04, hipY - torso);
  set(23, cx + 0.03, hipY);
  set(24, cx - 0.03, hipY);
  set(27, cx + 0.03, hipY + torso * 1.6, anklesVisible ? 0.99 : 0.05);
  set(28, cx - 0.03, hipY + torso * 1.6, anklesVisible ? 0.99 : 0.05);
  return lm;
}

/** The same person in metres, hip-centred: y down, z away from the camera. */
function worldOf(): Landmark[] {
  const lm = blank();
  const set = (i: number, x: number, y: number, z = 0) => (lm[i] = { x, y, z, visibility: 0.99 });
  set(0, 0, -0.75, -0.1); // nose, forward of the hips
  set(2, 0.03, -0.78, -0.08);
  set(5, -0.03, -0.78, -0.08);
  set(7, 0.07, -0.76, 0);
  set(8, -0.07, -0.76, 0);
  set(11, 0.2, -0.5);
  set(12, -0.2, -0.5);
  set(13, 0.25, -0.25);
  set(14, -0.25, -0.25);
  set(15, 0.27, 0);
  set(16, -0.27, 0);
  set(23, 0.1, 0);
  set(24, -0.1, 0);
  set(25, 0.1, 0.45);
  set(26, -0.1, 0.45);
  set(27, 0.1, 0.85);
  set(28, -0.1, 0.85);
  return lm;
}

// A webcam on a desk against the back wall, 1.2 m up, looking into the room (+z).
const RIG: CameraRig = { position: [0, 1.2, -2.5], forward: [0, 1], hfovDeg: 78, aspect: 16 / 9 };
const F = (16 / 9 / 2) / Math.tan((39 * Math.PI) / 180);

describe('COCO_FROM_BLAZEPOSE', () => {
  it('maps the 17 COCO joints to their BlazePose indices', () => {
    expect(COCO_FROM_BLAZEPOSE).toHaveLength(17);
    // nose, shoulders, hips and ankles are where the figure engine expects them
    expect(COCO_FROM_BLAZEPOSE[0]).toBe(0);
    expect([COCO_FROM_BLAZEPOSE[5], COCO_FROM_BLAZEPOSE[6]]).toEqual([11, 12]);
    expect([COCO_FROM_BLAZEPOSE[11], COCO_FROM_BLAZEPOSE[12]]).toEqual([23, 24]);
    expect([COCO_FROM_BLAZEPOSE[15], COCO_FROM_BLAZEPOSE[16]]).toEqual([27, 28]);
  });
});

describe('isTrackable', () => {
  it('needs both shoulders and both hips', () => {
    expect(isTrackable(imageOf())).toBe(true);
    const lm = imageOf();
    lm[12] = { ...lm[12], visibility: 0.2 };
    expect(isTrackable(lm)).toBe(false);
    expect(isTrackable(undefined)).toBe(false);
    expect(isTrackable(blank().slice(0, 20))).toBe(false);
  });
});

/** The placement of a body the test expects to be placed. */
function placed(image: Landmark[]): Placement {
  const r = placeBody(image, RIG);
  if (!r.ok) throw new Error(`not placed: ${r.reason}`);
  return r.placement;
}

describe('placeBody', () => {
  it('reads distance from how tall the torso appears', () => {
    const p = placed(imageOf(0.5, 0.2));
    expect(p.distance).toBeCloseTo((F * 0.5) / 0.2, 5);
    expect(p.distance).toBeGreaterThan(2.5);
    expect(p.distance).toBeLessThan(3);
    expect(p.lateral).toBeCloseTo(0, 6);
  });

  it('puts a bigger torso closer', () => {
    const far = placed(imageOf(0.5, 0.15));
    const near = placed(imageOf(0.5, 0.3));
    expect(near.distance).toBeLessThan(far.distance);
  });

  it('reads direction from where the hips sit across the frame', () => {
    const p = placed(imageOf(0.75, 0.2));
    expect(p.lateral).toBeCloseTo((p.distance * 0.25 * (16 / 9)) / F, 6);
    expect(p.lateral).toBeGreaterThan(0.9);
    expect(placed(imageOf(0.25, 0.2)).lateral).toBeCloseTo(-p.lateral, 6);
  });

  it('refuses a body whose shoulders or hips it cannot see', () => {
    const lm = imageOf();
    lm[23] = { ...lm[23], visibility: 0 };
    expect(placeBody(lm, RIG)).toEqual({ ok: false, reason: 'partial' });
  });

  it("refuses a body past the model's range rather than drawing it there", () => {
    // With this lens a torso 0.12 of the frame tall is about 4.6 m away.
    expect(placeBody(imageOf(0.5, 0.12), RIG)).toEqual({ ok: false, reason: 'too-far' });
    const edge = placed(imageOf(0.5, (F * 0.5) / (MAX_RANGE_M - 0.05)));
    expect(edge.distance).toBeCloseTo(MAX_RANGE_M - 0.05, 5);
  });

  it('refuses a torso of zero height instead of placing it at infinity', () => {
    const lm = imageOf();
    for (const i of [11, 12]) lm[i] = { ...lm[i], y: lm[23].y };
    expect(placeBody(lm, RIG)).toEqual({ ok: false, reason: 'too-far' });
  });
});

describe('toRoomBody', () => {
  it('stands the body on the floor in front of the camera, head up', () => {
    const body = toRoomBody(worldOf(), imageOf(), { lateral: 0, distance: 2 }, RIG)!;
    expect(body.anchor).toEqual([0, 0, -0.5]);
    const [ankleL, ankleR] = [body.keypoints[15], body.keypoints[16]];
    expect(Math.min(ankleL[1], ankleR[1])).toBeCloseTo(0.08, 6);
    const nose = body.keypoints[0];
    expect(nose[1]).toBeCloseTo(0.08 + 0.85 + 0.75, 6);
    expect(nose[1]).toBeGreaterThan(body.keypoints[11][1]);
  });

  it('faces the camera: the nose is nearer the camera than the hips', () => {
    const body = toRoomBody(worldOf(), imageOf(), { lateral: 0, distance: 2 }, RIG)!;
    const camZ = RIG.position[2];
    const hipZ = (body.keypoints[11][2] + body.keypoints[12][2]) / 2;
    expect(Math.abs(body.keypoints[0][2] - camZ)).toBeLessThan(Math.abs(hipZ - camZ));
  });

  it("puts the image's right on the camera's right", () => {
    // Looking along +z in three.js, the camera's right is -x.
    const body = toRoomBody(worldOf(), imageOf(), { lateral: 1, distance: 2 }, RIG)!;
    expect(body.anchor[0]).toBeCloseTo(-1, 6);
    // left shoulder (world +x, image right) ends up on the camera's right too
    expect(body.keypoints[5][0]).toBeLessThan(body.keypoints[6][0]);
  });

  it('follows a camera that looks another way', () => {
    const sideways: CameraRig = { ...RIG, position: [-3, 1.2, 0], forward: [1, 0] };
    const body = toRoomBody(worldOf(), imageOf(), { lateral: 0, distance: 2 }, sideways)!;
    expect(body.anchor[0]).toBeCloseTo(-1, 6);
    expect(body.anchor[2]).toBeCloseTo(0, 6);
  });

  it('keeps an overshooting estimate inside the walls', () => {
    const bounds = { minX: -3, maxX: 3, minZ: -2.5, maxZ: 2.5 };
    const body = toRoomBody(worldOf(), imageOf(), { lateral: 0, distance: 9 }, RIG, bounds)!;
    expect(body.anchor[2]).toBeCloseTo(2.2, 6);
  });

  it('uses a typical hip height when the ankles are out of frame', () => {
    const body = toRoomBody(worldOf(), imageOf(0.5, 0.2, false), { lateral: 0, distance: 1 }, RIG)!;
    expect(body.keypoints[11][1]).toBeCloseTo(0.95, 6);
  });
});

describe('smoothPlacement', () => {
  it('moves part of the way toward the new estimate', () => {
    const s = smoothPlacement({ lateral: 0, distance: 2 }, { lateral: 1, distance: 3 }, 0.3);
    expect(s.lateral).toBeCloseTo(0.3, 6);
    expect(s.distance).toBeCloseTo(2.3, 6);
    expect(smoothPlacement(null, { lateral: 1, distance: 3 })).toEqual({ lateral: 1, distance: 3 });
  });
});
