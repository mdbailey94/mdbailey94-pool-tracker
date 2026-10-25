import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actualTotals, blockScores, calibrationFor, carryForward, debriefFor, debriefSummary, intervalCalibration, learnedFrom,
  makeDebrief, sectionTouched,
} from '../src/learn.js';

const record = {
  id: 's1', date: '2026-10-20', slot: 'AM', minutes: 100, distance: 5000,
  blocks: [
    { id: 'warm', name: 'Warm-up', category: 'warmup', stroke: 'choice', gears: ['G1'], distance: 1500 },
    { id: 'thr', name: 'Threshold 100s', category: 'threshold', stroke: 'free', gears: ['G3'], distance: 2500 },
    { id: 'socks', name: 'Socks with FL', category: 'technique', stroke: 'fly', gears: [], distance: 1000 },
  ],
};

const debrief = (date, sections, extra = {}) => makeDebrief({ ...debriefFor({ ...record, date }), ...extra, sections: debriefFor({ ...record, date }).sections.map((s, i) => ({ ...s, ...(sections[i] || {}) })) });

test('a debrief has one section per block of the practice', () => {
  const d = debriefFor(record);
  assert.equal(d.practiceId, 's1');
  // A block with no gears of its own (socks) gets its category's gear, as the Debrief screen shows it.
  assert.deepEqual(d.sections.map((s) => [s.name, s.gear, s.stroke]), [['Warm-up', 'G1', 'choice'], ['Threshold 100s', 'G3', 'free'], ['Socks with FL', 'G1', 'fly']]);
  assert.equal(sectionTouched(d.sections[0]), false);
  const clean = makeDebrief({ ...d, overall: 9, sections: [{ verdict: 'great', intervals: 'too-hard', actualDistance: '1200' }] });
  assert.equal(clean.overall, null);
  assert.equal(clean.sections[0].verdict, null);
  assert.equal(clean.sections[0].intervals, 'too-hard');
  assert.equal(clean.sections[0].actualDistance, 1200);
});

test('good debriefs raise a block, bad ones and failing drills lower it', () => {
  const ds = [
    debrief('2026-10-20', [null, { verdict: 'good' }, { verdict: 'bad', drills: 'not' }]),
    debrief('2026-10-13', [null, { verdict: 'good' }, { verdict: 'mixed', drills: 'not' }]),
  ];
  const w = blockScores(ds, '2026-10-21');
  assert.ok(w.thr > 1.2 && w.thr <= 1.5, String(w.thr));
  assert.ok(w.socks < 0.8 && w.socks >= 0.5, String(w.socks));
  assert.equal(w.warm, undefined);
  // An old bad debrief counts less than a recent good one.
  const mixed = blockScores([debrief('2026-06-01', [null, { verdict: 'bad' }]), debrief('2026-10-20', [null, { verdict: 'good' }])], '2026-10-21');
  assert.ok(mixed.thr > 1, String(mixed.thr));
});

test('interval feedback adjusts send-offs per gear and stroke', () => {
  const ds = [
    debrief('2026-10-20', [null, { intervals: 'too-hard', made: 'few' }]),
    debrief('2026-10-18', [null, { intervals: 'too-hard' }]),
    debrief('2026-10-16', [{ intervals: 'too-easy' }]),
  ];
  const cal = intervalCalibration(ds, '2026-10-21');
  assert.ok(cal.G3.free >= 2.5 && cal.G3.free <= 3, JSON.stringify(cal));
  assert.equal(cal.G1.choice, undefined);
  assert.equal(cal.G1.all, -1);
  assert.equal(calibrationFor(cal, 'G3', 'free'), cal.G3.free);
  assert.equal(calibrationFor(cal, 'G3', 'back'), 0);
  assert.equal(calibrationFor(cal, 'G1', 'fly'), -1);
  // Skipped sections teach nothing; a block without gears learns in its category's gear.
  assert.deepEqual(intervalCalibration([debrief('2026-10-20', [null, { intervals: 'too-hard', skipped: true }, { intervals: 'too-hard' }])]), { G1: { fly: 1 } });
  // Sections saved without any gear teach nothing.
  assert.deepEqual(intervalCalibration([makeDebrief({ date: '2026-10-20', sections: [{ name: 'Old', intervals: 'too-hard', made: 'few' }] })]), {});
  // Never more than 6 s per 100.
  const many = Array.from({ length: 12 }, () => debrief('2026-10-20', [null, { intervals: 'too-hard', made: 'few' }]));
  assert.equal(intervalCalibration(many).G3.free, 6);
  assert.deepEqual(learnedFrom({}, { G3: { free: 1 } }), ['Send-offs for G3 free now +1s per 100.']);
  assert.deepEqual(learnedFrom({ G3: { all: 1 } }, {}), ['Send-offs for G3 back to the gear chart.']);
});

