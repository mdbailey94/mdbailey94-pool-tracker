// The lead coach's week: every session Monday to Sunday with what is planned
// for it and where it stands (open, written, swum, debriefed), the week's
// totals against the phase's targets (yards, gear bands, kick share), CNS
// load day by day, and a first draft of every open session in one go.
// Pure functions, no DOM.

import {
  addDays, composedYards, daysBetween, mondayOf, planPosition, recordComposed, sessionsOn, suggestPractice,
} from './practice.js';
import { cnsPoints, cnsResidual, gearIndex } from './gears.js';

// Gear bands the season plan is written in.
export const BANDS = [
  { key: 'aerobic', label: 'G1–G2.5', from: 0, to: 2.5 },
  { key: 'threshold', label: 'G3–G3.5', from: 3, to: 3.5 },
  { key: 'vo2', label: 'G4–G4.5', from: 4, to: 4.5 },
  { key: 'race', label: 'G5–G6', from: 5, to: 6 },
];

export const bandOf = (gear) => {
  const i = gearIndex(gear) ?? 2;
  return (BANDS.find((b) => i >= b.from && i <= b.to + 0.01) || BANDS[0]).key;
};

// Generic phase targets (share of the week's yards per band, and kick share
// on top). A phase can carry its own `targets`; these fill the gaps.
export const DEFAULT_TARGETS = { aerobic: 0.75, threshold: 0.13, vo2: 0.06, race: 0.06, kick: 0.2 };

export const phaseTargets = (phase) => ({ ...DEFAULT_TARGETS, ...(phase?.targets || {}) });

// The hour a session counts at in the CNS timeline: 6:00 (AM) or 16:00 (PM).
export const slotHour = (slot) => (slot === 'PM' ? 16 : 6);

// What each saved practice counts, by record: saved records are replaced on
// every change, never changed in place. Yards depend on the planning pace
// (sizes estimated from it), the CNS points on the gear model too.
const loads = new WeakMap();

// Yards per gear, kick yards, yards and CNS points of a saved practice as the
// builder counted them when it was written: put back together from its
// blocks, rounds and round pattern (recordComposed), each circuit round with
// its share of the lines and its gear shift, a block without lines at its
// distance in its first gear (composedYards). The yards follow the blocks'
// lines, also for practices saved with a minutes estimate; a v1 record
// (blocks without lines or sizes) keeps its own total. Build, Today, the
// Week and the coach chat all count a practice this way.
// → { byGear, kick, distance, cns } (shared: read only)
export function recordLoad(record, plan, model = plan.gears || {}) {
  const pace = plan.pace || 100;
  let c = loads.get(record);
  if (!c || c.pace !== pace) {
    const composed = recordComposed(record, plan);
    const { byGear, kick } = composedYards(composed);
    c = { pace, byGear: Object.freeze(byGear), kick, distance: composed.distance > 0 ? composed.distance : record.distance || 0, model: null, cns: 0 };
    loads.set(record, c);
  }
  if (c.model !== model) Object.assign(c, { model, cns: cnsPoints(model, c.byGear) });
  return { byGear: c.byGear, kick: c.kick, distance: c.distance, cns: c.cns };
}

// Practices on a timeline of hours from 0:00 on `origin`, each at its slot's
// hour with its CNS points, in time order: [{ record, at, points }], what
// cnsResidual reads.
export function cnsTimeline(records, origin, plan, model) {
  return records
    .map((record) => ({ record, at: daysBetween(origin, record.date) * 24 + slotHour(record.slot), points: recordLoad(record, plan, model).cns }))
    .sort((a, b) => a.at - b.at);
}

// The practice saved for a date + slot (newest first wins) and its debrief.
const findRecord = (log, date, slot) => log.find((r) => r.date === date && (r.slot || 'AM') === slot) || null;
const findDebrief = (debriefs, record) => (record ? debriefs.find((d) => d.practiceId === record.id) || null : null);

// Status of one session: open (nothing written), written (planned, still to
// swim), swum (date passed, no debrief yet), debriefed.
export function sessionStatus(record, debrief, date, today) {
  if (debrief) return 'debriefed';
  if (!record) return 'open';
  return date < today ? 'swum' : 'written';
}

// The week containing `date`.
export function weekOf({ plan, date, today, log = [], debriefs = [] }) {
  const monday = mondayOf(date);
  const position = planPosition(plan, monday);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(monday, i);
    const s = sessionsOn(plan, d);
    const sessions = s.sessions.map((x) => {
      const record = findRecord(log, d, x.slot);
      const debrief = findDebrief(debriefs, record);
      return { ...x, date: d, record, debrief, status: sessionStatus(record, debrief, d, today) };
    });
    // Practices written for a slot the plan doesn't have (an extra swim).
    for (const r of log.filter((x) => x.date === d && !sessions.some((y) => y.slot === (x.slot || 'AM')))) {
      const debrief = findDebrief(debriefs, r);
      sessions.push({ slot: r.slot || 'AM', minutes: r.minutes, focus: r.focus, volume: 1, theme: '', date: d, record: r, debrief, extra: true, status: sessionStatus(r, debrief, d, today) });
    }
    sessions.sort((a, b) => (a.slot < b.slot ? -1 : 1));
    return { date: d, weekday: i, meet: s.meet, preMeet: s.preMeet, position: s.position, sessions };
  });
  // Practices of the last 3 days before Monday: their CNS load is still
  // around on Monday morning (not counted in the week's totals).
  const before = log.filter((r) => r.date < monday && r.date >= addDays(monday, -3));
  return { monday, sunday: addDays(monday, 6), position, phase: position.phase || null, days, before };
}

