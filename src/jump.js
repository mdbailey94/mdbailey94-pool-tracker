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
  rigidTol: 0.02, // ...when the feet stay within this (× bodyLen) of the hips' free-fall curve
  fitSamples: 3, // hinge fallback: in-flight samples for the first guess of each crossing,
  airSpan: 0.15, // s of samples in the air (at least minAir)
  minAir: 3,
  groundSpan: 0.1, // s of samples on the ground (at least 2)
  groundPrior: 1, // weight (in samples) pulling the local ground level towards the baseline
  levelNote: 0.02, // landing foot level vs takeoff (× bodyLen): note above this,
  levelReject: 0.06, // reject above this (stepped onto/off something, walked)
  dropNote: 0.03, // hips lower (m) at landing than at takeoff: note above this,
  dropLow: 0.08, // low confidence above this
  bodyRange: [0.6, 2.4], // plausible shoulder–ankle length (m) implied by the hips' free-fall curvature
};

const median = (a) => {
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const robustSd = (a) => { const m = median(a); return 1.4826 * median(a.map((x) => Math.abs(x - m))); };

// Least-squares polynomial (degree 1 or 2) of y on x; returns coefficients [c0, c1, c2?].
function polyfit(xs, ys, deg) {
  const n = deg + 1, A = Array.from({ length: n }, () => new Array(n + 1).fill(0));
  xs.forEach((x, k) => {
    const p = [1, x, x * x];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) A[i][j] += p[i] * p[j];
      A[i][n] += p[i] * ys[k];
    }
  });
  for (let i = 0; i < n; i++) { // Gaussian elimination with partial pivoting
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
    if (this.flight && gap > o.maxGap) this.abort('Lost sight of you mid-jump');
    if (!ok) {
      if (this.flight) this.flight.gaps++;
      if (gap > o.noPersonAfter) {
        this.base = null; this.buf = []; this.phase = 'settling';
        return { status: 'no-person', jump: null };
      }
      return { status: this.status(), jump: null };
    }
    if (gap > o.noPersonAfter) { this.base = null; this.buf = []; this.phase = 'settling'; }
    this.lastSeen = t;
    const p = { t, l: s.footL, r: s.footR, h: s.hipY, L: s.bodyLen };
    this.buf.push(p);
    while (this.buf.length && this.buf[0].t < t - (o.maxFlight + o.settleWindow + 1)) this.buf.shift();

    let jump = null;
    if (this.phase === 'settling') this.trySettle(t);
    else if (this.phase === 'ready') {
      if (this.bothUp(p)) this.takeoff(p);
      else this.checkDrift(t);
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
    for (const k of ['l', 'r', 'h']) {
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
    //    level (standing baseline for takeoff, settled post-landing level for landing). It
    //    averages the most samples, and it is the most robust to the pose model's own
    //    adaptive smoothing, which lags the first frames after takeoff from rest and the
    //    slow frames near the apex: on a real MediaPipe trace with known 0.600 s flight it
    //    gives 0.600 s where edge-based methods give 0.58–0.62 s. Valid only while the leg
    //    posture is fixed in flight, so it is used when each foot's fitted curvature agrees
    //    with the hips' (free fall) within rigidTol.
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
    if (o.debug) console.log('rigid', rigid, W, 'ground', ground, 'base', b, 'tApex', tApex, 'c', c);
    const takeoffT = rigid ? Math.max(W[0].up, W[1].up) : Math.max(hinge('l', true), hinge('r', true));
    const landingT = rigid ? Math.min(W[0].down, W[1].down) : Math.min(hinge('l', false), hinge('r', false));
    const T = landingT - takeoffT;
    if (!(T >= o.minFlight && T <= o.maxFlight)) return fail('Flight time not plausible for a jump');

    // Cross-checks: lower confidence with a reason rather than silently report.
    const notes = [];
    let conf = 2; // 2 high, 1 medium, 0 low
    const flag = (level, note) => { conf = Math.min(conf, level); notes.push(note); };
    if (hipFit) {
      const scale = G / (2 * c); // metres per image unit
      const bodyM = b.L * scale;
      const [lo, hi] = o.bodyRange;
      if (bodyM < lo / 2 || bodyM > hi * 2) return fail('Body did not move like a free flight');
      if (bodyM < lo || bodyM > hi) flag(0, 'Your body did not move like a clean free flight, so this may not be accurate');
      const hipAt = (tt) => hipFit[0] + hipFit[1] * (tt - tm) + hipFit[2] * (tt - tm) ** 2;
      const rms = Math.sqrt(air.reduce((acc, q) => acc + (q.h - hipAt(q.t)) ** 2, 0) / air.length);
      if (rms > Math.max(4 * b.noise, 0.02) * b.L) flag(0, 'Tracking was unsteady during the jump');
      // Hips lower at touchdown than at takeoff (bent knees, tucked landing) stretch the
      // flight time and inflate the height; the reverse deflates it.
      const drop = (hipAt(landingT) - hipAt(takeoffT)) * scale;
      if (drop > o.dropNote) flag(drop > o.dropLow ? 0 : 1, 'Landing looked lower than takeoff, so the height may be overestimated. Land with straight legs, then bend');
      else if (drop < -o.dropNote) flag(drop < -o.dropLow ? 0 : 1, 'Takeoff looked lower than landing, so the height may be underestimated');
    } else flag(1, 'Too few video frames in the air to cross-check this jump');
    if (air.length < 6) flag(1, `Only ${air.length} video frames in the air, so timing is coarse`);
    if (f.gaps) flag(1, 'Tracking dropped out briefly during the jump');
    if (shift > o.levelNote) flag(1, 'You landed away from your takeoff spot; try to land where you took off');

    // Same spot → keep the baseline and stay ready for the next jump; else re-learn the ground.
    if (shift > o.levelNote) { this.base = null; this.phase = 'settling'; } else this.phase = 'ready';
    return {
      takeoffT, landingT, flightTime: T, heightM: heightFromFlightTime(T),
      confidence: ['low', 'medium', 'high'][conf], notes,
    };
  }
}
