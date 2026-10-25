// The coach's set notation: parse, time per group, write back, adjust for
// slower groups, generate blocks, learn the coach's style. Every set and
// number in this file is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtClock, gearPaces, imPaces, makeGearModel, paceOf, roundSendOff, sendOff, testForGearPace } from '../src/gears.js';
import {
  blockCns, blockSecondsByGroup, describe, formatColumns, gearYards, generateBlock, groupAdjustments, intervalFor, intervalsForLine,
  adjustmentPlan, learnStyle, lineGear, parseLine, parseSet, quickBlock, referenceRows, retime, scaleReps, setDistance, setGears, setSeconds,
  shiftLineGears, styleKey, writeLines, writeSwim, writingContext,
} from '../src/setlang.js';

// Four made-up groups, fastest first, defined by a G3 pace per 100 plus a
// 400 IM time, and a made-up fatigue factor.
const PLAN = {
  gears: { fatigue: 1.07 },
  groups: [
    { id: 'a', name: 'Lane 1', key: '1:02', g3: 62, im400: 255 },
    { id: 'b', name: 'Lane 2', key: '1:05', g3: 65, im400: 265 },
    { id: 'c', name: 'Lane 3', key: '1:08', g3: 68, im400: 275 },
    { id: 'd', name: 'Lane 4', key: '1:11', g3: 71, im400: 285 },
  ],
};
const CTX = writingContext(PLAN);
const swimsOf = (lines) => lines.map(parseLine).filter((l) => l.type === 'swim');
const strip = (lines) => lines.map((raw) => { const l = parseLine(raw); return l.type === 'swim' ? writeSwim(l, []) : raw; });
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} ${actual} vs ${expected} (±${tol})`);

// ------------------------------------------------------------------ parse

test('reps x distance with an interval column per group', () => {
  const l = parseLine('6 x 50 free  :44 | :47 | :50 | :53');
  assert.equal(l.type, 'swim');
  assert.equal(l.reps, 6);
  assert.equal(l.distance, 50);
  assert.equal(l.desc, 'free');
  assert.equal(l.stroke, 'free');
  assert.equal(l.kind, 'swim');
  assert.deepEqual(l.intervals, [44, 47, 50, 53]);
  assert.deepEqual(parseLine('4 x 100 free 1:10|1:14|1:18').intervals, [70, 74, 78], 'pipes without spaces');
  assert.deepEqual(parseLine('4x100 BK G3   1:15 | 1:20').intervals, [75, 80], '4x100 without spaces');
  assert.equal(parseLine('4x100 BK G3').reps, 4);
});

test('single swims, with and without a send-off', () => {
  const easy = parseLine('500 easy, any stroke    7:00');
  assert.equal(easy.type, 'swim');
  assert.equal(easy.reps, 1);
  assert.equal(easy.distance, 500);
  assert.equal(easy.easy, true);
  assert.deepEqual(easy.intervals, [420]);
  const bare = parseLine('200 free');
  assert.equal(bare.reps, 1);
  assert.deepEqual(bare.intervals, []);
  assert.equal(parseLine('1650 free G3.5   20:00').intervals[0], 1200, 'a 20:00 send-off');
  assert.equal(parseLine('8 x 12.5 fast   :20').distance, 12.5);
});

test('one shared interval, written plain or with @', () => {
  assert.deepEqual(parseLine('8 x 100 free G2   1:20').intervals, [80]);
  for (const raw of ['4 x 100 IM @ 1:20', '4 x 100 IM @1:20', '4 x 100 IM@1:20']) {
    const l = parseLine(raw);
    assert.equal(l.type, 'swim', raw);
    assert.deepEqual(l.intervals, [80], `${raw}: the send-off is read`);
    assert.equal(l.at, true, raw);
    assert.equal(l.desc, 'IM', `${raw}: the @ is not part of the description`);
    assert.equal(l.stroke, 'IM');
  }
  assert.deepEqual(parseLine('8 x 25 fly fast @ :30').intervals, [30]);
});

test('reference rows: a G3 pace row, a 400 IM row, a goal row', () => {
  const g3 = parseLine('G3 pace 1:02 | 1:05 | 1:08 | 1:11');
  assert.equal(g3.type, 'ref');
  assert.equal(g3.label, 'G3 pace');
  assert.deepEqual(g3.values, [62, 65, 68, 71]);
  assert.deepEqual(parseLine('G3 pace       1:02 | 1:05 | 1:08 | 1:11').values, [62, 65, 68, 71]);
  const im = parseLine('400 IM group 4:15 | 4:25 | 4:35 | 4:45');
  assert.equal(im.type, 'ref');
  assert.equal(im.label, '400 IM group');
  assert.deepEqual(im.values, [255, 265, 275, 285]);
  const goal = parseLine('1000 goal 11:40 | 12:05');
  assert.equal(goal.type, 'ref');
  assert.deepEqual(goal.values, [700, 725]);
});

test('rest lines, rounds headers and block headings', () => {
  assert.deepEqual(parseLine(':20 REST'), { type: 'rest', raw: ':20 REST', seconds: 20, note: '' });
  assert.equal(parseLine('1:00 rest').seconds, 60);
  assert.equal(parseLine(':30 REST then go').note, 'then go');
  for (const [raw, n] of [['3 rounds:', 3], ['3 rounds', 3], ['1 round:', 1], ['4 x', 4], ['4 x:', 4], ['2 Rounds:', 2]]) {
    assert.deepEqual(parseLine(raw), { type: 'rounds', raw, rounds: n }, raw);
  }
  assert.deepEqual(parseLine('36 min FL/free switch'), { type: 'heading', raw: '36 min FL/free switch', minutes: 36, title: 'FL/free switch' });
  assert.equal(parseLine('35 minutes kick').minutes, 35);
  assert.equal(parseLine('35 minutes kick').title, 'kick');
  assert.equal(parseLine('10 min x 3').type, 'text', 'not a heading');
});

test('odds / evens', () => {
  const l = parseLine('8 x 100 free   odds - G2   evens - G4    1:25 | 1:30');
  assert.equal(l.type, 'swim');
  assert.deepEqual(l.oddsEvens, { odds: 'G2', evens: 'G4' });
  assert.deepEqual(l.gears, ['G2', 'G4']);
  assert.deepEqual(l.intervals, [85, 90]);
  assert.equal(lineGear(l), 'G4', 'the harder of the two sets the send-off');
  assert.equal(parseLine('odds: fly').type, 'note');
  assert.equal(parseLine('evens: back').type, 'note');
});

test('gear arrows → and -> read the same', () => {
  const a = parseLine('6 x 50 FL, G2 → G5 by 25      :53 | :56 | :59 | 1:02');
  const b = parseLine('6 x 50 FL, G2 -> G5 by 25      :53 | :56 | :59 | 1:02');
  for (const l of [a, b]) {
    assert.equal(l.gearFrom, 'G2');
    assert.equal(l.gearTo, 'G5');
    assert.equal(l.gearBy, 25);
    assert.equal(l.stroke, 'fly');
    assert.deepEqual(l.intervals, [53, 56, 59, 62]);
  }
  assert.equal(b.desc, a.desc, '-> is written as →');
  assert.equal(lineGear(a), 'G4', 'mostly swum in the middle of the build');
  const toPace = parseLine('3 x 100 free, G3 → 500 pace');
  assert.equal(toPace.gearFrom, 'G3');
  assert.equal(toPace.gearTo, '500 pace');
  const noBy = parseLine('5 x 200 back D1-5, G2 → G4');
  assert.equal(noBy.gearBy, null);
  assert.equal(noBy.stroke, 'back');
});

test('brackets, pull / kick / drill and equipment', () => {
  const br = parseLine('6 x 50 kick [25 easy / 25 sprint]   1:05');
  assert.equal(br.type, 'swim');
  assert.equal(br.reps, 6);
  assert.equal(br.distance, 50);
  assert.equal(br.kind, 'kick');
  assert.ok(br.gears.includes('G6'), 'the fast part is G6');
  assert.equal(br.desc, 'kick [25 easy / 25 sprint]');

  const pull = parseLine('5 x 100 pull w/ buoy, no kick, G2   1:25 | 1:30');
  assert.equal(pull.kind, 'pull', 'pull, not kick');
  assert.deepEqual(pull.equipment, ['buoy']);
  assert.equal(parseLine('4 x 50 no kick swim').kind, 'swim');
  assert.equal(parseLine('4 x 50 kick, board').kind, 'kick');
  assert.deepEqual(parseLine('4 x 50 kick, board').equipment, ['board']);
  assert.equal(parseLine('12 x 50 drill   1:00').kind, 'drill');
  assert.equal(parseLine('4 x 50 drill/swim   :55').kind, 'swim');
  assert.deepEqual(parseLine('4 x 50 fly G5 with fins and paddles   :50').equipment, ['fins', 'paddles']);
  assert.deepEqual(parseLine('8 x 50 snorkel, socks').equipment, ['snorkel', 'socks']);
});

test('"[25 easy / 25 sprint]" is half fast, half easy: timed in the middle gear, yards split', () => {
  const mix = parseLine('4 x 50 kick [25 easy / 25 sprint]');
  assert.deepEqual(mix.gears, ['G6', 'G1']);
  assert.equal(lineGear(mix), 'G4', 'not a full G6 rep with G6 rest');
  assert.deepEqual(gearYards(parseSet('4 x 50 kick [25 easy / 25 sprint]')), { G6: 100, G1: 100 });
  const iv = intervalsForLine(mix, CTX);
  assert.ok(iv[0] > 40 && iv[0] < 60 && iv.at(-1) < 70, `50 kick send-offs ${iv.map(fmtClock).join(' | ')}`);
  // A plain fast rep stays G6.
  assert.deepEqual(parseLine('4 x 25 kick sprint, G6').gears, ['G6']);
  assert.deepEqual(parseLine('8 x 25 fast').gears, ['G6']);
  assert.equal(lineGear(parseLine('8 x 25 fast')), 'G6');
});

test('strokes, paces and easy / fast words', () => {
  const words = [['BK', 'back'], ['back', 'back'], ['BR', 'breast'], ['FL', 'fly'], ['fly', 'fly'], ['IM', 'IM'], ['FR', 'free'], ['free', 'free'], ['choice', 'choice'], ['', 'choice']];
  for (const [w, s] of words) assert.equal(describe(`${w} G3`).stroke, s, w);
  assert.equal(describe('free at 500 pace').pace, '500 pace');
  assert.equal(describe('free hold 1000 pace').pace, '1000 pace');
  assert.equal(describe('race pace').pace, 'race pace');
  assert.deepEqual(describe('fast').gears, ['G6']);
  assert.deepEqual(describe('free G4, fast finish').gears, ['G4'], 'a written gear wins over "fast"');
  assert.equal(describe('easy, any stroke').easy, true);
  assert.equal(describe('G2 easy').easy, undefined, 'a written gear is not easy');
});

test('group adjustments, notes, blanks and free text', () => {
  assert.deepEqual(parseLine('1:05 - 4 x 150 (start on #2)'), { type: 'adjust', raw: '1:05 - 4 x 150 (start on #2)', key: '1:05', text: '4 x 150 (start on #2)' });
  const third = parseLine('3rd interval - skip the G2 75 in RD2');
  assert.equal(third.type, 'adjust');
  assert.equal(third.key, '3rd interval');
  assert.equal(parseLine('4:35 – 4 x 50 FL in RD2 + RD3').key, '4:35', 'en dash');
  assert.equal(parseLine('#2 G2.5, breathe every 5th').type, 'note');
  assert.equal(parseLine('G3 = threshold').type, 'note');
  assert.equal(parseLine('broken 200 at 200 pace').type, 'note');
  assert.equal(parseLine('   ').type, 'blank');
  assert.equal(parseLine('').type, 'blank');
  assert.equal(parseLine(null).type, 'blank');
  assert.equal(parseLine('Focus on turns').type, 'text');
  assert.equal(parseLine('4 x 50 BK\tG3').type, 'swim', 'tabs are spaces');
});

test('parse → write → parse keeps every swim line', () => {
  const lines = [
    '6 x 50 free  :44 | :47 | :50 | :53',
    '500 easy, any stroke    7:00',
    '200 free',
    '4 x 100 IM @ 1:20',
    '8 x 100 free   odds - G2   evens - G4    1:25 | 1:30',
    '6 x 50 FL, G2 -> G5 by 25      :53 | :56 | :59 | 1:02',
    '6 x 50 kick [25 easy / 25 sprint]   1:05',
    '5 x 100 pull w/ buoy, no kick, G2   1:25 | 1:30',
    '5 x 200 back D1-5, G2 → G4   2:50 | 3:00 | 3:05 | 3:15',
    '8 x 12.5 fast :20',
    '3 x 300 free G3.5   3:25 | 3:40 | 3:50 | 4:05',
  ];
  for (const raw of lines) {
    const a = parseLine(raw);
    const written = writeSwim(a);
    const b = parseLine(written);
    for (const k of ['type', 'reps', 'distance', 'stroke', 'kind', 'gearFrom', 'gearTo', 'gearBy', 'pace', 'easy']) assert.deepEqual(b[k], a[k], `${raw}: ${k}`);
    assert.deepEqual(b.gears, a.gears, `${raw}: gears`);
    assert.deepEqual(b.oddsEvens, a.oddsEvens, `${raw}: odds/evens`);
    assert.deepEqual(b.equipment, a.equipment, `${raw}: equipment`);
    const same = a.intervals.every((v) => v === a.intervals[0]);
    assert.deepEqual(b.intervals, same ? a.intervals.slice(0, 1) : a.intervals, `${raw}: intervals`);
    assert.equal(writeSwim(b), written, `${raw}: writing is stable`);
  }
});

test('formatColumns right-aligns the columns; writeSwim writes one value when all agree', () => {
  assert.equal(formatColumns([44, 47, 85]), ':44 |  :47 | 1:25');
  assert.equal(formatColumns([70, 74]), '1:10 | 1:14');
  assert.equal(writeSwim(parseLine('6 x 50 free'), [44, 44, 44]), '6 x 50 free    :44');
  assert.equal(writeSwim(parseLine('200 free G2'), [150, 155]), '200 free G2    2:30 | 2:35');
  assert.equal(writeSwim(parseLine('200 free G2'), []), '200 free G2');
  assert.equal(writeSwim({ reps: 1, distance: 100, desc: '' }, [90]), '100    1:30');
});

// ------------------------------------------------------------- structure

const SET = [
  '30 min free gears',
  'G3 pace 1:02 | 1:05 | 1:08 | 1:11',
  '4 x 100 free, G2 → G3 by 50    1:17 | 1:21 | 1:25 | 1:29',
  ':20 REST',
  '3 rounds:',
  '6 x 50 FL, G2 -> G5 by 25   :53 | :56 | :59 | 1:02',
  '2 x 25 BK sprint, G6    :35',
  '150 easy, any stroke    3:00',
  ':15 REST',
  '',
  '1:05 - 3 x 100 (start on #2)',
].join('\n');

test('parseSet finds the heading and groups the rounds', () => {
  const p = parseSet(SET);
  assert.equal(p.heading.minutes, 30);
  assert.equal(p.heading.title, 'free gears');
  assert.deepEqual(p.structure.map((x) => x.type), ['heading', 'ref', 'swim', 'rest', 'rounds', 'adjust']);
  const r = p.structure[4];
  assert.equal(r.rounds, 3);
  assert.deepEqual(r.items.map((x) => x.type), ['swim', 'swim', 'swim', 'rest']);
  // A "4 x" header works like "4 rounds:"; a group adjustment ends the rounds.
  const q = parseSet('4 x\n2 x 50 free G3   :50\n1:05 - 1 x 50\n150 easy   3:00');
  assert.equal(q.structure[0].rounds, 4);
  assert.equal(q.structure[0].items.length, 1);
  assert.deepEqual(q.structure.slice(1).map((x) => x.type), ['adjust', 'swim']);
  assert.equal(parseSet('').heading, null);
});

test('setSeconds times the set per group column, rounds and rests counted', () => {
  const p = parseSet(SET);
  // pre 4 × send-off + :20 + 3 × (6 × 50 + 2 × :35 + 3:00 + :15)
  assert.equal(setSeconds(p, 0), 4 * 77 + 20 + 3 * (6 * 53 + 70 + 180 + 15));
  assert.equal(setSeconds(p, 1), 4 * 81 + 20 + 3 * (6 * 56 + 70 + 180 + 15));
  assert.equal(setSeconds(p, 2), 4 * 85 + 20 + 3 * (6 * 59 + 70 + 180 + 15));
  assert.equal(setSeconds(p, 3), 4 * 89 + 20 + 3 * (6 * 62 + 70 + 180 + 15));
  assert.equal(setSeconds(p, 6), setSeconds(p, 3), 'more groups than columns → the last column');
  assert.equal(setSeconds(p), setSeconds(p, 0));
  // Lines without send-offs count 0 unless a fallback times them.
  const bare = parseSet('4 x 100 free G2\n200 easy');
  assert.equal(setSeconds(bare, 0), 0);
  assert.equal(setSeconds(bare, 0, () => 90), 4 * 90 + 90);
  assert.equal(intervalFor(parseLine('4 x 50 free :50 | :55'), 3), 55);
  assert.equal(intervalFor(parseLine('4 x 50 free'), 0), null);
});

test('setDistance counts rounds; setGears expands progressions in order', () => {
  const p = parseSet(SET);
  assert.equal(setDistance(p), 400 + 3 * (300 + 50 + 150));
  assert.equal(setDistance(parseSet('4 x\n2 x 50 free\n8 x 12.5 fast')), 4 * (100 + 100));
  assert.equal(setDistance(parseSet('4 x\n2 x 50 free\n\n8 x 12.5 fast')), 4 * 100 + 100, 'a blank line ends the rounds');
  assert.equal(setDistance(parseSet('Focus on turns')), 0);
  assert.deepEqual(setGears(p), ['G2', 'G3', 'G4', 'G5', 'G6']);
  assert.deepEqual(setGears(parseSet('4 x 100 free G4\n4 x 50 G2')), ['G4', 'G2']);
});

test('half-gear and descending progressions name only the gears swum', () => {
  assert.deepEqual(setGears(parseSet('4 x 100 free, G2.5 → G4')), ['G2.5', 'G3', 'G4']);
  assert.deepEqual(setGears(parseSet('4 x 100 free, G3.5 → G5')), ['G3.5', 'G4', 'G5']);
  assert.deepEqual(setGears(parseSet('4 x 100 free, G5 → G3')), ['G5', 'G4', 'G3']);
});

// ------------------------------------------------------------------- load

test('gearYards splits progressions, maps paces and counts rounds', () => {
  const y = gearYards(parseSet(SET));
  // pre 400 over G2, G3; the FL build 3 × 300 over G2 … G5; 3 × 50 G6; 3 × 150 easy
  assert.deepEqual(y, { G2: 200 + 225, G3: 200 + 225, G4: 225, G5: 225, G6: 150, G1: 450 });
  assert.deepEqual(gearYards(parseSet('4 x 100 free at 500 pace')), { G5: 400 });
  assert.deepEqual(gearYards(parseSet('2 x 100 hold 1000 pace')), { G4: 200 });
  assert.deepEqual(gearYards(parseSet('4 x 50 at 200 pace')), { G6: 200 });
  assert.deepEqual(gearYards(parseSet('4 x 100 at 1650 pace')), { 'G3.5': 400 });
  assert.deepEqual(gearYards(parseSet('300 easy\n200 free')), { G1: 300, G2: 200 });
  assert.deepEqual(gearYards(parseSet('6 x 100 odds - G3 evens - G5')), { G3: 300, G5: 300 });
});

test('every yard of a set lands in some gear', () => {
  const sets = [
    SET,
    '4 x 100 free, G2.5 → G4',
    '4 x 100 free, G3.5 → G5\n200 easy',
    '4 x 100 free, G5 → G3',
    '3 rounds:\n4 x 50 BK, G4 → G2 by 50\n100 easy',
    '8 x 50 kick [25 easy / 25 sprint]\n5 x 100 pull w/ buoy, no kick',
  ];
  for (const text of sets) {
    const p = parseSet(text);
    const total = Object.values(gearYards(p)).reduce((s, v) => s + v, 0);
    near(total, setDistance(p), 2, `${text}: yards (each gear's share is rounded)`);
  }
  // A progression ends in its last gear, half gears included.
  assert.deepEqual(gearYards(parseSet('3 x 100 free, G2.5 → G4')), { 'G2.5': 100, G3: 100, G4: 100 });
  assert.deepEqual(gearYards(parseSet('3 x 100 free, G5 → G3')), { G5: 100, G4: 100, G3: 100 });
});

