// Lanes and placement: which athlete a tracked body belongs to, whether they
// are standing where the camera can measure them, and how the phone is tilted.
// Pure (no DOM), so it is tested in Node.

import { legSample } from './pose.js';

export const MAX_ATHLETES = 3;

// The screen is split into n equal vertical sections, numbered left to right as
// the viewer sees them. x is 0..1 across the frame; the front camera's picture is
// shown mirrored, so its lanes run the other way.
export function laneOf(x, n, mirrored = false) {
  const i = Math.min(n - 1, Math.max(0, Math.floor((mirrored ? 1 - x : x) * n)));
  return Number.isFinite(i) ? i : -1;
}

// Left and right edge of a lane in frame coordinates (not mirrored: for drawing on
// the overlay, which is mirrored together with the video).
export function laneBounds(i, n, mirrored = false) {
  const k = mirrored ? n - 1 - i : i;
  return [k / n, (k + 1) / n];
}

const hipX = (P) => (P[23].x + P[24].x) / 2;

// poses: the bodies found in one frame (each 33 landmarks). Returns one entry per
// lane: { landmarks, sample } or null. A body belongs to the lane its hips are in;
// if two share a lane, the one that looks bigger (nearer the camera) is kept.
export function assignLanes(poses, n, aspect = 1, mirrored = false) {
  const lanes = new Array(n).fill(null);
  for (const landmarks of poses || []) {
    const i = laneOf(hipX(landmarks), n, mirrored);
    if (i < 0) continue;
    const sample = legSample(landmarks, aspect);
    const size = Number.isFinite(sample.bodyLen) ? sample.bodyLen : 0;
    if (!lanes[i] || size > lanes[i].size) lanes[i] = { landmarks, sample, size };
  }
  return lanes.map((l) => l && { landmarks: l.landmarks, sample: l.sample });
}

// ---- where to stand

// The guide drawn in each lane, in fractions of the lane's width and the frame's
// height: feet go on the pad, and the whole jump has to fit under the top line.
export const GUIDE = { padY: 0.86, padH: 0.07, top: 0.06, width: 0.62 };

const HEADROOM = 0.5; // how far the hips rise in a good jump, in body lengths
const MIN_BODY = 0.25; // smallest useful body length, in frame heights
const EDGE = 0.18; // hips this close to the lane's edge count as off-centre

// What, if anything, the athlete should change before jumping. Returns null when
// the framing is fine, else a short instruction. Order matters: the first problem
// is the one worth fixing first.
export function framingHint(entry, i, n, mirrored = false) {
  if (!entry) return 'Step into your lane';
  const { landmarks: P, sample: s } = entry;
  const feet = [29, 30, 31, 32].map((k) => P[k].y);
  // Feet at or below the bottom edge: the ground is out of the picture.
  if (Math.max(...feet) > 0.985) return 'Feet are cut off: step back, or tilt the phone down';
  if (!s.visible) return 'Legs and feet must be in view';
  // Hips will rise about half a body length; they have to stay in the picture.
  if (s.hipY - HEADROOM * s.bodyLen < 0.02) return 'Too close: step back';
  if (s.bodyLen < MIN_BODY) return 'Too far: come closer';
  const [a, b] = laneBounds(i, n, mirrored);
  const u = (hipX(P) - a) / (b - a); // 0..1 across the lane
  if (n > 1 && (u < EDGE || u > 1 - EDGE)) return 'Move to the middle of your lane';
  return null;
}

// ---- how the phone is tilted

const RAD = Math.PI / 180;

// From the browser's device orientation angles (degrees; beta = front-back tilt,
// gamma = left-right tilt). With R = Rz(alpha)·Rx(beta)·Ry(gamma), the device's
// axes have these upward components: x: -cosβ·sinγ, y: sinβ, z: cosβ·cosγ.
// (alpha, the compass heading, does not affect any of them.)
const upOf = (beta, gamma) => ({
  x: -Math.cos(beta * RAD) * Math.sin(gamma * RAD),
  y: Math.sin(beta * RAD),
  z: Math.cos(beta * RAD) * Math.cos(gamma * RAD),
});

// How far above the horizon the camera points, in degrees: 0 = level, 90 = straight
// up. The rear camera looks out of the back of the phone (-z), the front one out of
// the screen (+z). Holds in any screen orientation.
export function cameraElevation(beta, gamma, facing = 'environment') {
  const z = upOf(beta, gamma).z;
  return Math.asin(Math.max(-1, Math.min(1, facing === 'user' ? z : -z))) / RAD;
}

// How far the picture's horizon is from level, in degrees (0 = level). screenAngle
// is screen.orientation.angle: 0 portrait, 90 or 270 landscape. Folded into
// (-90, 90] so that it does not matter which way round the phone was turned.
export function cameraRoll(beta, gamma, screenAngle = 0) {
  const up = upOf(beta, gamma), a = screenAngle * RAD;
  const right = Math.cos(a) * up.x + Math.sin(a) * up.y; // picture's right edge, upward part
  const top = -Math.sin(a) * up.x + Math.cos(a) * up.y; // picture's top edge, upward part
  let roll = Math.atan2(right, top) / RAD;
  if (roll > 90) roll -= 180;
  if (roll <= -90) roll += 180;
  return roll;
}

// The phone sits on the ground leaning back, so the camera looks up at the athletes.
// About 45 degrees is the starting point; the stand-here prompts do the fine tuning,
// because the right angle depends on the lens and how far away the athletes are.
export const TILT = { target: 45, low: 30, high: 55, level: 4 };

export function placementAdvice(elevation, roll) {
  if (!Number.isFinite(elevation)) return { ok: false, text: '' };
  if (elevation < TILT.low) return { ok: false, text: 'Lean the phone back more' };
  if (elevation > TILT.high) return { ok: false, text: 'Stand the phone up more' };
  if (Number.isFinite(roll) && Math.abs(roll) > TILT.level) return { ok: false, text: 'Level the phone: one side is higher' };
  return { ok: true, text: 'Phone angle is good' };
}
