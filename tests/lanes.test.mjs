import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignLanes, cameraElevation, cameraRoll, framingHint, horizonTilt, laneBounds, laneOf, placementAdvice, tiltFor,
} from '../src/lanes.js';
import { findWideCamera } from '../src/capture.js';

// A standing body: 33 landmarks with the legs filled in, hips at (cx, hipY), body
// scaled by `size` (thigh + shank, in frame heights). aspect 16:9 unless said.
function body({ cx = 0.5, hipY = 0.55, size = 0.28, vis = 0.9, aspect = 16 / 9 } = {}) {
  const P = new Array(33).fill(null).map(() => ({ x: cx, y: 0.3, visibility: 0.9 }));
  const dx = 0.03 / aspect;
  const leg = (side, sgn) => {
    const [hip, knee, ankle, heel, toe] = side;
    P[hip] = { x: cx + sgn * dx, y: hipY, visibility: 1 };
    P[knee] = { x: cx + sgn * dx, y: hipY + size / 2, visibility: vis };
    P[ankle] = { x: cx + sgn * dx, y: hipY + size, visibility: vis };
    P[heel] = { x: cx + sgn * dx, y: hipY + size + 0.02, visibility: vis };
    P[toe] = { x: cx + sgn * dx, y: hipY + size + 0.03, visibility: vis };
  };
  leg([23, 25, 27, 29, 31], -1);
  leg([24, 26, 28, 30, 32], 1);
  return P;
}

test('laneOf and laneBounds: left to right as seen, reversed for the mirrored front camera', () => {
  assert.deepEqual([0.1, 0.5, 0.9].map((x) => laneOf(x, 3)), [0, 1, 2]);
  assert.deepEqual([0.1, 0.5, 0.9].map((x) => laneOf(x, 3, true)), [2, 1, 0]);
  assert.equal(laneOf(0.7, 1), 0);
  assert.equal(laneOf(1.2, 3), 2); // hips just outside the frame still count for the edge lane
  assert.equal(laneOf(NaN, 3), -1);
  assert.deepEqual(laneBounds(0, 3), [0, 1 / 3]);
  assert.deepEqual(laneBounds(0, 3, true), [2 / 3, 1]);
  // A body is drawn inside the bounds of the lane it was assigned to, either way round.
  for (const m of [false, true]) for (const x of [0.05, 0.4, 0.62, 0.97]) {
    const [a, b] = laneBounds(laneOf(x, 3, m), 3, m);
    assert.ok(x >= a && x <= b, `x ${x} mirrored ${m}`);
  }
});

test('assignLanes: one body per lane, the nearer one wins a shared lane', () => {
  const left = body({ cx: 0.15 }), right = body({ cx: 0.85 }), far = body({ cx: 0.2, size: 0.15 });
  const lanes = assignLanes([right, far, left], 3, 16 / 9);
  assert.equal(lanes[0].landmarks, left); // bigger than `far`, which shares the lane
  assert.equal(lanes[1], null);
  assert.equal(lanes[2].landmarks, right);
  assert.ok(lanes[0].sample.visible && lanes[0].sample.bodyLen > 0);
  assert.deepEqual(assignLanes([], 2), [null, null]);
  assert.deepEqual(assignLanes(undefined, 1), [null]);
  // Mirrored: the body on the frame's left is in the viewer's right-hand lane.
  assert.equal(assignLanes([left], 3, 16 / 9, true)[2].landmarks, left);
});

test('framingHint: says what to fix, or nothing when the athlete is placed well', () => {
  const at = (opts, i = 1, n = 3) => framingHint(assignLanes([body(opts)], n, 16 / 9)[i], i, n);
  assert.equal(at({ cx: 0.5 }), null);
  assert.equal(framingHint(null, 0, 3), 'Step into your lane');
  assert.match(at({ cx: 0.5, hipY: 0.72 }), /cut off/); // feet below the frame
  assert.match(at({ cx: 0.5, vis: 0.2 }), /in view/);
  assert.match(at({ cx: 0.5, hipY: 0.2, size: 0.28 }), /Too close/); // no room above the hips
  assert.match(at({ cx: 0.5, hipY: 0.6, size: 0.1 }), /Too far/);
  assert.match(at({ cx: 0.36 }), /middle/); // near the lane's left edge
  assert.equal(at({ cx: 0.2 }, 0, 1), null); // one athlete has the whole frame
});