test('blockCns charges the hard gears', () => {
  // Default rates: 200 G6 × 0.25 + 3 × 400 G5 × 0.05 + 1000 G3 × 0.002
  assert.equal(blockCns(['4 x 50 free G6', '3 rounds:', '4 x 100 free G5', '', '1000 free G3'], {}), 50 + 60 + 2);
  assert.equal(blockCns(['2000 free G2', '400 easy'], {}), 0);
  assert.equal(blockCns([], {}), 0);
  assert.equal(blockCns(null, {}), 0);
});

// ---------------------------------------------------------------- context

test('writingContext builds each group\'s paces from the plan', () => {
  assert.equal(CTX.groups.length, 4);
  assert.deepEqual(CTX.groups.map((g) => g.key), ['1:02', '1:05', '1:08', '1:11']);
  CTX.groups.forEach((g, i) => {
    near(g.paces.G3, PLAN.groups[i].g3, 1e-9, `${g.name} G3`);
    assert.deepEqual(g.imPaces, imPaces(CTX.model, PLAN.groups[i].im400));
  });
  assert.equal(CTX.model.fatigue, 1.07);
  assert.equal(CTX.unit, 'y');
  // A group defined by a 1650 time.
  const t = { distance: 1650, seconds: 1000 };
  const byTest = writingContext({ groups: [{ name: 'T', test: t }] });
  assert.deepEqual(byTest.groups[0].paces, gearPaces(makeGearModel({}), t));
  assert.equal(byTest.groups[0].imPaces, null);
  assert.equal(byTest.groups[0].id, 'g0');
  // Groups with nothing to go on are dropped; with none at all, one is assumed from the plan pace.
  const none = writingContext({ pace: 90, groups: [{ name: 'empty' }] });
  assert.equal(none.groups.length, 1);
  assert.equal(none.groups[0].assumed, true);
  near(none.groups[0].paces.G3, 78, 1e-9, 'plan pace − 12');
  assert.equal(writingContext({}).groups[0].name, 'Everyone');
});