test('notes about a block come back newest first', () => {
  const ds = [
    debrief('2026-10-06', [null, null, { verdict: 'bad', why: 'hips sank', changed: 'switched to 25s' }]),
    debrief('2026-10-20', [null, null, { verdict: 'good', why: 'shorter reps worked' }]),
  ];
  const notes = carryForward(ds, 'socks');
  assert.deepEqual(notes.map((n) => [n.date, n.verdict]), [['2026-10-20', 'good'], ['2026-10-06', 'bad']]);
  assert.equal(notes[1].changed, 'switched to 25s');
  assert.deepEqual(carryForward(ds, 'warm'), []);
});

test('actual totals drop skipped sections and use actual distances', () => {
  const d = debrief('2026-10-20', [null, { actualDistance: 2000 }, { skipped: true }]);
  assert.deepEqual(actualTotals(record, d), { distance: 3500, minutes: 70, changed: true });
  assert.deepEqual(actualTotals(record, null), { distance: 5000, minutes: 100, changed: false });
  assert.equal(actualTotals(record, debrief('2026-10-20', [])).changed, false);
});

test('a one-line summary for lists and the coach', () => {
  const d = debrief('2026-10-20', [null, { verdict: 'good', intervals: 'right', goal: 'hit', times: '1:02s', changed: 'added :05' }], { overall: 4, notes: 'great energy' });
  assert.equal(debriefSummary(d), '4/5 · Threshold 100s: good, intervals right, goal times hit (1:02s), changed: added :05 · notes: great energy');
  assert.equal(debriefSummary(debriefFor(record)), 'No feedback yet');
});

// ------------------------------------------------- feedback lands on the set's own send-offs

import { blockTiming, makeSection, withTiming } from '../src/learn.js';
import { writeLines, writingContext } from '../src/setlang.js';

// Made-up groups and sets (no real coach data).
const wplan = { pace: 100, groups: [{ name: 'Lane 1', g3: 70 }, { name: 'Lane 2', g3: 75 }] };
const raceLines = ['6 x 50 free, G3 → G6 by 25', ':30 REST', '3 rounds:', '6 x 50 free G5', '4 x 25 free sprint, G6', '2 x 25 kick sprint, G6', '150 easy, any stroke'];
const imLines = ['5 x 100 IM', '2 rounds:', '6 x 50 BK, G2 → G5 by 25', '6 x 50 BR, G2 → G5 by 25', '6 x 25 FL sprint, G6', '4 x 25 kick sprint, G6', '150 easy, any stroke'];
const threshold = ['5 x 100 free G3'];
const tooHard = (rec) => {
  const d = debriefFor(rec);
  return makeDebrief({ ...d, sections: d.sections.map((s) => makeSection({ ...s, intervals: 'too-hard', made: 'few' })) });
};
const moved = (lines, cal) => {
  const a = writeLines(lines, writingContext(wplan), { retimeAll: true });
  const b = writeLines(lines, writingContext(wplan, { calibration: cal }), { retimeAll: true });
  return lines.filter((_, i) => a[i] !== b[i]);
};

test('interval feedback on a race set moves that set\'s send-offs, not threshold ones', () => {
  const rec = { id: 'r1', date: '2026-10-20', blocks: [{ id: 'rp', name: '35 min race pace', category: 'race', stroke: 'free', gears: ['G3', 'G4', 'G5', 'G6'], lines: raceLines, distance: 2100 }] };
  const d = tooHard(rec);
  // The build starts in G3 (the block's first gear) but no send-off is timed in G3.
  assert.equal(d.sections[0].gear, 'G5');
  assert.deepEqual(d.sections[0].timing, [{ gear: 'G5', stroke: 'free' }, { gear: 'G6', stroke: 'free' }]);
  const cal = intervalCalibration([d], '2026-10-21');
  assert.deepEqual(cal, { G5: { free: 2 }, G6: { free: 2 } });
  assert.deepEqual(moved(raceLines, cal), ['6 x 50 free, G3 → G6 by 25', '6 x 50 free G5', '4 x 25 free sprint, G6']);
  assert.deepEqual(moved(threshold, cal), []);
  assert.deepEqual(learnedFrom({}, cal), ['Send-offs for G5 free now +2s per 100.', 'Send-offs for G6 free now +2s per 100.']);
});

