// Vertical jump from flight time, h = g·T²/8, using pose landmarks from a live camera.
// Pure: no DOM, no imports. Feed one pose sample per video frame to JumpDetector.push().
//
// Units: image y normalised to frame height, increasing downward. Every threshold is a
// fraction of the standing body length (shoulder–ankle) so it works at any camera distance.

export const G = 9.80665;

export function heightFromFlightTime(T) {
  return Number.isFinite(T) && T >= 0 ? (G * T * T) / 8 : NaN;
}

const DEFAULTS = {
  settleWindow: 0.5, // s of standing still used to learn the ground level
  minSettleSamples: 5,
  stillHips: true, // hips must be still too while learning the ground (live); off for recordings
  stillTol: 0.025, // max robust spread / drift of feet and hips while "still" (× bodyLen)
  driftTol: 0.035, // feet this far from the baseline for driftWindow → person moved, re-settle
  driftWindow: 0.3,
  marginNoise: 5, // takeoff margin = marginNoise × measured foot jitter, clamped to:
  minMargin: 0.03,
  maxMargin: 0.07,
  minFlight: 0.15, // s; plausible flight times
  maxFlight: 1.1,
  maxGap: 0.25, // s; longest tracking gap tolerated inside a flight
  noPersonAfter: 0.4, // s without a visible person before reporting 'no-person'
  postWindow: 0.25, // s of ground contact after landing used to confirm it
  wholeFrac: 0.15, // whole-flight fit uses foot samples above this fraction of the peak rise
  rigidTol: 0.03, // ...when the feet stay within this (× bodyLen) of the hips' free-fall curve
  fitSamples: 3, // hinge fallback: in-flight samples for the first guess of each crossing,
  airSpan: 0.15, // s of samples in the air (at least minAir)
  minAir: 3,
  groundSpan: 0.1, // s of samples on the ground (at least 2)
  groundPrior: 1, // weight (in samples) pulling the local ground level towards the baseline
  riseFactor: 2, // glitch check: feet may rise at most this × takeoff speed next to a crossing
  levelNote: 0.02, // landing foot level vs takeoff (× bodyLen): note above this,
  levelReject: 0.06, // reject above this (stepped onto/off something, walked)
  dropNote: 0.05, // hips lower (m) at landing than at takeoff: note above this,
  dropLow: 0.1, // low confidence above this
  bodyRange: [0.6, 2.4], // plausible shoulder–ankle length (m) implied by the hips' free-fall curvature
};

const median = (a) => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const robustSd = (a) => { const m = median(a); return 1.4826 * median(a.map((x) => Math.abs(x - m))); };

// Linear least squares: rows of [x0..xn-1] against ys, via the normal equations.
function lstsq(rows, ys) {
  const n = rows[0].length, A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  rows.forEach((x, k) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += x[i] * x[j];
      A[i][n] += x[i] * ys[k];
    }
  });
  for (let i = 0; i < n; i++) { // Gauss-Jordan with partial pivoting
    let piv = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]];
    for (let r = 0; r < n; r++) {
      if (r === i || !A[i][i]) continue;
      const f = A[r][i] / A[i][i];
      for (let c = i; c <= n; c++) A[r][c] -= f * A[i][c];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}
// Polynomial (degree 1 or 2) of y on x: [c0, c1, c2?].
const polyfit = (xs, ys, deg) => lstsq(xs.map((x) => [1, x, x * x].slice(0, deg + 1)), ys);

export class JumpDetector {
  constructor(options = {}) {
    this.opt = { ...DEFAULTS, ...options };
    this.reset();
  }

  reset() {
    this.buf = []; // recent visible samples {t, l, r, h, L}
    this.base = null; // ground baseline {l, r, h, L, noise, margin}
    this.phase = 'settling'; // settling | ready | airborne | landed
    this.flight = null; // {start, land, gaps}
    this.lastSeen = -Infinity;
    this.lastReject = null; // why the last candidate was not counted (for debugging / UI hints)
  }

  status() {
    return this.phase === 'landed' ? 'ready' : this.phase;
  }