test('referenceRows writes each group\'s pace and reads back as a reference row', () => {
  const rows = referenceRows(CTX, ['G3', 'G4']);
  assert.equal(rows[0], 'G3 pace       1:02 | 1:05 | 1:08 | 1:11');
  const g4 = parseLine(rows[1]);
  assert.equal(g4.type, 'ref');
  assert.deepEqual(g4.values, CTX.groups.map((g) => Math.round(g.paces.G4)));
  assert.deepEqual(parseLine(rows[0]).values, [62, 65, 68, 71]);
  assert.deepEqual(referenceRows({ groups: [] }), []);
});

// -------------------------------------------------------------- send-offs

test('intervalsForLine follows the gear chart per group', () => {
  const l = parseLine('4 x 100 free G3');
  const iv = intervalsForLine(l, CTX);
  assert.deepEqual(iv, CTX.groups.map((g) => sendOff(CTX.model, g.paces, { gear: 'G3', distance: 100, stroke: 'free' })));
  for (let i = 1; i < iv.length; i++) assert.ok(iv[i] > iv[i - 1], 'slower groups get longer send-offs');
  // Backstroke and kick are slower than free.
  const bk = intervalsForLine(parseLine('4 x 100 BK G3'), CTX);
  const kick = intervalsForLine(parseLine('4 x 100 kick G3'), CTX);
  bk.forEach((v, i) => assert.ok(v > iv[i]));
  kick.forEach((v, i) => assert.ok(v > bk[i]));
  assert.equal(intervalsForLine(parseLine(':20 REST'), CTX), null);
});

test('easy swims get one round send-off from the easy pace', () => {
  assert.deepEqual(intervalsForLine(parseLine('200 easy'), CTX), [240]);
  assert.deepEqual(intervalsForLine(parseLine('100 easy, any stroke'), CTX), [120]);
  const ctx = writingContext(PLAN, { style: { easyPer100: 100 } });
  assert.deepEqual(intervalsForLine(parseLine('300 easy'), ctx), [300]);
  assert.deepEqual(intervalsForLine(parseLine('150 easy'), ctx), [150]);
});

test('odds / evens share one send-off: the slowest group\'s', () => {
  const iv = intervalsForLine(parseLine('8 x 100 free   odds - G2   evens - G4'), CTX);
  assert.equal(iv.length, 1);
  assert.equal(iv[0], sendOff(CTX.model, CTX.groups[3].paces, { gear: 'G4', distance: 100, stroke: 'free' }));
});

test('pace sets are timed in the gear that pace belongs to', () => {
  assert.equal(lineGear(parseLine('4 x 100 free hold 1000 pace')), 'G4');
  assert.equal(lineGear(parseLine('4 x 100 free at 500 pace')), 'G5');
  assert.equal(lineGear(parseLine('4 x 50 at 200 pace')), 'G6');
  assert.equal(lineGear(parseLine('4 x 100 at 1650 pace')), 'G3.5');
  assert.equal(lineGear(parseLine('4 x 50 drill')), 'G1');
  assert.equal(lineGear(parseLine('200 free')), 'G2');
  const at1000 = intervalsForLine(parseLine('4 x 100 free hold 1000 pace'), CTX);
  const g4 = intervalsForLine(parseLine('4 x 100 free G4'), CTX);
  assert.deepEqual(at1000, g4);
});

test('IM lines use the group\'s IM paces; debrief calibration adds time', () => {
  const im = intervalsForLine(parseLine('4 x 100 IM G3'), CTX);
  assert.deepEqual(im, CTX.groups.map((g) => sendOff(CTX.model, g.paces, { gear: 'G3', distance: 100, stroke: 'IM', strokePaces: g.imPaces })));
  const cal = writingContext(PLAN, { calibration: { G3: { all: 2, back: 4 } } });
  const free0 = intervalsForLine(parseLine('4 x 100 free G3'), CTX);
  const free2 = intervalsForLine(parseLine('4 x 100 free G3'), cal);
  const bk0 = intervalsForLine(parseLine('4 x 100 BK G3'), CTX);
  const bk4 = intervalsForLine(parseLine('4 x 100 BK G3'), cal);
  free2.forEach((v, i) => assert.ok(v - free0[i] >= 2, 'all strokes +2 s / 100'));
  bk4.forEach((v, i) => assert.ok(v - bk0[i] >= 4, 'back has its own +4 s / 100'));
  const g4 = intervalsForLine(parseLine('4 x 100 free G4'), cal);
  assert.deepEqual(g4, intervalsForLine(parseLine('4 x 100 free G4'), CTX), 'other gears untouched');
});

// ---------------------------------------------------------------- writing

test('writeLines fills missing send-offs and keeps the coach\'s', () => {
  const lines = ['G3 pace 1:02 | 1:05 | 1:08 | 1:11', '4 x 100 free G3', '4 x 100 free G3   1:20', ':20 REST', '#1 smooth', '3 rounds:'];
  const out = writeLines(lines, CTX);
  assert.equal(out[0], lines[0]);
  assert.deepEqual(parseLine(out[1]).intervals, intervalsForLine(parseLine(lines[1]), CTX));
  assert.equal(out[2], '4 x 100 free G3    1:20', 'written send-offs are kept');
  assert.deepEqual(out.slice(3), lines.slice(3));
  assert.deepEqual(writeLines(null, CTX), []);
  // retimeAll replaces the coach's too.
  assert.deepEqual(parseLine(writeLines([lines[2]], CTX, { retimeAll: true })[0]).intervals, intervalsForLine(parseLine(lines[2]), CTX));
});

test('writeLines with a gear shift moves every gear up and re-times the swims', () => {
  const lines = ['G3 pace 1:02 | 1:05 | 1:08 | 1:11', '4 x 100 free G2   1:32 | 1:37 | 1:42 | 1:47', '#1 G3 smooth', '6 x 50 FL, G2 → G4 by 25'];
  const out = writeLines(lines, CTX, { gearShift: 1 });
  assert.equal(out[0], lines[0], 'the reference row still shows each group\'s G3 pace');
  assert.match(out[1], /^4 x 100 free G3 /);
  assert.deepEqual(parseLine(out[1]).intervals, intervalsForLine(parseLine('4 x 100 free G3'), CTX));
  assert.equal(out[2], '#1 G4 smooth');
  assert.equal(parseLine(out[3]).gearFrom, 'G3');
  assert.equal(parseLine(out[3]).gearTo, 'G5');
  // Capped at G6, never below G1; half gears keep their half.
  assert.equal(shiftLineGears('4 x 50 G5 → G6 by 25', 2), '4 x 50 G6 → G6 by 25');
  assert.equal(shiftLineGears('4 x 100 G3.5', 1), '4 x 100 G4.5');
  assert.equal(shiftLineGears('4 x 100 G2', -3), '4 x 100 G1');
  assert.equal(shiftLineGears('4 x 100 G2', 0), '4 x 100 G2');
});

test('writeLines with a scale: fewer reps keep their send-off, a shorter swim gets its own', () => {
  const out = writeLines(['6 x 50 free G3   :48 | :50 | :53 | :55', '500 free G2   6:30', '400 free G2'], CTX, { scale: 0.5 });
  assert.equal(out[0], '3 x 50 free G3    :48 | :50 | :53 | :55');
  const short = parseLine(out[1]);
  assert.equal(short.distance, 250);
  assert.deepEqual(short.intervals, intervalsForLine(parseLine('250 free G2'), CTX), 'a 250 is not sent off on the 500\'s 6:30');
  assert.equal(parseLine(out[2]).distance, 200);
  assert.deepEqual(parseLine(out[2]).intervals, intervalsForLine(parseLine('200 free G2'), CTX));
  // Same distance after rounding to 25 → the coach's send-off stays.
  assert.equal(writeLines(['100 free G2   1:30'], CTX, { scale: 0.9 })[0], '100 free G2    1:30');
  assert.deepEqual(scaleReps(parseLine('6 x 50 free'), 0.5).reps, 3);
  assert.equal(scaleReps(parseLine('2 x 50 free'), 0.2).reps, 1, 'at least one rep');
  assert.equal(scaleReps(parseLine('100 free'), 0.1).distance, 25, 'at least a 25');
  const same = parseLine('6 x 50 free');
  assert.equal(scaleReps(same, 1), same);
});

