// Synthetic finish-line camera: swimmers racing one length towards a wall,
// seen head-on (coming at the camera) or from the side, on the same
// rippling, glary water as PoolSim. The head moves smoothly; an arm reaches
// out ahead of it for part of every stroke (so the swimmer's front edge
// jumps about, as a real one does), and reaches for the wall at the finish.
// Head and hand positions are known at every moment, so true crossing and
// touch times are exact.

import { applyH } from '../../src/homography.js';
import { PoolSim } from './pool-sim.mjs';

export const REACH = 0.6; // m from the front of the head to the outstretched hand

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

  // A swimmer racing up `lane` at `speed` m/s, the front of the head at
  // `from` m when the clock reads t0. Stops when the hand touches the wall,
  // unless `through`.
  addRacer({ lane, speed, t0 = 0, from = 0, rate = 50, through = false, lateral = 0, distractor = false }) {
    const r = { lane, speed, t0, from, rate, through, lateral, distractor };
    this.swimmers.push(r);
    return r;
  }

  // Front of the head, m from the start wall.
  headAt(r, t) {
    const h = r.from + r.speed * Math.max(0, t - r.t0);
    return r.through ? h : Math.min(this.L - REACH, h);
  }

  // How far the leading hand is ahead of the head: out in front for the
  // first part of each stroke, then pulled back under the body; fully out
  // when reaching for the wall.
  reachAt(r, t) {
    const h = this.headAt(r, t);
    if (!r.through && h > this.L - REACH - 0.5) return REACH;
    const entry = 60 / r.rate / 2;
    const ph = ((Math.max(0, t - r.t0) / entry) % 1);
    return ph < 0.45 ? REACH * Math.min(1, ph / 0.1) : 0;
  }

  // When the head reaches `y` metres from the start wall.
  reaches(r, y) {
    return r.t0 + (y - r.from) / r.speed;
  }

  // When the hand touches the far wall.
  touchTime(r) {
    return this.reaches(r, this.L - REACH);
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
    const h = this.headAt(r, t);
    const reach = this.reachAt(r, t);
    const moving = r.through || h < this.L - REACH;
    const since = Math.max(0, t - r.t0);
    const entry = 60 / r.rate / 2;
    const k = Math.floor(since / entry);
    const amp = moving ? Math.exp(-(since - k * entry) / 0.18) : 0;
    const side = k % 2 ? 1 : -1;
    this.paint(cx, h, [
      // Head (cap), body behind it.
      { x: h - 0.12, y: cx, rx: 0.13, ry: 0.11, col: [20, 25, 40], a: 0.9 },
      { x: h - 0.95, y: cx, rx: 0.8, ry: 0.22, col: [25, 30, 45], a: 0.85 },
      // The reaching arm, thin, ahead of the head.
      ...(reach > 0.05 ? [{ x: h + reach / 2 - 0.05, y: cx + (side * 0.1) / 2.5, rx: reach / 2 + 0.05, ry: 0.06, col: [30, 35, 50], a: 0.85 }] : []),
      // Splash of the hand entering, by the head.
      { x: h + 0.15, y: cx + (side * 0.25) / 2.5, rx: 0.3, ry: 0.22, col: [240, 245, 250], a: 0.9 * amp },
      // Kick.
      ...(moving ? [{ x: h - 2.1, y: cx, rx: 0.45, ry: 0.2, col: [225, 235, 240], a: 0.25 + 0.3 * this.rand() }] : []),
    ]);
  }
}
