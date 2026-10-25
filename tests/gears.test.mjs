// Gear model: clock helpers, the Riegel fatigue curve, gear paces, rest,
// send-offs and CNS load. Every input here is made up, and the expected
// values are worked out from the published formulas: Riegel
// (T2 = T1 × (D2 / D1)^F), the pace for a duration
// (T/d × 100 × (T_G / T)^((F − 1) / F)) and rest = swim × ratio × (swim / 60)^k.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GEAR_MODEL, cnsPoints, cnsResidual, fmtClock, gearIndex, gearPaces, imPaces, makeGearModel, paceForDuration,
  paceOf, paceTable, parseClock, predictTime, racePredictions, restFor, roundSendOff, sendOff, strokeOffset, testForGearPace,
} from '../src/gears.js';

const tenth = (x) => Math.round(x * 10) / 10;
const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg || ''} ${actual} vs ${expected} (±${tol})`);
// "10:20.3" style: race times to the tenth.
const clockTenths = (s) => {
  const t = Math.round(s * 10) / 10;
  const m = Math.floor(t / 60);
  const r = (t - m * 60).toFixed(1).padStart(4, '0');
  return m ? `${m}:${r}` : r;
};

// ------------------------------------------------------------------ clock

test('fmtClock writes the coach\'s clock: :46, 1:15, 1:02:05', () => {
  assert.equal(fmtClock(46), ':46');
  assert.equal(fmtClock(5), ':05');
  assert.equal(fmtClock(0), ':00');
  assert.equal(fmtClock(75), '1:15');
  assert.equal(fmtClock(600), '10:00');
  assert.equal(fmtClock(3600), '1:00:00');
  assert.equal(fmtClock(3725), '1:02:05');
  assert.equal(fmtClock(518.1), '8:38', 'tenths are dropped');
  assert.equal(fmtClock(59.6), '1:00', 'rounds, then carries into the minute');
  assert.equal(fmtClock(-4), ':00', 'never negative');
  assert.equal(fmtClock(NaN), '');
  assert.equal(fmtClock(null), '');
  assert.equal(fmtClock(Infinity), '');
});

test('parseClock reads every clock shape and rejects the rest', () => {
  assert.equal(parseClock(':46'), 46);
  assert.equal(parseClock('1:15'), 75);
  assert.equal(parseClock('15:30'), 930);
  assert.equal(parseClock('1:02:05'), 3725);
  assert.equal(parseClock('0:58.0'), 58);
  assert.equal(parseClock('58.4'), 58.4);
  assert.equal(parseClock('  1:20 '), 80);
  assert.equal(parseClock(':30.5'), 30.5);
  assert.equal(parseClock('90'), 90);
  for (const bad of ['1:60', '1:02:65', '1:75:00', 'abc', '', '1:2:3', '-1:00', '1::00', null, undefined]) {
    assert.equal(parseClock(bad), null, `"${bad}" is not a clock`);
  }
});

test('fmtClock and parseClock round-trip whole seconds', () => {
  for (let s = 0; s < 4000; s += 7) assert.equal(parseClock(fmtClock(s)), s, `${s} s`);
  for (const s of [59, 60, 61, 599, 600, 3599, 3600, 3661]) assert.equal(parseClock(fmtClock(s)), s);
});

test('gearIndex reads G-numbers, including half gears', () => {
  assert.equal(gearIndex('G3'), 3);
  assert.equal(gearIndex('G3.5'), 3.5);
  assert.equal(gearIndex('G6'), 6);
  assert.equal(gearIndex('g3'), null);
  assert.equal(gearIndex('G'), null);
  assert.equal(gearIndex(''), null);
  assert.equal(gearIndex(null), null);
  assert.equal(gearIndex('pace'), null);
});

// ------------------------------------------------------ worked examples

test('Riegel: F = 1.07 and a 1650 in 17:40 → the 1000, 500 and 200', () => {
  const model = { fatigue: 1.07 };
  const swim = { distance: 1650, seconds: 17 * 60 + 40 };
  const r = racePredictions(model, swim);
  // 1060 × (1000 / 1650)^1.07 and 1060 × (500 / 1650)^1.07
  near(r[1000], 1060 * (1000 / 1650) ** 1.07, 1e-9, '1000 formula');
  assert.equal(clockTenths(r[1000]), '10:20.3');
  assert.equal(clockTenths(r[500]), '4:55.5');
  near(r[1650], 1060, 1e-9, '1650 is the test itself');
  // The 200 comes off the 500 with the default extra exponent: 0.4^(F + 0.03).
  near(r[200], r[500] * 0.4 ** (1.07 + DEFAULT_GEAR_MODEL.offset200), 1e-9, '200 formula');
  assert.equal(clockTenths(r[200]), '1:47.8');
  // The extra exponent makes the 200 faster than a plain Riegel 200 from the 1650.
  assert.ok(r[200] < predictTime(swim, 200, 1.07));
});

test('Riegel: the same 1650 gives each gear\'s pace per 100 for its duration', () => {
  const swim = { distance: 1650, seconds: 1060 };
  const p = gearPaces({ fatigue: 1.07 }, swim);
  const durations = { G2: 14400, 'G2.5': 7200, G3: 3600, 'G3.5': 1800, G4: 900, 'G4.5': 600, G5: 300, G6: 120 };
  for (const [g, d] of Object.entries(durations)) near(p[g], paceForDuration(swim, d, 1.07), 1e-9, g);
  assert.equal(tenth(p.G2), 76.2);
  assert.equal(tenth(p.G3), 69.6);
  assert.equal(tenth(p.G4), 63.6);
  assert.equal(tenth(p.G5), 59.2);
  assert.equal(tenth(p.G6), 55.7);
  // G1 is a fixed factor slower than G2.
  near(p.G1, p.G2 * 1.1, 1e-9, 'G1');
});

test('an explicit 200 offset replaces the default one', () => {
  const swim = { distance: 1650, seconds: 1060 };
  const auto = racePredictions({ fatigue: 1.07 }, swim);
  const flat = racePredictions({ fatigue: 1.07, offset200: 0 }, swim);
  near(flat[200], flat[500] * 0.4 ** 1.07, 1e-9, 'offset 0 = plain Riegel from the 500');
  assert.ok(flat[200] > auto[200], 'no offset = a slower 200');
  assert.equal(flat[1000], auto[1000], 'only the 200 moves');
  const steep = racePredictions({ fatigue: 1.07, offset200: 0.1 }, swim);
  assert.ok(steep[200] < auto[200], 'a bigger offset = a faster 200 (sprinter)');
  // A cleared field (null) falls back to the default.
  assert.deepEqual(racePredictions({ fatigue: 1.07, offset200: null }, swim), auto);
});

test('F = 1.08 and G3 at 1:12 per 100 → the implied 1650 and every gear', () => {
  const model = makeGearModel({ fatigue: 1.08 });
  const t = testForGearPace(model, 'G3', 72);
  assert.equal(t.distance, 1650);
  // T = (pace × d / 100 / T_G3^((F − 1) / F))^F
  near(t.seconds, (72 * 1650 / 100 / 3600 ** (0.08 / 1.08)) ** 1.08, 1e-9, 'inverse formula');
  assert.equal(clockTenths(t.seconds), '18:07.2');
  const p = gearPaces(model, t);
  near(p.G3, 72, 1e-9, 'G3 comes back exactly');
  assert.deepEqual(
    ['G2', 'G2.5', 'G3.5', 'G4', 'G4.5', 'G5', 'G6'].map((g) => tenth(p[g])),
    [79.8, 75.8, 68.4, 65.0, 63.1, 59.9, 56.0],
  );
});

test('rest per 100 = swim × ratio × (swim / 60)^0.5 with the default ratios', () => {
  const model = makeGearModel({ fatigue: 1.08 });
  const p = gearPaces(model, testForGearPace(model, 'G3', 72));
  const ratios = { G2: 0.04, 'G2.5': 0.07, G3: 0.1, 'G3.5': 0.17, G4: 0.3, G5: 0.8 };
  // e.g. G5: 59.9 × 0.8 × (59.9 / 60)^0.5 = 47.9 → 48
  const expected = { G2: 4, 'G2.5': 6, G3: 8, 'G3.5': 12, G4: 20, G5: 48 };
  for (const [g, ratio] of Object.entries(ratios)) {
    assert.equal(model.gears.find((x) => x.name === g).rest, ratio, `${g} ratio`);
    const swim = p[g];
    assert.equal(restFor(model, g, swim), Math.round(swim * ratio * (swim / 60) ** 0.5), `${g} formula`);
    assert.equal(restFor(model, g, swim), expected[g], `${g} rest per 100`);
  }
});

test('IM: a 400 IM in 4:50 with the default F_IM 1.06 → IM paces per 100', () => {
  const p = imPaces({}, 290);
  near(p.G3, paceForDuration({ distance: 400, seconds: 290 }, 3600, 1.06), 1e-9, 'G3 formula');
  assert.equal(clockTenths(p.G2), '1:30.4');
  assert.equal(clockTenths(p.G3), '1:23.6');
  assert.equal(clockTenths(p.G4), '1:17.3');
  assert.equal(clockTenths(p.G5), '1:12.6');
  // IM paces follow imFatigue, not the free F.
  assert.deepEqual(imPaces({ fatigue: 1.03 }, 290), p);
  assert.deepEqual(imPaces({ fatigue: 1.1 }, 290), p);
  const steeper = imPaces({ imFatigue: 1.09 }, 290);
  assert.ok(steeper.G2 > p.G2 && steeper.G6 < p.G6, 'a bigger IM fatigue spreads the gears');
});

test('gear paces get faster gear by gear, and a faster test is faster in every gear', () => {
  for (const fatigue of [1.03, 1.05, 1.08]) {
    const model = makeGearModel({ fatigue });
    const p = gearPaces(model, { distance: 1650, seconds: 1000 });
    const order = ['G1', 'G2', 'G2.5', 'G3', 'G3.5', 'G4', 'G4.5', 'G5', 'G6'];
    for (let i = 1; i < order.length; i++) assert.ok(p[order[i]] < p[order[i - 1]], `F ${fatigue}: ${order[i]} faster than ${order[i - 1]}`);
    const quick = gearPaces(model, { distance: 1650, seconds: 950 });
    for (const g of order) assert.ok(quick[g] < p[g]);
  }
  // A bigger F (sprinter) spreads the gears further apart.
  const t = { distance: 1650, seconds: 1000 };
  const d = gearPaces({ fatigue: 1.03 }, t), s = gearPaces({ fatigue: 1.07 }, t);
  assert.ok(s.G2 - s.G6 > d.G2 - d.G6);
});

test('paceForDuration is the test pace at the test\'s own duration', () => {
  const t = { distance: 1650, seconds: 1000 };
  near(paceForDuration(t, 1000, 1.05), 1000 / 16.5, 1e-9, 'own duration');
  assert.ok(paceForDuration(t, 3600, 1.05) > 1000 / 16.5, 'longer = slower');
  // F = 1 means no fatigue: every duration has the same pace.
  near(paceForDuration(t, 120, 1), paceForDuration(t, 14400, 1), 1e-9, 'F = 1');
});

test('testForGearPace inverts gearPaces for every gear and test distance', () => {
  for (const fatigue of [1.03, 1.05, 1.07]) {
    const model = makeGearModel({ fatigue });
    for (const gear of ['G1', 'G2', 'G2.5', 'G3', 'G3.5', 'G4', 'G4.5', 'G5', 'G6']) {
      for (const pace of [58, 66, 75]) {
        const t = testForGearPace(model, gear, pace);
        near(gearPaces(model, t)[gear], pace, 1e-6, `F ${fatigue} ${gear} ${pace}`);
      }
    }
    const t1000 = testForGearPace(model, 'G3', 70, 1000);
    assert.equal(t1000.distance, 1000);
    near(gearPaces(model, t1000).G3, 70, 1e-6, '1000 test');
  }
  assert.equal(testForGearPace({}, 'G9', 60), null);
  assert.equal(testForGearPace({}, 'fast', 60), null);
});

// ------------------------------------------------------------- the model

test('makeGearModel merges the coach\'s overrides onto the defaults', () => {
  const before = JSON.stringify(DEFAULT_GEAR_MODEL);
  const m = makeGearModel({
    fatigue: 1.08,
    gears: [{ name: 'G3', rest: 0.2 }, { name: 'G7', label: 'Made-up', duration: 60, rest: 3 }],
    strokes: { back: 6 },
    kinds: { kick: 20 },
    cns: { G4: 0.01 },
  });
  assert.equal(m.fatigue, 1.08);
  const g3 = m.gears.find((g) => g.name === 'G3');
  assert.equal(g3.rest, 0.2);
  assert.equal(g3.duration, 3600, 'other G3 fields keep their defaults');
  assert.equal(m.gears.find((g) => g.name === 'G2').rest, 0.04);
  assert.equal(m.gears.at(-1).name, 'G7', 'new gears are appended');
  assert.deepEqual(m.gears.slice(0, DEFAULT_GEAR_MODEL.gears.length).map((g) => g.name), DEFAULT_GEAR_MODEL.gears.map((g) => g.name));
  assert.equal(m.strokes.back, 6);
  assert.equal(m.strokes.breast, 12);
  assert.equal(m.kinds.kick, 20);
  assert.equal(m.kinds.pull, 2);
  assert.equal(m.cns.G4, 0.01);
  assert.equal(m.cns.G6, 0.25, 'other rates keep their defaults');
  assert.equal(JSON.stringify(DEFAULT_GEAR_MODEL), before, 'defaults are not mutated');
  // Idempotent: a merged model merges to itself.
  assert.deepEqual(makeGearModel(m), m);
  assert.deepEqual(makeGearModel(), makeGearModel(DEFAULT_GEAR_MODEL));
});

test('a number for rounding means that step for every rep', () => {
  assert.deepEqual(makeGearModel({ rounding: 1 }).rounding, { short: 1, long: 1, longFrom: 0 });
  assert.deepEqual(makeGearModel({ rounding: { longFrom: 200 } }).rounding, { short: 1, long: 5, longFrom: 200 });
});

test('paceOf interpolates half gears the model does not list', () => {
  const paces = { G2: 70, G3: 66, G4: 62, G5: 58, G6: 56 };
  assert.equal(paceOf(paces, 'G3'), 66);
  assert.equal(paceOf(paces, 'G3.5'), 64);
  assert.equal(paceOf(paces, 'G5.5'), 57);
  assert.equal(paceOf({ ...paces, 'G3.5': 63 }, 'G3.5'), 63, 'a listed half gear wins');
  assert.equal(paceOf(paces, 'G1'), null);
  assert.equal(paceOf(paces, 'G7'), null);
  assert.equal(paceOf(paces, 'easy'), null);
  assert.equal(paceOf({ G6: 56 }, 'G6.5'), 56, 'falls back to the gear it has');
});

test('restFor grows with the gear and the rep, never under a second', () => {
  assert.equal(restFor({}, 'G2', 90), 4); // 90 × 0.04 × 1.5^0.5 = 4.4
  assert.equal(restFor({}, 'G6', 60), 90); // 60 × 1.5 × 1
  assert.equal(restFor({}, 'G5.5', 60), 69, 'half gear between G5 (0.8) and G6 (1.5)');
  assert.equal(restFor({}, 'G1', 180), 6); // 180 × 0.02 × 3^0.5 = 6.2
  assert.equal(restFor({}, 'X', 60), 6, 'unknown gear rests like G3');
  assert.equal(restFor({}, 'G2', 5), 1, 'at least 1 s');
  // Longer reps rest more than in proportion (exponent 0.5) …
  assert.ok(restFor({}, 'G3', 240) > 4 * restFor({}, 'G3', 60));
  // … and with exponent 0 rest is a fixed share of the swim.
  assert.equal(restFor({ restExponent: 0 }, 'G3', 120), 12);
  assert.equal(restFor({ restExponent: 0 }, 'G3', 240), 24);
  // The coach's own ratio wins.
  assert.equal(restFor({ gears: [{ name: 'G3', rest: 0.25 }] }, 'G3', 60), 15);
});

test('strokeOffset adds the stroke and the kind', () => {
  assert.equal(strokeOffset({}), 0);
  assert.equal(strokeOffset({}, 'back'), 5);
  assert.equal(strokeOffset({}, 'breast', 'kick'), 30);
  assert.equal(strokeOffset({}, 'IM', 'pull'), 9);
  assert.equal(strokeOffset({}, 'free', 'drill'), 12);
  assert.equal(strokeOffset({}, 'sidestroke'), 5, 'unknown stroke counts as choice');
  assert.equal(strokeOffset({}, 'free', 'float'), 0);
  assert.equal(strokeOffset({ strokes: { fly: 8 } }, 'fly'), 8);
});

test('roundSendOff: whole seconds under 150, up to the next :05 from 150', () => {
  assert.equal(roundSendOff({}, 66.4, 100), 66);
  assert.equal(roundSendOff({}, 66.6, 100), 67);
  assert.equal(roundSendOff({}, 149.6, 100), 150);
  assert.equal(roundSendOff({}, 151, 200), 155);
  assert.equal(roundSendOff({}, 155, 200), 155);
  assert.equal(roundSendOff({}, 150.2, 200), 150, 'a fraction over :00 stays on :00');
  assert.equal(roundSendOff({}, 156.2, 150), 160, '150s are long reps');
  assert.equal(roundSendOff({ rounding: 1 }, 156.2, 200), 156);
  assert.equal(roundSendOff({ rounding: { long: 1 } }, 156.2, 200), 156, 'the :05 toggle off');
  assert.equal(roundSendOff({ rounding: { short: 5 } }, 66.4, 100), 65);
});

test('sendOff = swim at the gear\'s pace (stroke, kind, adjust) + the gear\'s rest, rounded', () => {
  const paces = { G2: 75, G3: 71, G4: 67, G5: 64, G6: 61 };
  const expect = (per100, gear, distance) => {
    const swim = per100 * distance / 100;
    return roundSendOff({}, swim + restFor({}, gear, swim), distance);
  };
  assert.equal(sendOff({}, paces, { gear: 'G3', distance: 100 }), 79); // 71 + 71 × 0.1 × (71 / 60)^0.5 = 71 + 8
  assert.equal(sendOff({}, paces, { gear: 'G3', distance: 100, stroke: 'back' }), expect(76, 'G3', 100));
  assert.equal(sendOff({}, paces, { gear: 'G3', distance: 100, kind: 'kick' }), expect(89, 'G3', 100));
  assert.equal(sendOff({}, paces, { gear: 'G3', distance: 100, adjust: 2 }), expect(73, 'G3', 100));
  assert.equal(sendOff({}, paces, { gear: 'G2', distance: 200 }), expect(75, 'G2', 200));
  assert.equal(sendOff({}, paces, { gear: 'G2', distance: 200 }) % 5, 0, '200s on the :05');
  assert.equal(sendOff({}, paces, { gear: 'G3.5', distance: 100 }), expect(69, 'G3.5', 100), 'half gear');
  assert.equal(sendOff({}, paces, { gear: 'G7', distance: 100 }), null);
  // Stroke paces (IM) replace the free pace and its stroke offset; kind still counts.
  const im = { G3: 82 };
  assert.equal(sendOff({}, paces, { gear: 'G3', distance: 100, stroke: 'IM', strokePaces: im }), expect(82, 'G3', 100));
  assert.equal(sendOff({}, paces, { gear: 'G3', distance: 100, stroke: 'IM', kind: 'kick', strokePaces: im }), expect(100, 'G3', 100));
  assert.equal(sendOff({}, paces, { gear: 'G3', distance: 100, stroke: 'IM', strokePaces: {} }), expect(78, 'G3', 100), 'no IM pace → free + IM offset');
  // Harder gears give longer send-offs for the same rep once rest is counted.
  assert.ok(sendOff({}, paces, { gear: 'G5', distance: 100 }) > sendOff({}, paces, { gear: 'G3', distance: 100 }));
});

test('paceTable lists every gear with its label and pace', () => {
  const t = { distance: 1650, seconds: 1000 };
  const rows = paceTable({ fatigue: 1.07 }, t);
  const p = gearPaces({ fatigue: 1.07 }, t);
  assert.deepEqual(rows.map((r) => r.gear), DEFAULT_GEAR_MODEL.gears.map((g) => g.name));
  for (const r of rows) {
    assert.equal(r.pace, p[r.gear]);
    assert.ok(r.label && r.feel);
  }
});

// ------------------------------------------------------------------- load

test('cnsPoints = Σ yards × the gear\'s rate', () => {
  assert.equal(cnsPoints({}, { G5: 100, G6: 50 }), 17.5); // 100 × 0.05 + 50 × 0.25
  assert.equal(cnsPoints({}, { G2: 3000, G1: 400 }), 0, 'aerobic work costs nothing');
  assert.equal(cnsPoints({}, { G3: 1000 }), 2);
  assert.equal(cnsPoints({}, { 'G4.5': 100 }), 2.5);
  // Each whole gear from G3 costs 5× the one below it.
  const d = DEFAULT_GEAR_MODEL.cns;
  for (const [a, b] of [['G3', 'G4'], ['G4', 'G5'], ['G5', 'G6']]) near(d[b] / d[a], 5, 1e-9, `${b} / ${a}`);
  assert.equal(cnsPoints({}, {}), 0);
  assert.equal(cnsPoints({}, null), 0);
  assert.equal(cnsPoints({ cns: { G5: 0.5 } }, { G5: 100 }), 50, 'the coach\'s own rates');
  assert.equal(cnsPoints({}, { kick: 100 }), 0, 'not a gear → G2 rate');
});

test('cnsResidual halves every 12 hours and ignores sessions still to come', () => {
  assert.equal(cnsResidual({}, [{ at: 0, points: 40 }], 0), 40);
  assert.equal(cnsResidual({}, [{ at: 0, points: 40 }], 12), 20);
  assert.equal(cnsResidual({}, [{ at: 0, points: 40 }, { at: 12, points: 20 }], 24), 20);
  assert.equal(cnsResidual({}, [{ at: 0, points: 40 }, { at: 30, points: 20 }], 24), 10);
  assert.equal(cnsResidual({ cnsHalfLifeHours: 6 }, [{ at: 0, points: 40 }], 12), 10);
  assert.equal(cnsResidual({}, [], 24), 0);
});