test('writeLines single: one send-off (the slowest group\'s) wherever the app writes them', () => {
  const lines = ['4 x 100 free G2   1:32 | 1:37 | 1:42 | 1:47', '4 x 100 free G2', '4 x 100 free G3'];
  const out = writeLines(lines, CTX, { single: true });
  assert.equal(out[0], '4 x 100 free G2    1:32 | 1:37 | 1:42 | 1:47', 'the coach\'s own columns stay');
  assert.deepEqual(parseLine(out[1]).intervals, [Math.max(...intervalsForLine(parseLine(lines[1]), CTX))]);
  assert.deepEqual(parseLine(out[2]).intervals, [Math.max(...intervalsForLine(parseLine(lines[2]), CTX))]);
  // A shifted round re-times the coach's line too, so it gets one send-off as well (PM "hard last round").
  const shifted = writeLines([lines[0]], CTX, { single: true, gearShift: 1 });
  assert.deepEqual(parseLine(shifted[0]).intervals, [Math.max(...intervalsForLine(parseLine('4 x 100 free G3'), CTX))]);
});

test('retime swaps send-offs on swim lines only', () => {
  const text = 'G3 pace 1:02 | 1:05\n4 x 100 free G3   1:10 | 1:15\n:20 REST\n200 easy';
  const out = retime(text, (l) => (l.easy ? null : [99, 101]));
  assert.equal(out, 'G3 pace 1:02 | 1:05\n4 x 100 free G3    1:39 | 1:41\n:20 REST\n200 easy');
});

test('blockSecondsByGroup times the block once send-offs are filled in', () => {
  const lines = ['4 x 100 free G3', ':20 REST', '2 rounds:', '4 x 50 free G4', '100 easy'];
  const secs = blockSecondsByGroup(lines, CTX);
  assert.equal(secs.length, 4);
  const g3 = intervalsForLine(parseLine('4 x 100 free G3'), CTX);
  const g4 = intervalsForLine(parseLine('4 x 50 free G4'), CTX);
  secs.forEach((s, i) => assert.equal(s, 4 * g3[i] + 20 + 2 * (4 * g4[i] + 120)));
  for (let i = 1; i < secs.length; i++) assert.ok(secs[i] > secs[i - 1]);
});

// ------------------------------------------------------ group adjustments

// Made-up 4-group block: fastest group 45:12, the others 47:56, 50:52, 53:36.
const ADJ = [
  'G3 pace 1:02 | 1:05 | 1:08 | 1:11',
  '4 x 100 free, G2 → G3 by 50    1:16 | 1:21 | 1:26 | 1:31',
  ':20 REST',
  '3 rounds:',
  '4 x 50 FL, G2 → G5 by 25   :51 | :56 | 1:01 | 1:06',
  '4 x 25 BK sprint, G6    :31 | :33 | :36 | :38',
  '4 x 100 free G3   1:12 | 1:17 | 1:22 | 1:27',
  '150 easy    3:00',
];

test('groupAdjustments cuts slower groups in the coach\'s order until they fit', () => {
  const p = parseSet(ADJ.join('\n'));
  // 4 × pre + :20 + 3 × (4 × 50 FL + 4 × 25 BK + 4 × 100 free + 3:00)
  assert.deepEqual([0, 1, 2, 3].map((g) => setSeconds(p, g)), [
    4 * 76 + 20 + 3 * (4 * 51 + 4 * 31 + 4 * 72 + 180),
    4 * 81 + 20 + 3 * (4 * 56 + 4 * 33 + 4 * 77 + 180),
    4 * 86 + 20 + 3 * (4 * 61 + 4 * 36 + 4 * 82 + 180),
    4 * 91 + 20 + 3 * (4 * 66 + 4 * 38 + 4 * 87 + 180),
  ]);
  assert.deepEqual([0, 1, 2, 3].map((g) => setSeconds(p, g)), [2712, 2876, 3052, 3216]);
  const out = groupAdjustments(ADJ, CTX, 45);
  assert.deepEqual(out, [
    '1:05 - 3 x 100 (start on #2), skip the G2 50 of FL in RD2 + RD3',
    '1:08 - same as 1:05, plus skip the BK sprint 25s in RD3',
    '1:11 - same as 1:08, plus 3 x 100 in RD2 + RD3',
  ]);
  // What each group saves, by hand, puts every group inside 45:30.
  const target = 45 * 60 + 30;
  const saved = [2876 - 81 - 2 * 56, 3052 - 86 - 2 * 61 - 4 * 36, 3216 - 91 - 2 * 66 - 4 * 38 - 2 * 87];
  for (const s of saved) assert.ok(s <= target);
  assert.deepEqual(adjustmentPlan(ADJ, CTX, 45).seconds, [2712, ...saved]);
  for (const line of out) assert.equal(parseLine(line).type, 'adjust');
});

test('groupAdjustments: only the groups that need it, keyed by the reference row or group key', () => {
  assert.deepEqual(groupAdjustments(ADJ, CTX, 54), []);
  assert.deepEqual(groupAdjustments(ADJ, CTX, 53), ['1:11 - 3 x 100 (start on #2)']);
  const noRef = ADJ.slice(1);
  const ctx = writingContext({ ...PLAN, groups: PLAN.groups.map((g, i) => ({ ...g, key: `L${i + 1}` })) });
  assert.deepEqual(groupAdjustments(noRef, ctx, 53), ['L4 - 3 x 100 (start on #2)']);
  assert.deepEqual(groupAdjustments(ADJ, writingContext({ groups: [PLAN.groups[0]] }), 45), [], 'one group: nothing to adjust');
  assert.deepEqual(groupAdjustments(ADJ, CTX, 0), []);
});

test('groupAdjustments never cuts the same gear build twice', () => {
  // Only a build in the rounds: the speed cut must not be the build line again.
  const lines = ['G3 pace 1:02 | 1:05 | 1:08 | 1:11', '3 rounds:', '6 x 50 FL, G2 → G5 by 25   :50 | 1:00 | 1:10 | 1:20', '150 easy  3:00'];
  for (const m of [24, 26, 28, 30]) {
    for (const line of groupAdjustments(lines, CTX, m)) {
      assert.doesNotMatch(line, /\d x 50 FL in RD|skip the FL 50s/, `${m} min: ${line}`);
    }
  }
});

// ----------------------------------------------------------------- generate

const FOCUSES = ['aerobic', 'threshold', 'race', 'speed', 'technique', 'kick', 'im'];

test('generateBlock writes a block in the coach\'s shape that the parser fully reads', () => {
  for (const focus of FOCUSES) {
    const b = generateBlock({ focus, minutes: 40, stroke: focus === 'im' ? 'IM' : 'free', ctx: CTX });
    const p = parseSet(b.lines.join('\n'));
    assert.equal(b.lines[0], 'G3 pace       1:02 | 1:05 | 1:08 | 1:11', `${focus}: reference row first`);
    assert.ok(p.lines.every((l) => l.type !== 'text'), `${focus}: every line is notation`);
    assert.ok(p.lines.filter((l) => l.type === 'swim').every((l) => l.intervals.length), `${focus}: every swim has a send-off`);
    assert.ok(p.lines.some((l) => l.type === 'rounds'), `${focus}: has rounds`);
    assert.equal(b.session, 'AM');
    assert.equal(b.source, 'generated');
    assert.equal(b.distance, setDistance(p));
    assert.deepEqual(b.gears, setGears(p));
    assert.match(b.name, new RegExp(`^${b.minutes} min `));
  }
  const im = generateBlock({ focus: 'im', minutes: 40, stroke: 'IM', ctx: CTX });
  assert.equal(im.category, 'race');
  assert.equal(im.stroke, 'IM');
  assert.match(im.name, /IM stroke builds$/);
  assert.equal(generateBlock({ focus: 'recovery', minutes: 40, ctx: CTX }).category, 'technique');
  assert.equal(generateBlock({ focus: 'nonsense', minutes: 40, ctx: CTX }).category, 'aerobic');
});

test('generateBlock fits the minutes asked for, for the fastest group', () => {
  for (const stroke of ['free', 'back', 'breast', 'fly']) {
    for (const focus of FOCUSES) {
      for (const minutes of [40, 45, 50, 60]) {
        // The sprint shape (G6 50s and 25s) tops out under an hour; a 60 min speed block is not a thing.
        if (focus === 'speed' && minutes === 60) continue;
        const b = generateBlock({ focus, minutes, stroke: focus === 'im' ? 'IM' : stroke, ctx: CTX });
        const fastest = blockSecondsByGroup(b.lines, CTX)[0] / 60;
        near(fastest, minutes, 3, `${stroke} ${focus} ${minutes} min`);
        near(b.minutes, fastest, 0.5, `${stroke} ${focus} ${minutes} min: the name says how long it is`);
      }
    }
  }
  // The IM block's main line ("100 IM G4, strong walls") takes reps, so it can grow to fit.
  const im = generateBlock({ focus: 'im', minutes: 50, stroke: 'IM', ctx: CTX });
  assert.ok(im.lines.some((l) => /^\d+ x 100 IM G4\b/.test(l)), im.lines.join('\n'));
});

test('generateBlock cuts the slower groups down to the fastest group\'s minutes', () => {
  const b = generateBlock({ focus: 'aerobic', minutes: 45, ctx: CTX });
  const secs = blockSecondsByGroup(b.lines, CTX);
  const adj = b.lines.map(parseLine).filter((l) => l.type === 'adjust');
  const target = b.minutes * 60 + 30;
  const needed = CTX.groups.map((g, i) => secs[i] > target).filter(Boolean).length;
  assert.equal(adj.length, needed, 'one adjustment line per group that runs over');
  assert.deepEqual(adj.map((l) => l.key), CTX.groups.filter((g, i) => secs[i] > target).map((g) => g.key));
});