  push(sample) {
    const o = this.opt, s = sample ?? {};
    const t = s.t;
    const ok = s.visible && [t, s.footL, s.footR, s.hipY, s.bodyLen].every(Number.isFinite) && s.bodyLen > 0;
    const gap = t - this.lastSeen;
    let jump = null;
    if (this.flight && gap > o.maxGap) {
      // Losing sight after touchdown (stepping away, motion blur) must not cost a
      // flight that is already complete: score it with the ground contact seen so far.
      if (this.phase === 'landed') jump = this.finish(Infinity);
      else this.abort('Lost sight of you mid-jump');
    }
    if (!ok) {
      if (this.flight && this.phase === 'airborne') this.flight.gaps++;
      if (gap > o.noPersonAfter) {
        this.base = null; this.buf = []; this.phase = 'settling';
        return { status: 'no-person', jump };
      }
      return { status: this.status(), jump };
    }
    if (gap > o.noPersonAfter) { this.base = null; this.buf = []; this.phase = 'settling'; }
    this.lastSeen = t;
    const p = { t, l: s.footL, r: s.footR, h: s.hipY, L: s.bodyLen };
    this.buf.push(p);
    while (this.buf.length && this.buf[0].t < t - (o.maxFlight + o.settleWindow + 1)) this.buf.shift();

    if (this.phase === 'settling') this.trySettle(t);
    else if (this.phase === 'ready') {
      if (this.bothUp(p)) this.takeoff(p);
      else {
        this.checkDrift(t);
        this.trySettle(t); // keep the baseline fresh whenever the person stands still
      }
    } else if (this.phase === 'airborne') {
      if (!this.bothUp(p)) { this.flight.land = t; this.phase = 'landed'; }
      else if (t - this.flight.start > o.maxFlight + 0.2) this.abort('Feet never came back down (stepped up or walked away)');
    } else if (this.phase === 'landed') {
      // Wait for a little ground contact to confirm the landing level. A rebound
      // (pogo jumps) ends the wait early and starts the next flight straight away.
      // Both feet up again within a moment is landmark jitter near the margin, not a
      // landing (ground contact between pogo jumps lasts well over 0.1 s).
      const rebound = this.bothUp(p);
      if (rebound && t - this.flight.land < 0.1) { this.phase = 'airborne'; this.flight.land = NaN; }
      else if (rebound || t >= this.flight.land + o.postWindow) {
        jump = this.finish(rebound ? t : Infinity);
        if (rebound && this.phase === 'ready') this.takeoff(p);
      }
    }
    return { status: this.status(), jump };
  }

  // Call when the stream ends (video finished, session closed): returns a jump that
  // had landed but was still waiting for its post-landing window, else null.
  flush() {
    return this.flight && this.phase === 'landed' ? this.finish(Infinity) : null;
  }

  lift(p, foot) {
    return (this.base[foot] - p[foot]) / this.base.L; // height above baseline, × bodyLen
  }

  bothUp(p) {
    const m = this.base.margin;
    return this.lift(p, 'l') > m && this.lift(p, 'r') > m;
  }

  takeoff(p) {
    this.flight = { start: p.t, land: NaN, gaps: 0 };
    this.phase = 'airborne';
  }

  abort(reason) {
    this.lastReject = reason;
    this.flight = null;
    this.base = null;
    this.phase = 'settling';
  }

  // Baseline = medians over a still window. Stillness = small robust spread AND no
  // trend (first vs second half), for both feet and hips, scaled by body length.
  trySettle(t) {
    const o = this.opt;
    const w = this.buf.filter((q) => q.t >= t - o.settleWindow);
    if (w.length < o.minSettleSamples || t - w[0].t < 0.8 * o.settleWindow) return;
    const L = median(w.map((q) => q.L));
    const half = w.length >> 1;
    let noise = 0;
    for (const k of o.stillHips ? ['l', 'r', 'h'] : ['l', 'r']) {
      const v = w.map((q) => q[k]);
      const sd = robustSd(v);
      const drift = Math.abs(median(v.slice(0, half)) - median(v.slice(half)));
      if (sd > o.stillTol * L || drift > o.stillTol * L) return;
      if (k !== 'h') noise = Math.max(noise, sd / L);
    }
    if (robustSd(w.map((q) => q.L)) > 0.05 * L) return;
    const margin = Math.min(o.maxMargin, Math.max(o.minMargin, o.marginNoise * noise));
    this.base = { l: median(w.map((q) => q.l)), r: median(w.map((q) => q.r)), h: median(w.map((q) => q.h)), L, noise, margin };
    this.phase = 'ready';
  }

