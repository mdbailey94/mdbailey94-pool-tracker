import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeStrokes, runs, strokeCount } from '../src/strokes.js';
import { rng } from './support/pool-sim.mjs';

// Splash samples at ~fps: a burst of energy at every hand entry; for
// alternating strokes the burst lands on alternate sides of the body.
function splash({ cyclesPerMin, alternating, seconds = 12, fps = 25, noise = 0.3, seed = 3, t0 = 0 }) {
  const rand = rng(seed);
  const cycle = 60 / cyclesPerMin;
  const entry = alternating ? cycle / 2 : cycle;
  const out = [];
  for (let t = t0; t < t0 + seconds; t += 1 / fps + (rand() - 0.5) * 0.008) {
    const k = Math.floor((t - t0) / entry);
    const ph = t - t0 - k * entry;
    const burst = Math.exp(-ph / 0.18);
    const side = alternating ? (k % 2 ? 1 : -1) : 0;
    out.push({ t, x: 12, e: 20 + 12 * burst + noise * 10 * (rand() - 0.5), y: 0.12 * side * burst + noise * 0.05 * (rand() - 0.5) });
  }
  return out;
}

test('freestyle-like splash: rate in cycles/min and alternating family', () => {
  for (const rate of [32, 45, 60]) {
    const s = splash({ cyclesPerMin: rate, alternating: true });
    const r = analyzeStrokes(s, 0, 12);
    assert.equal(r.family, 'alternating', `rate ${rate}`);
    assert.ok(Math.abs(r.rate - rate) < 1.5, `expected ${rate}, got ${r.rate}`);
  }
});

test('breaststroke-like splash: simultaneous family', () => {
  for (const rate of [28, 40, 55]) {
    const s = splash({ cyclesPerMin: rate, alternating: false });
    const r = analyzeStrokes(s, 0, 12);
    assert.equal(r.family, 'simultaneous', `rate ${rate}`);
    assert.ok(Math.abs(r.rate - rate) < 1.5, `expected ${rate}, got ${r.rate}`);
  }
});

test('a stroke set by the coach decides the family', () => {
  const s = splash({ cyclesPerMin: 50, alternating: true });
  const r = analyzeStrokes(s, 0, 12, 'alternating');
  assert.equal(r.auto, false);
  assert.ok(Math.abs(r.rate - 50) < 1.5);
});

test('no rhythm in plain noise', () => {
  const rand = rng(9);
  const s = Array.from({ length: 300 }, (_, i) => ({ t: i / 25, e: 20 + 10 * rand(), y: 0.05 * rand() }));
  const r = analyzeStrokes(s, 0, 12);
  assert.ok(r === null || r.strength < 0.3);
});

test('gaps and overlap (NaN) split the data into runs', () => {
  const a = splash({ cyclesPerMin: 45, alternating: true, seconds: 5 });
  const b = splash({ cyclesPerMin: 45, alternating: true, seconds: 5, t0: 7 });
  const blocked = [{ t: 5.5, x: 12, e: NaN, y: NaN }];
  const rs = runs([...a, ...blocked, ...b], 0, 20);
  assert.equal(rs.length, 2);
  const r = analyzeStrokes([...a, ...blocked, ...b], 0, 20);
  assert.ok(Math.abs(r.rate - 45) < 2, `got ${r.rate}`);
});

test('stroke count covers the time spent splashing', () => {
  const quiet = Array.from({ length: 50 }, (_, i) => ({ t: i / 25, x: 2, e: 1, y: 0 }));
  const swim = splash({ cyclesPerMin: 40, alternating: true, seconds: 15, t0: 2 });
  // 15 s at 0.75 s per hand entry = 20 strokes.
  const n = strokeCount([...quiet, ...swim], 0, 17, 0.75);
  assert.ok(Math.abs(n - 20) <= 1, `got ${n}`);
});