test('generateBlock PM: straight sets, one send-off each, no reference rows', () => {
  for (const focus of ['aerobic', 'technique', 'recovery', 'threshold', 'race', 'kick']) {
    for (const minutes of [20, 30, 45]) {
      const b = generateBlock({ focus, minutes, slot: 'PM', ctx: CTX });
      const p = parseSet(b.lines.join('\n'));
      assert.equal(b.session, 'PM');
      assert.ok(!p.lines.some((l) => l.type === 'ref' || l.type === 'adjust' || l.type === 'rounds'), `${focus} ${minutes}`);
      assert.ok(p.lines.filter((l) => l.type === 'swim').every((l) => l.intervals.length === 1), `${focus} ${minutes}`);
      near(blockSecondsByGroup(b.lines, CTX)[0] / 60, minutes, 3, `PM ${focus} ${minutes}`);
      // The odds / evens straight set comes in pairs.
      if (p.lines[0].oddsEvens) assert.equal(p.lines[0].reps % 2, 0, `${focus} ${minutes}: odds / evens in pairs`);
    }
  }
});

test('generateBlock PM follows the focus: aerobic, technique and recovery doubles are not odds G3 / evens G5', () => {
  // Was: every PM focus wrote "odds - G3 evens - G5" + G6 25s + fast kick.
  for (const focus of ['aerobic', 'technique', 'recovery']) {
    for (const stroke of ['free', 'fly', 'IM']) {
      const b = generateBlock({ focus, minutes: 45, stroke, slot: 'PM', ctx: CTX });
      const swims = swimsOf(b.lines);
      assert.ok(!swims.some((l) => l.oddsEvens), `${focus} ${stroke}: ${b.lines.join(' / ')}`);
      assert.ok(!b.gears.includes('G5') && !b.gears.includes('G4'), `${focus} ${stroke}: gears ${b.gears}`);
      assert.ok(swims.some((l) => lineGear(l) === 'G2' && l.distance >= 100), `${focus} ${stroke}: aerobic work`);
      assert.ok(swims.some((l) => l.drillShare), `${focus} ${stroke}: some skill work`);
      if (focus === 'recovery') assert.ok(Math.max(...b.gears.map((g) => +g.slice(1))) <= 3, `recovery builds to G3 at most: ${b.gears}`);
      else assert.ok(b.gears.includes('G6'), `${focus} ${stroke}: a little speed`);
    }
  }
  // The sharper focuses keep the meet-week straight set.
  assert.ok(swimsOf(generateBlock({ focus: 'threshold', minutes: 45, slot: 'PM', ctx: CTX }).lines)[0].oddsEvens);
  assert.notDeepEqual(generateBlock({ focus: 'aerobic', minutes: 45, slot: 'PM', ctx: CTX }).lines, generateBlock({ focus: 'technique', minutes: 45, slot: 'PM', ctx: CTX }).lines);
});

test('generateBlock is deterministic and uses the learned rest line', () => {
  const a = generateBlock({ focus: 'threshold', minutes: 45, ctx: CTX });
  assert.deepEqual(generateBlock({ focus: 'threshold', minutes: 45, ctx: CTX }), a);
  const styled = writingContext(PLAN, { style: { restLine: ':30 REST', rounds: 3, easyPer100: 120, ratios: {} } });
  assert.ok(generateBlock({ focus: 'threshold', minutes: 45, ctx: styled }).lines.includes(':30 REST'));
  for (const v of [0, 1, 2, 3]) {
    const b = generateBlock({ focus: 'aerobic', minutes: 45, ctx: CTX, variant: v });
    near(blockSecondsByGroup(b.lines, CTX)[0] / 60, 45, 5, `variant ${v}`);
  }
});

// ---------------------------------------------------------------- quick add

test('quickBlock files a pasted set under the right category', () => {
  const cat = (t) => quickBlock(t, CTX).category;
  assert.equal(cat('20 min warm up\n400 free easy\n4 x 100 IM G2'), 'warmup');
  assert.equal(cat('300 cool down easy'), 'cooldown');
  assert.equal(cat('8 x 50 kick sprint, G6\n4 x 50 kick G3'), 'kick');
  assert.equal(cat('5 x 100 pull w/ buoy, no kick, G3\n150 easy'), 'pull');
  assert.equal(cat('4 x 50 fly drill\n4 x 50 back drill'), 'technique');
  assert.equal(cat('8 x 25 fast, G6\n4 x 50 G6'), 'speed');
  assert.equal(cat('24 min sharpen + turns\n4 x 50 G5'), 'speed');
  assert.equal(cat('4 x 100 free G5\n100 easy'), 'race');
  assert.equal(cat('6 x 100 free at 500 pace'), 'race');
  assert.equal(cat('5 x 200 free G3   2:40 | 2:45'), 'threshold');
  assert.equal(cat('6 x 100 free G2'), 'aerobic');
});

test('quickBlock keeps the heading as the name and the lines without it', () => {
  const text = '\n36 min FL/free switch\n\nG3 pace 1:02 | 1:05 | 1:08 | 1:11\n6 x 50 FL, G2 -> G5 by 25   :53 | :56 | :59 | 1:02\n\n150 easy   3:00\n\n\n';
  const q = quickBlock(text, CTX);
  assert.equal(q.name, '36 min FL/free switch');
  assert.equal(q.minutes, 36);
  assert.equal(q.distance, null);
  assert.equal(q.stroke, 'fly');
  assert.deepEqual(q.gears, ['G2', 'G3', 'G4', 'G5']);
  assert.equal(q.source, 'pasted');
  assert.deepEqual(q.lines, ['G3 pace 1:02 | 1:05 | 1:08 | 1:11', '6 x 50 FL, G2 -> G5 by 25   :53 | :56 | :59 | 1:02', '', '150 easy   3:00'],
    'no blank lines at the ends, the one in the middle kept');
});

test('quickBlock without a heading: name from the first line, minutes from send-offs', () => {
  const q = quickBlock('6 x 50 free :44 | :47\n4 x 50 fly, fins', CTX);
  assert.equal(q.name, '6 x 50 free');
  assert.deepEqual(q.equipment, ['fins']);
  const fly = intervalsForLine(parseLine('4 x 50 fly, fins'), CTX)[0];
  assert.equal(q.minutes, Math.round((6 * 44 + 4 * fly) / 60));
  const noCtx = quickBlock('6 x 100 free G2');
  assert.equal(noCtx.minutes, null);
  assert.equal(noCtx.distance, 600);
  assert.equal(quickBlock('4 x 100 BK G3\n4 x 100 BK G3\n2 x 100 BR G3').stroke, 'back');
  assert.equal(quickBlock('400 free easy\n4 x 100 IM G2\n4 x 100 free G2').stroke, 'IM');
  const junk = quickBlock('hello there');
  assert.equal(junk.name, 'New block');
  assert.equal(junk.minutes, null);
  assert.equal(junk.distance, null);
});

// ----------------------------------------------------------------- style

// A made-up block whose send-offs follow one ratio to G3 pace per line, the
// way a consistent coach writes them (long reps rounded up to :05).
const STYLE_BLOCK = [
  '63 min free gears',
  'G3 pace 1:02 | 1:05 | 1:08 | 1:11',
  '3 x 300 free, G2 → G3 by 100   3:50 | 4:00 | 4:15 | 4:25',
  ':20 REST',
  '3 rounds:',
  '6 x 50 FL, G2 → G5 by 25      :52 | :54 | :57 | :59',
  '5 x 100 free G3     1:09 | 1:13 | 1:16 | 1:20',
  '6 x 25 BK sprint, G6     :31 | :32 | :34 | :35',
  '150 easy, any stroke   3:00',
];

test('learnStyle reads the coach\'s habits from a block', () => {
  const s = learnStyle([STYLE_BLOCK.join('\n')], PLAN.gears);
  assert.deepEqual(s.learnedFrom, { blocks: 1, lines: 5 });
  assert.equal(s.columns, 4);
  assert.equal(s.restLine, ':20 REST');
  assert.equal(s.rounds, 3);
  assert.equal(s.blockMinutes, 63);
  assert.equal(s.easyPer100, 120);
  assert.equal(s.roundLongTo5, true);
  assert.equal(s.steps[50], 2);
  assert.ok(s.ratios['swim|G3|100|free'] > 1 && s.ratios['swim|G3|100'] === s.ratios['swim|G3|100|free']);
  assert.ok(s.ratios['swim|G2>G5|50|fly']);
  assert.deepEqual(s.phrases.easy, ['easy, any stroke']);
  // Nothing to learn from → defaults.
  const empty = learnStyle([]);
  assert.deepEqual(empty.ratios, {});
  assert.equal(empty.columns, 1);
  assert.equal(empty.restLine, ':20 REST');
  assert.equal(empty.rounds, 3);
  assert.equal(empty.blockMinutes, 40);
  assert.equal(empty.roundLongTo5, null);
});

test('learned ratios write the coach\'s own send-offs back (within 1–2 s)', () => {
  const style = learnStyle([STYLE_BLOCK.join('\n')], PLAN.gears);
  const ctx = writingContext(PLAN, { style });
  const original = swimsOf(STYLE_BLOCK);
  const rewritten = swimsOf(writeLines(strip(STYLE_BLOCK), ctx));
  assert.equal(rewritten.length, original.length);
  rewritten.forEach((l, i) => {
    const want = original[i].intervals;
    assert.equal(l.intervals.length, want.length, l.raw);
    l.intervals.forEach((v, g) => near(v, want[g], 2, `${l.raw} group ${g + 1}`));
  });
  // A ratio learned on fly writes breaststroke slower, the same shape.
  const fl = intervalsForLine(parseLine('6 x 50 FL, G2 → G5 by 25'), ctx);
  const br = intervalsForLine(parseLine('6 x 50 BR, G2 → G5 by 25'), ctx);
  br.forEach((v, g) => assert.ok(v > fl[g]));
});