  // Feet moving away from the baseline without a jump means the person moved: re-learn the ground.
  // (Squats and calf raises keep the toes down, so the lowest foot point does not move.)
  checkDrift(t) {
    const o = this.opt;
    const w = this.buf.filter((q) => q.t >= t - o.driftWindow);
    if (w.length < 3) return;
    const off = (k) => Math.abs(median(w.map((q) => q[k])) - this.base[k]) / this.base.L;
    if (off('l') > o.driftTol || off('r') > o.driftTol) { this.base = null; this.phase = 'settling'; }
  }

  finish(until) {
    const o = this.opt, b = this.base, f = this.flight;
    this.flight = null;
    const fail = (why) => { this.lastReject = why; this.phase = 'settling'; this.base = null; return null; };
    const S = this.buf;
    const air = S.filter((q) => q.t >= f.start && q.t < f.land);
    const post = S.filter((q) => q.t >= f.land && q.t < until);
    if (air.length < 2 || air.at(-1).t - air[0].t > o.maxFlight) return fail('Not a jump (too brief or too long)');

    // Landing level vs takeoff level: a jump lands where it took off. A different level
    // means stepping onto/off something or walking. A small shift (landing a bit forward)
    // is tolerated: the landing crossing is solved against the level the feet settle at.
    // Only trust the post-landing level when it clearly differs: right after landing the
    // pose model's smoothing still lags (feet read a little high for a few hundred ms).
    let ground = { l: median(post.map((q) => q.l)), r: median(post.map((q) => q.r)) };
    const shift = Math.max(Math.abs(ground.l - b.l), Math.abs(ground.r - b.r)) / b.L;
    if (shift > o.levelReject) return fail('Landed at a different level from takeoff');
    if (shift <= o.levelNote) ground = b;

    // Hips are close to the centre of mass, so in flight they follow y = a + bτ + cτ²
    // with 2c = g in image units. The fit gives the apex time and the image scale.
    const tm = (air[0].t + air.at(-1).t) / 2;
    let c, tApex, hipFit = null;
    if (air.length >= 4) {
      hipFit = polyfit(air.map((q) => q.t - tm), air.map((q) => q.h), 2);
      c = hipFit[2];
      if (!(c > 0)) return fail('Body did not move like a free flight');
      tApex = tm - hipFit[1] / (2 * c);
    } else {
      c = (G * b.L) / (2 * 1.35); // too few samples: assume an adult's 1.35 m shoulder–ankle length
      tApex = tm;
    }

    // Sub-frame ground crossings, per foot: takeoff = last foot off, landing = first foot
    // down. Threshold crossings are useless as they stand: late by margin/velocity (~30 ms)
    // and frame-quantised. Two estimators, chosen per jump:
    //
    // 1. Whole-flight parabola (preferred). Fit u(t) = k0 + k1·τ + k2·τ² to every sample of
    //    the foot whose rise exceeds wholeFrac of its peak, and intersect with the ground
    //    level (the standing baseline, or the post-landing level if the person moved). It
    //    averages the most samples and is the most robust to the pose model's own adaptive
    //    smoothing, which lags both the first frames after takeoff from rest and the descent
    //    by ~10 ms (the lags cancel in T, unlike at a single edge): on a real MediaPipe
    //    trace with a known 0.600 s flight it gives 0.601 s where edge-based methods give
    //    0.58–0.62 s. Valid only while leg posture is fixed in flight, so it is used when
    //    each foot's curvature matches the hips' free fall to within rigidTol × bodyLen of
    //    displacement over the fitted span.
    // 2. Hinge fit (fallback, when knees tuck or legs fold in flight so the feet do not follow
    //    a parabola). Near each crossing:  u = p0 on the ground,  u = p0 + q·τ − c·τ² in the
    //    air (τ = time since contact loss, c = the hips' free-fall curvature), fitted by least
    //    squares over a short window (ground samples pin the hinge, air samples its slope)
    //    with a fine 1-D search for the contact time. p0 is shrunk towards the baseline
    //    (just before takeoff only the toe touches). In simulation a whole-flight fit is
    //    biased ~4 cm low by a 15 cm knee tuck; the hinge ~1 cm.
    const span = S.filter((q) => q.t >= f.start - 0.3 && q.t < until);
    const whole = (foot) => {
      const lift = (q) => b[foot] - q[foot];
      let i = span.findIndex((q) => q.t >= tApex);
      if (i < 0) i = span.length - 1;
      const thr = o.wholeFrac * Math.max(...span.map(lift));
      let lo = i, hi = i; // contiguous run around the apex above the threshold
      while (span[lo - 1] && lift(span[lo - 1]) > thr) lo--;
      while (span[hi + 1] && lift(span[hi + 1]) > thr) hi++;
      const pts = span.slice(lo, hi + 1);
      if (pts.length < 4) return null;
      const [k0, k1, k2] = polyfit(pts.map((q) => q.t - tm), pts.map(lift), 2);
      const root = (level, sgn) => tm + (-k1 + sgn * Math.sqrt(k1 * k1 - 4 * k2 * (k0 - level))) / (2 * k2);
      // How far the foot strayed from the hips' free fall over the fitted span (posture change).
      const bend = Math.abs(k2 + c) * ((pts.at(-1).t - pts[0].t) / 2) ** 2 / b.L;
      return { up: root(0, 1), down: root(b[foot] - ground[foot], -1), bend };
    };
    const m = b.margin * b.L;
    const hinge = (foot, rising) => {
      const g0 = rising ? b[foot] : ground[foot], sgn = rising ? 1 : -1;
      const okSide = (q) => (rising ? q.t < tApex : q.t > tApex && q.t < until);
      // First guess, to centre the window: the same model with p0 = 0 through the first
      // fitSamples samples of the foot's own run above the margin.
      let i = S.indexOf(rising ? air[0] : air.at(-1));
      while (S[i - sgn] && g0 - S[i - sgn][foot] > m && okSide(S[i - sgn])) i -= sgn;
      const run = [];
      for (let j = i; S[j] && run.length < o.fitSamples && g0 - S[j][foot] > m && okSide(S[j]); j += sgn) run.push(S[j]);
      let t0 = S[i].t;
      if (run.length >= 2) {
        const t1 = run[0].t;
        const [p, q] = polyfit(run.map((r) => r.t - t1), run.map((r) => g0 - r[foot] + c * (r.t - t1) ** 2), 1);
        const disc = q * q + 4 * c * p;
        if (disc >= 0) t0 = t1 + (q - sgn * Math.sqrt(disc)) / (2 * c);
        t0 = t1 - sgn * Math.min(0.2, Math.max(0, sgn * (t1 - t0)));
      }
      // Window: groundSpan / airSpan either side, but at least 2 ground and minAir air
      // samples so both parts are always determined (at 15 fps a span may hold one).
      const side = (inAir, len, min) => {
        const a = S.filter((q) => okSide(q) && (sgn * (q.t - t0) > 0) === inAir);
        if (rising !== inAir) a.reverse(); // nearest first
        return a.slice(0, Math.max(min, a.filter((q) => Math.abs(q.t - t0) < len).length));
      };
      const pts = [...side(false, o.groundSpan, 2), ...side(true, o.airSpan, o.minAir)].map((q) => [q.t, g0 - q[foot]]);
      let best = Infinity, bestT = t0;
      for (let tc = t0 - 0.06; tc <= t0 + 0.06; tc += 0.0005) {
        let sy = 0, n = 0, sxy = 0, sxx = 0, cost = 0;
        for (const [t, u] of pts) if (sgn * (t - tc) <= 0) { sy += u; n++; }
        const p0 = n ? sy / (n + o.groundPrior) : 0;
        for (const [t, u] of pts) {
          const tau = sgn * (t - tc);
          if (tau > 0) { sxy += tau * (u - p0 + c * tau * tau); sxx += tau * tau; } else cost += (u - p0) ** 2;
        }
        if (!sxx) continue;
        const q = sxy / sxx; // best foot velocity for this contact time
        for (const [t, u] of pts) { const tau = sgn * (t - tc); if (tau > 0) cost += (u - p0 - q * tau + c * tau * tau) ** 2; }
        if (cost < best) { best = cost; bestT = tc; }
      }
      return bestT;
    };
    const W = [whole('l'), whole('r')];
    const rigid = hipFit && W.every((w) => w && w.bend < o.rigidTol && Number.isFinite(w.up + w.down));
    const takeoffT = rigid ? Math.max(W[0].up, W[1].up) : Math.max(hinge('l', true), hinge('r', true));
    const landingT = rigid ? Math.min(W[0].down, W[1].down) : Math.min(hinge('l', false), hinge('r', false));
    const T = landingT - takeoffT;
    if (!(T >= o.minFlight && T <= o.maxFlight)) return fail('Flight time not plausible for a jump');
    // Physics checks against tracking glitches (landmarks snapping up for a few frames).
    // With takeoff speed v0 = c·T: (a) next to each margin crossing the feet can rise at
    // most ~v0 per second (riseFactor × that allowed for legs folding); (b) the feet need
    // ~margin/v0 to clear the margin, so takeoff/landing cannot lie further than that
    // beyond the samples that were still below it.
    const v0 = c * T, pre = S[S.indexOf(air[0]) - 1], next = S[S.indexOf(air.at(-1)) + 1];
    const lowFoot = (q) => Math.min(b.l - q.l, b.r - q.r);
    const slack = m + 3 * b.noise * b.L, reach = slack / v0 + 0.02;
    if ((pre && (lowFoot(air[0]) > slack + o.riseFactor * v0 * (air[0].t - pre.t) || takeoffT < pre.t - reach)) ||
        (next && (lowFoot(air.at(-1)) > slack + o.riseFactor * v0 * (next.t - air.at(-1).t) || landingT > next.t + reach))) {
      return fail('Tracking glitch, not a jump');
    }

    // Cross-checks: lower confidence with a reason rather than silently report.
    const notes = [];
    let conf = 2; // 2 high, 1 medium, 0 low
    const flag = (level, note) => { conf = Math.min(conf, level); notes.push(note); };
    let bodyM = NaN; // body length implied by gravity; says whether the clock is real time
    if (hipFit) {
      const scale = G / (2 * c); // metres per image unit
      bodyM = b.L * scale;
      const [lo, hi] = o.bodyRange;
      if (bodyM < lo / 2 || bodyM > hi * 2) return fail('Body did not move like a free flight');
      if (bodyM < lo || bodyM > hi) {
        // A tiny "hop" seen in a few frames that is not a free fall: a tracking glitch.
        if (air.length < 6 && T < 0.25) return fail('Body did not move like a free flight');
        flag(0, 'Your body did not move like a clean free flight, so this may not be accurate');
      }
      const hipAt = (tt) => hipFit[0] + hipFit[1] * (tt - tm) + hipFit[2] * (tt - tm) ** 2;
      const rms = Math.sqrt(air.reduce((acc, q) => acc + (q.h - hipAt(q.t)) ** 2, 0) / air.length);
      if (rms > Math.max(4 * b.noise, 0.02) * b.L) flag(0, 'Tracking was unsteady during the jump');
      // Hips lower at touchdown than at takeoff (bent knees, tucked landing) stretch the
      // flight time and inflate the height; the reverse deflates it.
      const drop = (hipAt(landingT) - hipAt(takeoffT)) * scale;
      if (drop > o.dropNote) flag(drop > o.dropLow ? 0 : 1, `${NOTE_LOWER_LANDING}, so the height may be overestimated. Land with straight legs, then bend`);
      else if (drop < -o.dropNote) flag(drop < -o.dropLow ? 0 : 1, `${NOTE_LOWER_TAKEOFF}, so the height may be underestimated`);
    } else flag(0, 'Too few video frames in the air to measure this jump reliably');
    if (air.length < 6) flag(1, `Only ${air.length} video frames in the air, so timing is coarse`);
    if (f.gaps) flag(1, 'Tracking dropped out briefly during the jump');
    if (shift > o.levelNote) flag(1, 'You landed away from your takeoff spot; try to land where you took off');

    // Same spot → keep the baseline and stay ready for the next jump; else re-learn the ground.
    if (shift > o.levelNote) { this.base = null; this.phase = 'settling'; } else this.phase = 'ready';
    return {
      takeoffT, landingT, flightTime: T, heightM: heightFromFlightTime(T),
      confidence: ['low', 'medium', 'high'][conf], notes, bodyM,
    };
  }
}

