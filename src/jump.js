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
  fitSamples: 3, // in-flight samples next to each ground crossing used to extrapolate it
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
      const rebound = this.bothUp(p);
      if (rebound || t >= this.flight.land + o.postWindow) {
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
    const ground = { l: median(post.map((q) => q.l)), r: median(post.map((q) => q.r)) };
    const shift = Math.max(Math.abs(ground.l - b.l), Math.abs(ground.r - b.r)) / b.L;
    if (shift > o.levelReject) return fail('Landed at a different level from takeoff');

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

    // Sub-frame ground crossings, per foot. Near each crossing the foot is fitted as
    // u(t) = p + q·(t−t1) − c·(t−t1)², i.e. free fall with the curvature measured on the
    // hips and only offset + velocity free, using the fitSamples in-flight samples closest
    // to the crossing, then solved for u = 0 (the ground). This removes the margin bias
    // (the toe left the ground well before it crossed the margin) without assuming the
    // whole foot path is a parabola (legs fold in flight), and the fixed curvature keeps
    // the extrapolation stable with 2–3 noisy points. With a single point the apex time
    // from the hips stands in for the velocity.
    const m = b.margin * b.L;
    const cross = (foot, rising) => {
      const g0 = rising ? b[foot] : ground[foot];
      // The foot's own airborne run around the both-feet-up interval (one foot leaves first).
      let i = S.indexOf(rising ? air[0] : air.at(-1));
      const step = rising ? -1 : 1;
      while (S[i + step] && g0 - S[i + step][foot] > m && (rising || S[i + step].t < until)) i += step;
      const run = [];
      for (let j = i; S[j] && run.length < o.fitSamples && g0 - S[j][foot] > m; j -= step) {
        if (rising ? S[j].t > tApex : S[j].t < tApex) break;
        run.push(S[j]);
      }
      const edge = S[i + step]; // last ground sample before / first after
      if (!run.length) return rising ? air[0].t : air.at(-1).t;
      const t1 = run[0].t;
      const u = run.map((q) => g0 - q[foot]);
      let p, q;
      if (run.length >= 2) [p, q] = polyfit(run.map((r) => r.t - t1), u.map((v, k) => v + c * (run[k].t - t1) ** 2), 1);
      else { q = 2 * c * (tApex - t1); p = u[0]; }
      const disc = q * q + 4 * c * p;
      let tc = disc >= 0 ? t1 + (q + (rising ? -1 : 1) * Math.sqrt(disc)) / (2 * c) : t1;
      // Never beyond the neighbouring ground sample (with a little slack for noise).
      if (edge) tc = rising ? Math.max(tc, edge.t - 0.01) : Math.min(tc, edge.t + 0.01);
      return rising ? Math.min(tc, t1) : Math.max(tc, t1);
    };
    const takeoffT = Math.max(cross('l', true), cross('r', true)); // last foot off
    const landingT = Math.min(cross('l', false), cross('r', false)); // first foot down
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
