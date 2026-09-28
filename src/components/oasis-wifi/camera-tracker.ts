/**
 * Webcam body tracking for OASIS WIFI, in the browser.
 *
 * Google MediaPipe's pose landmarker (Apache-2.0, model card: BlazePose GHUM
 * 3D) runs on this machine from files served by this app (public/mediapipe).
 * The video is never recorded, uploaded or sent anywhere: frames go from the
 * camera to the model and are dropped.
 *
 * Inference runs in a Web Worker (pose.worker.ts), one frame at a time, so the
 * 3D scene keeps the main thread. If a worker cannot start, it falls back to
 * the main thread and says so in the stats.
 *
 * The model card sets the limits the view must respect: ONE person, within
 * about 4 m of the camera, head in frame, approximate depth.
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark } from '@/lib/wifi-sensing/body';

export type CameraStatus = 'off' | 'starting' | 'tracking' | 'no-person' | 'error';

export interface PoseFrame {
  image: Landmark[];
  world: Landmark[];
  /** Frame width / height. */
  aspect: number;
}

export interface TrackerStats {
  /** Poses per second achieved. */
  rate: number;
  /** Mean time one inference took, ms. */
  ms: number;
  /** Where inference runs: the worker, or the page's own thread (fallback). */
  where: 'worker' | 'main';
  /** The processor the model runs on. */
  delegate: 'GPU' | 'CPU' | null;
}

export interface CameraTrackerEvents {
  onStatus: (status: CameraStatus, detail: string | null) => void;
  /** A tracked body, or null when the frame holds nobody. */
  onPose: (pose: PoseFrame | null) => void;
  /** Once a second. */
  onStats?: (stats: TrackerStats) => void;
}

const WASM_BASE = '/mediapipe/wasm';
const MODEL = '/mediapipe/pose_landmarker_lite.task';
/** At most ~15 poses a second; in the worker the real ceiling is one inference at a time. */
const MIN_INTERVAL_MS = 66;
/** A worker that has not loaded the model by now is treated as unavailable. */
const WORKER_READY_MS = 30_000;
/** Frames in a row that may fail to reach the worker before tracking moves to the main thread. */
const CAPTURE_FAILURES_MAX = 5;

export const POSE_CONNECTIONS = PoseLandmarker.POSE_CONNECTIONS;

/** Say why the camera could not start, in terms the operator can act on. */
export function describeCameraError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was refused. Allow the camera for this app (the camera icon in the address bar or site settings), then turn CAMERA on again.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this computer.';
  if (name === 'NotReadableError' || name === 'AbortError') {
    return 'The camera is in use by another app (a call, OBS, the Camera app). Close it and try again.';
  }
  return `Camera tracking failed to start: ${(e as Error)?.message ?? String(e)}`;
}

