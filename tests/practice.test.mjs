import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockDistance, blockMinutes, composePractice, defaultPlan, makeBlock, planPosition, planWeeks, practiceText,
  recencyMap, shareLine, splitEven, starterBlocks, suggestPractice, mondayOf, weekdayIndex,
} from '../src/practice.js';

const plan = defaultPlan('2026-09-07'); // a Monday; Base 6, Build 7, Race 5, Taper 2 weeks
const lib = starterBlocks();
const byName = (n) => lib.find((b) => b.name === n);

test('blocks keep one measure and estimate the other from the planning pace', () => {
  const warm = makeBlock({ name: '30 min warmup', category: 'warmup', minutes: 30 });
  assert.equal(warm.distance, null);
  assert.equal(blockDistance(warm, 100), 1800); // 30 min at 1:40/100
  const socks = makeBlock({ name: '500y socks with FL', category: 'technique', stroke: 'fly', distance: 500, equipment: ['socks'] });
  assert.equal(socks.minutes, null);
  assert.equal(blockMinutes(socks, 100), 11); // 5 × 100 s × 1.3 (drill rest) ≈ 10.8 min
  const both = makeBlock({ name: 'x', minutes: 10, distance: 500 });
  assert.equal(both.distance, null);
  assert.equal(makeBlock({ name: 'y' }).minutes, 10);
});

test('season weeks are Monday-first and phases follow in order', () => {
  assert.equal(weekdayIndex('2026-10-25'), 6); // Sunday
  assert.equal(mondayOf('2026-10-28'), '2026-10-26');
  assert.equal(planWeeks(plan), 20);
  assert.equal(planPosition(plan, '2026-09-01').status, 'before');
  const base = planPosition(plan, '2026-09-10'); // Thu of week 1
  assert.equal(base.phase.name, 'Base');
  assert.equal(base.week, 0);
  assert.equal(base.focus, 'threshold');
  const build = planPosition(plan, '2026-10-27'); // Tue, season week 8 → Build week 2
  assert.equal(build.phase.name, 'Build');
  assert.equal(build.phaseWeek, 1);
  assert.equal(build.focus, 'threshold');
  const taper = planPosition(plan, '2027-01-24'); // Sunday of the last week
  assert.equal(taper.phase.name, 'Taper');
  assert.equal(taper.focus, 'rest');
  assert.equal(planPosition(plan, '2027-02-01').status, 'after');
});

test('a suggestion fits the time, opens with a warm-up and serves the day', () => {
  const s = suggestPractice({ plan, library: lib, date: '2026-10-27', minutes: 75 });
  assert.equal(s.focus, 'threshold');
  assert.equal(s.blocks[0].category, 'warmup');
  assert.equal(s.blocks.at(-1).category, 'cooldown');
  assert.ok(s.blocks.some((b) => b.category === 'threshold'));
  const total = s.blocks.reduce((n, b) => n + blockMinutes(b, plan.pace), 0);
  assert.ok(total >= 60 && total <= 90, `total ${total}`);
  assert.equal(s.rounds, 1); // threshold intervals stay separate
  // Same day, same answer; another variant differs.
  assert.deepEqual(suggestPractice({ plan, library: lib, date: '2026-10-27', minutes: 75 }).blocks.map((b) => b.id), s.blocks.map((b) => b.id));
  const alt = suggestPractice({ plan, library: lib, date: '2026-10-27', minutes: 75, variant: 1 });
  assert.notDeepEqual(alt.blocks.map((b) => b.id), s.blocks.map((b) => b.id));
});

test('aerobic days blend steady blocks into a circuit; tired days ease off', () => {
  const s = suggestPractice({ plan, library: lib, date: '2026-10-26', minutes: 90 }); // Mon, aerobic
  assert.equal(s.focus, 'aerobic');
  assert.ok(s.blocks.filter((b) => b.circuit).length >= 2);
  assert.ok(s.rounds >= 2 && s.rounds <= 4);
  assert.ok(!s.blocks.find((b) => b.category === 'warmup').circuit);
  const tired = suggestPractice({ plan, library: lib, date: '2026-10-27', minutes: 60, feeling: 'tired' });
  assert.equal(tired.plannedFocus, 'threshold');
  assert.equal(tired.focus, 'aerobic');
  assert.ok(!tired.blocks.some((b) => b.category === 'threshold'));
  const rest = suggestPractice({ plan, library: lib, date: '2026-11-01' }); // Sunday
  assert.equal(rest.focus, 'rest');
  assert.equal(rest.blocks.length, 0);
});

