// Jump simulator: builds a continuous physical motion (metres, seconds) from a
// script of segments, then samples it like a phone camera + pose model would:
// irregular frame times, dropped frames, timestamp noise, noisy heel/toe/hip
// landmarks smoothed by a MediaPipe-like One-Euro filter, perspective from camera
// distance. The detector only ever sees the sampled landmarks, never the motion model.
//
// Options: seed, fps, jitter (frame interval ±fraction), drop (dropped-frame probability),
// tNoise (timestamp sd, s), noise (landmark sd before smoothing, × body length),
// distance (m from camera), smoothing (oneEuro options, null = raw), t0, script.
// Segments: stand, jump {height, cmDepth, heelRise, tuck, landBend, footDelay, landDelay,
// forward, landFloor, vanishAfter, swap}, walk {to, dur}, squat, calfRaise, stepUp,
// dropout, glitch {dur, offset}.
//
//   const { samples, truth } = simulate({ seed: 1, fps: 30, noise: 0.008,
//     script: [{ type: 'stand', dur: 1 }, { type: 'jump', height: 0.4 }, { type: 'stand', dur: 1 }] });

const G = 9.80665;
const CAM_H = 0.9; // camera height (m); frame covers `distance` metres vertically at the subject
const HIP = 0.95; // standing hip height (m)
const SHOULDER = 1.45; // standing shoulder height (m)
const HEAD = 1.68; // standing ear height (m); the head moves rigidly with the hips here
const ANKLE = 0.08;

export function rng(seed) {
  let a = seed >>> 0 || 1;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  u.normal = () => Math.sqrt(-2 * Math.log(1 - u())) * Math.cos(2 * Math.PI * u());
  return u;
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => { x = clamp01(x); return x * x * (3 - 2 * x); };
const ease = (x) => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(x)); // 0→1 with zero end slopes
// Cubic Hermite from (p0, v0) to (p1, v1) over duration d, evaluated at local time s.
function hermite(s, d, p0, v0, p1, v1) {
  const x = clamp01(s / d), x2 = x * x, x3 = x2 * x;
  return (2 * x3 - 3 * x2 + 1) * p0 + (x3 - 2 * x2 + x) * d * v0 + (-2 * x3 + 3 * x2) * p1 + (x3 - x2) * d * v1;
}

const flatFeet = (floor) => ({ L: { toe: floor, heel: floor }, R: { toe: floor, heel: floor } });

// --- segments: each returns { dur, at(s) -> pose, end: {floor, distance} }, pose in metres ---

function stand(cfg, ctx) {
  const { floor, distance } = ctx;
  return { dur: cfg.dur ?? 1, end: ctx, at: (s) => ({ distance, hip: floor + HIP + 0.004 * Math.sin(2.1 * s), feet: flatFeet(floor) }) };
}

