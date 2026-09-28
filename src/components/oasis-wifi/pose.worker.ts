/// <reference lib="webworker" />
/**
 * Pose inference off the main thread.
 *
 * On the main thread one inference took 68 ms (measured on CC's Ryzen 5
 * 5600GT), which at 12 a second left the 3D scene 13 fps. Here the scene keeps
 * its thread; this worker takes one frame at a time (an ImageBitmap the page
 * transfers in) and answers with the pose.
 *
 * GPU or CPU: neither wins everywhere. On that APU, with the 3D scene sharing
 * the integrated GPU, the CPU path took 148 ms and the GPU path 195 ms; a Mac's
 * GPU is likely the reverse. So both are loaded when possible, the first few
 * real frames are timed on each, and the slower one is closed.
 *
 * Which MediaPipe build loads depends on how the bundler starts this worker.
 * Turbopack runs it as a CLASSIC worker even when asked for a module one
 * (measured: its bootstrap is loaded with importScripts), and there the
 * module build fails with "Cannot use 'import.meta' outside a module". So the
 * classic build is tried first and the module build second.
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

type InitMsg = { type: 'init'; wasmBase: string; model: string };
type FrameMsg = { type: 'frame'; bitmap: ImageBitmap; ts: number };
type Delegate = 'GPU' | 'CPU';

interface Candidate {
  lm: PoseLandmarker;
  delegate: Delegate;
  runs: number;
  totalMs: number;
}

/** Timed frames per candidate before choosing (the first of each is a warm-up and not counted). */
const TRIAL_RUNS = 4;

let candidates: Candidate[] = [];
let chosen: Candidate | null = null;

const post = (msg: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

async function create(msg: InitMsg, useModule: boolean, delegate: Delegate): Promise<PoseLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase, useModule);
  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: msg.model, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

async function init(msg: InitMsg): Promise<void> {
  let first: unknown = null;
  for (const useModule of [false, true]) {
    for (const delegate of ['GPU', 'CPU'] as const) {
      try {
        candidates.push({ lm: await create(msg, useModule, delegate), delegate, runs: 0, totalMs: 0 });
      } catch (e) {
        first ??= e;
      }
    }
    if (candidates.length) break;
  }
  if (!candidates.length) {
    post({ type: 'error', message: (first as Error)?.message ?? String(first) });
    return;
  }
  if (candidates.length === 1) chosen = candidates[0];
  post({ type: 'ready', delegate: chosen?.delegate ?? null });
}

/** The candidate to run this frame on: the chosen one, or the least-tried during the trial. */
function pick(): Candidate | null {
  if (chosen) return chosen;
  return candidates.reduce((a, b) => (b.runs < a.runs ? b : a), candidates[0]) ?? null;
}

function settle(): void {
  if (chosen || !candidates.every((c) => c.runs > TRIAL_RUNS)) return;
  const avg = (c: Candidate) => c.totalMs / TRIAL_RUNS;
  chosen = candidates.reduce((a, b) => (avg(b) < avg(a) ? b : a));
  for (const c of candidates) if (c !== chosen) c.lm.close();
  candidates = [chosen];
  post({ type: 'chosen', delegate: chosen.delegate, ms: Math.round(avg(chosen)) });
}

function frame(msg: FrameMsg): void {
  const { bitmap } = msg;
  const c = pick();
  if (!c) {
    bitmap.close();
    return;
  }
  const t0 = performance.now();
  try {
    const r = c.lm.detectForVideo(bitmap, msg.ts);
    const ms = performance.now() - t0;
    if (!chosen) {
      if (c.runs > 0) c.totalMs += ms; // first run of each is warm-up
      c.runs++;
      settle();
    }
    post({
      type: 'pose',
      image: r.landmarks[0] ?? null,
      world: r.worldLandmarks[0] ?? null,
      aspect: bitmap.width / Math.max(1, bitmap.height),
      ms,
      delegate: c.delegate,
    });
  } catch (e) {
    post({ type: 'error', message: (e as Error)?.message ?? String(e) });
  } finally {
    bitmap.close();
  }
}

self.onmessage = (e: MessageEvent<InitMsg | FrameMsg>) => {
  if (e.data.type === 'init') void init(e.data);
  else if (e.data.type === 'frame') frame(e.data);
};