test('equipment and history steer the choice', () => {
  const noKit = suggestPractice({ plan, library: lib, date: '2026-10-26', minutes: 90, equipment: [] });
  assert.ok(noKit.blocks.every((b) => b.equipment.length === 0));
  const history = [{ date: '2026-10-25', blocks: [{ id: byName('Threshold 100s').id }] }];
  assert.deepEqual(recencyMap(history, '2026-10-27'), { [byName('Threshold 100s').id]: 2 });
  const fresh = suggestPractice({ plan, library: lib, date: '2026-10-27', minutes: 75 });
  const after = suggestPractice({ plan, library: lib, date: '2026-10-27', minutes: 75, history });
  const thr = (s) => s.blocks.find((b) => b.category === 'threshold')?.name;
  assert.equal(thr(fresh), 'Threshold 100s');
  assert.equal(thr(after), 'Threshold 200s');
});

test('splitEven shares a block across rounds in sensible steps', () => {
  assert.deepEqual(splitEven(500, 3, 25), [175, 175, 150]);
  assert.deepEqual(splitEven(40, 3, 1), [14, 13, 13]);
  assert.deepEqual(splitEven(500, 4, 25), [125, 125, 125, 125]);
  assert.deepEqual(splitEven(50, 4, 25), [25, 25, 25, 25]); // never less than one step a round
});

test('composing keeps separate blocks in order and blends the rest into one circuit', () => {
  const blocks = [
    { ...byName('Warm-up'), circuit: false },
    { ...byName('Aerobic IM'), circuit: true },
    { ...byName('Kick set'), circuit: false },
    { ...byName('Socks with FL'), circuit: true },
    { ...byName('Cool-down'), circuit: false },
  ];
  const c = composePractice({ blocks, rounds: 3, pace: 100, unit: 'y' });
  assert.deepEqual(c.sections.map((s) => s.type), ['block', 'circuit', 'block', 'block']);
  const circ = c.sections[1];
  assert.equal(circ.rounds, 3);
  assert.deepEqual(circ.items.map((i) => i.block.name), ['Aerobic IM', 'Socks with FL']);
  assert.deepEqual(circ.items[0].shares.map((x) => x.minutes), [14, 13, 13]);
  assert.deepEqual(circ.items[1].shares.map((x) => x.distance), [175, 175, 150]);
  assert.equal(shareLine(circ.items[1], 'y'), '175y Socks with FL (last round 150y)');
  assert.equal(shareLine(circ.items[0], 'y'), '14 min Aerobic IM (rounds: 14 min, 13 min, 13 min)');
  assert.equal(c.minutes, 30 + 40 + 11 + 19 + 8);
  assert.equal(c.distance, 1800 + 2400 + 500 + 800 + 500);

  const text = practiceText(c, { date: '2026-10-26', focus: 'aerobic', phase: 'Build', showDetail: false });
  assert.match(text, /^Monday, Oct 26 · Build · Aerobic\n/);
  assert.match(text, /3 rounds of:\n  • 14 min Aerobic IM/);
  assert.match(text, /Total ≈ 108 min · ~6,000y$/);

  // All separate: no circuit section, whatever rounds says.
  const sep = composePractice({ blocks: blocks.map((b) => ({ ...b, circuit: false })), rounds: 3, pace: 100, unit: 'y' });
  assert.ok(sep.sections.every((s) => s.type === 'block'));
});

// ------------------------------------------------------------ v2: sessions

import {
  gearTotals, makeMeet, migratePlan, nextMeet, PATTERNS, practiceRecord, roundPlan, sessionsOn, shiftGear, splitByWeights,
} from '../src/practice.js';

