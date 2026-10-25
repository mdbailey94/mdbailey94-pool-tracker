// Gears: an intensity scale (G1 recovery … G6 max speed), each group's
// training pace per 100 in every gear, and the send-offs that follow.
// Pure functions, no DOM. Times are seconds.

// ------------------------------------------------------------------ clock

// 46 → ':46', 75 → '1:15', 3725 → '1:02:05'. Tenths are dropped.
export function fmtClock(sec) {
  if (!Number.isFinite(sec)) return '';
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  if (h) return `${h}:${String(m).padStart(2, '0')}:${r}`;
  return m ? `${m}:${r}` : `:${r}`;
}

// ':46' → 46, '1:15' → 75, '15:30' → 930, '1:02:05' → 3725, '0:58.0' → 58,
// '58.4' → 58.4; anything else → null.
export function parseClock(text) {
  const t = String(text ?? '').trim();
  let m = /^:(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (m) return +m[1];
  m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (m && +m[2] < 60) return +m[1] * 60 + +m[2];
  m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(t);
  if (m && +m[2] < 60 && +m[3] < 60) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  m = /^\d+(?:\.\d+)?$/.exec(t);
  if (m) return +t;
  return null;
}

// ------------------------------------------------------------- the model
//
// Race times follow a fatigue curve (Riegel): T2 = T1 × (D2 / D1)^F.
// A gear is the speed a swimmer could hold for a set duration, so its pace
// per 100 is the curve solved for that duration:
//   pace_G = T/d × 100 × (T_G / T)^((F − 1) / F)
// G1 sits a fixed factor slower than G2. Rest grows with the gear and the
// rep: rest = swim × ratio × (swim / 60)^exponent, with a ratio per gear.
//
// The defaults below are generic placeholders, not any coach's chart:
// Riegel's classic F of 1.06, a small fixed extra exponent for the 200,
// textbook durations (aerobic for hours, threshold for an hour, VO2max for a
// few minutes), a smooth round series of rest ratios and a round 5× CNS
// ladder. A coach's own constants are saved in the app's private storage
// (plan.gears) and override every one of these, so their send-offs, paces
// and loads come from their chart, not from here.

export const DEFAULT_GEAR_MODEL = {
  fatigue: 1.06,          // F (Riegel's classic); lower for distance swimmers, higher for sprinters
  offset200: 0.03,        // extra exponent for the 200 from the 500
  imFatigue: 1.06,        // F for IM paces from a 400 IM time
  baseDistance: 1650,     // the test the groups are defined by (yards)
  restExponent: 0.5,      // 0 = rest a fixed share of swim time, 1 = grows with rep length
  gears: [
    { name: 'G1', label: 'Recovery', feel: 'Very easy', from: 'G2', factor: 1.1, rest: 0.02 },
    { name: 'G2', label: 'Aerobic', feel: 'Easy and steady', duration: 14400, rest: 0.04 },
    { name: 'G2.5', label: 'Upper aerobic', feel: 'Steady, a little harder', duration: 7200, rest: 0.07 },
    { name: 'G3', label: 'Threshold', feel: 'Comfortably hard, even splits', duration: 3600, rest: 0.1 },
    { name: 'G3.5', label: 'Critical speed', feel: 'Hard but sustainable', duration: 1800, rest: 0.17 },
    { name: 'G4', label: 'VO2, about 15 min', feel: 'Hard', duration: 900, rest: 0.3 },
    { name: 'G4.5', label: 'VO2, about 10 min', feel: 'Very hard', duration: 600, rest: 0.5 },
    { name: 'G5', label: 'VO2max, about 5 min', feel: 'Near max, long rest', duration: 300, rest: 0.8 },
    { name: 'G6', label: 'Speed, about 2 min', feel: 'Max effort, full rest', duration: 120, rest: 1.5 },
  ],
  // Seconds per 100 added to the free pace for other strokes and for kick,
  // pull and drill (when a group has no time for that stroke).
  strokes: { free: 0, back: 5, breast: 12, fly: 5, IM: 7, choice: 5 },
  kinds: { swim: 0, pull: 2, kick: 18, drill: 12 },
  // Send-offs: whole seconds up to 100s, rounded up to :05 from 150 on.
  rounding: { short: 1, long: 5, longFrom: 150 },
  // CNS points per yard in each gear (load and readiness): ×5 per whole gear
  // from G3, half gears in between, nothing for aerobic work.
  cns: { G1: 0, G2: 0, 'G2.5': 0, G3: 0.002, 'G3.5': 0.005, G4: 0.01, 'G4.5': 0.025, G5: 0.05, G6: 0.25 },
  cnsHalfLifeHours: 12,
};

export function makeGearModel(m = {}) {
  const base = DEFAULT_GEAR_MODEL;
  const byName = Object.fromEntries((m.gears || []).map((g) => [g.name, g]));
  return {
    ...base,
    ...m,
    gears: base.gears.map((g) => ({ ...g, ...(byName[g.name] || {}) }))
      .concat((m.gears || []).filter((g) => !base.gears.some((b) => b.name === g.name))),
    strokes: { ...base.strokes, ...(m.strokes || {}) },
    kinds: { ...base.kinds, ...(m.kinds || {}) },
    rounding: typeof m.rounding === 'number' ? { short: m.rounding, long: m.rounding, longFrom: 0 } : { ...base.rounding, ...(m.rounding || {}) },
    cns: { ...base.cns, ...(m.cns || {}) },
  };
}

const offset200 = (m) => (Number.isFinite(m.offset200) ? m.offset200 : DEFAULT_GEAR_MODEL.offset200);

// Predicted time for `distance` from a test swim (Riegel).
export const predictTime = (test, distance, fatigue) => test.seconds * (distance / test.distance) ** fatigue;

// Race-time predictions for a test swim (1650, 1000, 500 and a 200 from the 500).
export function racePredictions(model, test) {
  const m = makeGearModel(model);
  const f = m.fatigue;
  const t500 = predictTime(test, 500, f);
  const t200 = predictTime({ distance: 500, seconds: t500 }, 200, f + offset200(m));
  return { 1650: predictTime(test, 1650, f), 1000: predictTime(test, 1000, f), 500: t500, 200: t200 };
}

// Pace per 100 a swimmer could hold for `duration` seconds.
export function paceForDuration(test, duration, fatigue) {
  return test.seconds / test.distance * 100 * (duration / test.seconds) ** ((fatigue - 1) / fatigue);
}

// Pace per 100 in every gear for one test swim: { G1: 63.2, G2: 58.0, … }.
// `fatigue` overrides the model's F (IM paces use imFatigue).
export function gearPaces(model, test, fatigue = null) {
  const m = makeGearModel(model);
  const f = fatigue || m.fatigue;
  const out = {};
  for (const g of m.gears) if (g.duration) out[g.name] = paceForDuration(test, g.duration, f);
  for (const g of m.gears) {
    if (!g.duration && g.from && out[g.from] != null) out[g.name] = out[g.from] * (g.factor || 1) + (g.offset || 0);
  }
  return out;
}

// IM pace per 100 in every gear from a 400 IM time.
export const imPaces = (model, seconds400) => gearPaces(model, { distance: 400, seconds: seconds400 }, makeGearModel(model).imFatigue);

// The 1650-style test time that gives a wanted pace in one gear (to define a
// group by its G3 pace per 100, e.g. "G3 pace 1:10").
export function testForGearPace(model, gear, pacePer100, distance = null) {
  const m = makeGearModel(model);
  const dist = distance || m.baseDistance;
  let g = m.gears.find((x) => x.name === gear);
  let pace = pacePer100;
  while (g && !g.duration && g.from) { pace = (pace - (g.offset || 0)) / (g.factor || 1); g = m.gears.find((x) => x.name === g.from); }
  if (!g?.duration) return null;
  // pace = T/d × 100 × (T_G / T)^((F−1)/F)  →  T^(1/F) = pace × d / 100 / T_G^((F−1)/F)
  const f = m.fatigue;
  const seconds = (pace * dist / 100 / g.duration ** ((f - 1) / f)) ** f;
  return { distance: dist, seconds };
}

export const gearIndex = (gear) => {
  const m = /^G(\d(?:\.\d)?)$/.exec(String(gear || ''));
  return m ? +m[1] : null;
};

// Pace of any gear, including half gears the model doesn't list (G5.5).
export function paceOf(paces, gear) {
  if (paces[gear] != null) return paces[gear];
  const i = gearIndex(gear);
  if (i == null) return null;
  const lo = paces[`G${Math.floor(i)}`];
  const hi = paces[`G${Math.ceil(i)}`];
  return lo != null && hi != null ? lo + (hi - lo) * (i - Math.floor(i)) : lo ?? hi ?? null;
}

// A gear the model doesn't know rests like G3.
const g3Rest = (m) => m.gears.find((x) => x.name === 'G3')?.rest ?? 0.1;

// Rest after one rep: swim × ratio × (swim / 60)^exponent, at least 1 s.
export function restFor(model, gear, swimSeconds) {
  const m = makeGearModel(model);
  const i = gearIndex(gear);
  let g = m.gears.find((x) => x.name === gear);
  let ratio = g?.rest;
  if (ratio == null && i != null) {
    const lo = m.gears.find((x) => x.name === `G${Math.floor(i)}`)?.rest ?? g3Rest(m);
    const hi = m.gears.find((x) => x.name === `G${Math.ceil(i)}`)?.rest ?? lo;
    ratio = lo + (hi - lo) * (i - Math.floor(i));
  }
  if (ratio == null) ratio = g3Rest(m);
  return Math.max(1, Math.round(swimSeconds * ratio * (swimSeconds / 60) ** m.restExponent));
}

// Seconds per 100 a stroke and kind add to the free pace.
export function strokeOffset(model, stroke = 'free', kind = 'swim') {
  const m = makeGearModel(model);
  return (m.strokes[stroke] ?? m.strokes.choice ?? 0) + (m.kinds[kind] ?? 0);
}

// Round a send-off the coach's way: whole seconds for short reps, up to the
// next :05 from 150 on (`nearest`: to the nearest :05, for values that were
// already rounded up once, like ratios learned from written send-offs).
export function roundSendOff(model, seconds, distance, nearest = false) {
  const r = makeGearModel(model).rounding;
  if (distance >= (r.longFrom || Infinity) && r.long > 1) return (nearest ? Math.round(seconds / r.long) : Math.ceil(Math.round(seconds) / r.long)) * r.long;
  const step = r.short || 1;
  return Math.round(seconds / step) * step;
}

// Send-off for one rep: swim time at the gear's pace (adjusted for stroke,
// kick/pull and what debriefs taught) plus the gear's rest. `paces` are the
// group's free paces; `strokePaces` (e.g. IM paces) replace them for that stroke.
export function sendOff(model, paces, { gear, distance, stroke = 'free', kind = 'swim', adjust = 0, strokePaces = null }) {
  const m = makeGearModel(model);
  const own = strokePaces && paceOf(strokePaces, gear);
  const base = own ?? paceOf(paces, gear);
  if (base == null) return null;
  const per100 = base + (own != null ? m.kinds[kind] ?? 0 : strokeOffset(m, stroke, kind)) + adjust;
  const swim = per100 * distance / 100;
  return roundSendOff(m, swim + restFor(m, gear, swim), distance);
}

// One row per gear for a group: label and pace per 100 (for the Season tab
// and the coach chat).
export function paceTable(model, test) {
  const m = makeGearModel(model);
  const paces = gearPaces(m, test);
  return m.gears.map((g) => ({ gear: g.name, label: g.label, pace: paces[g.name] ?? null, feel: g.feel }));
}

// ------------------------------------------------------------------- load
//
// CNS load: points = Σ yards in a gear × that gear's rate. What is left of
// it halves every 12 hours, and a high-CNS session wants under 5 left.

export function cnsPoints(model, yardsByGear) {
  const m = makeGearModel(model);
  let pts = 0;
  for (const [g, y] of Object.entries(yardsByGear || {})) {
    const rate = m.cns[g] ?? m.cns[`G${Math.round(gearIndex(g) ?? 2)}`] ?? 0;
    pts += y * rate;
  }
  return Math.round(pts * 10) / 10;
}

// sessions: [{ at: hours (any origin), points }] in time order. Returns what
// is left at `atHours`.
export function cnsResidual(model, sessions, atHours) {
  const half = makeGearModel(model).cnsHalfLifeHours || 12;
  let left = 0;
  for (const s of sessions) {
    if (s.at > atHours) break;
    left += s.points * 0.5 ** ((atHours - s.at) / half);
  }
  return Math.round(left * 10) / 10;
}
