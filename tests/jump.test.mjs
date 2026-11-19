import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { G, heightFromFlightTime, JumpDetector } from '../src/jump.js';
import { simulate, run } from './support/jump-sim.mjs';

const stand = (dur = 1.5) => ({ type: 'stand', dur });
const HEIGHTS = [0.15, 0.25, 0.35, 0.5, 0.65, 0.8];

// One jump per stream with varied camera distance and foot asymmetry; returns errors in cm.
function sweep({ fps, noise, seeds = 20, jump = {}, smoothing = {} }) {
  const errs = [], misses = [];
  for (const h of HEIGHTS) for (let seed = 1; seed <= seeds; seed++) {
    const u = ((seed * 7919 + h * 1000) % 97) / 97; // deterministic spread in [0, 1)
    const { samples, truth } = simulate({
      seed: seed * 1009 + Math.round(h * 100) * 31 + fps, fps, noise, smoothing, distance: 2.5 + 2 * u,
      script: [stand(1.2), { type: 'jump', height: h, swap: seed % 2 === 0, footDelay: 0.02 * u, landDelay: 0.02 * (1 - u), ...jump }, stand(0.8)],
    });
    const det = new JumpDetector();
    const { jumps } = run(det, samples);
    if (jumps.length !== 1) misses.push(`${h} m seed ${seed}: ${jumps.length} jumps (${det.lastReject})`);
    else errs.push((jumps[0].heightM - truth[0].heightM) * 100);
  }
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  return {
    misses, n: errs.length,
    mean: abs.reduce((a, b) => a + b, 0) / abs.length,
    bias: errs.reduce((a, b) => a + b, 0) / errs.length,
    p90: abs[Math.floor(0.9 * abs.length)],
    max: abs.at(-1),
    within1: abs.filter((e) => e <= 1).length / abs.length,
  };
}
const fmt = (s) => `n=${s.n} mean ${s.mean.toFixed(2)} bias ${s.bias.toFixed(2)} p90 ${s.p90.toFixed(2)} max ${s.max.toFixed(2)} cm, ${(100 * s.within1).toFixed(0)}% within 1 cm`;

test('heightFromFlightTime', () => {
  assert.equal(G, 9.80665);
  assert.equal(heightFromFlightTime(0), 0);
  assert.ok(Math.abs(heightFromFlightTime(0.5) - 0.306458) < 1e-6);
  // Round trip with the take-off speed of a 40 cm jump: T = 2·sqrt(2gh)/g.
  const T = (2 * Math.sqrt(2 * G * 0.4)) / G;
  assert.ok(Math.abs(heightFromFlightTime(T) - 0.4) < 1e-12);
  assert.ok(Number.isNaN(heightFromFlightTime(-0.1)));
  assert.ok(Number.isNaN(heightFromFlightTime(NaN)));
});

// Tolerances are what the method measurably achieves on these seeds (with ~15% headroom),
// for jumps of 15–80 cm with MediaPipe-like smoothing (fitted to a real trace), 25% frame-time
// jitter and 3% dropped frames. noise = landmark sd before smoothing, as a fraction of body
// length (0.008 ≈ realistic in motion). The worst cases are short (15–25 cm) jumps, where the
// smoothing lags most around the slow apex. At 15 fps the simulated smoothing lags landings
// more than takeoffs, hence the ~+1 cm bias there.
const ACCURACY = [
  // fps, noise, mean, p90, max (cm), |bias| (cm), misses allowed
  [60, 0.004, 0.6, 1.1, 1.7, 0.5, 0],
  [60, 0.008, 0.7, 1.6, 2.5, 0.5, 0],
  [60, 0.015, 1.15, 2.4, 4.7, 0.5, 2],
  [30, 0.004, 0.8, 1.5, 3.3, 0.5, 0],
  [30, 0.008, 1.05, 2.4, 4.5, 0.5, 0],
  [30, 0.015, 1.6, 3.4, 6.3, 0.5, 2],
  [24, 0.008, 1.2, 2.4, 4.4, 0.5, 0],
  [15, 0.008, 1.9, 4.4, 7.5, 1.3, 0],
];
for (const [fps, noise, mean, p90, max, bias, misses] of ACCURACY) {
  test(`accuracy ${fps} fps, noise ${noise}`, (t) => {
    const s = sweep({ fps, noise });
    t.diagnostic(fmt(s));
    assert.ok(s.misses.length <= misses, s.misses.join('; '));
    assert.ok(s.mean <= mean, `mean ${s.mean.toFixed(2)} > ${mean}`);
    assert.ok(s.p90 <= p90, `p90 ${s.p90.toFixed(2)} > ${p90}`);
    assert.ok(s.max <= max, `max ${s.max.toFixed(2)} > ${max}`);
    assert.ok(Math.abs(s.bias) <= bias, `bias ${s.bias.toFixed(2)}`);
  });
}

test('60 fps realistic noise: most jumps within 1 cm', () => {
  assert.ok(sweep({ fps: 60, noise: 0.008 }).within1 >= 0.8);
});