test('the default week is 2 hours every morning but Sunday, doubles Tuesday and Thursday', () => {
  const p = defaultPlan('2026-09-07');
  const day = (d) => sessionsOn(p, d).sessions.map((x) => `${x.slot}:${x.minutes}:${x.focus}`);
  assert.deepEqual(day('2026-09-07'), ['AM:120:aerobic']); // Mon, Base volume 1.0
  assert.deepEqual(day('2026-09-08'), ['AM:120:technique', 'PM:60:aerobic']); // Tue double
  assert.deepEqual(day('2026-09-10'), ['AM:120:threshold', 'PM:60:aerobic']); // Thu double
  assert.deepEqual(day('2026-09-13'), []); // Sunday
  assert.deepEqual(day('2026-10-27'), ['AM:132:threshold', 'PM:66:aerobic']); // Build volume 1.1
});

test('meet days have no practice; the day before sharpens', () => {
  const p = defaultPlan('2026-09-07');
  p.meets = [makeMeet({ name: 'Fall Invite', start: '2026-11-13', end: '2026-11-15' })];
  const fri = sessionsOn(p, '2026-11-13');
  assert.equal(fri.meet.name, 'Fall Invite');
  assert.deepEqual(fri.sessions, []);
  const thu = sessionsOn(p, '2026-11-12');
  assert.equal(thu.preMeet, true);
  assert.deepEqual(thu.sessions.map((x) => [x.slot, x.focus, x.minutes]), [['AM', 'speed', 79]]);
  assert.match(thu.sessions[0].note, /Fall Invite/);
  assert.equal(nextMeet(p, '2026-11-01').name, 'Fall Invite');
  const s = suggestPractice({ plan: p, library: lib, date: '2026-11-14' });
  assert.equal(s.focus, 'rest');
  assert.match(s.notes[0], /Meet day/);
  p.preMeet = false;
  assert.equal(sessionsOn(p, '2026-11-12').sessions.length, 2);
});

test('PM suggestions use the PM focus and skip AM-only blocks', () => {
  const p = defaultPlan('2026-09-07');
  const library = [...lib, makeBlock({ name: 'AM only aerobic', category: 'aerobic', minutes: 20, session: 'AM' })];
  const s = suggestPractice({ plan: p, library, date: '2026-09-08', slot: 'PM' });
  assert.equal(s.slot, 'PM');
  assert.equal(s.focus, 'aerobic');
  assert.equal(s.minutes, 60);
  assert.ok(!s.blocks.some((b) => b.name === 'AM only aerobic'));
  const none = suggestPractice({ plan: p, library, date: '2026-09-07', slot: 'PM' }); // Monday: no double
  assert.equal(none.focus, 'rest');
});

test('learned weights steer the main set', () => {
  const p = defaultPlan('2026-09-07');
  const base = suggestPractice({ plan: p, library: lib, date: '2026-10-27', minutes: 75 });
  const top = base.blocks.find((b) => b.category === 'threshold');
  const after = suggestPractice({ plan: p, library: lib, date: '2026-10-27', minutes: 75, weights: { [top.id]: 0.3 } });
  assert.notEqual(after.blocks.find((b) => b.category === 'threshold')?.id, top.id);
});

test('v1 plans migrate: days become AM, session length becomes the week', () => {
  const v1 = { name: 'Old', start: '2026-09-09', unit: 'y', pace: 95, sessionMinutes: 90, phases: [{ name: 'Base', weeks: 4, volume: 1, days: ['aerobic', 'threshold', 'aerobic', 'race', 'aerobic', 'speed', 'rest'] }] };
  const p = migratePlan(v1);
  assert.equal(p.start, '2026-09-07');
  assert.deepEqual(p.phases[0].am, v1.phases[0].days);
  assert.deepEqual(p.phases[0].pm, [null, null, null, null, null, null, null]);
  assert.deepEqual(p.week.map((d) => d.am), [90, 90, 90, 90, 90, 90, 0]);
  assert.equal(p.pace, 95);
  assert.equal(p.sessionMinutes, undefined);
  assert.deepEqual(p.meets, []);
});

