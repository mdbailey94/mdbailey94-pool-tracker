// What the app learns from debriefs: which blocks work (weights for the
// suggestion engine), whether send-offs per gear and stroke are too tight or
// too easy (seconds per 100 to add to computed intervals), and the notes to
// bring back the next time a block comes up. Pure functions, no DOM.

import { byDateDesc, CATEGORY_GEAR, daysBetween, uid } from './practice.js';
import { gearIndex } from './gears.js';
import { eachItem, lineGear, parseSet } from './setlang.js';

export const VERDICTS = { good: 'Good', mixed: 'Mixed', bad: 'Bad' };
export const INTERVALS = { 'too-easy': 'Too easy', right: 'Right', 'too-hard': 'Too hard' };
export const MADE = { all: 'All', most: 'Most', few: 'Few' };
export const GOALS = { beat: 'Beat', hit: 'Hit', missed: 'Missed' };
export const DRILLS = { working: 'Working', somewhat: 'Somewhat', not: 'Not working' };

const pick = (v, table) => (v in table ? v : null);
const HALF_LIFE = 21; // days: a debrief three weeks old counts half

const decay = (date, today) => {
  const age = Math.max(0, daysBetween(date, today));
  return 0.5 ** (age / HALF_LIFE);
};

const STROKE_KEYS = ['free', 'back', 'breast', 'fly', 'IM', 'all'];
// Calibration is kept per stroke; 'all' when the stroke is unknown (choice).
const strokeKey = (st) => (st && st !== 'choice' ? st : 'all');

// The gears and strokes a block's send-offs are timed in, as setlang times
// them (each swim line's lineGear and stroke; easy swims have no gear send-
// off), most yards first. Lines that name no stroke count as 'all' only
// when no line of the block names one (a kick set), so a free set's kick
// doesn't move every stroke's send-offs. A block without timed lines: its
// gears, else its category's gear, in its stroke.
// → { gear: the gear with the most yards, timing: [{ gear, stroke }] }
export function blockTiming(b) {
  const yards = new Map();
  if (b.lines?.length) {
    const parsed = parseSet(b.lines.join('\n'));
    const timed = parsed.lines.filter((l) => l.type === 'swim' && !l.easy);
    const named = timed.some((l) => l.stroke !== 'choice');
    eachItem(parsed, (l, times) => {
      if (!timed.includes(l) || (named && l.stroke === 'choice')) return;
      const key = `${lineGear(l)}|${strokeKey(l.stroke)}`;
      yards.set(key, (yards.get(key) || 0) + l.reps * l.distance * times);
    });
  }
  if (!yards.size) {
    const gears = b.gears?.length ? b.gears : [CATEGORY_GEAR[b.category]].filter(Boolean);
    return { gear: gears[0] || null, timing: gears.map((gear) => ({ gear, stroke: strokeKey(b.stroke) })) };
  }
  const keys = [...yards].sort((x, y) => y[1] - x[1]);
  const byGear = new Map();
  for (const [k, y] of keys) { const g = k.split('|')[0]; byGear.set(g, (byGear.get(g) || 0) + y); }
  const gear = [...byGear].sort((x, y) => y[1] - x[1])[0][0];
  return { gear, timing: keys.map(([k]) => { const [g, stroke] = k.split('|'); return { gear: g, stroke }; }) };
}

// One section per block of the saved practice (circuit blocks too). The
// section carries the gears and strokes the block's send-offs are timed in,
// so interval feedback moves those send-offs.
export function debriefFor(record) {
  return {
    id: uid('d'),
    practiceId: record.id,
    date: record.date,
    slot: record.slot || 'AM',
    createdAt: Date.now(),
    overall: null,
    notes: '',
    sections: (record.blocks || []).map((b, index) => makeSection({ index, blockId: b.id, name: b.name, ...blockTiming(b), stroke: b.stroke || null, plannedDistance: b.distance ?? null })),
  };
}

export function makeSection(x = {}) {
  return {
    index: x.index ?? 0,
    blockId: x.blockId ?? null,
    name: String(x.name || ''),
    verdict: pick(x.verdict, VERDICTS),
    why: String(x.why || ''),
    changed: String(x.changed || ''),
    intervals: pick(x.intervals, INTERVALS),
    made: pick(x.made, MADE),
    goal: pick(x.goal, GOALS),
    times: String(x.times || ''),
    drills: pick(x.drills, DRILLS),
    skipped: !!x.skipped,
    actualDistance: Number.isFinite(+x.actualDistance) && x.actualDistance !== null && x.actualDistance !== '' ? Math.max(0, Math.round(+x.actualDistance)) : null,
    plannedDistance: Number.isFinite(x.plannedDistance) ? x.plannedDistance : null,
    gear: x.gear || null,
    stroke: x.stroke || null,
    timing: (Array.isArray(x.timing) ? x.timing : [])
      .filter((t) => gearIndex(t?.gear) != null)
      .map((t) => ({ gear: t.gear, stroke: STROKE_KEYS.includes(t.stroke) ? t.stroke : 'all' })),
  };
}

