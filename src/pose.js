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

const MIN_VIS = 0.5; // hips, ankles, heels, toes must be at least this visible
const NEEDED = [23, 24, 27, 28, 29, 30, 31, 32];

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
  const none = { footL: NaN, footR: NaN, hipY: NaN, bodyLen: NaN, visible: false };

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
    if (!lm) return { landmarks: null, sample: { ...none } };
    const landmarks = lm.map((p) => ({ x: p.x, y: p.y, visibility: p.visibility ?? 0 }));
    const P = landmarks;
    const mid = (a, b, k) => (P[a][k] + P[b][k]) / 2;
    // Normalise to frame height (x scaled by W/H) so bodyLen is isotropic.
    const ar = video.videoWidth / video.videoHeight || 1;
    const sample = {
      footL: Math.max(P[29].y, P[31].y),
      footR: Math.max(P[30].y, P[32].y),
      hipY: mid(23, 24, 'y'),
      bodyLen: Math.hypot((mid(11, 12, 'x') - mid(27, 28, 'x')) * ar, mid(11, 12, 'y') - mid(27, 28, 'y')),
      visible:
        NEEDED.every((i) => P[i].visibility >= MIN_VIS) &&
        [29, 30, 31, 32].every((i) => P[i].x >= 0 && P[i].x <= 1 && P[i].y >= 0 && P[i].y <= 1),
    };
    return { landmarks, sample };
  }

  return { detect, close: () => landmarker.close(), delegate };
}