// ---------------------------------------------------------------- recordings

// A recorded clip can be analysed with hindsight, which removes two things a live
// stream needs from the user:
//
// 1. The play rate. A slow-motion clip's timestamps run k times slow, which makes
//    gravity look k² times weak: the body length implied by the hips' free fall comes
//    out k² times too big. Rates differ by 2×, so implied lengths differ by 4× and
//    only the true rate gives a human-sized body. Each rate is tried; the one whose
//    jumps imply a body nearest BODY_M wins. The rate is snapped, not estimated, so
//    height still comes from flight time alone and not from an assumed body size.
// 2. Standing still first. A jump looks the same played backwards, so the clip is
//    also run in reverse: standing still after the landing then serves as the
//    baseline, and a clip that starts mid-crouch is still measured.
export const PLAY_RATES = [1, 2, 4, 8];
const BODY_M = 1.35; // typical adult shoulder–ankle length
// Clips are often trimmed tight and filmed hand-held, so less standing still is asked
// for than live (feet only, a quarter of a second), and landing a little nearer or
// farther from the camera is tolerated. A clip was chosen because it holds a jump, so
// the stricter live rules against walking and stepping matter less here.
const RECORDING = { settleWindow: 0.25, stillHips: false, levelReject: 0.12 };

const NOTE_LOWER_LANDING = 'Landing looked lower than takeoff';
const NOTE_LOWER_TAKEOFF = 'Takeoff looked lower than landing';