test('splitByWeights is exact and never leaves a round empty', () => {
  assert.deepEqual(splitByWeights(600, [3, 2, 1], 25), [300, 200, 100]);
  assert.deepEqual(splitByWeights(500, [3, 2, 1], 25), [250, 175, 75]);
  assert.deepEqual(splitByWeights(100, [3, 2, 1], 25), [50, 25, 25]);
  assert.deepEqual(splitByWeights(40, [1, 2, 3, 4], 1), [4, 8, 12, 16]);
  for (const [t, w] of [[725, [5, 4, 3, 2, 1]], [50, [1, 1, 1]], [1000, [1, 3]]]) {
    const parts = splitByWeights(t, w, 25);
    assert.ok(parts.every((x) => x >= 25 && x % 25 === 0), String(parts));
  }
});

test('round patterns: descending, building gears, hard last round', () => {
  assert.deepEqual(roundPlan('descend', 3).map((r) => r.weight), [3, 2, 1]);
  assert.deepEqual(roundPlan('build', 3).map((r) => r.gearShift), [0, 1, 2]);
  assert.deepEqual(roundPlan('hard-last', 3).map((r) => r.gearShift), [0, 0, 2]);
  assert.equal(shiftGear('G2', 2), 'G4');
  assert.equal(shiftGear('G5', 3), 'G6');
  assert.ok(PATTERNS['hard-last']);

  const kick = makeBlock({ name: 'Kick', category: 'kick', distance: 600, gears: ['G2'] });
  const socks = makeBlock({ name: 'Socks with FL', category: 'technique', stroke: 'fly', distance: 500, equipment: ['socks'] });
  const blocks = [{ ...kick, circuit: true }, { ...socks, circuit: true }];
  const desc = composePractice({ blocks, rounds: 3, pattern: 'descend', pace: 100, unit: 'y' });
  const [k, f] = desc.sections[0].items;
  assert.deepEqual(k.shares.map((x) => x.distance), [300, 200, 100]);
  assert.equal(shareLine(k, 'y'), '300 / 200 / 100y Kick');
  assert.deepEqual(f.shares.map((x) => x.distance), [250, 175, 75]);
  assert.equal(desc.distance, 1100);

  const build = composePractice({ blocks, rounds: 3, pattern: 'build', pace: 100, unit: 'y' });
  assert.equal(shareLine(build.sections[0].items[0], 'y'), '200y Kick (G2 → G3 → G4 by round)');
  const hard = composePractice({ blocks, rounds: 3, pattern: 'hard-last', pace: 100, unit: 'y' });
  assert.equal(shareLine(hard.sections[0].items[0], 'y'), '200y Kick (last round G4 fast)');
  const text = practiceText(hard, { showDetail: false, renderLines: (b, share) => (b.name === 'Kick' ? [`4 x 50 kick ${shiftGear('G2', share?.gearShift || 0)}`] : []) });
  assert.match(text, /3 rounds of: \(hard last round\)/);
  assert.match(text, /\n      4 x 50 kick G2\n/);
});

test('practice records keep sizes per block for debriefs and gear totals', () => {
  const kick = makeBlock({ name: 'Kick', category: 'kick', distance: 600, gears: ['G2'] });
  const thr = makeBlock({ name: '100s', category: 'threshold', distance: 1600, gears: ['G3'], lines: ['16 x 100 FR G3'], source: 'generated' });
  const blocks = [{ ...kick, circuit: false }, { ...thr, circuit: false }];
  const composed = composePractice({ blocks, pace: 100, unit: 'y' });
  const rec = practiceRecord({ date: '2026-10-27', slot: 'PM', focus: 'threshold', blocks, rounds: 1, composed, text: 'x' });
  assert.equal(rec.slot, 'PM');
  assert.deepEqual(rec.blocks.map((b) => [b.name, b.distance, b.gears[0]]), [['Kick', 600, 'G2'], ['100s', 1600, 'G3']]);
  assert.deepEqual(rec.blocks[1].lines, ['16 x 100 FR G3']);
  assert.equal(rec.blocks[1].source, 'generated', 'app-written lines stay marked (not learned as the coach\'s style)');
  assert.deepEqual(gearTotals([rec], '2026-10-28', 7), { G2: 600, G3: 1600 });
});