// Countermovement jump. True takeoff = last toe leaving the ground; true landing = first toe touching.
function jump(cfg, ctx) {
  const c = {
    height: 0.4, cmDepth: 0.25, cmDur: 0.45, pushDur: 0.28, heelRise: 0.07, heelLead: 0.15,
    tuck: 0, landBend: 0, footDelay: 0.012, landDelay: 0.01, swap: false, absorb: 0.15, recover: 0.8,
    landFloor: ctx.floor, forward: 0, vanishAfter: Infinity, ...cfg,
  };
  const f0 = ctx.floor, f1 = c.landFloor, d0 = ctx.distance, d1 = d0 - c.forward;
  const v0 = Math.sqrt(2 * G * c.height);
  const T0 = (2 * v0) / G; // nominal flight with unchanged posture
  const t0 = c.cmDur + c.pushDur; // takeoff (segment-local)
  const hipTO = f0 + HIP + c.heelRise; // hips higher at takeoff: legs straight and on the toes
  const tuck = (tau) => (tau > 0 && tau < T0 ? c.tuck * Math.sin((Math.PI * tau) / T0) ** 2 : 0);
  const bend = (tau) => c.landBend * smooth(tau / T0); // legs shorten towards landing (bent-knee touchdown)
  const disp = (tau) => v0 * tau - (G * tau * tau) / 2; // centre of mass rise since takeoff
  const toeFlight = (tau) => f0 + disp(tau) + tuck(tau) + bend(tau);
  // Landing: first time after the apex that the leading toe meets the landing floor.
  let lo = v0 / G, hi = T0 + 1;
  for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (toeFlight(m) > f1) lo = m; else hi = m; }
  const TL = (lo + hi) / 2;
  const vL = v0 - G * TL;
  const hipLand = hipTO + disp(TL);
  const toe = (tau) => (tau <= 0 ? f0 : tau >= TL ? f1 : toeFlight(tau));
  // The other foot leaves `footDelay` earlier and lands `landDelay` later.
  const toe2 = (tau) => {
    const w = smooth(tau / TL);
    return toe(tau + c.footDelay * (1 - w) - c.landDelay * w);
  };
  const heelUp = (tau, tLand) => c.heelRise * (tau < 0 ? smooth((tau + c.heelLead) / c.heelLead) : tau < tLand ? 1 : 1 - smooth((tau - tLand) / 0.08));
  const tEnd = t0 + TL;
  const dur = tEnd + c.recover;
  const at = (s) => {
    const tau = s - t0;
    let hip;
    if (s < c.cmDur) hip = f0 + HIP - c.cmDepth * ease(s / c.cmDur);
    else if (tau < 0) hip = hermite(s - c.cmDur, c.pushDur, f0 + HIP - c.cmDepth, 0, hipTO, v0);
    else if (tau < TL) hip = hipTO + disp(tau) - 0.25 * tuck(tau); // hips sit a little below the CoM when tucked
    else if (tau < TL + 0.25) hip = hermite(tau - TL, 0.25, hipLand, vL, f1 + HIP - c.absorb, 0);
    else hip = f1 + HIP - c.absorb * (1 - ease((tau - TL - 0.25) / (c.recover - 0.3)));
    const a = { toe: toe(tau), heel: toe(tau) + heelUp(tau, TL) };
    const b = { toe: toe2(tau), heel: toe2(tau) + heelUp(tau + c.footDelay, TL + c.landDelay) };
    const distance = d0 + (d1 - d0) * smooth(tau / TL);
    return { distance, hip, feet: c.swap ? { L: b, R: a } : { L: a, R: b }, visible: tau < c.vanishAfter };
  };
  const truth = c.vanishAfter < Infinity || f1 !== f0 ? null
    : { localTakeoff: t0, flightTime: TL, heightM: c.height, flightHeight: (G * TL * TL) / 8, riseM: c.height + c.heelRise };
  return { dur, at, truth, end: { floor: f1, distance: d1 } };
}

// Walking to a new distance from the camera, feet alternating.
function walk(cfg, ctx) {
  const { floor } = ctx, d0 = ctx.distance, d1 = cfg.to ?? d0, period = cfg.step ?? 0.55;
  const dur = cfg.dur ?? 2.2;
  const swing = (ph) => (ph < 0.6 ? Math.sin((Math.PI * ph) / 0.6) : 0);
  const foot = (ph) => ({ toe: floor + 0.05 * swing(ph), heel: floor + 0.14 * swing(Math.min(0.6, ph + 0.12)) });
  const at = (s) => {
    const n = s / period;
    return {
      distance: d0 + (d1 - d0) * clamp01(s / dur),
      hip: floor + HIP + 0.02 * Math.cos(2 * Math.PI * n),
      feet: { L: foot((n % 2) / 1), R: foot(((n + 1) % 2) / 1) },
    };
  };
  return { dur, at, end: { floor, distance: d1 } };
}