test('learned ratios never round a long rep up twice', () => {
  // A coach who writes exactly ratio × G3 pace, rounded up to :05, for any ratio.
  const g3 = [62, 65, 68, 71];
  for (const r of [1.22, 1.25, 1.27, 1.3, 1.33]) {
    const iv = g3.map((p) => roundSendOff(CTX.model, r * 2 * p, 200));
    const block = `G3 pace 1:02 | 1:05 | 1:08 | 1:11\n4 x 200 free G3   ${formatColumns(iv)}`;
    const ctx = writingContext(PLAN, { style: learnStyle([block], PLAN.gears) });
    assert.deepEqual(intervalsForLine(parseLine('4 x 200 free G3'), ctx), iv, `ratio ${r}`);
  }
});

test('a 400 IM reference row teaches IM send-offs from each group\'s IM pace', () => {
  const block = [
    '400 IM group 4:15 | 4:25 | 4:35 | 4:45',
    '6 x 50 FL, G2 → G5 by 25      :52 | :54 | :56 | :58',
    '6 x 50 BR, G2 → G5 by 25      :57 | :59 | 1:01 | 1:03',
    '3 x 100 IM G4    1:27 | 1:31 | 1:34 | 1:37',
  ];
  const style = learnStyle([block.join('\n')], PLAN.gears);
  assert.ok(Object.keys(style.ratios).every((k) => k.startsWith('im:')));
  const ctx = writingContext(PLAN, { style });
  const rewritten = swimsOf(writeLines(strip(block), ctx));
  swimsOf(block).forEach((l, i) => l.intervals.forEach((v, g) => near(rewritten[i].intervals[g], v, 2, `${l.raw} group ${g + 1}`)));
});

test('styleKey buckets lines by kind, gear shape and distance', () => {
  assert.equal(styleKey(parseLine('6 x 50 FL, G2 → G5 by 25')), 'swim|G2>G5|50');
  assert.equal(styleKey(parseLine('6 x 50 FL, G2 → G5 by 25'), true), 'swim|G2>G5|50|fly');
  assert.equal(styleKey(parseLine('3 x 100 free, G3 → 500 pace')), 'swim|G3>pace|100');
  assert.equal(styleKey(parseLine('8 x 100 odds - G2 evens - G4')), 'swim|oe|100');
  assert.equal(styleKey(parseLine('4 x 100 kick G4')), 'kick|G4|100');
  assert.equal(styleKey(parseLine('200 easy')), 'swim|easy|200');
  assert.equal(styleKey(parseLine('4 x 100 at 500 pace')), 'swim|pace|100');
  assert.equal(styleKey(parseLine('4 x 100 free')), 'swim|none|100');
});

test('the example block in the module header reads cleanly', () => {
  const text = [
    '36 min FL/free switch',
    '400 IM group       4:15 | 4:25 | 4:35 | 4:45',
    '3 x 300 free       3:35 | 3:50 | 4:05 | 4:20',
    '#2 G2.5, breathe every 5th',
    ':15 REST',
    '3 rounds:',
    '6 x 50 FL, G2 → G5 by 25      :53 | :56 | :59 | 1:02',
    '150 easy, any stroke      3:00',
    '4:35 - 4 x 50 FL in RD2 + RD3',
  ].join('\n');
  const p = parseSet(text);
  assert.deepEqual(p.lines.map((l) => l.type), ['heading', 'ref', 'swim', 'note', 'rest', 'rounds', 'swim', 'swim', 'adjust']);
  assert.equal(setSeconds(p, 0), 3 * 215 + 15 + 3 * (6 * 53 + 180));
  assert.equal(fmtClock(setSeconds(p, 0)), '35:54', 'about the heading\'s 36 min');
  assert.equal(setSeconds(p, 2), 3 * 245 + 15 + 3 * (6 * 59 + 180));
  assert.equal(setDistance(p), 900 + 3 * 450);
  assert.equal(fmtClock(setSeconds(p, 3)), '40:51'); // 3 × 4:20 + :15 + 3 × (6 × 1:02 + 3:00)
  near(paceOf(CTX.groups[0].paces, 'G3'), 62, 1e-9, 'G3 pace');
  near(testForGearPace(CTX.model, 'G3', 62).seconds, CTX.groups[0].test.seconds, 1e-9);
});

// ------------------------------------------------- review fixes (made up)

test('a gear shift leaves lines with no gear on the coach\'s send-offs', () => {
  const lines = ['6 x 100 free   1:32 | 1:37 | 1:42 | 1:47', '6 x 50 kick   1:05', '300 easy   5:00', '4 x 100 free G2   1:30', '4 x 50 free G6   1:10'];
  const out = writeLines(lines, CTX, { gearShift: 1 });
  assert.equal(out[0], '6 x 100 free    1:32 | 1:37 | 1:42 | 1:47', 'no G to shift: kept');
  assert.equal(out[1], '6 x 50 kick    1:05');
  assert.equal(out[2], '300 easy    5:00');
  assert.deepEqual(parseLine(out[3]).intervals, intervalsForLine(parseLine('4 x 100 free G3'), CTX), 'G2 → G3 is re-timed');
  assert.equal(out[4], '4 x 50 free G6    1:10', 'already G6: nothing changed, so the send-off stays');
  assert.equal(writeLines(['6 x 50 kick   1:05'], CTX, { gearShift: 2, single: true })[0], '6 x 50 kick    1:05');
});

test('only the first line is a heading: "N min rest" and "N min kick" inside a set stay in it', () => {
  assert.deepEqual(parseLine('2 min rest'), { type: 'rest', raw: '2 min rest', seconds: 120, note: '' });
  assert.equal(parseLine('1 min rest, then go').seconds, 60);
  assert.equal(parseLine('1 min rest, then go').note, 'then go');
  const rounds = parseSet('3 rounds:\n4 x 50 free G5   :50\n1 min rest\n4 x 25 fast   :30');
  assert.equal(setSeconds(rounds, 0), 3 * (200 + 60 + 120), 'the rest is inside the rounds');
  assert.equal(setDistance(rounds), 900);
  const timed = parseSet('20 min kick\n4 x 100 kick G2   2:00\n5 min kick w/ fins\n150 easy   3:00');
  assert.equal(timed.heading.title, 'kick');
  assert.equal(timed.headingIndex, 0);
  assert.equal(timed.lines[2].type, 'timed');
  assert.equal(setSeconds(timed, 0), 4 * 120 + 300 + 180, 'the 5 min kick counts');
  // Saved blocks keep those lines; only the heading line goes into the name.
  const q = quickBlock('30 min aerobic\n3 rounds:\n4 x 100 free G2   1:20\n1 min rest\n4 x 50 kick   1:05', CTX);
  assert.equal(q.name, '30 min aerobic');
  assert.deepEqual(q.lines, ['3 rounds:', '4 x 100 free G2   1:20', '1 min rest', '4 x 50 kick   1:05']);
  assert.deepEqual(quickBlock('20 min kick\n4 x 100 kick G2   2:00\n5 min kick w/ fins', CTX).lines, ['4 x 100 kick G2   2:00', '5 min kick w/ fins']);
  // No heading: named from the first swim, minutes from the whole set.
  const noHead = quickBlock('4 x 200 free   2:45\n2 min rest\n8 x 100 free G3   1:20', CTX);
  assert.equal(noHead.name, '4 x 200 free');
  assert.equal(noHead.minutes, Math.round((4 * 165 + 120 + 8 * 80) / 60));
  assert.deepEqual(noHead.lines, ['4 x 200 free   2:45', '2 min rest', '8 x 100 free G3   1:20']);
  assert.equal(parseSet('Tuesday\n30 min kick').heading, null, 'a heading further down is not the block\'s');
});

test('bracketed gears are timed in their middle gear with that gear\'s rest, not the top gear\'s', () => {
  const build = parseLine('5 x 100 free [G2 / G3 / G4 / G5] by 25');
  assert.equal(lineGear(build), 'G3.5');
  assert.equal(lineGear(parseLine('2 x 300 BR [G2 / G4]')), 'G3');
  const iv = intervalsForLine(build, CTX);
  assert.deepEqual(iv, CTX.groups.map((g) => sendOff(CTX.model, g.paces, { gear: 'G3.5', distance: 100, stroke: 'free' })));
  const g3 = intervalsForLine(parseLine('4 x 100 free G3'), CTX);
  const g4 = intervalsForLine(parseLine('4 x 100 free G4'), CTX);
  const g5 = intervalsForLine(parseLine('4 x 100 free G5'), CTX);
  iv.forEach((v, i) => {
    assert.ok(v < g5[i], `group ${i + 1}: under the G5 send-off`);
    assert.ok(v >= g3[i] && v <= g4[i], `group ${i + 1}: between G3 and G4 (${fmtClock(v)} vs ${fmtClock(g3[i])} / ${fmtClock(g4[i])})`);
  });
  const br = intervalsForLine(parseLine('2 x 300 BR [G2 / G4]'), CTX);
  assert.deepEqual(br, intervalsForLine(parseLine('2 x 300 BR G3'), CTX));
  // The generator's race pre-set gets those send-offs.
  const race = swimsOf(generateBlock({ focus: 'race', minutes: 40, ctx: CTX }).lines)[0];
  assert.match(race.raw, /\[G2 \/ G3 \/ G4 \/ G5\]/);
  assert.deepEqual(race.intervals, iv);
  // A learned ratio for a bracket is not shared with plain G5 lines.
  assert.equal(styleKey(build), 'swim|G2/G3/G4/G5|100');
  assert.notEqual(styleKey(build), styleKey(parseLine('4 x 100 free G5')));
  assert.equal(styleKey(parseLine('4 x 50 kick [25 easy / 25 sprint]')), 'kick|G1|50', 'fast / easy splits keep their bucket');
});

test('a single swim at a pace with send-off columns is a swim, not a reference row', () => {
  const p = parseSet('4 x 100 free   1:20\n200 at 500 pace    2:40 | 2:45 | 2:50 | 2:55\n150 easy  3:00');
  assert.deepEqual(p.lines.map((l) => l.type), ['swim', 'swim', 'swim']);
  assert.equal(setDistance(p), 750);
  assert.equal(setSeconds(p, 0), 4 * 80 + 160 + 180);
  assert.equal(parseLine('200 free hold 1000 pace   2:30 | 2:35').type, 'swim');
  // What the app writes reads back as a swim too.
  assert.equal(parseLine(writeLines(['200 free at 500 pace'], CTX)[0]).type, 'swim');
  // Reference rows still read as reference rows.
  for (const raw of ['400 IM group 4:15 | 4:25', '1000 goal 11:40 | 12:05', '500 pace 5:50 | 6:00', '200 free pace 2:10 | 2:15', 'G3 pace 1:02 | 1:05', '400 IM group (Fall): 4:15 | 4:25']) {
    assert.equal(parseLine(raw).type, 'ref', raw);
  }
});