// Totals for the week: written yards and minutes, yards per gear and band
// (share of the week), kick, CNS per day and what is left each morning, and
// the targets for the phase. Every practice is counted as the builder counts
// it (recordLoad: circuit rounds and their gear shifts included), so the
// Week, Build, Today and the coach chat show the same points.
export function weekTotals(week, plan, model = plan.gears || {}) {
  const byGear = {};
  let distance = 0;
  let minutes = 0;
  let kick = 0;
  let written = 0; // planned sessions with a practice written
  let planned = 0;
  let extras = 0; // practices on days or slots the plan doesn't have
  const cnsByDay = week.days.map(() => 0);
  const records = [];
  week.days.forEach((day, i) => {
    for (const s of day.sessions) {
      if (!s.extra) planned++;
      if (!s.record) continue;
      if (s.extra) extras++;
      else written++;
      const r = s.record;
      const load = recordLoad(r, plan, model);
      distance += load.distance;
      minutes += r.minutes || 0;
      kick += load.kick;
      for (const [k, v] of Object.entries(load.byGear)) byGear[k] = (byGear[k] || 0) + v;
      cnsByDay[i] += load.cns;
      records.push(r);
    }
  });
  const bands = Object.fromEntries(BANDS.map((b) => [b.key, 0]));
  for (const [g, y] of Object.entries(byGear)) bands[bandOf(g)] += y;
  const geared = Object.values(bands).reduce((s, v) => s + v, 0);
  const share = Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, geared ? v / geared : 0]));
  const targets = phaseTargets(week.phase);
  const targetYards = plan.weeklyYards ? Math.round(plan.weeklyYards * (week.phase?.volume ?? 1)) : null;
  // CNS left at 6:00 each morning, from this week's sessions and the last
  // days before it.
  const timeline = cnsTimeline([...records, ...(week.before || [])], week.monday, plan, model);
  const morning = week.days.map((_, i) => cnsResidual(model, timeline, i * 24 + slotHour('AM') - 0.001));
  return {
    distance, minutes, kick, kickShare: distance ? kick / distance : 0, written, planned, extras, unit: plan.unit === 'm' ? 'm' : 'y',
    byGear, bands, share, targets, targetYards,
    cnsByDay: cnsByDay.map((v) => Math.round(v * 10) / 10), cnsMorning: morning,
  };
}

// Where the week is off its targets, in plain words (for the planner and the
// coach chat). Only shares more than `tolerance` away count.
export function weekGaps(totals, tolerance = 0.04) {
  const out = [];
  if (!totals.distance) return out;
  const word = totals.unit === 'm' ? 'metres' : 'yards';
  const names = { aerobic: 'aerobic (G1–G2.5)', threshold: 'threshold (G3–G3.5)', vo2: 'VO2 (G4–G4.5)', race: 'race pace (G5–G6)' };
  for (const b of BANDS) {
    const have = totals.share[b.key] || 0;
    const want = totals.targets[b.key] ?? 0;
    if (Math.abs(have - want) > tolerance) out.push({ key: b.key, have, want, text: `${have > want ? 'More' : 'Less'} ${names[b.key]} than planned: ${Math.round(have * 100)}% of ${word} vs ${Math.round(want * 100)}%` });
  }
  const kw = totals.targets.kick;
  if (kw && Math.abs(totals.kickShare - kw) > tolerance) out.push({ key: 'kick', have: totals.kickShare, want: kw, text: `Kick is ${Math.round(totals.kickShare * 100)}% of ${word} vs ${Math.round(kw * 100)}% planned` });
  if (totals.targetYards && totals.written === totals.planned && Math.abs(totals.distance - totals.targetYards) / totals.targetYards > 0.1) {
    out.push({ key: 'yards', have: totals.distance, want: totals.targetYards, text: `${totals.distance.toLocaleString('en-US')} ${word} written vs about ${totals.targetYards.toLocaleString('en-US')} for this phase` });
  }
  return out;
}

// Blocks on the day before, the same day or the day after (written or
// drafted) score this much lower, so back-to-back sessions get different
// main sets whenever the library has another block that fits.
const NEAR_WEIGHT = 0.05;

// First drafts for every open session of the week (not meets, not past days
// unless asked), varied against each other and the log.
export function draftWeek({ plan, library, week, log = [], weights = {}, today, includePast = false, equipment = null }) {
  const history = [...log];
  const drafts = [];
  for (const day of week.days) {
    if (!includePast && day.date < today) continue;
    for (const s of day.sessions) {
      if (s.record || s.extra) continue;
      const near = { ...weights };
      for (const h of history) {
        if (Math.abs(daysBetween(h.date, day.date)) > 1) continue;
        for (const b of h.blocks || []) near[b.id] = (Number.isFinite(weights[b.id]) ? weights[b.id] : 1) * NEAR_WEIGHT;
      }
      const sug = suggestPractice({ plan, library, date: day.date, slot: s.slot, history, weights: near, equipment });
      if (!sug.blocks.length) continue;
      drafts.push({ date: day.date, slot: s.slot, suggestion: sug });
      history.unshift({ date: day.date, blocks: sug.blocks.map((b) => ({ id: b.id })) });
    }
  }
  return drafts;
}