function squat(cfg, ctx) {
  const { floor, distance } = ctx, depth = cfg.depth ?? 0.35, dur = cfg.dur ?? 1.6;
  return { dur, end: ctx, at: (s) => ({ distance, hip: floor + HIP - depth * Math.sin((Math.PI * s) / dur) ** 2, feet: flatFeet(floor) }) };
}

function calfRaise(cfg, ctx) {
  const { floor, distance } = ctx, reps = cfg.reps ?? 3, rise = cfg.rise ?? 0.08, dur = reps * 0.9;
  return {
    dur, end: ctx,
    at: (s) => {
      const r = rise * Math.sin((Math.PI * s) / 0.9) ** 2;
      const f = { toe: floor, heel: floor + r };
      return { distance, hip: floor + HIP + r, feet: { L: f, R: { ...f } } };
    },
  };
}

// Stepping up onto a box, one foot then the other (`hop: true` jumps up instead).
function stepUp(cfg, ctx) {
  const { distance } = ctx, f0 = ctx.floor, f1 = f0 + (cfg.box ?? 0.2);
  const lift = (s) => f0 + (f1 - f0) * ease(s / 0.35) + 0.12 * Math.sin(Math.PI * clamp01(s / 0.35));
  const foot = (s) => (s <= 0 ? f0 : s >= 0.35 ? f1 : lift(s));
  return {
    dur: 1.4, end: { floor: f1, distance },
    at: (s) => ({
      distance, hip: f0 + HIP + (f1 - f0) * ease((s - 0.2) / 0.6),
      feet: { L: { toe: foot(s - 0.1), heel: foot(s - 0.1) }, R: { toe: foot(s - 0.55), heel: foot(s - 0.55) } },
    }),
  };
}

// Person standing but the tracker loses them (visible:false) for a while.
function dropout(cfg, ctx) {
  const base = stand({ dur: cfg.dur ?? 0.3 }, ctx);
  return { ...base, at: (s) => ({ ...base.at(s), visible: false }) };
}

// Landmark glitch: tracker briefly snaps feet (and hips) upward while the person stands.
function glitch(cfg, ctx) {
  const base = stand({ dur: cfg.dur ?? 0.08 }, ctx), off = cfg.offset ?? 0.25;
  return {
    ...base,
    at: (s) => {
      const p = base.at(s), up = (f) => ({ toe: f.toe + off, heel: f.heel + off });
      return { ...p, hip: p.hip + off * 0.5, feet: { L: up(p.feet.L), R: up(p.feet.R) } };
    },
  };
}

// One-Euro filter, the adaptive low-pass MediaPipe's pose landmarker applies to landmarks
// in video mode. Near-still landmarks are smoothed hard (lag at takeoff from rest, a
// flattened, late apex, feet still a little high at touchdown); fast ones pass almost
// untouched. Defaults fitted to a real MediaPipe trace of a jump with known motion
// (min cutoff 0.05 Hz, beta 20 on coordinates divided by body length, derivative 1 Hz).
export function oneEuro({ minCutoff = 0.05, beta = 20, dCutoff = 1 } = {}) {
  let x = null, dx = 0, tPrev = 0;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  const f = (value, t, scale) => {
    const v = value / scale;
    if (x === null || !(t > tPrev)) { x = v; dx = 0; tPrev = t; return value; }
    const dt = t - tPrev;
    tPrev = t;
    dx += alpha(dCutoff, dt) * ((v - x) / dt - dx);
    x += alpha(minCutoff + beta * Math.abs(dx), dt) * (v - x);
    return x * scale;
  };
  f.reset = () => { x = null; };
  return f;
}

const SEGMENTS = { stand, jump, walk, squat, calfRaise, stepUp, dropout, glitch };

