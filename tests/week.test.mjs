import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, defaultPlan, makeBlock, makeMeet, practiceRecord, composePractice, starterBlocks } from '../src/practice.js';
import { bandOf, draftWeek, phaseTargets, recordLoad, sessionStatus, weekGaps, weekOf, weekTotals } from '../src/week.js';

const plan = defaultPlan('2026-09-07'); // made-up season: Base from Sep 7
plan.weeklyYards = 40000;
const lib = starterBlocks();

function rec(date, slot, blocks) {
  const bs = blocks.map((b) => ({ ...makeBlock(b), circuit: false }));
  const composed = composePractice({ blocks: bs, pace: 100, unit: 'y' });
  return practiceRecord({ date, slot, focus: 'aerobic', blocks: bs, rounds: 1, composed, text: '' });
}

test('gear bands follow the season plan', () => {
  assert.equal(bandOf('G1'), 'aerobic');
  assert.equal(bandOf('G2.5'), 'aerobic');
  assert.equal(bandOf('G3.5'), 'threshold');
  assert.equal(bandOf('G4.5'), 'vo2');
  assert.equal(bandOf('G6'), 'race');
  assert.deepEqual(phaseTargets({ targets: { threshold: 0.18 } }).threshold, 0.18);
  assert.equal(phaseTargets(null).aerobic, 0.75);
});

test('a session is open, written, swum or debriefed', () => {
  assert.equal(sessionStatus(null, null, '2026-10-27', '2026-10-26'), 'open');
  assert.equal(sessionStatus({}, null, '2026-10-27', '2026-10-26'), 'written');
  assert.equal(sessionStatus({}, null, '2026-10-25', '2026-10-26'), 'swum');
  assert.equal(sessionStatus({}, {}, '2026-10-25', '2026-10-26'), 'debriefed');
});

test('the week lists every session with what is written for it', () => {
  const p = { ...plan, meets: [makeMeet({ name: 'Made-up Invite', start: '2026-10-30', end: '2026-11-01' })] };
  const amTue = rec('2026-10-27', 'AM', [{ name: 'Main', category: 'threshold', distance: 2000, lines: ['20 x 100 free G3   1:10'] }]);
  const extraSun = rec('2026-11-01', 'AM', [{ name: 'Loosen', category: 'aerobic', distance: 1000 }]);
  const debriefs = [{ practiceId: amTue.id }];
  const w = weekOf({ plan: p, date: '2026-10-28', today: '2026-10-29', log: [amTue, extraSun], debriefs });
  assert.equal(w.monday, '2026-10-26');
  assert.equal(w.days.length, 7);
  const tue = w.days[1];
  assert.deepEqual(tue.sessions.map((s) => [s.slot, s.status]), [['AM', 'debriefed'], ['PM', 'open']]);
  assert.equal(w.days[3].preMeet, true); // Thursday before a Friday meet
  assert.equal(w.days[4].meet.name, 'Made-up Invite');
  assert.deepEqual(w.days[4].sessions, []);
  assert.equal(w.days[6].sessions[0].extra, true); // swim on a meet Sunday
});

test('gear yards come from block lines, scaled to the block, kick counted', () => {
  const r = rec('2026-10-27', 'AM', [
    { name: 'Set', category: 'threshold', distance: 1800, lines: ['3 rounds:', '4 x 100 free G3   1:10', '4 x 50 kick G2   1:00'] },
    { name: 'Easy', category: 'cooldown', distance: 300 },
  ]);
  const g = recordLoad(r, plan);
  assert.deepEqual(g.byGear, { G3: 1200, G2: 600, G1: 300 });
  assert.equal(g.kick, 600);
  assert.equal(g.distance, 2100);
});

test('week totals: shares by band against the phase targets, CNS by day', () => {
  const log = [
    rec('2026-10-26', 'AM', [{ name: 'Aerobic', category: 'aerobic', distance: 6000, lines: ['60 x 100 free G2   1:15'] }]),
    rec('2026-10-27', 'AM', [{ name: 'Thr', category: 'threshold', distance: 2000, lines: ['20 x 100 free G3   1:10'] }, { name: 'Fast', category: 'race', distance: 400, lines: ['8 x 50 free G5   1:00'] }]),
  ];
  const w = weekOf({ plan, date: '2026-10-26', today: '2026-10-26', log });
  const t = weekTotals(w, plan);
  assert.equal(t.distance, 8400);
  assert.equal(t.written, 2);
  assert.ok(t.planned >= 8);
  assert.equal(Math.round(t.share.aerobic * 100), 71);
  assert.equal(Math.round(t.share.threshold * 100), 24);
  assert.equal(Math.round(t.share.race * 100), 5);
  assert.equal(t.cnsByDay[0], 0);
  assert.equal(t.cnsByDay[1], 24); // 2000 G3 × 0.002 + 400 G5 × 0.05 (default rates)
  assert.ok(t.cnsMorning[2] > 5.9 && t.cnsMorning[2] < 6.1); // half-life 12 h: ¼ left a day later
  assert.equal(t.targetYards, Math.round(40000 * w.phase.volume));
  const gaps = weekGaps(t);
  assert.ok(gaps.some((g) => g.key === 'threshold' && /More threshold/.test(g.text)));
});

