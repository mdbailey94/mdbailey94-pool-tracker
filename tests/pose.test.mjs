import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { legSample } from '../src/pose.js';
import { JumpDetector } from '../src/jump.js';

// 33 landmarks with only the legs (indices 23–32) filled in: the upper body is not needed.
const pose = (legs) => { const P = new Array(33).fill(null); legs.forEach((q, i) => { P[23 + i] = { x: q[0], y: q[1], visibility: q[2] }; }); return P; };
// hipL hipR kneeL kneeR ankleL ankleR heelL heelR toeL toeR, standing, both legs clear.
const STANDING = [
  [0.45, 0.5, 1], [0.55, 0.5, 1], [0.45, 0.7, 0.9], [0.55, 0.7, 0.9], [0.45, 0.9, 0.9], [0.55, 0.9, 0.9],
  [0.44, 0.93, 0.9], [0.56, 0.93, 0.9], [0.46, 0.95, 0.9], [0.54, 0.94, 0.9],
];
const withVis = (legs, idx, v) => legs.map((q, i) => (idx.includes(i) ? [q[0], q[1], v] : q));
const LEFT = [4, 6, 8], RIGHT = [5, 7, 9]; // ankle, heel, toe of each leg

test('legSample needs only the legs', () => {
  const s = legSample(pose(STANDING), 1);
  assert.equal(s.visible, true);
  assert.equal(s.footL, 0.95); // lowest of heel and toe
  assert.equal(s.footR, 0.94);
  assert.equal(s.hipY, 0.5);
  assert.ok(Math.abs(s.bodyLen - 1.6 * 0.4) < 1e-9, `bodyLen ${s.bodyLen}`); // 1.6 × (thigh + shank)
  assert.equal(s.stretch, 1); // legs straight
  assert.ok(Number.isNaN(s.headY)); // no head in the picture: it is optional
  assert.deepEqual(legSample(null), { footL: NaN, footR: NaN, hipY: NaN, bodyLen: NaN, headY: NaN, stretch: NaN, visible: false });
});

test('legSample: head height from the ears, and how straight the leg is', () => {
  const P = pose(STANDING);
  P[7] = { x: 0.48, y: 0.12, visibility: 0.9 };
  P[8] = { x: 0.52, y: 0.14, visibility: 0.2 }; // far ear hidden, as side-on: the pair is still used
  assert.ok(Math.abs(legSample(P, 1).headY - 0.13) < 1e-9);
  P[7].visibility = 0.3;
  assert.ok(Number.isNaN(legSample(P, 1).headY), 'neither ear clear');
  P[7] = { x: 0.48, y: -0.02, visibility: 0.9 };
  P[8] = { x: 0.52, y: -0.02, visibility: 0.9 };
  assert.ok(Number.isNaN(legSample(P, 1).headY), 'head above the picture');
  // Knee pushed 10% of the frame forward: the leg is the same length but reaches less far.
  const bent = pose(STANDING.map((q, i) => (i === 2 || i === 3 ? [q[0] + 0.1, q[1], q[2]] : q)));
  const b = legSample(bent, 1);
  assert.ok(b.stretch < 0.92 && b.stretch > 0.8, `stretch ${b.stretch}`);
});

test('legSample keeps a half-hidden far leg and replaces a lost one', () => {
  // Side-on, the far leg is mostly hidden but still placed by the model: keep its own position.
  const dim = legSample(pose(withVis(STANDING, LEFT, 0.25)), 1);
  assert.equal(dim.visible, true);
  assert.equal(dim.footL, 0.95);
  // Far leg lost entirely: the near leg stands in for it.
  const lost = legSample(pose(withVis(STANDING, LEFT, 0.05)), 1);
  assert.equal(lost.visible, true);
  assert.equal(lost.footL, 0.94);
  assert.equal(lost.footR, 0.94);
  // Neither leg clear enough, hips hidden, or the feet out of frame: not usable.
  assert.equal(legSample(pose(withVis(STANDING, [...LEFT, ...RIGHT], 0.3)), 1).visible, false);
  assert.equal(legSample(pose(withVis(STANDING, [0, 1], 0.2)), 1).visible, false);
  const cut = STANDING.map((q, i) => (i >= 6 ? [q[0], 1.05, q[2]] : q));
  assert.equal(legSample(pose(cut), 1).visible, false);
});

// Landmarks from a real side-on clip (60 fps): the far leg's visibility drops to ~0.2
// through the squat and takeoff, the clip opens with half a second of standing and ends
// 0.3 s after landing. Checked by eye against the frames: toes leave the ground at about
// 1.32–1.33 s and touch down at about 1.97 s.
test('side-on clip: every frame usable and one jump found', () => {
  const { aspect, frames } = JSON.parse(readFileSync(new URL('./fixtures/side-view-legs-60fps.json', import.meta.url)));
  const det = new JumpDetector();
  const jumps = [];
  let usable = 0;
  for (const f of frames) {
    const s = legSample(pose(f.legs), aspect);
    if (s.visible) usable++;
    const { jump } = det.push({ t: f.t, ...s });
    if (jump) jumps.push(jump);
  }
  const last = det.flush();
  if (last) jumps.push(last);
  assert.equal(usable, frames.length, 'frames dropped for low visibility');
  assert.equal(jumps.length, 1, `expected 1 jump, got ${jumps.length} (${det.lastReject})`);
  const [j] = jumps;
  assert.ok(Math.abs(j.takeoffT - 1.325) < 0.035, `takeoff ${j.takeoffT}`);
  assert.ok(Math.abs(j.landingT - 1.967) < 0.035, `landing ${j.landingT}`);
  assert.ok(j.flightTime > 0.61 && j.flightTime < 0.69, `flight ${j.flightTime}`);
});
