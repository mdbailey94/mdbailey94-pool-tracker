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
  holdAfter: 0, // s a reading stays up before the next jump is looked for (the live camera uses 2)
  stillHips: true, // hips must be still too while learning the ground (live); off for recordings
  straightLeg: 0.96, // hip-to-ankle reach over leg length that counts as standing tall (head reference)
  tallLeg: 0.9, // and leg length then, as a share of leg length in flight
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

// ---- height and how sure it is
//
// Flight time gives the height exactly only if the body is in the same posture at
// takeoff and landing. Two departures from that are measured and allowed for:
//
// - Bent-knee landing. The hips are lower at touchdown than at takeoff, so the fall
//   takes longer than the rise and g·T²/8 reads high. The hips' free-fall arc gives the
//   size of that drop, and a third of it comes off the height.
// - Knees tucked in flight. The feet rise more than the hips, the feet stop following a
//   parabola, and the fallback timing reads about a centimetre low.
//
// The 95% range combines timing precision (coarser with fewer frames in the air) with
// the uncertainty of each adjustment. The constants were tuned on simulated jumps
// (heights 20–70 cm, 30–120 fps, tucks to 15 cm, bent landings to 15 cm), where the
// range held the true height in 98–99% of jumps. They have not been checked against
// measured jumps by real athletes.
const EST = {
  dropFrom: 0.015, dropGain: 0.33, dropSpread: 0.3, // bent landing: threshold (m), share removed, its sd as a share
  // tuck: fold (m) where the adjustment starts and where it is complete, the full amount
  // added (m), and its sd as a share. Ramped, so near-identical jumps read alike.
  foldFrom: 0.015, foldFull: 0.04, foldGain: 0.012, foldSpread: 0.6,
  timeBase: 0.004, timePerFrame: 0.25, // flight-time sd (s): base + share of one frame interval
  blind: 0.02, // extra sd (m) when too few frames were seen to check posture at all
  moved: 0.015, // extra sd (m) when the landing spot was not the takeoff spot
  pushScale: 0.12, pushBase: 0.008, // push-off rise sd: share of it, plus a fixed part (m)
};

// Jump-and-reach equivalent: the flight-time height plus the push-off rise, with its
// own range. The push-off rise is about 5 to 10 cm, measured with a scale good to
// roughly a tenth, plus landmark noise.
export function withReach(est, pushOffM) {
  if (!Number.isFinite(pushOffM)) return { ...est, pushOffM: NaN, reachM: NaN, reachLowM: NaN, reachHighM: NaN };
  const sdH = (est.highM - est.heightM) / 1.96;
  const sd = Math.hypot(sdH, EST.pushScale * pushOffM + EST.pushBase);
  const reachM = est.heightM + pushOffM;
  return { ...est, pushOffM, reachM, reachLowM: Math.max(0, reachM - 1.96 * sd), reachHighM: reachM + 1.96 * sd };
}