test('the week drafts every open session from today on, without repeats', () => {
  const w = weekOf({ plan, date: '2026-10-26', today: '2026-10-28', log: [] });
  const drafts = draftWeek({ plan, library: lib, week: w, today: '2026-10-28' });
  assert.ok(drafts.every((d) => d.date >= '2026-10-28'));
  const slots = drafts.map((d) => `${d.date} ${d.slot}`);
  assert.ok(slots.includes('2026-10-29 PM'));
  assert.ok(!slots.some((s) => s.startsWith('2026-11-01'))); // Sunday off
  // Consecutive days don't reuse the same main block when the library has alternatives.
  const main = (d) => d.suggestion.blocks.filter((b) => !['warmup', 'cooldown'].includes(b.category)).map((b) => b.id);
  const am = drafts.filter((d) => d.slot === 'AM');
  for (let i = 1; i < am.length; i++) assert.notDeepEqual(main(am[i]), main(am[i - 1]));
});

test('extra practices count in the yards but not as planned sessions written', () => {
  const log = [
    rec('2026-10-26', 'AM', [{ name: 'Aerobic', category: 'aerobic', distance: 5000 }]),
    rec('2026-10-28', 'PM', [{ name: 'Loosen', category: 'aerobic', distance: 800 }]), // no PM on Wednesdays
  ];
  const w = weekOf({ plan, date: '2026-10-26', today: '2026-10-26', log });
  const t = weekTotals(w, plan);
  assert.equal(t.written, 1);
  assert.equal(t.extras, 1);
  assert.equal(t.distance, 5800);
  assert.ok(t.written < t.planned);
});

test('drafts avoid main blocks of the day before, the same day and a practice written the day after', () => {
  const p = defaultPlan('2026-09-07');
  p.week = p.week.map((d, i) => ({ am: i < 6 ? 60 : 0, pm: i === 1 || i === 3 ? 45 : 0 }));
  p.phases = [{ ...p.phases[0], weeks: 10, am: [...Array(6).fill('aerobic'), 'rest'], pm: [null, 'aerobic', null, 'aerobic', null, null, null] }];
  const blocks = [
    makeBlock({ id: 'w', name: 'Made-up warm', category: 'warmup', minutes: 10 }),
    makeBlock({ id: 'c', name: 'Made-up cool', category: 'cooldown', minutes: 5 }),
    makeBlock({ id: 'a', name: 'Made-up A', category: 'aerobic', minutes: 25, gears: ['G2'] }),
    makeBlock({ id: 'b', name: 'Made-up B', category: 'aerobic', minutes: 25 }),
    makeBlock({ id: 'k', name: 'Made-up C', category: 'aerobic', minutes: 25 }),
    makeBlock({ id: 'd', name: 'Made-up D', category: 'aerobic', minutes: 25 }),
  ];
  for (const monday of ['2026-09-14', '2026-10-12', '2026-10-19']) {
    const fri = { ...rec(addDays(monday, 4), 'AM', [blocks[2]]), blocks: [{ id: 'a', category: 'aerobic' }] };
    const w = weekOf({ plan: p, date: monday, today: monday, log: [fri] });
    const drafts = draftWeek({ plan: p, library: blocks, week: w, today: monday, log: [fri] });
    const all = [...drafts.map((d) => [d.date, d.suggestion.blocks.filter((b) => b.category === 'aerobic').map((b) => b.id)]), [fri.date, ['a']]];
    for (const [i, [d1, ids1]] of all.entries()) {
      for (const [d2, ids2] of all.slice(i + 1)) {
        if (Math.abs(Date.parse(d1) - Date.parse(d2)) <= 86400000) assert.ok(!ids1.some((x) => ids2.includes(x)), `${d1} and ${d2} share a main block`);
      }
    }
  }
});

