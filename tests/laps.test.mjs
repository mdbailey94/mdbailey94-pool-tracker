import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Swimmer, WallDetector } from '../src/laps.js';
import { rng } from './support/pool-sim.mjs';

// Feed a position trajectory x(t) (with gaps where fn returns null).
function run(det, fn, t0, t1, fps = 25, noise = 0.15, seed = 1) {
  const rand = rng(seed);
  const ev = [];
  for (let t = t0; t < t1; t += 1 / fps) {
    const x = fn(t);
    if (x === null) continue;
    ev.push(...det.push(t, x + noise * (rand() - 0.5) * 2));
  }
  return ev;
}

// Back and forth in a 25 m pool at 1.5 m/s, touching 1 m from each wall
// (where a tracked swimmer's centre is), with a 0.6 s turn.
function lengths(t, { start = 1, speed = 1.5, L = 25, n = 4, dwell = 0.6, hide = 0 } = {}) {
  const span = L - 2;
  const legT = span / speed;
  if (t < start) return 1;
  let u = t - start;
  for (let k = 0; k < n; k++) {
    if (u <= legT) {
      if (k > 0 && u < hide) return null; // underwater after the push-off
      return k % 2 === 0 ? 1 + u * speed : L - 1 - u * speed;
    }
    u -= legT;
    if (k < n - 1 && u <= dwell) return k % 2 === 0 ? L - 1 : 1;
    if (k < n - 1) u -= dwell;
  }
  return n % 2 ? L - 1 : 1;
}

test('turns are reported at the touch, finishes as arrivals', () => {
  const det = new WallDetector(25);
  const ev = run(det, (t) => lengths(t, { hide: 2 }), 0, 70);
  const legT = 23 / 1.5;
  const types = ev.map((e) => e.type);
  assert.deepEqual(types, ['depart', 'turn', 'turn', 'turn', 'arrive']);
  assert.deepEqual(ev.map((e) => e.wall), [0, 1, 0, 1, 0]);
  const expectTouch = [1 + legT, 1 + 2 * legT + 0.6, 1 + 3 * legT + 1.2, 1 + 4 * legT + 1.8];
  ev.slice(1).forEach((e, i) => assert.ok(Math.abs(e.t - expectTouch[i]) < 0.35, `${e.type} ${e.t} vs ${expectTouch[i]}`));
});

test('a rest at the wall splits into arrival and departure', () => {
  const det = new WallDetector(25);
  // Up, 10 s rest at the far wall, back down.
  const fn = (t) => (t < 1 ? 1 : t < 16.33 ? 1 + (t - 1) * 1.5 : t < 26.33 ? 24 : Math.max(1, 24 - (t - 26.33) * 1.5));
  const ev = run(det, fn, 0, 50);
  assert.deepEqual(ev.map((e) => e.type), ['depart', 'arrive', 'depart', 'arrive']);
  assert.ok(Math.abs(ev[1].t - 16.33) < 0.4);
  assert.ok(Math.abs(ev[2].t - 26.33) < 0.4);
});

test('turning back mid-pool is not a length', () => {
  const det = new WallDetector(25);
  const fn = (t) => (t < 8 ? 1 + t * 1.5 : 13 - (t - 8) * 1.5);
  const ev = run(det, fn, 0, 15);
  assert.deepEqual(ev.map((e) => e.type), ['depart', 'reverse']);
  const sw = new Swimmer({ lane: 0, length: 25 });
  assert.deepEqual(sw.handle(ev), []);
});

test('Swimmer strings wall events into lengths and uses the race clock', () => {
  const sw = new Swimmer({ lane: 0, length: 25 });
  sw.clockStart = 10;
  const done = sw.handle([
    { type: 'depart', wall: 0, t: 10.8 },
    { type: 'turn', wall: 1, t: 25 },
    { type: 'turn', wall: 0, t: 41 },
    { type: 'arrive', wall: 1, t: 57.5 },
    { type: 'depart', wall: 1, t: 70 },
    { type: 'arrive', wall: 0, t: 86 },
  ]);
  assert.deepEqual(done.map((l) => l.time), [15, 16, 16.5, 16]);
  assert.deepEqual(done.map((l) => l.from), [0, 1, 0, 1]);
});

test('an estimated departure never overrides a known one', () => {
  const sw = new Swimmer({ lane: 0, length: 25 });
  sw.handle([{ type: 'depart', wall: 0, t: 5 }]);
  sw.handle([{ type: 'depart', wall: 0, t: 9, estimated: true }]); // track re-found mid-length
  const [len] = sw.handle([{ type: 'turn', wall: 1, t: 21 }]);
  assert.equal(len.time, 16);
  assert.equal(len.estimated, false);
});