test('adjustment lines start with each group\'s column key from the Season tab', () => {
  const keyed = writingContext({ ...PLAN, groups: PLAN.groups.map((g, i) => ({ ...g, key: ['4:15', '4:25', '4:35', '4:45'][i] })) });
  const b = generateBlock({ focus: 'im', minutes: 42, stroke: 'IM', ctx: keyed });
  const adj = b.lines.map(parseLine).filter((l) => l.type === 'adjust');
  assert.ok(adj.length, b.lines.join('\n'));
  for (const l of adj) assert.ok(['4:25', '4:35', '4:45'].includes(l.key), `keyed by the group key: ${l.raw}`);
  assert.ok(b.lines.some((l) => /^G3 pace\s+1:02 \| 1:05 \| 1:08 \| 1:11$/.test(l)), 'the reference row is still each group\'s G3 pace');
  // Without keys: the reference row's value; two groups with the same value fall back to their names.
  const noKeys = writingContext({ ...PLAN, groups: PLAN.groups.map(({ key, ...g }) => g) });
  assert.deepEqual(groupAdjustments(ADJ, noKeys, 53), ['1:11 - 3 x 100 (start on #2)']);
  const twins = writingContext({ ...PLAN, groups: [PLAN.groups[0], { ...PLAN.groups[1], key: '' }, { ...PLAN.groups[2], key: '', name: 'Lane 3' }, PLAN.groups[3]] });
  const ref = ['G3 pace 1:02 | 1:06 | 1:06 | 1:11', ...ADJ.slice(1)];
  for (const line of groupAdjustments(ref, twins, 45)) assert.doesNotMatch(line, /^1:06 /, line);
});

test('pasted warm-ups, warm-downs and cool-downs are filed by their heading, hyphen or not', () => {
  const cat = (t) => quickBlock(t, CTX).category;
  assert.equal(cat('30 min warm-up\n400 free G1\n4 x 100 IM drill/swim G2\n8 x 50 kick G2'), 'warmup');
  assert.equal(cat('15 min warm-down\n200 easy back G1\n4 x 50 drill'), 'cooldown');
  assert.equal(cat('10 min cool-down\n200 easy'), 'cooldown');
  assert.equal(cat('300 warm-down easy'), 'cooldown');
  assert.equal(cat('25 min warmup\n300 free easy\n6 x 50 drill'), 'warmup');
  // A heading that says aerobic wins over one G6 25.
  assert.equal(cat('40 min free aerobic base\n2 x 400 free, G2 → G3 by 200\n:20 REST\n3 rounds:\n6 x 100 free G2, steady\n4 x 25 free G6 sprint'), 'aerobic');
  assert.equal(cat('35 min kick\n6 x 100 kick G3\n4 x 100 free G2'), 'kick');
  assert.equal(cat('30 min threshold\n6 x 200 free G3\n4 x 25 fast, G6'), 'threshold');
});

test('stroke IM does not turn an aerobic, threshold or kick block into IM gears', () => {
  for (const focus of ['aerobic', 'threshold', 'kick', 'technique']) {
    const b = generateBlock({ focus, minutes: 40, stroke: 'IM', ctx: CTX });
    assert.doesNotMatch(b.name, /IM stroke builds/, `${focus}: ${b.name}`);
    // A 25 or a 50 is never written as an IM: short reps go in IM order.
    for (const l of swimsOf(b.lines)) if (l.distance < 100) assert.doesNotMatch(l.desc, /\bIM\b/, `${focus}: ${l.raw}`);
  }
  const aerobic = generateBlock({ focus: 'aerobic', minutes: 40, stroke: 'IM', ctx: CTX });
  assert.equal(aerobic.category, 'aerobic');
  assert.ok(!aerobic.gears.includes('G5') && !aerobic.gears.includes('G4'), aerobic.gears.join(' '));
  assert.ok(swimsOf(aerobic.lines).some((l) => l.stroke === 'IM' && l.distance >= 100 && lineGear(l) === 'G2'), 'aerobic IMs at G2');
  assert.match(generateBlock({ focus: 'kick', minutes: 40, stroke: 'IM', ctx: CTX }).name, /kick$/);
  assert.match(generateBlock({ focus: 'im', minutes: 40, stroke: 'IM', ctx: CTX }).name, /IM stroke builds$/, 'the IM gears focus is still the IM gears set');
});

test('warm-up, cool-down and recovery blocks are written easy', () => {
  const top = (b) => Math.max(...b.gears.map((g) => +g.slice(1)), 0);
  for (const [focus, minutes] of [['warmup', 15], ['warmup', 30], ['cooldown', 8], ['cooldown', 15], ['recovery', 20], ['recovery', 40]]) {
    for (const slot of ['AM', 'PM']) {
      const b = generateBlock({ focus, minutes, slot, ctx: CTX });
      assert.ok(top(b) <= 3, `${focus} ${minutes} ${slot}: builds to G3 at most (${b.gears.join(' ')})`);
      assert.ok(!b.lines.some((l) => /\bfast\b|\bsprint\b/i.test(l)), `${focus} ${slot}: nothing fast`);
      assert.ok(!b.lines.some((l) => parseLine(l).type === 'ref'), `${focus} ${slot}: no reference row`);
      assert.equal(blockCns(b.lines, CTX.model) < 2, true, `${focus} ${slot}: CNS ${blockCns(b.lines, CTX.model)}`);
      near(blockSecondsByGroup(b.lines, CTX)[0] / 60, minutes, 3, `${focus} ${minutes} ${slot}`);
    }
  }
  assert.equal(generateBlock({ focus: 'warmup', minutes: 20, ctx: CTX }).category, 'warmup');
  assert.match(generateBlock({ focus: 'warmup', minutes: 20, ctx: CTX }).name, /^\d+ min warm-up$/);
  const cool = generateBlock({ focus: 'cooldown', minutes: 8, ctx: CTX });
  assert.equal(cool.category, 'cooldown');
  assert.ok(cool.gears.every((g) => g === 'G1'), `cool-down is G1: ${cool.gears}`);
  assert.ok(swimsOf(cool.lines).every((l) => l.easy));
});

test('a ratio learned on a 400 IM row keeps breaststroke slower than back and fly', () => {
  const block = ['400 IM group 4:15 | 4:25 | 4:35 | 4:45', '6 x 50 BK, G2 → G5 by 25      :47 | :49 | :50 | :52'].join('\n');
  const ctx = writingContext(PLAN, { style: learnStyle([block], PLAN.gears) });
  const at = (raw) => intervalsForLine(parseLine(raw), ctx);
  const bk = at('6 x 50 BK, G2 → G5 by 25');
  assert.deepEqual(bk, [47, 49, 50, 52], 'the coach\'s own line comes back as written');
  const br = at('6 x 50 BR, G2 → G5 by 25');
  br.forEach((v, g) => assert.ok(v > bk[g] + 2, `group ${g + 1}: BR ${v} vs BK ${bk[g]}`));
  const fly = at('4 x 25 FL sprint, G6');
  const brFast = at('4 x 25 BR sprint, G6');
  brFast.forEach((v, g) => assert.ok(v > fly[g], `group ${g + 1}: BR 25 ${v} vs FL 25 ${fly[g]}`));
});

test('drill / swim reps are timed with their drill share', () => {
  assert.equal(parseLine('4 x 100 free [50 drill / 50 swim]').drillShare, 0.5);
  assert.equal(parseLine('6 x 75 BK [25 drill / 50 swim]').drillShare, 1 / 3);
  assert.equal(parseLine('4 x 50 drill/swim').drillShare, 0.5);
  assert.equal(parseLine('4 x 50 drill/swim').kind, 'swim');
  assert.equal(parseLine('4 x 100 free G2').drillShare, undefined);
  const ds = intervalsForLine(parseLine('4 x 100 free [50 drill / 50 swim]'), CTX);
  const swim = intervalsForLine(parseLine('4 x 100 free G2'), CTX);
  const drill = intervalsForLine(parseLine('4 x 100 free drill'), CTX);
  ds.forEach((v, g) => {
    assert.ok(v > swim[g] && v < drill[g], `group ${g + 1}: ${fmtClock(v)} between swim ${fmtClock(swim[g])} and drill ${fmtClock(drill[g])}`);
    // Swim + half the drill offset fits inside the send-off.
    assert.ok(v > CTX.groups[g].paces.G2 + CTX.model.kinds.drill / 2, `group ${g + 1}: rest is not negative`);
  });
  // A learned ratio for drill / swim writes the coach's send-off back.
  const block = 'G3 pace 1:02 | 1:05 | 1:08 | 1:11\n4 x 100 free [50 drill / 50 swim]   1:22 | 1:26 | 1:30 | 1:34';
  const ctx = writingContext(PLAN, { style: learnStyle([block], PLAN.gears) });
  intervalsForLine(parseLine('4 x 100 free [50 drill / 50 swim]'), ctx).forEach((v, g) => near(v, [82, 86, 90, 94][g], 1, `group ${g + 1}`));
});