test('descending and ascending rounds never go back the other way', () => {
  const blocks = [makeBlock({ name: 'Socks with FL', category: 'technique', distance: 300 }), makeBlock({ name: 'Kick', category: 'kick', minutes: 12 })].map((b) => ({ ...b, circuit: true }));
  const down = composePractice({ blocks, rounds: 5, pattern: 'descend', pace: 100, unit: 'y' }).sections[0].items;
  assert.deepEqual(down[0].shares.map((s) => s.distance), [100, 75, 50, 50, 25]);
  assert.deepEqual(down[1].shares.map((s) => s.minutes), [4, 3, 2, 2, 1]);
  const up = composePractice({ blocks, rounds: 5, pattern: 'ascend', pace: 100, unit: 'y' }).sections[0].items;
  assert.deepEqual(up[0].shares.map((s) => s.distance), [25, 50, 50, 75, 100]);
  assert.deepEqual(up[1].shares.map((s) => s.minutes), [1, 2, 2, 3, 4]);
  for (let n = 2; n <= 8; n++) {
    for (const [pattern, dir] of [['descend', -1], ['ascend', 1]]) {
      const w = roundPlan(pattern, n).map((r) => r.weight);
      for (const [t, step] of [...Array.from({ length: 120 }, (_, i) => [i + 1, 1]), ...Array.from({ length: 80 }, (_, i) => [(i + 1) * 25, 25])]) {
        if (t < n * step) continue;
        const parts = splitByWeights(t, w, step);
        assert.equal(parts.reduce((a, b) => a + b, 0), t, `${pattern} ${n} × ${t}`);
        assert.ok(parts.every((x, i) => i === 0 || dir * (x - parts[i - 1]) >= 0), `${pattern} ${n} rounds of ${t}: ${parts}`);
      }
    }
  }
});

test('a block with set lines counts the yards in its lines', () => {
  // Made-up 35 min set with 1,500y of lines; the minutes estimate would say 1,900y.
  const timed = makeBlock({ name: '35 min threshold', category: 'threshold', stroke: 'free', minutes: 35, lines: ['3 rounds:', '4 x 100 free G3   1:20 | 1:25', '100 easy'] });
  assert.equal(timed.distance, null);
  assert.equal(blockDistance(timed, 100), 1500);
  assert.equal(blockMinutes(timed, 100), 35); // the coach's minutes stay
  const blocks = [{ ...timed, circuit: false }];
  const c = composePractice({ blocks, pace: 100, unit: 'y' });
  assert.equal(c.distance, 1500);
  const rec = practiceRecord({ date: '2026-10-27', focus: 'threshold', blocks, rounds: 1, composed: c, text: '' });
  assert.deepEqual([rec.distance, rec.blocks[0].distance], [1500, 1500]);
  assert.match(practiceText(c, { showDetail: false }), /Total ≈ 35 min · ~1,500y$/);

  // A measured block: its lines' yards over a stale distance, its minutes from
  // the fastest group's send-offs (4 × 2:40 + :30 = 11:10).
  const pull = makeBlock({ name: 'Pull', category: 'pull', distance: 1000, lines: ['4 x 200 pull   2:40 | 2:50', ':30 REST'] });
  assert.equal(blockDistance(pull, 100), 800);
  assert.equal(blockMinutes(pull, 100), 11);
  // In a circuit the rounds share the lines' yards and scale the lines to match.
  const circ = composePractice({ blocks: [{ ...pull, circuit: true }, { ...makeBlock({ name: 'Kick', category: 'kick', distance: 400 }), circuit: true }], rounds: 2, pace: 100, unit: 'y' });
  const it = circ.sections[0].items[0];
  assert.deepEqual(it.shares.map((s) => [s.distance, s.scale]), [[400, 0.5], [400, 0.5]]);
  assert.equal(circ.distance, 1200);
  // Lines with no swim yards (a note) fall back to the estimate.
  assert.equal(blockDistance(makeBlock({ category: 'aerobic', minutes: 30, lines: ['Choice of drills'] }), 100), 1800);
});

// ------------------------------------------------- gear yards of a practice

import { composedGearYards, recordComposed, shareScale } from '../src/practice.js';

