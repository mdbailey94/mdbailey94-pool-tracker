// Pose tracking for Jump Height: MediaPipe PoseLandmarker (lite), run on the
// live <video> element. Everything loads from ../vendor/mediapipe/ (no CDN).

const BASE = new URL('../vendor/mediapipe/', import.meta.url).href;

// Standard BlazePose skeleton as landmark index pairs (hardcoded so this
// export is synchronous and doesn't pull the 100s-of-KB bundle at import time).
export const POSE_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [15, 21], [17, 19],
  [12, 14], [14, 16], [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24], [23, 25], [24, 26], [25, 27], [26, 28],
  [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

// Only the legs are measured. Landmark indices per side: hip, knee, ankle, heel, toe.
const LEGS = { L: [23, 25, 27, 29, 31], R: [24, 26, 28, 30, 32] };
const MIN_VIS = 0.5; // the better-seen leg's ankle, heel and toe must be at least this visible
// Side-on, the far leg is hidden behind the near one for much of a jump. The model
// still places it sensibly, so it is accepted at a much lower visibility; below this
// the near leg stands in for it.
const FAR_VIS = 0.15;
// Shoulder-to-ankle length is about 1.6 x thigh + shank. The detector scales its
// thresholds by the former; measuring it from the leg means the upper body is not needed.
const BODY_PER_LEG = 1.6;
const NONE = { footL: NaN, footR: NaN, hipY: NaN, bodyLen: NaN, visible: false };

// Landmarks (33 x {x, y, visibility}, normalised to the frame) -> the detector's
// sample. y is normalised to frame height, increasing downward; aspect = width / height.
// Pure, so it can be tested without a browser.
export function legSample(P, aspect = 1) {
  if (!P) return { ...NONE };
  const leg = (side) => {
    const [hip, knee, ankle, heel, toe] = LEGS[side].map((i) => P[i]);
    const dist = (a, b) => Math.hypot((a.x - b.x) * aspect, a.y - b.y);
    return {
      vis: Math.min(ankle.visibility, heel.visibility, toe.visibility),
      inFrame: [heel, toe].every((q) => q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1),
      foot: Math.max(heel.y, toe.y), // lowest point of the foot
      len: dist(hip, knee) + dist(knee, ankle), // unchanged by bending the knee
    };
  };
  const l = leg('L'), r = leg('R');
  const best = l.vis >= r.vis ? l : r, other = best === l ? r : l;
  const otherOk = other.vis >= FAR_VIS && other.inFrame;
  return {
    footL: l === best || otherOk ? l.foot : best.foot,
    footR: r === best || otherOk ? r.foot : best.foot,
    hipY: (P[23].y + P[24].y) / 2,
    bodyLen: BODY_PER_LEG * best.len,
    visible: best.vis >= MIN_VIS && best.inFrame && Math.max(P[23].visibility, P[24].visibility) >= MIN_VIS,
  };
}

export async function createPoseTracker() {
  // Dynamic import keeps the heavy bundle off the app's startup path.
  const { PoseLandmarker } = await import(`${BASE}vision_bundle.mjs`);
  // Built by hand: FilesetResolver may pick the no-SIMD build, which we don't ship.
  const fileset = { wasmLoaderPath: `${BASE}vision_wasm_internal.js`, wasmBinaryPath: `${BASE}vision_wasm_internal.wasm` };
  const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}pose_landmarker_lite.task`, delegate },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  let landmarker, delegate = 'GPU';
  try {
    landmarker = await make('GPU');
  } catch (e) {
    console.warn('Pose GPU delegate unavailable, using CPU:', e?.message ?? e);
    delegate = 'CPU';
    landmarker = await make('CPU');
  }

  let lastMs = -1, offset = 0;

  // t in seconds. y values are returned raw: no temporal smoothing, because
  // filtering would lag/blur the takeoff and landing edges the jump timing uses.
  function detect(video, t) {
    // detectForVideo requires strictly increasing timestamps.
    // When time restarts (a file run again, a camera flip), shift the clock
    // forward so stamps keep their true spacing; the model's tracking uses it.
    let ms = Math.round(t * 1000) + offset;
    if (ms < lastMs - 100) { offset += lastMs + 1000 - ms; ms = lastMs + 1000; }
    ms = Math.max(ms, lastMs + 1);
    lastMs = ms;
    const lm = landmarker.detectForVideo(video, ms).landmarks?.[0];
    if (!lm) return { landmarks: null, sample: { ...NONE } };
    const landmarks = lm.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility ?? 0 }));
    const sample = legSample(landmarks, video.videoWidth / video.videoHeight || 1);
    return { landmarks, sample };
  }

  return { detect, close: () => landmarker.close(), delegate };
}