test('group adjustments bring every slower group within about a minute, never cutting RD1', () => {
  const rows = [];
  for (const focus of FOCUSES) {
    for (const minutes of [20, 30, 40, 45, 51, 60, 62]) {
      for (const stroke of ['free', 'breast']) {
        const b = generateBlock({ focus, minutes, stroke: focus === 'im' ? 'IM' : stroke, ctx: CTX });
        const body = b.lines.filter((l) => parseLine(l).type !== 'adjust');
        // A single round is written without a header (and never "1 rounds:").
        const rounds = parseSet(body.join('\n')).structure.find((x) => x.type === 'rounds') || { rounds: 1 };
        assert.ok(!body.some((l) => /^\s*1\s*rounds?\b/i.test(l)), `${b.name}: ${body.join(' / ')}`);
        const plan = adjustmentPlan(body, CTX, b.minutes);
        assert.deepEqual(plan.lines, b.lines.filter((l) => parseLine(l).type === 'adjust'), `${b.name}: the block carries the plan's lines`);
        for (const line of plan.lines) assert.doesNotMatch(line, /\bRD1\b/, `${b.name}: ${line}`);
        // A single round is cut inside that round (its lines name no round).
        if (rounds.rounds === 1) for (const line of plan.lines) assert.doesNotMatch(line, /\bRD\d/, `${b.name}: ${line}`);
        rows.push({ name: `${b.name} (${focus} ${stroke})`, off: plan.seconds.map((s) => s - b.minutes * 60), lines: plan.lines });
      }
    }
  }
  assert.ok(rows.length > 40);
  for (const r of rows) {
    // Within about a minute either way (the block's own fastest group may already be ±1 min off its name).
    assert.ok(r.off.every((s) => s >= -90 && s <= 90), `${r.name}: ${r.off.join(', ')} s off · ${r.lines.join(' ; ')}`);
  }
  const within = rows.filter((r) => r.off.every((s) => Math.abs(s) <= 60)).length;
  assert.ok(within / rows.length >= 0.9, `${within} of ${rows.length} blocks have every group within a minute`);
});

test('a single round is written without a header; its timing, yards and group adjustments read as one round', () => {
  let ones = 0;
  for (const focus of ['warmup', 'recovery', ...FOCUSES]) {
    for (const minutes of [10, 15, 20, 25]) {
      const b = generateBlock({ focus, minutes, stroke: focus === 'im' ? 'IM' : 'free', ctx: CTX });
      assert.ok(!b.lines.some((l) => /^\s*\d+\s*rounds?\s*:?\s*$/i.test(l) && parseLine(l).rounds === 1), `${b.name}: ${b.lines.join(' / ')}`);
      const p = parseSet(b.lines.join('\n'));
      if (p.structure.some((x) => x.type === 'rounds')) continue;
      ones += 1;
      // The same lines with a "1 round:" header where the round starts (after
      // the pre-set's rest, else after the reference rows) read the same.
      const body = b.lines.filter((l) => parseLine(l).type !== 'adjust');
      const typed = body.map(parseLine);
      const rest = typed.findIndex((l) => l.type === 'rest');
      const at = rest >= 0 ? rest + 1 : typed.findIndex((l) => l.type !== 'ref');
      const headed = [...body.slice(0, at), '1 round:', ...body.slice(at)];
      const h = parseSet(headed.join('\n'));
      assert.equal(h.structure.filter((x) => x.type === 'rounds').length, 1);
      for (let g = 0; g < CTX.groups.length; g++) assert.equal(setSeconds(p, g), setSeconds(h, g), `${b.name}: group ${g + 1} time`);
      assert.equal(setDistance(p), setDistance(h));
      assert.equal(b.distance, setDistance(h));
      assert.deepEqual(gearYards(p), gearYards(h));
      assert.deepEqual(b.gears, setGears(h));
      const adjust = b.lines.filter((l) => parseLine(l).type === 'adjust');
      assert.deepEqual(adjustmentPlan(headed, CTX, b.minutes), adjustmentPlan(body, CTX, b.minutes), `${b.name}: cut as one round`);
      assert.deepEqual(groupAdjustments(body, CTX, b.minutes), adjust);
      for (const line of adjust) assert.doesNotMatch(line, /\bRD\d/, `${b.name}: ${line}`);
    }
  }
  assert.ok(ones >= 6, `${ones} one-round blocks`);
  // A 20 min warm-up: one round, no header.
  const warm = generateBlock({ focus: 'warmup', minutes: 20, ctx: CTX });
  assert.ok(!warm.lines.some((l) => parseLine(l).type === 'rounds'), warm.lines.join(' / '));
  assert.ok(!warm.lines.some((l) => /\brounds?:/.test(l)), warm.lines.join(' / '));
  // Without a header the lines after the pre-set's rest are the round: a
  // made-up set cut in its main line and its speed reps, no RD named.
  const set = ['G3 pace 1:02 | 1:05 | 1:08 | 1:11', '4 x 150 free D1-4, G2 → G4   2:00 | 2:05 | 2:10 | 2:15', ':20 REST', '8 x 100 free G3   1:15 | 1:20 | 1:25 | 1:30', '6 x 50 free G6 sprint   1:00', '150 easy   3:00'];
  const minutes = Math.round(setSeconds(parseSet(set.join('\n')), 0) / 60);
  const cut = groupAdjustments(set, CTX, minutes);
  assert.deepEqual(cut, groupAdjustments([...set.slice(0, 3), '1 round:', ...set.slice(3)], CTX, minutes));
  assert.ok(cut.some((l) => /x 100 free|x 50 free|skip the free 50s/.test(l)), cut.join(' ; '));
  for (const line of cut) assert.doesNotMatch(line, /\bRD\d/, line);
});

test('writeLines never prints "1 rounds:"', () => {
  assert.equal(writeLines(['2 rounds:'], CTX, { scale: 0.5 })[0], '1 round:');
  assert.equal(writeLines(['3 Rounds:'], CTX, { scale: 0.34 })[0], '1 round:');
  assert.equal(writeLines(['10 rounds:'], CTX, { scale: 0.1 })[0], '1 round:');
  assert.equal(writeLines(['3 rounds:'], CTX, { scale: 0.5 })[0], '2 rounds:');
  // A block saved with "1 rounds:" (written by an earlier version) is printed right.
  assert.equal(writeLines(['1 rounds:', '4 x 50 free G3'], CTX, { retimeAll: true })[0], '1 round:');
  assert.equal(writeLines(['1 round:'], CTX)[0], '1 round:');
  for (let n = 2; n <= 8; n++) {
    for (const scale of [0.05, 0.1, 0.2, 0.25, 0.34, 0.5, 0.75, 1]) {
      const [head] = writeLines([`${n} rounds:`, '4 x 100 free G2'], CTX, { scale });
      assert.doesNotMatch(head, /^\s*1\s*rounds\b/i, `${n} rounds at ${scale}`);
      assert.equal(parseLine(head).type, 'rounds');
    }
  }
});

test('group adjustments cut kick in a kick block and more than one rep in long aerobic blocks', () => {
  const kick = generateBlock({ focus: 'kick', minutes: 60, ctx: CTX });
  const kickPlan = adjustmentPlan(kick.lines.filter((l) => parseLine(l).type !== 'adjust'), CTX, kick.minutes);
  kickPlan.seconds.forEach((s, g) => near(s, kick.minutes * 60, 60, `kick group ${g + 1}`));
  assert.ok(kickPlan.lines.some((l) => /kick|x 50 in RD/.test(l)), kickPlan.lines.join(' ; '));
  // A made-up long aerobic set: the slowest group needs more than one 100 off per round.
  const long = ['G3 pace 1:02 | 1:05 | 1:08 | 1:11', '2 x 400 free, G2 → G3 by 200   5:10 | 5:25 | 5:40 | 5:55', ':20 REST', '4 rounds:', '10 x 100 free G2   1:08 | 1:11 | 1:14 | 1:17', '150 easy   3:00'];
  const longMin = Math.round(setSeconds(parseSet(long.join('\n')), 0) / 60); // the fastest group's time
  const plan = adjustmentPlan(long, CTX, longMin);
  plan.seconds.forEach((s, g) => near(s, longMin * 60, 60, `aerobic group ${g + 1}: ${plan.lines.join(' ; ')}`));
  assert.ok(plan.lines.some((l) => /\b[0-8] x 100 in RD/.test(l)), `more than one 100 off a round: ${plan.lines.join(' ; ')}`);
  // A cut that would leave a group far under is passed over for a smaller one.
  const speedSet = ['G3 pace 1:02 | 1:05 | 1:08 | 1:11', '2 x 300 BR [G2 / G4]   5:30 | 6:15 | 6:30 | 6:50', ':20 REST', '3 rounds:', '4 x 50 BR G6   1:20 | 1:23 | 1:27 | 1:31', '150 easy   3:00'];
  const sp = adjustmentPlan(speedSet, CTX, Math.round(setSeconds(parseSet(speedSet.join('\n')), 0) / 60));
  assert.ok(!/start on #2/.test(sp.lines[0] || ''), `the 1:05 group does not drop a whole 300 BR: ${sp.lines.join(' ; ')}`);
});

test('a circuit share with fewer reps writes its group adjustments for the reps it prints', async () => {
  const { blockLines } = await import('../src/pw/render.js');
  const ctx = { learned: { writing: CTX }, state: { debriefs: [] } };
  const b = { ...generateBlock({ focus: 'aerobic', minutes: 40, ctx: CTX }), id: 'x', circuit: true };
  const swimsIn = (lines) => swimsOf(lines.filter((l) => parseLine(l).type !== 'adjust'));
  // Unscaled: the block's own adjustments.
  assert.deepEqual(blockLines(b, ctx, { scale: 1 }), writeLines(b.lines, CTX, { retimeAll: true }));
  for (const scale of [0.5, 0.33, 0.17]) {
    const lines = blockLines(b, ctx, { scale, minutes: Math.round(40 * scale) });
    // Most reps printed at each distance ("3 x 100 free" and "100 easy" are both 100s).
    const reps = new Map();
    for (const l of swimsIn(lines)) reps.set(l.distance, Math.max(reps.get(l.distance) ?? 0, l.reps));
    for (const l of lines.map(parseLine).filter((x) => x.type === 'adjust')) {
      // "3 x 100 in RD2": never more reps than the share prints.
      for (const m of l.text.matchAll(/(\d+) x (\d+)/g)) assert.ok(+m[1] < (reps.get(+m[2]) ?? Infinity), `${scale}: ${l.raw} vs ${[...reps].join(' ')}`);
    }
  }
  // PM: one send-off for everyone, so no group adjustments.
  assert.ok(!blockLines(b, ctx, { scale: 0.5 }, 'PM').some((l) => parseLine(l).type === 'adjust'));
  // Keyed by group names (no clock): still recognised and rewritten.
  const named = { ...b, source: 'coach', lines: [...b.lines.filter((l) => parseLine(l).type !== 'adjust'), 'Lane 4 - 7 x 100 in RD3'] };
  assert.ok(!blockLines(named, ctx, { scale: 0.33 }).some((l) => l.startsWith('Lane 4 - 7 x 100')));
});