test('composedGearYards counts every circuit round with its gear shift and its share of the lines', () => {
  // A made-up set whose lines cover all three rounds: 600y a round.
  const set = makeBlock({ name: 'Made-up circuit set', category: 'aerobic', distance: 1800, lines: ['3 rounds:', '4 x 100 free G2', '4 x 50 kick G2'] });
  const blocks = [{ ...set, circuit: true }];
  const yards = (pattern) => composedGearYards(composePractice({ blocks, rounds: 3, pattern, pace: 100, unit: 'y' }));
  assert.deepEqual(yards('even'), { G2: 1800 });
  assert.deepEqual(yards('build'), { G2: 600, G3: 600, G4: 600 });
  assert.deepEqual(yards('hard-last'), { G2: 1200, G4: 600 });
  // Separate blocks count their lines as written.
  assert.deepEqual(composedGearYards(composePractice({ blocks: [{ ...set, circuit: false }], pace: 100, unit: 'y' })), { G2: 1800 });
});

test('a block without set lines counts its distance in its first gear, a circuit round its share', () => {
  const warm = makeBlock({ name: 'Made-up warm-up', category: 'warmup', minutes: 20 });
  const sprints = makeBlock({ name: 'Made-up sprints', category: 'speed', distance: 400 });
  const plain = composePractice({ blocks: [{ ...warm, circuit: false }, { ...sprints, circuit: false }], pace: 100, unit: 'y' });
  // 20 min at 1:40/100 = 1,200y in the warm-up's G1; the sprints in G6.
  assert.deepEqual(composedGearYards(plain), { G1: 1200, G6: 400 });
  // Lines with no swim yards count like no lines.
  const noted = makeBlock({ name: 'Made-up drills', category: 'technique', distance: 300, gears: ['G2'], lines: ['Choice of drills'] });
  assert.deepEqual(composedGearYards(composePractice({ blocks: [{ ...noted, circuit: false }], pace: 100, unit: 'y' })), { G2: 300 });
  // A circuit round counts its share, a gear up each round when the rounds build.
  const kick = makeBlock({ name: 'Made-up kick', category: 'kick', distance: 600, gears: ['G3'] });
  const build = composePractice({ blocks: [{ ...kick, circuit: true }], rounds: 3, pattern: 'build', pace: 100, unit: 'y' });
  assert.deepEqual(composedGearYards(build), { G3: 200, G4: 200, G5: 200 });
  const timed = makeBlock({ name: 'Made-up drill', category: 'technique', minutes: 12 }); // 12 min ≈ 550y at 1:40 × 1.3
  const even = composePractice({ blocks: [{ ...timed, circuit: true }, { ...kick, circuit: true }], rounds: 2, pace: 100, unit: 'y' });
  assert.deepEqual(composedGearYards(even), { G1: blockDistance(timed, 100), G3: 600 });
  // A block saved without any size (a v1 record) adds nothing, not NaN.
  assert.deepEqual(composedGearYards(recordComposed({ blocks: [{ id: 'a', name: 'Warm-up', category: 'warmup' }] })), {});
});

test('a saved practice composes again as it was built, rounds and pattern included', () => {
  const kick = makeBlock({ name: 'Made-up kick', category: 'kick', distance: 600, lines: ['12 x 50 kick G2'] });
  const drill = makeBlock({ name: 'Made-up drill', category: 'technique', minutes: 12 });
  const blocks = [{ ...kick, circuit: true }, { ...drill, circuit: true }];
  const composed = composePractice({ blocks, rounds: 3, pattern: 'hard-last', pace: 100, unit: 'y' });
  const rec = JSON.parse(JSON.stringify(practiceRecord({ date: '2026-10-27', focus: 'aerobic', blocks, rounds: 3, pattern: 'hard-last', composed, text: '' })));
  rec.blocks[0].measure = 'distance';
  rec.blocks[1].measure = 'time';
  const again = recordComposed(rec, { pace: 100 });
  assert.equal(again.distance, composed.distance);
  assert.deepEqual(composedGearYards(again), composedGearYards(composed));
  assert.deepEqual(composedGearYards(again), { G2: 400, G4: 200, G1: 2 * Math.round(blockDistance(drill, 100) / 3), G3: Math.round(blockDistance(drill, 100) / 3) });
  assert.equal(shareScale(null), 1);
  assert.equal(shareScale({ scale: 0.995 }), 1);
  assert.equal(shareScale({ scale: 0.5 }), 0.5);
});