test('accuracy without pose smoothing (raw landmarks)', (t) => {
  // Raw landmarks: a +0.6 cm bias from taking the max of noisy heel/toe y on a flat foot.
  const s = sweep({ fps: 30, noise: 0.008, smoothing: null });
  t.diagnostic(fmt(s));
  assert.deepEqual(s.misses, []);
  assert.ok(s.mean <= 1.0 && s.max <= 3.8 && Math.abs(s.bias) <= 0.8, fmt(s));
});

test('knee tuck in flight (re-extended before landing) costs about 1.5 cm', (t) => {
  // Feet no longer follow the hips' parabola, so the detector falls back to the hinge fit.
  const s = sweep({ fps: 30, noise: 0.008, seeds: 10, jump: { tuck: 0.1 } });
  t.diagnostic(fmt(s));
  assert.ok(s.misses.length <= 2, s.misses.join('; '));
  assert.ok(s.mean <= 2.0 && s.max <= 3.8, fmt(s));
});

// --- things that are not jumps ---

const NON_JUMPS = {
  'standing still': [stand(6)],
  'walking into view': [{ type: 'walk', to: 3, dur: 2.5 }, stand(2)],
  'walking away from the camera': [stand(), { type: 'walk', to: 4, dur: 2.2 }, stand(2)],
  'walking towards the camera': [stand(), { type: 'walk', to: 2.3, dur: 2.2 }, stand(2)],
  squats: [stand(), { type: 'squat' }, { type: 'squat', depth: 0.5, dur: 1.2 }, stand()],
  'calf raises': [stand(), { type: 'calfRaise', reps: 4, rise: 0.1 }, stand()],
  'stepping onto a box': [stand(), { type: 'stepUp' }, stand(1.5)],
  'hopping up onto a box': [stand(), { type: 'jump', height: 0.3, landFloor: 0.25 }, stand(1.5)],
  'tracking dropouts': [stand(), { type: 'dropout', dur: 0.1 }, stand(0.5), { type: 'dropout', dur: 0.6 }, stand(2)],
  'landmark glitches (1–3 frames)': [stand(), { type: 'glitch', dur: 0.03 }, stand(1), { type: 'glitch', dur: 0.05 }, stand(1), { type: 'glitch', dur: 0.1, offset: 0.3 }, stand(1)],
  'leaving the frame mid-air': [stand(), { type: 'jump', height: 0.4, vanishAfter: 0.12 }, { type: 'dropout', dur: 1 }],
};
for (const [name, script] of Object.entries(NON_JUMPS)) {
  test(`no jump reported: ${name}`, () => {
    for (const fps of [15, 30, 60]) for (const smoothing of [{}, null]) for (let seed = 1; seed <= 8; seed++) {
      const { samples } = simulate({ seed, fps, noise: 0.008, smoothing, script });
      const { jumps } = run(new JumpDetector(), samples);
      assert.equal(jumps.length, 0, `${fps} fps seed ${seed} smoothing ${!!smoothing}: ${JSON.stringify(jumps[0])}`);
    }
  });
}

// --- streams with jumps ---

test('repeated jumps in one stream, hands-free', () => {
  const script = [stand(), { type: 'jump', height: 0.3 }, stand(0.4), { type: 'jump', height: 0.45 }, { type: 'jump', height: 0.2 }, stand(1)];
  for (const fps of [15, 30, 60]) for (let seed = 1; seed <= 6; seed++) {
    const { samples, truth } = simulate({ seed, fps, noise: 0.008, script });
    const { jumps, statuses } = run(new JumpDetector(), samples);
    assert.equal(jumps.length, 3, `${fps} fps seed ${seed}`);
    jumps.forEach((j, i) => {
      assert.ok(Math.abs(j.heightM - truth[i].heightM) < 0.045, `${fps} fps seed ${seed} jump ${i}: ${j.heightM} vs ${truth[i].heightM}`);
      assert.ok(Math.abs(j.takeoffT - truth[i].takeoffT) < 0.04);
    });
    assert.equal(statuses.at(-1), 'ready');
  }
});

test('status: no-person, settling, ready, airborne', () => {
  const det = new JumpDetector();
  assert.equal(det.push({ t: 0, visible: false, footL: NaN, footR: NaN, hipY: NaN, bodyLen: NaN }).status, 'no-person');
  assert.equal(det.push({ t: 1, visible: false, footL: NaN, footR: NaN, hipY: NaN, bodyLen: NaN }).status, 'no-person');
  const { samples, truth } = simulate({ seed: 3, fps: 30, script: [stand(1.5), { type: 'jump', height: 0.4 }, stand(1)], t0: 2 });
  const statuses = samples.map((s) => [s.t, det.push(s).status]);
  assert.equal(statuses[0][1], 'settling');
  assert.ok(statuses.some(([t, st]) => st === 'ready' && t < truth[0].takeoffT));
  assert.ok(statuses.filter(([t]) => t > truth[0].takeoffT + 0.1 && t < truth[0].landingT - 0.1).every(([, st]) => st === 'airborne'));
  assert.equal(statuses.at(-1)[1], 'ready');
});