test('a mixed-stroke set is calibrated per stroke; a kick set in every stroke', () => {
  const t = blockTiming({ category: 'race', stroke: 'IM', gears: ['G3', 'G6'], lines: imLines });
  assert.equal(t.gear, 'G4');
  // Most yards first; the kick (no stroke named) and the easy swim are left out.
  assert.deepEqual(t.timing, [{ gear: 'G4', stroke: 'back' }, { gear: 'G4', stroke: 'breast' }, { gear: 'G2', stroke: 'IM' }, { gear: 'G6', stroke: 'fly' }]);
  const rec = { id: 'r2', date: '2026-10-20', blocks: [{ id: 'im', name: 'IM builds', category: 'race', stroke: 'IM', gears: ['G2', 'G6'], lines: imLines, distance: 2500 }] };
  const cal = intervalCalibration([tooHard(rec)], '2026-10-21');
  assert.equal(cal.G3, undefined);
  assert.deepEqual(moved(imLines, cal), ['5 x 100 IM', '6 x 50 BK, G2 → G5 by 25', '6 x 50 BR, G2 → G5 by 25', '6 x 25 FL sprint, G6']);
  assert.deepEqual(learnedFrom({}, cal), ['Send-offs for G2 IM now +2s per 100.', 'Send-offs for G4 back and breast now +2s per 100.', 'Send-offs for G6 fly now +2s per 100.']);
  // A set that names no stroke (all kick) is timed in 'all' at each of its gears.
  assert.deepEqual(blockTiming({ category: 'kick', stroke: 'choice', lines: ['6 x 100 kick, G2', '8 x 25 kick sprint, G6'] }).timing, [{ gear: 'G2', stroke: 'all' }, { gear: 'G6', stroke: 'all' }]);
  // No lines: the block's gears, else its category's.
  assert.deepEqual(blockTiming({ category: 'threshold', stroke: 'free', gears: [] }), { gear: 'G3', timing: [{ gear: 'G3', stroke: 'free' }] });
  // 'all' only speaks for the strokes without a value of their own.
  assert.deepEqual(learnedFrom({}, { G6: { fly: 2, all: 1 } }), ['Send-offs for G6 fly now +2s per 100.', 'Send-offs for G6 in other strokes now +1s per 100.']);
});

test('sections saved before timing was kept still learn in their one gear', () => {
  const old = makeDebrief({ date: '2026-10-20', sections: [{ name: 'Old', gear: 'G3', stroke: 'free', intervals: 'too-hard' }] });
  assert.deepEqual(old.sections[0].timing, []);
  assert.deepEqual(intervalCalibration([old], '2026-10-20'), { G3: { free: 1 } });
  // Timing survives a save, and junk in it is dropped.
  const kept = makeSection({ gear: 'G5', timing: [{ gear: 'G5', stroke: 'back' }, { gear: 'x', stroke: 'free' }, { gear: 'G6', stroke: 'swim' }] });
  assert.deepEqual(kept.timing, [{ gear: 'G5', stroke: 'back' }, { gear: 'G6', stroke: 'all' }]);
});

test('an older debrief of a saved practice learns in the gears its block is timed in', () => {
  const rec = { id: 'r9', date: '2026-10-20', blocks: [{ id: 'rp', name: '35 min race pace', category: 'race', stroke: 'free', gears: ['G3', 'G4', 'G5', 'G6'], lines: raceLines, distance: 2100 }] };
  // Saved before sections kept their timing: only the block's first gear.
  const old = makeDebrief({ id: 'd9', practiceId: 'r9', date: '2026-10-20', sections: [{ index: 0, name: '35 min race pace', gear: 'G3', stroke: 'free', intervals: 'too-hard', made: 'few' }] });
  assert.deepEqual(intervalCalibration([old], '2026-10-21'), { G3: { free: 2 } });
  const [read] = withTiming([old], [rec]);
  assert.deepEqual(intervalCalibration([read], '2026-10-21'), { G5: { free: 2 }, G6: { free: 2 } });
  assert.deepEqual(moved(threshold, intervalCalibration([read], '2026-10-21')), []);
  // Without its practice (deleted), or already with timing, a debrief is read as saved.
  assert.equal(withTiming([old], [])[0], old);
  const fresh = tooHard(rec);
  assert.equal(withTiming([fresh], [rec])[0], fresh);
});

test('actual totals of v1 records (blocks without sizes) share the practice evenly', () => {
  const v1 = { id: 'v1', date: '2026-10-20', minutes: 90, distance: 4000, blocks: [{ id: 'a', name: 'Warm-up', category: 'warmup', stroke: 'choice' }, { id: 'b', name: 'Aerobic', category: 'aerobic', stroke: 'free' }] };
  const d = debriefFor(v1);
  const with_ = (i, x) => makeDebrief({ ...d, sections: d.sections.map((s, k) => (k === i ? { ...s, ...x } : s)) });
  assert.deepEqual(actualTotals(v1, with_(0, { verdict: 'good' })), { distance: 4000, minutes: 90, changed: false });
  assert.deepEqual(actualTotals(v1, with_(1, { skipped: true })), { distance: 2000, minutes: 45, changed: true });
  assert.deepEqual(actualTotals(v1, with_(0, { actualDistance: 1000 })), { distance: 3000, minutes: 68, changed: true });
  // Some blocks sized: the others share what is left.
  const mixed = { ...v1, blocks: [{ ...v1.blocks[0], distance: 1000 }, v1.blocks[1]] };
  assert.deepEqual(actualTotals(mixed, with_(0, { skipped: true })), { distance: 3000, minutes: 68, changed: true });
});
