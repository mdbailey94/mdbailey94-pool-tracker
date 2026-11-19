import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { G, heightFromFlightTime, estimateHeight, JumpDetector, analyseRecording } from '../src/jump.js';
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
  // p90 was 2.0 before posture adjustments: with landmarks this noisy the hip-drop measure
  // sometimes sees a bent landing that is not there. The mean is unchanged, and real bent
  // landings go from reading 4 cm high to under 1 (see the posture tests below).
  [60, 0.015, 1.15, 2.6, 4.7, 0.5, 2],
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

test('knee tuck in flight (re-extended before landing) is allowed for', (t) => {
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

test('bent-knee landing lowers confidence, says why, and is adjusted for', () => {
  for (const fps of [15, 30, 60]) {
    let adj = 0, raw = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { samples, truth } = simulate({ seed, fps, noise: 0.008, script: [stand(), { type: 'jump', height: 0.4, landBend: 0.12 }, stand(1)] });
      const { jumps } = run(new JumpDetector(), samples);
      assert.equal(jumps.length, 1);
      const j = jumps[0], h = truth[0].heightM;
      assert.notEqual(j.confidence, 'high', `${fps} fps seed ${seed}`);
      assert.ok(j.notes.some((n) => /Landing looked lower than takeoff/.test(n)));
      // The fall really is longer than the rise, so flight time alone reads high; the
      // reported height takes the hips' drop off, and its range holds the true height.
      assert.ok(j.bentLandingM < -0.02, `${fps} fps seed ${seed}: adjustment ${j.bentLandingM}`);
      assert.ok(j.lowM <= h && h <= j.highM, `${fps} fps seed ${seed}: ${h} outside ${j.lowM}–${j.highM}`);
      adj += Math.abs(j.heightM - h) / 6;
      raw += Math.abs(j.flightHeightM - h) / 6;
    }
    assert.ok(raw > 0.03, `${fps} fps: flight time alone is only ${raw} m off`);
    assert.ok(adj < raw / 2, `${fps} fps: adjusted ${adj} m off vs ${raw} m for flight time alone`);
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

// A flight that has already landed must survive the stream ending, or sight being lost,
// before the post-landing window has passed (a tightly trimmed clip; stepping out of view).
test('a landed jump is kept when the stream ends or sight is lost just after landing', () => {
  for (const fps of [30, 60]) for (let seed = 1; seed <= 5; seed++) {
    const { samples, truth } = simulate({ seed: 40 + seed + fps, fps, noise: 0.004, script: [stand(1.2), { type: 'jump', height: 0.4 }, stand(1)] });
    const cut = truth[0].landingT + 0.12;
    const head = samples.filter((s) => s.t <= cut);

    // Clip ends 0.12 s after touchdown: nothing from push, the jump comes from flush().
    const a = new JumpDetector();
    const pushed = head.map((s) => a.push(s).jump).filter(Boolean);
    assert.equal(pushed.length, 0, 'jump should still be pending');
    const flushed = a.flush();
    assert.ok(flushed, `fps ${fps} seed ${seed}: flush returned no jump (${a.lastReject})`);
    assert.ok(Math.abs(flushed.heightM - truth[0].heightM) < 0.04, `flush height off: ${flushed.heightM} vs ${truth[0].heightM}`);
    assert.equal(a.flush(), null, 'flush must not report the same jump twice');

    // Sight lost 0.12 s after touchdown for half a second: the jump is reported, not dropped.
    const b = new JumpDetector();
    const blank = (t) => ({ t, footL: NaN, footR: NaN, hipY: NaN, bodyLen: NaN, visible: false });
    const gapped = [...head, ...samples.filter((s) => s.t > cut && s.t <= cut + 0.5).map((s) => blank(s.t)), ...samples.filter((s) => s.t > cut + 0.5)];
    const { jumps } = run(b, gapped);
    assert.equal(jumps.length, 1, `fps ${fps} seed ${seed}: expected 1 jump after losing sight, got ${jumps.length} (${b.lastReject})`);
  }
});

test('a jump seen in under four frames is never better than low confidence', () => {
  for (const fps of [8, 10]) for (let seed = 1; seed <= 10; seed++) {
    const { samples } = simulate({ seed: 900 + seed + fps, fps, noise: 0.004, script: [stand(1.5), { type: 'jump', height: 0.2 }, stand(1.5)] });
    const { jumps } = run(new JumpDetector(), samples);
    for (const j of jumps) {
      const frames = samples.filter((s) => s.t > j.takeoffT && s.t < j.landingT).length;
      if (frames < 4) assert.equal(j.confidence, 'low', `fps ${fps} seed ${seed}: ${frames} frames in the air but ${j.confidence}`);
    }
  }
});

// ---- recordings: analysed as a whole, so the play rate and the baseline come from hindsight

const clip = ({ seed, fps, height = 0.35, before = 1.2, after = 0.8, slow = 1 }) => {
  const { samples, truth } = simulate({ seed, fps, noise: 0.008, smoothing: {}, script: [stand(1.2), { type: 'jump', height }, stand(1)] });
  const from = truth[0].takeoffT - 0.7 - before, to = truth[0].landingT + after; // 0.7 s ≈ the countermovement
  return { truth: truth[0], samples: samples.filter((s) => s.t >= from && s.t <= to).map((s) => ({ ...s, t: s.t * slow })) };
};

test('recording: slow motion is recognised and gives the same height as real time', () => {
  for (const fps of [30, 60, 120]) for (const height of [0.2, 0.4, 0.6]) for (let seed = 1; seed <= 4; seed++) {
    const base = analyseRecording(clip({ seed: seed * 13 + fps, fps, height }).samples);
    assert.equal(base.rate, 1, `${fps} fps ${height} m seed ${seed}: real-time clip read as ${base.rate}x`);
    assert.equal(base.jumps.length, 1);
    for (const slow of [2, 4, 8]) {
      const { truth, samples } = clip({ seed: seed * 13 + fps, fps, height, slow });
      const r = analyseRecording(samples);
      assert.equal(r.rate, slow, `${fps} fps ${height} m seed ${seed}: ${slow}x clip read as ${r.rate}x`);
      assert.equal(r.jumps.length, 1);
      assert.ok(Math.abs(r.jumps[0].flightTime - base.jumps[0].flightTime) < 1e-6, 'slow motion changed the flight time');
      assert.ok(Math.abs(r.jumps[0].heightM - truth.heightM) < 0.04, `height ${r.jumps[0].heightM} vs ${truth.heightM}`);
      // Times are reported in real time, in order.
      assert.ok(Math.abs(r.jumps[0].takeoffT - truth.takeoffT) < 0.05, `takeoff ${r.jumps[0].takeoffT} vs ${truth.takeoffT}`);
    }
  }
});

test('recording: a clip that starts mid-crouch or ends soon after landing is still measured', () => {
  for (const fps of [30, 60, 120]) for (let seed = 1; seed <= 6; seed++) {
    for (const [before, after] of [[0, 0.8], [-0.5, 0.8], [0.3, 0.3], [1.2, 0.05]]) {
      const { truth, samples } = clip({ seed: seed * 29 + fps, fps, before, after });
      const r = analyseRecording(samples);
      assert.equal(r.jumps.length, 1, `${fps} fps seed ${seed} before ${before} after ${after}: ${r.jumps.length} jumps`);
      assert.equal(r.rate, 1);
      assert.ok(Math.abs(r.jumps[0].heightM - truth.heightM) < 0.04, `height ${r.jumps[0].heightM} vs ${truth.heightM}`);
    }
  }
});

test('recording: non-jumps give no reading at any play rate', () => {
  for (const [name, script] of Object.entries(NON_JUMPS)) for (const fps of [30, 60, 120]) for (let seed = 1; seed <= 5; seed++) {
    const { samples } = simulate({ seed: seed * 77 + fps, fps, noise: 0.008, smoothing: {}, script });
    const r = analyseRecording(samples);
    assert.equal(r.jumps.length, 0, `${name} at ${fps} fps seed ${seed}: read as a ${(r.jumps[0]?.heightM * 100).toFixed(1)} cm jump at ${r.rate}x`);
  }
});

test('recording: repeated jumps are each reported once, in order', () => {
  const { samples, truth } = simulate({ seed: 5, fps: 60, noise: 0.008, smoothing: {}, script: [stand(), { type: 'jump', height: 0.3 }, stand(0.6), { type: 'jump', height: 0.45 }, stand(1)] });
  const r = analyseRecording(samples);
  assert.equal(r.jumps.length, 2);
  r.jumps.forEach((j, i) => assert.ok(Math.abs(j.heightM - truth[i].heightM) < 0.04, `jump ${i}: ${j.heightM} vs ${truth[i].heightM}`));
});


// ---- height estimate: posture adjustments and the 95% range

test('estimateHeight: plain flight time when posture matches, adjusted when it does not', () => {
  const T = 0.6, flight = heightFromFlightTime(T);
  const clean = estimateHeight({ flightTime: T, frames: 36, dropM: 0.005, foldM: 0 });
  assert.equal(clean.heightM, flight);
  assert.equal(clean.bentLandingM, 0);
  assert.equal(clean.tuckM, 0);
  assert.ok(clean.lowM < flight && flight < clean.highM);
  // Hips 10 cm lower at landing: about a third of that comes off, and the range widens.
  const bent = estimateHeight({ flightTime: T, frames: 36, dropM: 0.1, foldM: 0 });
  assert.ok(bent.heightM < flight - 0.02 && bent.heightM > flight - 0.04, `${bent.heightM} vs ${flight}`);
  assert.equal(bent.flightHeightM, flight);
  assert.ok(bent.highM - bent.lowM > clean.highM - clean.lowM);
  // Hips lower at takeoff than landing is noted elsewhere but not adjusted for.
  assert.equal(estimateHeight({ flightTime: T, frames: 36, dropM: -0.1, foldM: 0 }).heightM, flight);
  // Knees tucked: a little is added back.
  assert.ok(estimateHeight({ flightTime: T, frames: 36, dropM: 0, foldM: 0.08 }).heightM > flight);
  // Fewer frames in the air means a wider range; so does not being able to check posture.
  const few = estimateHeight({ flightTime: T, frames: 9, dropM: 0, foldM: 0 });
  assert.ok(few.highM - few.lowM > clean.highM - clean.lowM);
  const blind = estimateHeight({ flightTime: T, frames: 36, dropM: NaN, foldM: NaN });
  assert.ok(blind.highM - blind.lowM > clean.highM - clean.lowM);
  assert.ok(estimateHeight({ flightTime: 0.16, frames: 3, dropM: 0.2, foldM: 0 }).lowM >= 0);
});

// The claim behind "95% range": across clean jumps, tucks and bent landings, the true
// height falls inside the reported range at least that often, and the reported height
// is closer to the truth than flight time alone when the landing is bent.
test('95% range holds the true height; bent landings and tucks are corrected', (t) => {
  const CONDS = { clean: {}, 'tuck 5 cm': { tuck: 0.05 }, 'tuck 10 cm': { tuck: 0.1 }, 'bend 5 cm': { landBend: 0.05 }, 'bend 10 cm': { landBend: 0.1 }, 'bend 15 cm': { landBend: 0.15 } };
  let inside = 0, n = 0;
  for (const [name, jump] of Object.entries(CONDS)) {
    const adj = [], raw = [];
    let hit = 0, m = 0, missed = 0;
    for (const fps of [30, 60, 120]) for (const h of [0.25, 0.4, 0.55]) for (let seed = 1; seed <= 6; seed++) {
      const { samples, truth } = simulate({ seed: seed * 53 + fps + Math.round(h * 100), fps, noise: 0.008, smoothing: {}, script: [stand(1.2), { type: 'jump', height: h, ...jump }, stand(1)] });
      const j = analyseRecording(samples).jumps[0];
      // A deep bend on a small jump at a low frame rate can be too distorted to accept.
      if (!j) { missed++; continue; }
      const true_ = truth[0].heightM;
      adj.push((j.heightM - true_) * 100);
      raw.push((j.flightHeightM - true_) * 100);
      if (j.lowM <= true_ && true_ <= j.highM) hit++;
      m++;
    }
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    t.diagnostic(`${name}: reported ${mean(adj).toFixed(1)} cm off on average (flight time alone ${mean(raw).toFixed(1)}), true height inside the range ${Math.round((100 * hit) / m)}%`);
    assert.ok(missed <= (/bend 15/.test(name) ? 3 : 0), `${name}: ${missed} jumps not found`);
    assert.ok(hit / m >= 0.9, `${name}: only ${hit}/${m} inside the range`);
    assert.ok(Math.abs(mean(adj)) < 1.2, `${name}: reported height off by ${mean(adj).toFixed(2)} cm on average`);
    if (/bend 1/.test(name)) assert.ok(Math.abs(mean(adj)) < Math.abs(mean(raw)) / 3, `${name}: ${mean(adj)} vs ${mean(raw)}`);
    inside += hit; n += m;
  }
  assert.ok(inside / n >= 0.95, `overall ${inside}/${n} inside the range`);
});

// A jump that lands away from the takeoff spot shifts the ground level in the picture.
// It must be read about right or not at all: never at the wrong play rate (which would
// report a quarter of the height), and never as a second, false jump.
test('recording: landing nearer or farther from the camera is read right or not reported', () => {
  for (const slow of [1, 4]) for (const forward of [-0.3, -0.15, 0.15, 0.3]) {
    let found = 0;
    for (const fps of [30, 60, 120]) for (const h of [0.25, 0.4, 0.55]) for (let seed = 1; seed <= 4; seed++) {
      const { samples, truth } = simulate({ seed: seed * 31 + fps, fps, noise: 0.008, smoothing: {}, script: [stand(1.2), { type: 'jump', height: h, forward }, stand(1)] });
      const r = analyseRecording(samples.map((s) => ({ ...s, t: s.t * slow })));
      assert.ok(r.jumps.length <= 1, `forward ${forward} ${fps} fps ${h} m seed ${seed}: ${r.jumps.length} jumps`);
      if (!r.jumps.length) continue;
      found++;
      assert.equal(r.rate, slow, `forward ${forward} ${fps} fps ${h} m seed ${seed}: read at ${r.rate}x, clip is ${slow}x`);
      assert.ok(Math.abs(r.jumps[0].heightM - truth[0].heightM) < 0.05, `forward ${forward} ${fps} fps ${h} m seed ${seed}: ${r.jumps[0].heightM} vs ${truth[0].heightM}`);
    }
    if (Math.abs(forward) <= 0.15 && forward > 0) assert.ok(found > 0, `forward ${forward}: nothing found`);
  }
});