export class CameraBodyTracker {
  private stream: MediaStream | null = null;
  private worker: Worker | null = null;
  private landmarker: PoseLandmarker | null = null;
  private busy = false;
  private raf = 0;
  private lastRun = 0;
  private lastVideoTime = -1;
  private stopped = false;
  private seen: 'person' | 'nobody' | null = null;
  private statsSince = 0;
  private statsRuns = 0;
  private statsMs = 0;
  private delegate: 'GPU' | 'CPU' | null = null;
  private captureFailures = 0;

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly events: CameraTrackerEvents,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.events.onStatus('starting', 'Opening the camera…');
    if (!navigator.mediaDevices?.getUserMedia) {
      // Browsers only expose cameras to secure pages; 127.0.0.1 counts, a LAN IP over http does not.
      this.events.onStatus('error', 'This page cannot use a camera here. Open OASIS VISION on this computer (http://127.0.0.1:3177), or over HTTPS.');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        // 16:9, the shape of webcam sensors: a 4:3 request makes most of them
        // crop the sides, which narrows the lens and throws the distance
        // estimate off (measured: the same frame read 1.8 m, then 1.4 m).
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30 }, facingMode: 'user' },
      });
    } catch (e) {
      this.events.onStatus('error', describeCameraError(e));
      return;
    }
    if (this.stopped) return this.release();
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    try {
      await this.video.play();
    } catch (e) {
      this.events.onStatus('error', `The camera opened but its video would not play: ${(e as Error).message}`);
      return this.release();
    }

    this.events.onStatus('starting', 'Loading the body-tracking model…');
    if (!(await this.startWorker())) {
      console.warn('[oasis-wifi] pose worker unavailable; tracking on the main thread');
      if (!(await this.loadOnMainThread())) return;
    }
    if (this.stopped) return this.release();
    this.events.onStatus('no-person', 'Step into the camera’s view.');
    this.loop();
  }

  /** Resolves true once the worker has the model loaded. */
  private startWorker(): Promise<boolean> {
    let w: Worker;
    try {
      w = new Worker(new URL('./pose.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      // Not this.fail(): a worker that never starts is replaced by the main thread, not an error.
      const unavailable = () => {
        clearTimeout(timer);
        w.terminate();
        resolve(false);
      };
      const timer = setTimeout(unavailable, WORKER_READY_MS);
      w.onerror = unavailable;
      w.onmessage = (e: MessageEvent) => {
        if (e.data?.type === 'ready') {
          clearTimeout(timer);
          this.delegate = e.data.delegate ?? null;
          this.worker = w;
          w.onmessage = this.onWorkerMessage;
          w.onerror = () => this.fail('Body tracking stopped: its worker crashed.');
          resolve(true);
        } else if (e.data?.type === 'error') {
          console.warn('[oasis-wifi] pose worker failed to start:', e.data.message);
          unavailable();
        }
      };
      w.postMessage({ type: 'init', wasmBase: location.origin + WASM_BASE, model: location.origin + MODEL });
    });
  }

  private onWorkerMessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type === 'chosen') {
      // The worker has timed GPU against CPU on real frames and kept the faster.
      this.delegate = msg.delegate;
      console.info(`[oasis-wifi] pose tracking on ${msg.delegate} (${msg.ms} ms a pose)`);
      return;
    }
    this.busy = false;
    if (this.stopped) return;
    if (msg?.type === 'pose') {
      this.delegate = msg.delegate ?? this.delegate;
      this.report(msg.image && msg.world ? { image: msg.image, world: msg.world, aspect: msg.aspect } : null, msg.ms, 'worker');
    } else if (msg?.type === 'error') {
      this.fail(`Body tracking stopped: ${msg.message}`);
    }
  };

  /** Track on the page's own thread instead of a worker: slower, and the stats say so. */
  private async loadOnMainThread(): Promise<boolean> {
    try {
      const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
      this.landmarker = await this.create(fileset, 'GPU')
        .then((l) => ((this.delegate = 'GPU'), l))
        .catch(() => this.create(fileset, 'CPU').then((l) => ((this.delegate = 'CPU'), l)));
    } catch (e) {
      this.fail(`The body-tracking model failed to load: ${(e as Error).message}`);
      return false;
    }
    if (this.stopped) {
      this.release();
      return false;
    }
    return true;
  }

  /** Frames keep failing to reach the worker: carry on without it. */
  private async abandonWorker(reason: unknown): Promise<void> {
    if (!this.worker) return;
    console.warn('[oasis-wifi] camera frames cannot reach the pose worker; tracking on the main thread:', reason);
    this.worker.terminate();
    this.worker = null;
    this.busy = false;
    await this.loadOnMainThread();
  }

  private create(fileset: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>, delegate: 'GPU' | 'CPU') {
    return PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  }

  private loop = () => {
    if (this.stopped) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (this.busy || now - this.lastRun < MIN_INTERVAL_MS) return;
    if (this.video.readyState < 2 || this.video.currentTime === this.lastVideoTime) return;
    this.lastRun = now;
    this.lastVideoTime = this.video.currentTime;

    if (this.worker) {
      // One frame in flight at a time: the worker sets the pace.
      this.busy = true;
      // Half size: the model downsizes to 256 px anyway, and a smaller bitmap
      // is cheaper to hand over and to convert.
      const w = Math.max(160, Math.round(this.video.videoWidth / 2));
      const h = Math.max(120, Math.round(this.video.videoHeight / 2));
      createImageBitmap(this.video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' })
        .then((bitmap) => {
          if (this.stopped || !this.worker) {
            bitmap.close();
            this.busy = false;
            return;
          }
          try {
            this.worker.postMessage({ type: 'frame', bitmap, ts: now }, [bitmap]);
          } catch (e) {
            // Not transferred, so still ours to free.
            bitmap.close();
            throw e;
          }
          this.captureFailures = 0;
        })
        .catch((e) => {
          this.busy = false;
          // One bad frame (the camera changing mode) is let go; a run of them is not.
          if (++this.captureFailures === 1) console.warn('[oasis-wifi] could not hand a camera frame to the worker:', e);
          if (this.captureFailures >= CAPTURE_FAILURES_MAX) void this.abandonWorker(e);
        });
      return;
    }

    if (!this.landmarker) return;
    let result;
    try {
      result = this.landmarker.detectForVideo(this.video, now);
    } catch (e) {
      this.fail(`Body tracking stopped: ${(e as Error).message}`);
      return;
    }
    const aspect = this.video.videoWidth / Math.max(1, this.video.videoHeight);
    const image = result.landmarks[0];
    const world = result.worldLandmarks[0];
    this.report(image && world ? { image, world, aspect } : null, performance.now() - now, 'main');
  };

  private report(pose: PoseFrame | null, ms: number, where: TrackerStats['where']): void {
    this.events.onPose(pose);
    if (pose && this.seen !== 'person') {
      this.seen = 'person';
      this.events.onStatus('tracking', null);
    } else if (!pose && this.seen !== 'nobody') {
      this.seen = 'nobody';
      this.events.onStatus('no-person', 'Nobody in the camera’s view.');
    }
    const t = performance.now();
    this.statsRuns++;
    this.statsMs += ms;
    if (t - this.statsSince >= 1000) {
      if (this.statsSince) {
        this.events.onStats?.({
          rate: Math.round((this.statsRuns * 1000) / (t - this.statsSince)),
          ms: Math.round(this.statsMs / Math.max(1, this.statsRuns)),
          where,
          delegate: this.delegate,
        });
      }
      this.statsSince = t;
      this.statsRuns = 0;
      this.statsMs = 0;
    }
  }

  stop(): void {
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.release();
    this.events.onStatus('off', null);
  }

  /** Stop on a failure, keeping its reason on screen (stop() would replace it with 'off'). */
  private fail(detail: string): void {
    if (this.stopped) return;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    this.release();
    this.events.onPose(null);
    this.events.onStatus('error', `${detail} Turn CAMERA off and on to try again.`);
  }

  private release(): void {
    this.worker?.terminate();
    this.worker = null;
    this.landmarker?.close();
    this.landmarker = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}