test('cameraElevation: how far above the horizon the camera looks', () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
  near(cameraElevation(90, 0), 0, 'upright portrait looks level');
  near(cameraElevation(135, 0), 45, 'leaning back 45 in portrait');
  near(cameraElevation(0, 0), -90, 'flat, screen up: rear camera looks at the ground');
  near(cameraElevation(180, 0), 90, 'flat, screen down: rear camera looks straight up');
  near(cameraElevation(45, 0, 'user'), 45, 'front camera looks the other way');
  // Landscape: the phone is on its side (gamma near ±90) and leans about its long edge.
  near(cameraElevation(0, 90), 0, 'upright landscape looks level');
  near(cameraElevation(0, -90), 0, 'upright landscape, other way round');
  near(cameraElevation(0, 135), 45, 'leaning back 45 in landscape');
});

test('cameraRoll: 0 when the picture is level, either way round', () => {
  const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);
  near(cameraRoll(90, 0, 0), 0, 'portrait, level');
  near(Math.abs(cameraRoll(90, 10, 0)), 0, 'portrait upright: gamma turns about the vertical, not a roll');
  near(cameraRoll(135, 0, 0), 0, 'portrait, leaning back, level');
  near(cameraRoll(0, 90, 90), 0, 'landscape, level');
  near(cameraRoll(0, -90, 270), 0, 'landscape the other way, level');
  near(cameraRoll(0, -90, 90), 0, 'screen angle reported the other way still reads level');
  near(cameraRoll(0, 135, 90), 0, 'landscape, leaning back, level');
  assert.ok(Math.abs(Math.abs(cameraRoll(10, 90, 90)) - 10) < 1e-6, 'landscape with one end 10 degrees up');
  // The gauge's version needs no screen angle: level reads 0 upright or on its side,
  // leaning back or not, and a tilt reads the same either way.
  for (const [b, g] of [[90, 0], [135, 0], [105, 0], [0, 90], [0, -90], [0, 105], [0, 135]]) near(horizonTilt(b, g), 0, `level at beta ${b} gamma ${g}`);
  assert.ok(Math.abs(Math.abs(horizonTilt(10, 90)) - 10) < 1e-6, 'on its side, one end 10 degrees up');
  assert.ok(Math.abs(Math.abs(horizonTilt(90, 8)) - 0) < 1e-6, 'upright, turned about the vertical: still level');
});

test('placementAdvice: about 15 degrees on its side, about 45 upright, and level', () => {
  // On its side (landscape, 0.5x camera).
  assert.equal(placementAdvice(15, 0, true).ok, true);
  assert.equal(placementAdvice(22, 0, true).ok, true);
  assert.match(placementAdvice(4, 0, true).text, /back more/);
  assert.match(placementAdvice(45, 0, true).text, /up more/); // good upright, too far back on its side
  assert.match(placementAdvice(15, 9, true).text, /Level/);
  // Upright (portrait): the default.
  assert.equal(placementAdvice(45, 0).ok, true);
  assert.match(placementAdvice(15, 0).text, /back more/);
  assert.match(placementAdvice(80, 0, false).text, /up more/);
  assert.equal(placementAdvice(NaN, 0, true).text, '');
  assert.deepEqual([tiltFor(true).target, tiltFor(false).target], [15, 45]);
});

test('findWideCamera: picks the rear 0.5x camera by name', () => {
  const cam = (label, deviceId = label) => ({ kind: 'videoinput', label, deviceId });
  const iphone = [cam('Front Camera'), cam('Back Triple Camera'), cam('Back Dual Wide Camera'), cam('Back Ultra Wide Camera'), cam('Back Camera'), cam('Back Telephoto Camera'), { kind: 'audioinput', label: 'Ultra Wide Microphone', deviceId: 'm' }];
  assert.equal(findWideCamera(iphone).label, 'Back Ultra Wide Camera');
  assert.equal(findWideCamera([cam('Back Ultra-Wide Camera')]).label, 'Back Ultra-Wide Camera');
  assert.equal(findWideCamera([cam('Front Ultra Wide Camera'), cam('Back Camera')]), undefined);
  assert.equal(findWideCamera([cam('camera2 0, facing back'), cam('camera2 1, facing front')]), undefined);
  // Before permission is given the names are blank.
  assert.equal(findWideCamera([{ kind: 'videoinput', label: '', deviceId: '' }]), undefined);
  assert.equal(findWideCamera(undefined), undefined);
});
