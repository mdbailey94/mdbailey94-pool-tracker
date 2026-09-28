// Stroke rhythm from the splash around a swimmer.
//
// Each hand entry throws up a burst of white water, so the amount of
// "not water" around the swimmer (energy) pulses once per arm stroke. In
// freestyle and backstroke the arms alternate, so the splash also swings from
// one side of the body to the other (lateral) — once per full cycle. In
// butterfly and breaststroke both arms move together and the splash stays
// centred. That lets us tell the two families apart and turn splash pulses
// into the numbers coaches use:
//   stroke rate  — full arm cycles per minute
//   stroke count — hand entries per length for free/back, cycles for fly/breast

export const FS = 20; // Hz, analysis sample rate
const MIN_PERIOD = 0.4; // s between splash pulses (fast freestyle)
const MAX_PERIOD = 2.6; // s (slow breaststroke)
const SINGLE_ARM_MAX = 0.85; // s: quicker than this can't be a fly/breast cycle

export const STROKES = {
  auto: { label: 'Auto', family: null },
  free: { label: 'Freestyle', family: 'alternating' },
  back: { label: 'Backstroke', family: 'alternating' },
  breast: { label: 'Breaststroke', family: 'simultaneous' },
  fly: { label: 'Butterfly', family: 'simultaneous' },
};
export const FAMILY_LABEL = { alternating: 'Free/Back', simultaneous: 'Fly/Breast' };

// Uniform FS-Hz series over [t0, t1] by linear interpolation of
// irregular samples [{ t, ...values }]. Returns null if too sparse.
export function resample(samples, key, t0, t1) {
  const pts = samples.filter((s) => s.t >= t0 - 0.5 && s.t <= t1 + 0.5 && Number.isFinite(s[key]));
  if (pts.length < 4) return null;
  const n = Math.floor((t1 - t0) * FS) + 1;
  const out = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / FS;
    while (k < pts.length - 2 && pts[k + 1].t < t) k++;
    const a = pts[k], b = pts[k + 1];
    const f = b.t === a.t ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    out[i] = a[key] + f * (b[key] - a[key]);
  }
  return out;
}

// Remove slow trends (the swimmer getting nearer or further from the camera)
// with a centred moving average `win` samples wide.
export function detrend(x, win) {
  const n = x.length;
  const out = new Float64Array(n);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  const h = win >> 1;
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n, i + h + 1);
    out[i] = x[i] - (pre[b] - pre[a]) / (b - a);
  }
  return out;
}

// Normalised autocorrelation for lags 0 … maxLag (unbiased).
export function autocorr(x, maxLag) {
  const n = x.length;
  let e = 0;
  for (let i = 0; i < n; i++) e += x[i] * x[i];
  const r = new Float64Array(maxLag + 1);
  if (e <= 0) return r;
  for (let k = 0; k <= maxLag && k < n; k++) {
    let s = 0;
    for (let i = 0; i + k < n; i++) s += x[i] * x[i + k];
    r[k] = (s / (n - k)) / (e / n);
  }
  return r;
}

// Value of r at a fractional lag.
const at = (r, lag) => {
  const i = Math.floor(lag);
  if (i < 0 || i + 1 >= r.length) return 0;
  return r[i] + (lag - i) * (r[i + 1] - r[i]);
};

// Strongest repeating period (in samples) of the energy signal: the shortest
// autocorrelation peak within 65 % of the tallest, refined to sub-sample.
function dominantLag(r) {
  const lo = Math.round(MIN_PERIOD * FS), hi = Math.min(r.length - 2, Math.round(MAX_PERIOD * FS));
  const peaks = [];
  for (let k = Math.max(lo, 1); k <= hi; k++) {
    if (r[k] > r[k - 1] && r[k] >= r[k + 1] && r[k] > 0.1) peaks.push(k);
  }
  if (!peaks.length) return null;
  const best = Math.max(...peaks.map((k) => r[k]));
  const k = peaks.find((p) => r[p] >= 0.65 * best);
  const a = r[k - 1], b = r[k], c = r[k + 1];
  const den = a - 2 * b + c;
  const shift = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0;
  return { lag: k + shift, strength: b };
}

// Unbroken stretches of samples (no gap over `maxGap` s, no missing
// energy), each at least `minLen` seconds long.
export function runs(samples, t0, t1, { maxGap = 0.5, minLen = 3 } = {}) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length > 1 && cur[cur.length - 1].t - cur[0].t >= minLen) out.push(cur);
    cur = [];
  };
  for (const s of samples) {
    if (s.t < t0 || s.t > t1) continue;
    if (!Number.isFinite(s.e) || (cur.length && s.t - cur[cur.length - 1].t > maxGap)) flush();
    if (Number.isFinite(s.e)) cur.push(s);
  }
  flush();
  return out;
}