test('Monday morning CNS counts the weekend before', () => {
  const log = [rec('2026-10-24', 'AM', [{ name: 'Fast', category: 'race', distance: 400, lines: ['8 x 50 free G5   1:00'] }])]; // Saturday: 400 × 0.05 = 20 points
  const w = weekOf({ plan, date: '2026-10-26', today: '2026-10-26', log });
  const t = weekTotals(w, plan);
  assert.equal(t.distance, 0); // not part of this week's totals
  assert.equal(t.cnsMorning[0], 1.3); // 48 h later: 1/16 left (1.25)
  assert.equal(t.cnsMorning[1], 0.3); // 72 h: 1/64 (0.31)
});

test('week yards follow the lines, also for practices saved with a minutes estimate', () => {
  // Made-up 40 min set: 2,700y of lines.
  const lines = ['3 rounds:', '6 x 100 free G2   1:20', '4 x 50 kick G2   1:00', '2 x 50 free G4   :50'];
  const fresh = rec('2026-10-27', 'AM', [{ name: '40 min aerobic', category: 'aerobic', minutes: 40, lines }]);
  assert.equal(fresh.distance, 2700);
  assert.equal(recordLoad(fresh, plan).distance, 2700);
  // Saved before sizes came from the lines: the block said 2,400y (40 min at the planning pace).
  const old = { ...fresh, distance: 2400, blocks: [{ ...fresh.blocks[0], distance: 2400 }] };
  const g = recordLoad(old, plan);
  assert.deepEqual(g.byGear, { G2: 2400, G4: 300 });
  assert.equal(g.kick, 600);
  assert.equal(g.distance, 2700);
  const t = weekTotals(weekOf({ plan, date: '2026-10-26', today: '2026-10-26', log: [old] }), plan);
  assert.equal(t.distance, 2700);
  assert.equal(Math.round(t.kickShare * 100), 22); // 600 of 2,700
  // A v1 record (blocks without lines or sizes) keeps its own total.
  const v1 = { id: 'v1', date: '2026-10-28', slot: 'AM', minutes: 90, distance: 4000, blocks: [{ id: 'a', name: 'Warm-up', category: 'warmup' }] };
  assert.deepEqual(recordLoad(v1, plan), { byGear: {}, kick: 0, distance: 4000, cns: 0 });
});

// ------------------------------------------- one CNS count for the whole app

import { blockCns, writingContext } from '../src/setlang.js';
import { recordCns, savedRecord } from '../src/pw/load.js';
import { practiceMetrics } from '../src/pw/render.js';

const appCtx = (log = []) => ({ state: { plan, log, debriefs: [] }, learned: { weights: {}, writing: writingContext(plan) } });
// A made-up circuit: 600y of lines a round in G2, and a kick block without lines.
const circuitSet = makeBlock({ name: 'Made-up circuit set', category: 'aerobic', distance: 1800, lines: ['3 rounds:', '4 x 100 free G2', '4 x 50 kick G2'] });
const plainKick = makeBlock({ name: 'Made-up kick', category: 'kick', distance: 600 });
function circuitRecord(ctx, date, pattern) {
  const blocks = [{ ...circuitSet, circuit: true }, { ...plainKick, circuit: true }];
  const composed = composePractice({ blocks, rounds: 3, pattern, pace: plan.pace, unit: 'y' });
  const record = JSON.parse(JSON.stringify(savedRecord(ctx, { date, title: '', focus: 'aerobic', slot: 'AM', blocks, rounds: 3, pattern, composed, text: '' })));
  return { record, composed };
}

test('week CNS and gear bands count circuit rounds as Build, Today and the Week do', () => {
  const ctx = appCtx();
  const model = ctx.learned.writing.model;
  const bands = {
    build: { byGear: { G2: 800, G3: 800, G4: 800 }, aerobic: 33, threshold: 33, vo2: 33 },
    'hard-last': { byGear: { G2: 1600, G4: 800 }, aerobic: 67, threshold: 0, vo2: 33 },
  };
  for (const pattern of ['build', 'hard-last']) {
    const { record, composed } = circuitRecord(ctx, '2026-10-27', pattern);
    const w = weekOf({ plan, date: '2026-10-26', today: '2026-10-26', log: [record] });
    const t = weekTotals(w, plan, model);
    const shown = practiceMetrics(composed, ctx).cns; // Build's "CNS load"
    assert.ok(shown > 0, pattern);
    assert.equal(t.cnsByDay[1], shown, `${pattern}: the Week's own count is Build's`);
    assert.equal(recordCns(record, ctx), shown, `${pattern}: Today (recordCns)`);
    // Was: each block's lines once, all in G2, and the kick block not at all.
    assert.ok(t.cnsByDay[1] > record.blocks.reduce((s, b) => s + blockCns(b.lines, model), 0), pattern);
    assert.deepEqual(t.byGear, bands[pattern].byGear, pattern);
    for (const k of ['aerobic', 'threshold', 'vo2']) assert.equal(Math.round(t.share[k] * 100), bands[pattern][k], `${pattern} ${k}`);
    assert.equal(t.distance, 2400, 'yards as written');
  }
});