function detectAll(samples, options) {
  const det = new JumpDetector(options), jumps = [];
  for (const s of samples) { const { jump } = det.push(s); if (jump) jumps.push(jump); }
  const last = det.flush();
  if (last) jumps.push(last);
  return jumps;
}

// A jump found in the reversed clip, put back in forward time: takeoff and landing
// swap, and so do the notes about which end was lower.
function unreverse(j) {
  const swap = (n) => (n.startsWith(NOTE_LOWER_LANDING) ? `${NOTE_LOWER_TAKEOFF}, so the height may be underestimated`
    : n.startsWith(NOTE_LOWER_TAKEOFF) ? `${NOTE_LOWER_LANDING}, so the height may be overestimated. Land with straight legs, then bend`
      : n);
  return { ...j, takeoffT: -j.landingT, landingT: -j.takeoffT, notes: j.notes.map(swap) };
}

const RANK = { low: 0, medium: 1, high: 2 };

// samples: [{ t, footL, footR, hipY, bodyLen, visible }] in the clip's own time.
// Returns { rate, jumps }: rate is how many times slower than life the clip plays
// (null when no jump was found), and jumps are in real time, in order.
export function analyseRecording(samples, { rates = PLAY_RATES, options } = {}) {
  options = { ...RECORDING, ...options };
  let best = null;
  for (const rate of rates) {
    const fwd = detectAll(samples.map((s) => ({ ...s, t: s.t / rate })), options);
    const rev = detectAll(samples.slice().reverse().map((s) => ({ ...s, t: -s.t / rate })), options).map(unreverse);
    // The same jump seen in both directions: keep the more confident reading.
    const jumps = [...fwd];
    for (const r of rev) {
      const i = jumps.findIndex((f) => f.takeoffT < r.landingT && r.takeoffT < f.landingT);
      if (i < 0) jumps.push(r);
      else if (RANK[r.confidence] > RANK[jumps[i].confidence]) jumps[i] = r;
    }
    if (!jumps.length) continue;
    jumps.sort((a, b) => a.takeoffT - b.takeoffT);
    // How far from human-sized the implied body is, in octaves; unknown counts as far.
    const off = jumps.map((j) => (j.bodyM > 0 ? Math.abs(Math.log2(j.bodyM / BODY_M)) : 3));
    const score = off.reduce((a, b) => a + b, 0) / off.length;
    if (!best || score < best.score) best = { rate, jumps, score };
  }
  return best ? { rate: best.rate, jumps: best.jumps } : { rate: null, jumps: [] };
}