export function makeDebrief(d) {
  const overall = Math.round(+d.overall);
  return {
    id: d.id || uid('d'),
    practiceId: d.practiceId || null,
    date: d.date,
    slot: d.slot || 'AM',
    createdAt: d.createdAt || Date.now(),
    overall: overall >= 1 && overall <= 5 ? overall : null,
    notes: String(d.notes || ''),
    sections: (d.sections || []).map(makeSection),
  };
}

// Has the coach said anything about this section?
export const sectionTouched = (s) => !!(s.verdict || s.why || s.changed || s.intervals || s.made || s.goal || s.times || s.drills || s.skipped || s.actualDistance !== null);

// ------------------------------------------------------------- learning

// Suggestion weights per block in [0.5, 1.5]: good debriefs raise a block,
// bad ones (and drills that aren't working) lower it; recent ones count more.
export function blockScores(debriefs, today) {
  const sum = {};
  const n = {};
  for (const d of debriefs) {
    const w = decay(d.date, today);
    for (const s of d.sections || []) {
      if (!s.blockId) continue;
      let v = s.verdict === 'good' ? 1 : s.verdict === 'bad' ? -1 : s.verdict === 'mixed' ? 0 : null;
      if (s.drills === 'not') v = (v ?? 0) - 0.5;
      if (s.drills === 'working') v = (v ?? 0) + 0.25;
      if (v === null) continue;
      sum[s.blockId] = (sum[s.blockId] || 0) + v * w;
      n[s.blockId] = (n[s.blockId] || 0) + w;
    }
  }
  const out = {};
  for (const id of Object.keys(sum)) {
    // Shrink towards neutral until there are a few debriefs.
    const mean = sum[id] / (n[id] + 1);
    out[id] = Math.round(Math.min(1.5, Math.max(0.5, 1 + 0.5 * mean)) * 100) / 100;
  }
  return out;
}

// Debriefs saved before sections kept their timing (only the block's first
// gear) are read with the gears their practice's blocks are timed in.
export function withTiming(debriefs, log = []) {
  const byId = new Map(log.map((r) => [r.id, r]));
  return debriefs.map((d) => {
    const rec = byId.get(d.practiceId);
    if (!rec || (d.sections || []).every((s) => s.timing?.length)) return d;
    return { ...d, sections: d.sections.map((s) => (s.timing?.length || !rec.blocks?.[s.index] ? s : { ...s, timing: blockTiming(rec.blocks[s.index]).timing })) };
  });
}

// The gear + stroke keys a section's feedback goes to: the ones its block's
// send-offs are timed in, or (sections saved before that) its one gear.
const sectionKeys = (s) => (s.timing?.length ? s.timing : s.gear ? [{ gear: s.gear, stroke: strokeKey(s.stroke) }] : []);

// Seconds per 100 to add to computed send-offs, per gear and stroke
// ('all' when the stroke is unknown), for every gear and stroke the
// section's block is timed in: too hard / few made → +1, too easy → −1,
// recent debriefs count more; clamped to ±6, in 0.5 steps.
export function intervalCalibration(debriefs, today = null) {
  const acc = {};
  const ref = today || debriefs.reduce((m, d) => (d.date > m ? d.date : m), '0000-00-00');
  for (const d of debriefs) {
    const w = decay(d.date, ref);
    for (const s of d.sections || []) {
      if (s.skipped) continue;
      let v = 0;
      if (s.intervals === 'too-hard') v += 1;
      if (s.intervals === 'too-easy') v -= 1;
      if (s.made === 'few') v += 1;
      if (s.made === 'most' && s.intervals !== 'too-easy') v += 0.5;
      if (!v) continue;
      for (const { gear, stroke } of sectionKeys(s)) {
        acc[gear] ||= {};
        acc[gear][stroke] = (acc[gear][stroke] || 0) + v * w;
      }
    }
  }
  const out = {};
  for (const [gear, byStroke] of Object.entries(acc)) {
    for (const [stroke, v] of Object.entries(byStroke)) {
      const r = Math.round(Math.min(6, Math.max(-6, v)) * 2) / 2;
      if (r) (out[gear] ||= {})[stroke] = r;
    }
  }
  return out;
}

// The adjustment for one gear + stroke: the stroke's own value, else 'all'.
export function calibrationFor(cal, gear, stroke) {
  const g = cal?.[gear];
  if (!g) return 0;
  return g[stroke] ?? g.all ?? 0;
}

