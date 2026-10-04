// Synthetic finish-line camera: swimmers racing one length towards a wall,
// seen head-on (coming at the camera) or from the side, on the same
// rippling, glary water as PoolSim. Each swimmer's leading hand is at a
// known position at every moment, so the true finish time is exact.

import { applyH } from '../../src/homography.js';
import { PoolSim } from './pool-sim.mjs';

// Pool corners (start wall first lane, start wall last lane, turn wall last
// lane, turn wall first lane). Swimmers race from the start wall to the turn
// wall, so with these the turn wall is the finish.
export const VIEWS = {
  // Camera behind the finish wall, looking up the pool.
  head: [[0.3, 0.06], [0.7, 0.06], [0.98, 0.97], [0.02, 0.97]],
  // Camera on the side, lane 1 nearest; swimmers go left to right.
  side: [[0.02, 0.97], [0.18, 0.28], [0.82, 0.28], [0.98, 0.97]],
};

export class RaceSim extends PoolSim {
  constructor({ view = 'head', ...opts } = {}) {
    super({ corners: VIEWS[view], ...opts });
  }

  // A swimmer racing up `lane` at `speed` m/s, hand at `from` m when the
  // clock reads t0, stopping at the wall (the touch) unless `through`.
  addRacer({ lane, speed, t0 = 0, from = 0, rate = 50, through = false, lateral = 0, distractor = false }) {
    const r = { lane, speed, t0, from, rate, through, lateral, distractor };
    this.swimmers.push(r);
    return r;
  }

  handAt(r, t) {
    const p = r.from + r.speed * Math.max(0, t - r.t0);
    return r.through ? p : Math.min(this.L, p);
  }

  // When the hand reaches `y` metres from the start wall.
  reaches(r, y) {
    return r.t0 + (y - r.from) / r.speed;
  }

  // Band corners for the app: dots on a line `at` m from the start wall and on
  // a line `depth` m before it, in the app's order.
  band(at, depth) {
    const P = (x, y) => applyH(this.H, x, y);
    return [P(0, at), P(this.lanes, at), P(this.lanes, at - depth), P(0, at - depth)];
  }

  drawSwimmer(r, t) {
    const cx = r.lane + 0.5 + r.lateral;
    if (r.distractor) {
      // Something parked in the water (a swimmer resting, a kickboard).
      this.paint(cx, r.from, [{ x: r.from, y: cx, rx: 0.8, ry: 0.3, col: [240, 220, 60], a: 0.9 }]);
      return;
    }
    const p = this.handAt(r, t);
    const moving = r.through || p < this.L;
    const since = Math.max(0, t - r.t0);
    const entry = 60 / r.rate / 2;
    const k = Math.floor(since / entry);
    const amp = moving ? Math.exp(-(since - k * entry) / 0.18) : 0;
    const side = k % 2 ? 1 : -1;
    this.paint(cx, p, [
      // Arm reaching to the hand, head and body behind it.
      { x: p - 0.35, y: cx, rx: 0.35, ry: 0.09, col: [30, 35, 50], a: 0.85 },
      { x: p - 1.2, y: cx, rx: 0.95, ry: 0.22, col: [25, 30, 45], a: 0.85 },
      // Splash of the stroke behind the hand, alternating sides.
      { x: p - 0.6, y: cx + (side * 0.3) / 2.5, rx: 0.35, ry: 0.25, col: [240, 245, 250], a: 0.9 * amp },
      // Kick.
      ...(moving ? [{ x: p - 2.4, y: cx, rx: 0.45, ry: 0.2, col: [225, 235, 240], a: 0.25 + 0.3 * this.rand() }] : []),
    ]);
  }
}