export function simulate(opts = {}) {
  const o = {
    seed: 1, fps: 30, jitter: 0.25, drop: 0.03, tNoise: 0.001, noise: 0.008, distance: 3, t0: 0, smoothing: {},
    script: [{ type: 'stand', dur: 1.5 }, { type: 'jump' }, { type: 'stand', dur: 1 }], ...opts,
  };
  const rand = rng(o.seed);
  const randHead = rng(o.seed + 7919); // its own stream, so adding the head left every other landmark as it was
  // Build the timeline.
  let ctx = { floor: 0, distance: o.distance }, t = 0;
  const segs = [], truth = [];
  for (const cfg of o.script) {
    const seg = SEGMENTS[cfg.type](cfg, ctx);
    segs.push({ start: t, ...seg });
    if (seg.truth) {
      const takeoffT = o.t0 + t + seg.truth.localTakeoff;
      truth.push({ takeoffT, landingT: takeoffT + seg.truth.flightTime, flightTime: seg.truth.flightTime, heightM: seg.truth.heightM, flightHeight: seg.truth.flightHeight,
        riseM: seg.truth.riseM }); // riseM: head rise from standing tall, which includes the rise onto the toes
    }
    t += seg.dur;
    ctx = seg.end;
  }
  const total = t;
  const poseAt = (time) => {
    let i = segs.length - 1;
    while (i > 0 && segs[i].start > time) i--;
    return segs[i].at(Math.min(time - segs[i].start, segs[i].dur));
  };
  // Sample it.
  const samples = [];
  const dt = 1 / o.fps;
  // smoothing: options for oneEuro(), or null for raw landmarks.
  const filt = Object.fromEntries(['heelL', 'toeL', 'heelR', 'toeR', 'hip', 'head'].map((k) => [k, o.smoothing ? oneEuro(o.smoothing) : null]));
  const sm = (k, v, t, scale) => (filt[k] ? filt[k](v, t, scale) : v);
  for (let time = 0; time < total; time += dt * (1 + o.jitter * (2 * rand() - 1))) {
    if (rand() < o.drop) continue;
    const p = poseAt(time);
    const tr = o.t0 + time + o.tNoise * rand.normal();
    if (p.visible === false) {
      Object.values(filt).forEach((f) => f?.reset());
      samples.push({ t: tr, footL: NaN, footR: NaN, hipY: NaN, bodyLen: NaN, headY: NaN, visible: false });
      continue;
    }
    const scale = p.distance; // metres per frame height
    const y = (z) => 0.5 + (CAM_H - z) / scale;
    const ankle = Math.min(p.feet.L.heel, p.feet.R.heel) + ANKLE;
    const shoulder = p.hip + (SHOULDER - HIP);
    const bodyLen = (shoulder - ankle) / scale;
    const sd = o.noise * ((SHOULDER - ANKLE) / scale); // landmark noise as a fraction of standing body length
    const n = () => sd * rand.normal();
    const size = (SHOULDER - ANKLE) / scale;
    const lm = (k, z, s = 1) => sm(k, y(z) + s * n(), tr, size);
    // lowest point of each foot = max of heel/toe y
    const footL = Math.max(lm('heelL', p.feet.L.heel), lm('toeL', p.feet.L.toe));
    const footR = Math.max(lm('heelR', p.feet.R.heel), lm('toeR', p.feet.R.toe));
    const headY = o.head === false ? NaN : sm('head', y(p.hip + (HEAD - HIP)) + Math.SQRT1_2 * sd * randHead.normal(), tr, size);
    samples.push({ t: tr, footL, footR, hipY: lm('hip', p.hip, Math.SQRT1_2), bodyLen: bodyLen + n(), headY, visible: true });
  }
  for (let i = 1; i < samples.length; i++) if (samples[i].t <= samples[i - 1].t) samples[i].t = samples[i - 1].t + 1e-4;
  return { samples, truth, duration: total };
}

// Feed a stream to a detector; returns the jumps it reported and every status.
export function run(detector, samples) {
  const jumps = [], statuses = [];
  for (const s of samples) {
    const r = detector.push(s);
    statuses.push(r.status);
    if (r.jump) jumps.push(r.jump);
  }
  return { jumps, statuses };
}