// Autocorrelation of `key` averaged over several runs, weighted by length.
function pooledAutocorr(rs, key, maxLag) {
  const acc = new Float64Array(maxLag + 1);
  let w = 0;
  for (const run of rs) {
    const x = resample(run, key, run[0].t, run[run.length - 1].t);
    if (!x || x.length < maxLag + 2) continue;
    const r = autocorr(detrend(x, Math.round(3 * FS) | 1), maxLag);
    for (let k = 0; k <= maxLag; k++) acc[k] += r[k] * x.length;
    w += x.length;
  }
  if (!w) return null;
  for (let k = 0; k <= maxLag; k++) acc[k] /= w;
  return acc;
}

// Analyse samples [{ t, e (energy), y (lateral offset) }] between t0 and t1.
// Samples with e = NaN (e.g. while two swimmers overlap) split the data into
// separate runs. `family` forces 'alternating' / 'simultaneous' when the coach
// has set the stroke. `lateral: false` means the lane is too thin on screen
// to see the splash change sides (a camera beside the pool squashes the
// across-lane direction): a clear swing still counts, but its absence is not
// taken as fly/breast; the tempo decides instead. Returns { entryPeriod,
// cyclePeriod, rate, family, auto, strength } or null when there is no clear
// rhythm.
export function analyzeStrokes(samples, t0, t1, family = null, { lateral = true } = {}) {
  const rs = runs(samples, t0, t1);
  const maxLag = Math.round((MAX_PERIOD + 0.3) * FS);
  const re = pooledAutocorr(rs, 'e', maxLag);
  if (!re) return null;
  const dom = dominantLag(re);
  if (!dom || dom.strength < 0.2) return null;
  const ry = pooledAutocorr(rs, 'y', maxLag);
  const swing = (lag) => (ry ? -at(ry, lag) : 0); // > 0 when the splash changes side

  let P = dom.lag;
  let fam = family;
  let auto = false;
  if (!fam) {
    auto = true;
    // The energy peak might be a whole cycle (left+right) rather than one arm.
    if (at(re, P / 2) > 0.2 && swing(P / 2) > 0.25 && P / 2 >= MIN_PERIOD * FS) {
      P /= 2; fam = 'alternating';
    } else {
      const alternating = swing(P) > 0.25
        // Splashes this often (> ~70 a minute) are single arms: no fly or
        // breaststroke cycle is that quick.
        || (!lateral && P / FS < SINGLE_ARM_MAX);
      fam = alternating ? 'alternating' : 'simultaneous';
    }
  } else if (fam === 'alternating' && P / FS > 1.25 && P / 2 >= MIN_PERIOD * FS) {
    P /= 2; // too slow for one arm: it's the full cycle
  } else if (fam === 'simultaneous' && P / FS < 0.75) {
    P *= 2; // too quick for a full fly/breast cycle
  }
  const entryPeriod = P / FS;
  const cyclePeriod = fam === 'alternating' ? entryPeriod * 2 : entryPeriod;
  return { entryPeriod, cyclePeriod, rate: 60 / cyclePeriod, family: fam, auto, strength: dom.strength };
}

// How long the swimmer was actually stroking between t0 and t1: from the first
// to the last moment the (smoothed) splash is at least 35 % of its typical
// mid-length level. Skips the underwater glide after the wall.
export function activeTime(samples, t0, t1) {
  const e = resample(samples, 'e', t0, t1);
  if (!e) return 0;
  const w = FS; // 1 s smoothing
  const pre = new Float64Array(e.length + 1);
  for (let i = 0; i < e.length; i++) pre[i + 1] = pre[i] + e[i];
  const env = Array.from(e, (_, i) => {
    const a = Math.max(0, i - (w >> 1)), b = Math.min(e.length, i + (w >> 1) + 1);
    return (pre[b] - pre[a]) / (b - a);
  });
  const mid = env.slice(Math.floor(env.length * 0.25), Math.ceil(env.length * 0.75)).sort((a, b) => a - b);
  const level = mid[mid.length >> 1];
  if (!(level > 0)) return 0;
  const first = env.findIndex((v) => v >= 0.35 * level);
  let last = env.length - 1;
  while (last > first && env[last] < 0.35 * level) last--;
  return first < 0 ? 0 : (last - first) / FS;
}

// Strokes in one length: hand entries (free/back) or cycles (fly/breast),
// the way coaches count them.
export function strokeCount(samples, t0, t1, entryPeriod) {
  if (!entryPeriod) return null;
  return Math.round(activeTime(samples, t0, t1) / entryPeriod);
}