export function estimateHeight({ flightTime: T, frames, dropM, foldM, moved = false }) {
  const flightHeightM = heightFromFlightTime(T);
  const seen = Number.isFinite(dropM);
  const bentLandingM = seen && dropM > EST.dropFrom ? -EST.dropGain * (dropM - EST.dropFrom) : 0;
  const ramp = Number.isFinite(foldM) ? Math.min(1, Math.max(0, (foldM - EST.foldFrom) / (EST.foldFull - EST.foldFrom))) : 0;
  const tuckM = EST.foldGain * ramp;
  const sdTime = ((G * T) / 4) * (EST.timeBase + EST.timePerFrame * (T / Math.max(1, frames)));
  const sd = Math.hypot(sdTime, EST.dropSpread * bentLandingM, EST.foldSpread * tuckM, seen ? 0 : EST.blind, moved ? EST.moved : 0);
  const heightM = Math.max(0, flightHeightM + bentLandingM + tuckM);
  return {
    heightM, flightHeightM, bentLandingM, tuckM,
    lowM: Math.max(0, heightM - 1.96 * sd), highM: heightM + 1.96 * sd,
  };
}

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
    this.holding = false; // a reading is on screen; no new jump is looked for
    this.holdUntil = -Infinity;
  }

  status() {
    if (this.holding) return 'hold';
    return this.phase === 'landed' ? 'ready' : this.phase;
  }

  // With holdAfter set, a reading stays up for that long before the next jump is looked
  // for, so the athlete has time to read it. A jump made during the hold is ignored; the
  // next one counts only from the ground, once the hold is over.
  push(sample) {
    const r = this.step(sample);
    if (r.jump && this.opt.holdAfter > 0) {
      this.holding = true;
      this.holdUntil = sample.t + this.opt.holdAfter;
      if (this.flight) { this.flight = null; this.phase = this.base ? 'ready' : 'settling'; } // a rebound already in the air
      if (r.status !== 'no-person') r.status = 'hold';
    }
    return r;
  }

  step(sample) {
    const o = this.opt, s = sample ?? {};
    const t = s.t;
    const ok = s.visible && [t, s.footL, s.footR, s.hipY, s.bodyLen].every(Number.isFinite) && s.bodyLen > 0;
    const gap = t - this.lastSeen;
    let jump = null;
    if (this.flight && gap > o.maxGap && !this.holding) {
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
    const p = {
      t, l: s.footL, r: s.footR, h: s.hipY, L: s.bodyLen,
      e: Number.isFinite(s.headY) ? s.headY : NaN, // head height, optional
      k: Number.isFinite(s.stretch) ? s.stretch : 1, // leg straightness, 1 when not given
    };
    this.buf.push(p);
    while (this.buf.length && this.buf[0].t < t - (o.maxFlight + o.settleWindow + 1)) this.buf.shift();

    if (this.holding) {
      // Keep the ground level current, but take no takeoff until the hold is over and
      // the athlete is standing.
      if (this.phase === 'settling') this.trySettle(t);
      else if (this.phase === 'ready') {
        this.checkDrift(t);
        if (this.phase === 'ready' && !this.bothUp(p)) this.trySettle(t);
      }
      if (t >= this.holdUntil && this.phase === 'ready' && !this.bothUp(p)) this.holding = false;
      return { status: this.status(), jump: null };
    }
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
        if (rebound && this.phase === 'ready' && !(o.holdAfter > 0)) this.takeoff(p);
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
    // Head level when standing tall, for the head-rise measure: the highest level the
    // head has held still at since the athlete took up this spot. A crouch held before
    // the jump is lower, so it never replaces it; a head still moving is not counted,
    // nor is one held still over bent knees.
    let e = this.base ? this.base.e : NaN, eL = this.base ? this.base.eL : NaN; // level, and leg length seen then
    const ev = w.map((q) => q.e).filter(Number.isFinite);
    if (ev.length >= 0.8 * w.length) {
      const h2 = ev.length >> 1;
      if (robustSd(ev) < o.stillTol * L && Math.abs(median(ev.slice(0, h2)) - median(ev.slice(h2))) < 0.5 * o.stillTol * L &&
          median(w.map((q) => q.k)) >= o.straightLeg) {
        const m = median(ev);
        if (!Number.isFinite(e) || m < e) { e = m; eL = L; } // y grows downward: smaller is higher
      }
    }
    // Hip level when standing tall, for the jump-and-reach figure: the same rules as the
    // head (highest level held still, legs straight), so a held crouch never counts.
    let hT = this.base ? this.base.hT : NaN, hTL = this.base ? this.base.hTL : NaN;
    const hv = w.map((q) => q.h);
    if (robustSd(hv) < o.stillTol * L && Math.abs(median(hv.slice(0, half)) - median(hv.slice(half))) < 0.5 * o.stillTol * L &&
        median(w.map((q) => q.k)) >= o.straightLeg) {
      const m = median(hv);
      if (!Number.isFinite(hT) || m < hT) { hT = m; hTL = L; }
    }
    this.base = { l: median(w.map((q) => q.l)), r: median(w.map((q) => q.r)), h: median(w.map((q) => q.h)), L, noise, margin, e, eL, hT, hTL };
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
      const half = ((pts.at(-1).t - pts[0].t) / 2) ** 2;
      const bend = Math.abs(k2 + c) * half / b.L;
      // Signed: positive when the foot rose more than the hips mid-flight (knees tucked).
      return { up: root(0, 1), down: root(b[foot] - ground[foot], -1), bend, fold: -(k2 + c) * half };
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
    let dropM = NaN, foldM = NaN; // posture: hips lower at landing than takeoff; legs folded mid-flight (m)
    let freeFall = Boolean(hipFit); // the hips followed a clean gravity arc of a plausible size
    if (hipFit) {
      const scale = G / (2 * c); // metres per image unit
      bodyM = b.L * scale;
      const [lo, hi] = o.bodyRange;
      if (bodyM < lo / 2 || bodyM > hi * 2) return fail('Body did not move like a free flight');
      if (bodyM < lo || bodyM > hi) {
        // A tiny "hop" seen in a few frames that is not a free fall: a tracking glitch.
        if (air.length < 6 && T < 0.25) return fail('Body did not move like a free flight');
        flag(0, 'Your body did not move like a clean free flight, so this may not be accurate');
        freeFall = false;
      }
      const hipAt = (tt) => hipFit[0] + hipFit[1] * (tt - tm) + hipFit[2] * (tt - tm) ** 2;
      const rms = Math.sqrt(air.reduce((acc, q) => acc + (q.h - hipAt(q.t)) ** 2, 0) / air.length);
      if (rms > Math.max(4 * b.noise, 0.02) * b.L) { flag(0, 'Tracking was unsteady during the jump'); freeFall = false; }
      // Hips lower at touchdown than at takeoff (bent knees, tucked landing) stretch the
      // flight time and inflate the height; the reverse deflates it.
      const drop = (hipAt(landingT) - hipAt(takeoffT)) * scale;
      dropM = drop;
      if (W[0] && W[1]) foldM = ((W[0].fold + W[1].fold) / 2) * scale;
      if (drop > o.dropNote) flag(drop > o.dropLow ? 0 : 1, `${NOTE_LOWER_LANDING}${LOWER_LANDING_REST}`);
      else if (drop < -o.dropNote) flag(drop < -o.dropLow ? 0 : 1, `${NOTE_LOWER_TAKEOFF}${LOWER_TAKEOFF_REST}`);
    } else flag(0, 'Too few video frames in the air to measure this jump reliably');
    if (air.length < 6) flag(1, `Only ${air.length} video frames in the air, so timing is coarse`);
    if (f.gaps) flag(1, 'Tracking dropped out briefly during the jump');
    if (shift > o.levelNote) flag(1, 'You landed away from your takeoff spot; try to land where you took off');

    // Second, independent measure: how far the head rose above its standing-tall level.
    // In flight the head follows a gravity arc; the arc's curvature gives the picture's
    // scale at the head (so no body size is assumed), and its top gives the peak. This
    // ignores the feet and the landing altogether. It counts the rise onto the toes
    // before takeoff, so it normally reads a little higher than flight time. It needs a
    // standing-tall reference, and it is thrown off if the athlete moves towards or away
    // from the camera, which flight time is not.
    let headRiseM = NaN, headRiseSdM = NaN;
    // Standing tall means legs as long in the picture as they are in flight. Seen from
    // the front a crouch hides its bent knees, but the legs look shorter.
    const tall = Number.isFinite(b.e) && b.eL >= o.tallLeg * median(air.map((q) => q.L));
    if (hipFit && tall) {
      const pts = S.filter((q) => q.t >= takeoffT + 0.1 * T && q.t <= landingT - 0.1 * T && Number.isFinite(q.e));
      if (pts.length >= 6) {
        const k = polyfit(pts.map((q) => q.t - tm), pts.map((q) => q.e), 2);
        if (k[2] > 0.6 * c && k[2] < 1.6 * c) { // the head must fall like the hips do
          const top = k[0] - (k[1] * k[1]) / (4 * k[2]);
          const rise = ((b.e - top) * G) / (2 * k[2]);
          if (rise > 0 && rise < 1.6) {
            headRiseM = rise;
            // Spread seen in simulated jumps: about 1 cm with 65 frames in the air, 2 cm
            // with 33, 3 cm with 16. Coarser than flight time, most of all at low frame rates.
            headRiseSdM = 0.004 + 0.46 / air.length;
          }
        }
      }
    }

    // How far the hips rose between standing tall and leaving the ground: up onto the
    // toes and through the ankles. Flight time does not count it; a jump-and-reach test
    // (standing reach to highest touch, as on a Vertec) does. Hip height at takeoff comes
    // from the flight arc, the scale from its curvature, so no body size is assumed.
    let pushOffM = NaN;
    const tallHips = Number.isFinite(b.hT) && b.hTL >= o.tallLeg * median(air.map((q) => q.L));
    if (hipFit && tallHips) {
      const hipTO = hipFit[0] + hipFit[1] * (takeoffT - tm) + hipFit[2] * (takeoffT - tm) ** 2;
      const rise = ((b.hT - hipTO) * G) / (2 * c);
      if (rise > -0.05 && rise < 0.35) pushOffM = Math.max(0, rise);
    }

    // Same spot → keep the baseline and stay ready for the next jump; else re-learn the ground.
    if (shift > o.levelNote) { this.base = null; this.phase = 'settling'; } else this.phase = 'ready';
    return {
      takeoffT, landingT, flightTime: T,
      confidence: ['low', 'medium', 'high'][conf], notes, bodyM, apexT: hipFit ? tApex : NaN,
      dropM, foldM, freeFall, rigid: Boolean(rigid), frames: air.length, moved: shift > o.levelNote, headRiseM, headRiseSdM,
      ...withReach(estimateHeight({ flightTime: T, frames: air.length, dropM, foldM, moved: shift > o.levelNote }), pushOffM),
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
const RATE_TOL = 1; // octaves the implied body may be from BODY_M for a play rate to be believed
// Clips are often trimmed tight and filmed hand-held, so less standing still is asked
// for than live (feet only, a quarter of a second), and landing a little nearer or
// farther from the camera is tolerated. A clip was chosen because it holds a jump, so
// the stricter live rules against walking and stepping matter less here.
const RECORDING = { settleWindow: 0.25, stillHips: false, levelReject: 0.12 };

const NOTE_LOWER_LANDING = 'Landing looked lower than takeoff';
const NOTE_LOWER_TAKEOFF = 'Takeoff looked lower than landing';
const LOWER_LANDING_REST = ' (bent knees), so the height has been adjusted down. Land with straight legs, then bend';
const LOWER_TAKEOFF_REST = ', so the height may be underestimated';

// Runs a detector over a whole clip. readyAt is when it first had a ground level to
// measure against (Infinity if it never did).
function detectAll(samples, options) {
  const det = new JumpDetector(options), jumps = [];
  let readyAt = Infinity;
  for (const s of samples) {
    const { jump, status } = det.push(s);
    if (jump) jumps.push(jump);
    if (status === 'ready' && readyAt === Infinity) readyAt = s.t;
  }
  const last = det.flush();
  if (last) jumps.push(last);
  return { jumps, readyAt };
}

// A jump found in the reversed clip, put back in forward time: takeoff and landing
// swap, and so do the notes about which end was lower.
function unreverse(j) {
  const swap = (n) => (n.startsWith(NOTE_LOWER_LANDING) ? `${NOTE_LOWER_TAKEOFF}${LOWER_TAKEOFF_REST}`
    : n.startsWith(NOTE_LOWER_TAKEOFF) ? `${NOTE_LOWER_LANDING}${LOWER_LANDING_REST}`
      : n);
  // Which end was lower flips too, so the height is worked out again the right way round.
  const dropM = -j.dropM;
  return {
    ...j, takeoffT: -j.landingT, landingT: -j.takeoffT, apexT: -j.apexT, dropM, notes: j.notes.map(swap),
    ...withReach(estimateHeight({ flightTime: j.flightTime, frames: j.frames, dropM, foldM: j.foldM, moved: j.moved }), NaN),
  };
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
    const rev = detectAll(samples.slice().reverse().map((s) => ({ ...s, t: -s.t / rate })), options).jumps.map(unreverse);
    // The same jump seen in both directions: keep the more confident reading.
    const jumps = [...fwd.jumps];
    for (const r of rev) {
      const i = jumps.findIndex((f) => f.takeoffT < r.landingT && r.takeoffT < f.landingT);
      // Head rise needs a standing-tall reference from before the jump; seen backwards the
      // "before" is the recovery after landing, so only the forward pass's figure is kept.
      // The same holds for the push-off rise.
      const noHead = { headRiseM: NaN, headRiseSdM: NaN };
      if (i >= 0) {
        const f = jumps[i];
        if (RANK[r.confidence] > RANK[f.confidence]) jumps[i] = { ...withReach(r, f.pushOffM), headRiseM: f.headRiseM, headRiseSdM: f.headRiseSdM };
        continue;
      }
      // Seen only backwards. That is what the reverse pass is for when the clip starts
      // mid-jump, before the forward pass has a ground level. Later than that, the forward
      // pass looked at the same moment and saw no jump, and it is the one to believe: if
      // the athlete landed nearer the camera, then seen backwards they stand "above" the
      // new ground level at their old spot, which looks like hovering.
      if (r.takeoffT < fwd.readyAt) jumps.push({ ...withReach(r, NaN), ...noHead });
    }
    if (!jumps.length) continue;
    jumps.sort((a, b) => a.takeoffT - b.takeoffT);
    // How far from person-sized the implied body is, in octaves. A wrong rate is two
    // octaves out, so more than one octave is not this clip's rate: without this, a jump
    // that the true rate rejects (say, for landing somewhere else) would be reported at
    // another rate, with a height a quarter or four times the real one. When too few
    // frames were seen to tell, only real time is believed.
    // Only flights that moved like a free fall can vouch for a rate: at a wrong rate the
    // fits are poor, and a poor fit can land on a plausible body size by chance.
    const sure = jumps.filter((j) => j.bodyM > 0 && j.freeFall).map((j) => Math.abs(Math.log2(j.bodyM / BODY_M)));
    let score = sure.length ? sure.reduce((a, b) => a + b, 0) / sure.length : Infinity;
    // Real time needs no proof (the detector's own checks stand), but a slow-motion rate
    // that is vouched for beats a real-time reading that is not.
    if (rate === 1) score = Math.min(score, RATE_TOL);
    else if (score > RATE_TOL) continue;
    if (!best || score < best.score) best = { rate, jumps, score };
  }
  // score: how far from person-sized the implied body is at this rate (lower is surer).
  return best ? { rate: best.rate, jumps: best.jumps, score: best.score } : { rate: null, jumps: [], score: Infinity };
}

// Several athletes filmed in one clip share its play rate. Each lane is analysed on
// its own first; the lane whose rate is surest sets it for everyone.
// lanes: one sample list per athlete. Returns { rate, lanes: [jumps per athlete] }.
export function analyseLanes(lanes, opts = {}) {
  const first = lanes.map((samples) => analyseRecording(samples, opts));
  const surest = first.reduce((a, b) => (b.score < a.score ? b : a), { rate: null, score: Infinity });
  if (surest.rate == null) return { rate: null, lanes: lanes.map(() => []) };
  return {
    rate: surest.rate,
    lanes: lanes.map((samples, i) => (first[i].rate === surest.rate ? first[i].jumps
      : analyseRecording(samples, { ...opts, rates: [surest.rate] }).jumps)),
  };
}