// The latest notes about a block, newest first, to show when it comes up
// again. The app keeps its debriefs newest first (byDateDesc), so they are
// only sorted when handed over in another order.
export function carryForward(debriefs, blockId, max = 3) {
  const out = [];
  const sorted = debriefs.every((d, i) => i === 0 || byDateDesc(debriefs[i - 1], d) <= 0);
  for (const d of sorted ? debriefs : [...debriefs].sort(byDateDesc)) {
    for (const s of d.sections || []) {
      if (s.blockId !== blockId || !(s.verdict || s.why || s.changed || s.times)) continue;
      out.push({ date: d.date, verdict: s.verdict, why: s.why, changed: s.changed, intervals: s.intervals, times: s.times });
      if (out.length >= max) return out;
    }
  }
  return out;
}

// What was actually swum: skipped sections removed, actual distances used.
// Blocks saved without a size (v1 records) share what is left of the
// practice's distance evenly.
export function actualTotals(record, debrief) {
  if (!debrief) return { distance: record.distance, minutes: record.minutes, changed: false };
  let distance = 0;
  let minutes = 0;
  let changed = false;
  const blocks = record.blocks || [];
  const sized = (b) => Number.isFinite(b.distance);
  const unsized = blocks.filter((b) => !sized(b)).length;
  const rest = unsized ? Math.max(0, (record.distance || 0) - blocks.filter(sized).reduce((n, b) => n + b.distance, 0)) / unsized : 0;
  blocks.forEach((b, i) => {
    const s = debrief.sections?.find((x) => x.index === i) || null;
    const planned = sized(b) ? b.distance : rest;
    const share = record.distance ? planned / record.distance : 0;
    if (s?.skipped) { changed = true; return; }
    const d = s?.actualDistance ?? planned;
    if (s?.actualDistance !== null && s?.actualDistance !== undefined && s.actualDistance !== planned) changed = true;
    distance += d;
    minutes += (record.minutes || 0) * share * (planned ? d / planned : 1);
  });
  if (!blocks.length) return { distance: record.distance, minutes: record.minutes, changed: false };
  return { distance: Math.round(distance), minutes: Math.round(minutes), changed };
}

// One line for lists and for the coach chat.
export function debriefSummary(d) {
  const parts = [];
  if (d.overall) parts.push(`${d.overall}/5`);
  for (const s of d.sections || []) {
    if (!sectionTouched(s)) continue;
    const bits = [];
    if (s.skipped) bits.push('skipped');
    if (s.verdict) bits.push(VERDICTS[s.verdict].toLowerCase());
    if (s.intervals) bits.push(`intervals ${INTERVALS[s.intervals].toLowerCase()}`);
    if (s.made) bits.push(`made ${MADE[s.made].toLowerCase()}`);
    if (s.goal) bits.push(`goal times ${GOALS[s.goal].toLowerCase()}${s.times ? ` (${s.times})` : ''}`);
    if (s.drills) bits.push(`drills ${DRILLS[s.drills].toLowerCase()}`);
    if (s.why) bits.push(`why: ${s.why}`);
    if (s.changed) bits.push(`changed: ${s.changed}`);
    parts.push(`${s.name}: ${bits.join(', ')}`);
  }
  if (d.notes) parts.push(`notes: ${d.notes}`);
  return parts.join(' · ') || 'No feedback yet';
}

// Sentences describing what this debrief changed, for the confirmation: one
// per gear and new value ("Send-offs for G5 back and breast now +2s per 100.").
export function learnedFrom(before, after) {
  const out = [];
  const gears = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const rank = (st) => STROKE_KEYS.indexOf(st) + 1; // 'all' last, unknown first
  const list = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);
  for (const g of [...gears].sort()) {
    const strokes = [...new Set([...Object.keys(before?.[g] || {}), ...Object.keys(after?.[g] || {})])].sort((x, y) => rank(x) - rank(y));
    const changes = new Map(); // what the send-offs are now → strokes
    for (const st of strokes) {
      const a = before?.[g]?.[st] || 0;
      const b = after?.[g]?.[st] || 0;
      if (a === b) continue;
      const now = b ? `now ${b > 0 ? '+' : ''}${b}s per 100.` : 'back to the gear chart.';
      changes.set(now, [...(changes.get(now) || []), st]);
    }
    // 'all' covers only the strokes without a value of their own.
    const others = Object.keys(after?.[g] || {}).some((st) => st !== 'all') ? ' in other strokes' : '';
    for (const [now, sts] of changes) {
      const named = sts.filter((st) => st !== 'all');
      if (named.length) out.push(`Send-offs for ${g} ${list(named)} ${now}`);
      if (sts.includes('all')) out.push(`Send-offs for ${g}${others} ${now}`);
    }
  }
  return out;
}
