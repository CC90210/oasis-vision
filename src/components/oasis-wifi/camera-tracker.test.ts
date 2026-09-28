import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The model itself cannot run under Node; these tests drive the tracker's own
// control flow around it: what it reports when inference dies or frames stop
// reaching the worker.
const detectForVideo = vi.fn(() => ({ landmarks: [], worldLandmarks: [] }));
vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: { forVisionTasks: vi.fn(async () => ({})) },
  PoseLandmarker: {
    POSE_CONNECTIONS: [],
    createFromOptions: vi.fn(async () => ({ detectForVideo, close: vi.fn() })),
  },
}));

import { CameraBodyTracker, type CameraStatus } from './camera-tracker';

class FakeWorker {
  static last: FakeWorker | null = null;
  /** Throw on every frame, as postMessage does when a bitmap cannot be transferred. */
  static refuseFrames = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  terminated = false;
  constructor() {
    FakeWorker.last = this;
  }
  postMessage(msg: { type: string }) {
    if (msg.type === 'init') queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', delegate: 'CPU' } } as MessageEvent));
    if (msg.type === 'frame' && FakeWorker.refuseFrames) throw new Error('DataCloneError: could not be transferred');
  }
  terminate() {
    this.terminated = true;
  }
}

let clock = 1000;
let frames: FrameRequestCallback[] = [];
const track = { stop: vi.fn() };
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Let one animation frame run, 100 ms after the last. */
async function nextFrame() {
  clock += 100;
  const due = frames;
  frames = [];
  due.forEach((cb) => cb(clock));
  await settle();
}

function fakeVideo(): HTMLVideoElement {
  let t = 0;
  return {
    srcObject: null,
    play: vi.fn(async () => {}),
    readyState: 4,
    // Each read is a newer frame.
    get currentTime() {
      return ++t;
    },
    videoWidth: 640,
    videoHeight: 360,
  } as unknown as HTMLVideoElement;
}

function tracker() {
  const statuses: Array<[CameraStatus, string | null]> = [];
  const t = new CameraBodyTracker(fakeVideo(), { onStatus: (s, d) => statuses.push([s, d]), onPose: () => {} });
  return { t, statuses, last: () => statuses[statuses.length - 1] };
}

beforeEach(() => {
  clock = 1000;
  frames = [];
  FakeWorker.last = null;
  FakeWorker.refuseFrames = false;
  detectForVideo.mockClear();
  track.stop.mockClear();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('location', { origin: 'http://127.0.0.1:3177' });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) } });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CameraBodyTracker', () => {
  it('keeps the reason on screen when inference dies mid-session', async () => {
    const { t, last } = tracker();
    await t.start();
    await settle();
    FakeWorker.last!.onmessage!({ data: { type: 'error', message: 'WebGL context lost' } } as MessageEvent);

    // Not 'off': that left the preview on "starting" with nothing to act on.
    expect(last()[0]).toBe('error');
    expect(last()[1]).toMatch(/WebGL context lost/);
    expect(last()[1]).toMatch(/off and on/);
    expect(FakeWorker.last!.terminated).toBe(true);
    expect(track.stop).toHaveBeenCalled();
  });

  it('keeps the reason on screen when the worker crashes', async () => {
    const { t, last } = tracker();
    await t.start();
    FakeWorker.last!.onerror!(new Error('crash'));
    expect(last()).toEqual(['error', expect.stringMatching(/worker crashed/)]);
  });

  it('reports off, not an error, when the operator turns it off', async () => {
    const { t, last } = tracker();
    await t.start();
    t.stop();
    expect(last()).toEqual(['off', null]);
  });

  it('moves to the main thread when frames keep failing to reach the worker', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => Promise.reject(new Error('capture failed'))));
    const { t, statuses } = tracker();
    await t.start(); // the first frame is captured (and fails) as the loop starts
    await settle();
    for (let i = 0; i < 3; i++) await nextFrame();
    // Four bad frames in a row: still the worker's.
    expect(FakeWorker.last!.terminated).toBe(false);
    expect(console.warn).toHaveBeenCalledWith('[oasis-wifi] could not hand a camera frame to the worker:', expect.any(Error));

    await nextFrame(); // the fifth
    await settle();
    expect(FakeWorker.last!.terminated).toBe(true);

    await nextFrame();
    expect(detectForVideo).toHaveBeenCalled();
    expect(statuses.some(([s]) => s === 'error')).toBe(false);
  });

  it('counts a frame the worker refuses, and frees it', async () => {
    FakeWorker.refuseFrames = true;
    const bitmaps: Array<{ close: ReturnType<typeof vi.fn> }> = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      const b = { close: vi.fn() };
      bitmaps.push(b);
      return b;
    }));
    const { t } = tracker();
    await t.start();
    await settle();
    for (let i = 0; i < 4; i++) await nextFrame();
    await settle();

    expect(FakeWorker.last!.terminated).toBe(true);
    expect(bitmaps).toHaveLength(5);
    expect(bitmaps.every((b) => b.close.mock.calls.length === 1)).toBe(true);
    await nextFrame();
    expect(detectForVideo).toHaveBeenCalled();
  });

  it('lets a single bad frame go', async () => {
    let calls = 0;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => (++calls === 1 ? Promise.reject(new Error('mode change')) : { close: vi.fn() })));
    const { t } = tracker();
    await t.start();
    await settle();
    for (let i = 0; i < 6; i++) {
      await nextFrame();
      // The worker answers each frame, so the next can go.
      FakeWorker.last!.onmessage!({ data: { type: 'pose', image: null, world: null, aspect: 16 / 9, ms: 50 } } as MessageEvent);
    }
    expect(FakeWorker.last!.terminated).toBe(false);
    expect(detectForVideo).not.toHaveBeenCalled();
  });
});