test('a dropped frame or two mid-flight keeps the jump, with a note', () => {
  for (const fps of [30, 60]) for (let seed = 1; seed <= 8; seed++) {
    const { samples, truth } = simulate({ seed, fps, noise: 0.008, script: [stand(), { type: 'jump', height: 0.4 }, stand(1)] });
    let k = 0;
    for (const s of samples) {
      if (s.t > truth[0].takeoffT + 0.15 && k < 1 + (seed % 2)) {
        Object.assign(s, { visible: false, footL: NaN, footR: NaN, hipY: NaN, bodyLen: NaN });
        k++;
      }
    }
    const { jumps } = run(new JumpDetector(), samples);
    assert.equal(jumps.length, 1, `${fps} fps seed ${seed}`);
    assert.ok(Math.abs(jumps[0].heightM - 0.4) < 0.03, `${fps} fps seed ${seed}: ${jumps[0].heightM}`);
    assert.notEqual(jumps[0].confidence, 'high');
    assert.ok(jumps[0].notes.some((n) => /dropped out/.test(n)));
  }
});

test('bent-knee landing lowers confidence and says why', () => {
  for (const fps of [15, 30, 60]) for (let seed = 1; seed <= 6; seed++) {
    const { samples } = simulate({ seed, fps, noise: 0.008, script: [stand(), { type: 'jump', height: 0.4, landBend: 0.12 }, stand(1)] });
    const { jumps } = run(new JumpDetector(), samples);
    assert.equal(jumps.length, 1);
    // Flight time really is longer, so the height is overestimated: that is what the note is for.
    assert.ok(jumps[0].heightM > 0.42);
    assert.notEqual(jumps[0].confidence, 'high', `${fps} fps seed ${seed}`);
    assert.ok(jumps[0].notes.some((n) => /Landing looked lower than takeoff/.test(n)));
  }
});

test('symmetric jumps are mostly high confidence with no notes', () => {
  let high = 0, n = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { samples } = simulate({ seed, fps: 30, noise: 0.008, script: [stand(), { type: 'jump', height: 0.35 }, stand(1)] });
    const j = run(new JumpDetector(), samples).jumps[0];
    n++;
    if (j.confidence === 'high' && j.notes.length === 0) high++;
  }
  assert.ok(high / n >= 0.85, `${high}/${n}`);
});

test('re-settles after walking to a new spot, then measures', () => {
  for (const fps of [15, 30, 60]) for (let seed = 1; seed <= 6; seed++) {
    const { samples, truth } = simulate({
      seed, fps, noise: 0.008,
      script: [stand(), { type: 'walk', to: 3.8, dur: 2 }, stand(1.2), { type: 'jump', height: 0.35 }, stand(1)],
    });
    const { jumps } = run(new JumpDetector(), samples);
    assert.equal(jumps.length, 1, `${fps} fps seed ${seed}`);
    assert.ok(Math.abs(jumps[0].heightM - truth[0].heightM) < 0.035, `${fps} fps seed ${seed}: ${jumps[0].heightM}`);
  }
});

test('landing a little forward still counts, with a note', () => {
  const { samples, truth } = simulate({ seed: 2, fps: 30, noise: 0.008, script: [stand(), { type: 'jump', height: 0.4, forward: 0.15 }, stand(1)] });
  const { jumps } = run(new JumpDetector(), samples);
  assert.equal(jumps.length, 1);
  assert.ok(Math.abs(jumps[0].heightM - truth[0].heightM) < 0.03);
  assert.ok(jumps[0].notes.some((n) => /landed away/.test(n)));
});

// --- real MediaPipe trace: a photo moved rigidly on a gravity parabola, flight exactly 0.600 s ---

const FIXTURE = process.env.JUMP_TRACE ?? new URL('./fixtures/pose-trace-60fps.json', import.meta.url);
test('real pose trace: flight time 0.600 s', { skip: !existsSync(FIXTURE) && 'fixture tests/fixtures/pose-trace-60fps.json not present' }, () => {
  const trace = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  // Full rate within ±3 ms; every 2nd sample (30 fps) ±5 ms; every 4th (15 fps) ±12 ms, i.e.
  // about ±1.5 cm at this height: at 15 fps one frame is 67 ms and the fit has ~8 points.
  for (const [k, tol] of [[1, 0.003], [2, 0.005], [4, 0.012]]) {
    for (let off = 0; off < k; off++) {
      const { jumps } = run(new JumpDetector(), trace.filter((_, i) => i % k === off));
      assert.equal(jumps.length, 1, `every ${k}th from ${off}`);
      const T = jumps[0].flightTime;
      assert.ok(Math.abs(T - 0.6) <= tol, `every ${k}th from ${off}: T = ${T.toFixed(4)}`);
      assert.equal(jumps[0].confidence, 'high');
    }
  }
});