test('the weekend before counts with the same CNS', () => {
  const ctx = appCtx();
  const model = ctx.learned.writing.model;
  const { record: sat, composed } = circuitRecord(ctx, '2026-10-24', 'build');
  const w = weekOf({ plan, date: '2026-10-26', today: '2026-10-26', log: [sat] });
  const shown = practiceMetrics(composed, ctx).cns;
  const t = weekTotals(w, plan, model);
  assert.equal(t.cnsMorning[0], Math.round(shown / 16 * 10) / 10); // 48 h later, half-life 12 h
  // The same practice on Tuesday: its points that day, a quarter left a day later.
  const tue = weekTotals(weekOf({ plan, date: '2026-10-26', today: '2026-10-26', log: [{ ...sat, date: '2026-10-27' }] }), plan, model);
  assert.equal(tue.cnsByDay[1], shown);
  assert.ok(Math.abs(tue.cnsMorning[2] - shown / 4) <= 0.06, `${tue.cnsMorning[2]} vs ${shown / 4}`);
  assert.deepEqual(tue.byGear, { G2: 800, G3: 800, G4: 800 }, 'gear bands from the rounds');
});

test('a practice of blocks without set lines is not free (starter blocks)', () => {
  const ctx = appCtx();
  const blocks = ['Warm-up', 'Threshold 100s', 'Sprint 25s', 'Cool-down'].map((n) => ({ ...lib.find((b) => b.name === n), circuit: false }));
  const composed = composePractice({ blocks, pace: plan.pace, unit: 'y' });
  const record = savedRecord(ctx, { date: '2026-10-28', title: '', focus: 'threshold', slot: 'AM', blocks, rounds: 1, composed, text: '' });
  const t = weekTotals(weekOf({ plan, date: '2026-10-26', today: '2026-10-26', log: [record] }), plan, ctx.learned.writing.model);
  assert.deepEqual(t.byGear, { G1: 1800 + 500, G3: 1600, G6: 400 }); // 30 min + 8 min ≈ 500y of G1 at 1:40/100
  assert.ok(t.cnsByDay[2] > 0);
  assert.equal(t.cnsByDay[2], practiceMetrics(composed, ctx).cns);
  assert.equal(t.cnsByDay[2], recordCns(record, ctx));
});

// ------------------------------------------------- one count per practice, kept

import { makeGearModel } from '../src/gears.js';
import { cnsTimeline, slotHour } from '../src/week.js';

test('a practice\'s count is kept until the planning pace or the gear model changes', () => {
  // Made-up: a 30 min warm-up with no lines or yards, so its yards come from the pace.
  const r = { id: 'made-up', date: '2026-10-27', slot: 'AM', minutes: 30, distance: 1800, blocks: [{ id: 'w', name: 'Made-up warm-up', category: 'warmup', minutes: 30 }] };
  const p = { ...plan, pace: 100 };
  const model = makeGearModel({ cns: { G1: 0.01 } });
  const first = recordLoad(r, p, model);
  assert.deepEqual(first, { byGear: { G1: 1800 }, kick: 0, distance: 1800, cns: 18 });
  assert.equal(recordLoad(r, p, model).byGear, first.byGear, 'kept for the same record');
  assert.ok(Object.isFrozen(first.byGear));
  assert.equal(recordLoad(r, p, makeGearModel({ cns: { G1: 0.02 } })).cns, 36, 'a new gear model counts the points again');
  p.pace = 120; // the coach's planning pace changed: 30 min is fewer yards now
  assert.deepEqual(recordLoad(r, p, model).byGear, { G1: 1500 });
});

test('practices on the CNS timeline: hours from the origin day, slot hour, in time order', () => {
  assert.deepEqual([slotHour('AM'), slotHour('PM'), slotHour(undefined)], [6, 16, 6]);
  const am = rec('2026-10-28', 'AM', [{ name: 'Fast', category: 'race', distance: 400, lines: ['8 x 50 free G5   1:00'] }]);
  const pm = rec('2026-10-27', 'PM', [{ name: 'Easy', category: 'aerobic', distance: 1000 }]);
  const t = cnsTimeline([am, pm], '2026-10-26', plan, plan.gears || {});
  assert.deepEqual(t.map((x) => [x.record.id, x.at, x.points]), [[pm.id, 40, 0], [am.id, 54, 20]]);
});
