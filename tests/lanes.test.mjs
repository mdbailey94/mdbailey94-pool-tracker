// Finding lane ropes to line up the dots, on synthetic pool pictures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RaceSim } from './support/race-sim.mjs';
import { applyH, fitHomography, homography } from '../src/homography.js';
import { findLaneLines } from '../src/lanes.js';

// Dots slid off the lane lines along the finish and back lines by these
// fractions of a lane (as a coach's rough placement would be).
function roughDots(sim, at, depth, slide) {
  const P = (x, y) => applyH(sim.H, x, y);
  const L = sim.lanes;
  return [P(0 + slide[0], at), P(L + slide[1], at), P(L + slide[2], at - depth), P(0 + slide[3], at - depth)];
}

// Worst distance (px) between where the dots put each lane line and where it
// really is, at the finish and back lines.
function laneError(sim, corners, at, depth) {
  const L = sim.lanes;
  const H = homography([[0, 0], [L, 0], [L, depth], [0, depth]], corners);
  let worst = 0;
  for (let k = 0; k <= L; k++) {
    for (const d of [0, depth]) {
      const [u, v] = applyH(H, k, d);
      const [tu, tv] = applyH(sim.H, k, at - d);
      worst = Math.max(worst, Math.hypot((u - tu) * sim.w, (v - tv) * sim.h));
    }
  }
  return worst;
}

for (const view of ['head', 'side']) {
  for (const lanes of [4, 6]) {
    test(`${view} view, ${lanes} lanes: finds the ropes and fixes rough dots`, () => {
      const sim = new RaceSim({ view, lanes, length: 25, width: 480, height: 300, seed: 5 });
      const frame = sim.render(0);
      const at = 25, depth = 5;
      const rough = roughDots(sim, at, depth, [0.3, -0.25, 0.35, -0.2]);
      const before = laneError(sim, rough, at, depth);
      const res = findLaneLines(frame, sim.w, sim.h, rough, lanes, depth);
      const after = laneError(sim, res.corners, at, depth);
      assert.ok(before > 8, `test setup: dots should start well off (${before.toFixed(1)} px)`);
      assert.equal(res.found, lanes - 1, 'every rope found (the outer edges are walls, not ropes)');
      assert.ok(after < 2, `lane lines within 2 px after finding: ${after.toFixed(2)} px (was ${before.toFixed(1)})`);
    });
  }
}

test('only two ropes in view (3 lanes): lanes slide and stretch onto them', () => {
  for (const view of ['head', 'side']) {
    const sim = new RaceSim({ view, lanes: 3, length: 25, width: 480, height: 300, seed: 5 });
    const rough = roughDots(sim, 25, 5, [0.3, -0.25, 0.35, -0.2]);
    const res = findLaneLines(sim.render(0), sim.w, sim.h, rough, 3, 5);
    assert.equal(res.found, 2, view);
    assert.ok(laneError(sim, res.corners, 25, 5) < 4, `${view}: ${laneError(sim, res.corners, 25, 5).toFixed(1)} px`);
  }
});

test('works with swimmers in the water', () => {
  const sim = new RaceSim({ view: 'head', lanes: 5, length: 25, width: 480, height: 300, seed: 2 });
  sim.addRacer({ lane: 1, speed: 1.6, t0: 0, from: 18 });
  sim.addRacer({ lane: 3, speed: 1.5, t0: 0, from: 19 });
  const rough = roughDots(sim, 25, 5, [-0.3, 0.3, 0.25, -0.3]);
  const res = findLaneLines(sim.render(1), sim.w, sim.h, rough, 5, 5);
  assert.ok(laneError(sim, res.corners, 25, 5) < 2.5);
});

test('flat water with no ropes leaves the dots alone', () => {
  const w = 160, h = 100;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) rgba.set([35, 115, 175, 255], i * 4);
  const dots = [[0.1, 0.9], [0.9, 0.9], [0.7, 0.3], [0.3, 0.3]];
  const res = findLaneLines(rgba, w, h, dots, 4, 5);
  assert.equal(res.found, 0);
  assert.deepEqual(res.corners, dots);
});

test('fitHomography matches the exact solution and averages extra points', () => {
  const src = [[0, 0], [4, 0], [4, 5], [0, 5]];
  const dst = [[0.1, 0.9], [0.9, 0.9], [0.7, 0.3], [0.3, 0.3]];
  const exact = homography(src, dst);
  const fit = fitHomography([...src, [2, 0], [2, 5]], [...dst, applyH(exact, 2, 0), applyH(exact, 2, 5)]);
  fit.forEach((v, i) => assert.ok(Math.abs(v - exact[i]) < 1e-6));
});
