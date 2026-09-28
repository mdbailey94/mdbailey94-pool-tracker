// End to end: synthetic pool video → lengths, split times and stroke rates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoolSim, planSwimmer } from './support/pool-sim.mjs';
import { PoolSession, sessionCSV, sessionRecord } from '../src/session.js';

function simulate({ L = 25, lanes = 4, swimmers, laneSetup = {}, fps = 25, clockAt = null, width = 240 }) {
  const sim = new PoolSim({ lanes, length: L, width, height: Math.round(width * 0.625) });
  const plans = swimmers.map((s) => sim.add(planSwimmer({ length: L, ...s })));
  const lane = {};
  for (let i = 0; i < lanes; i++) lane[i] = { track: plans.some((p) => p.lane === i), ...(laneSetup[i] || {}) };
  const setup = { corners: sim.corners, length: L, unit: 'm', lanes, firstLane: 1, lane };
  const session = new PoolSession(setup, sim.w, sim.h);
  const end = Math.max(...plans.map((p) => p.end)) + 6;
  for (let t = 0; t < end; t += 1 / fps) {
    if (clockAt !== null && session.clockStart === null && t >= clockAt) session.startClock(clockAt);
    session.process(sim.render(t), t);
  }
  session.finish();
  return { session, plans };
}

const truthSplits = (p) => p.walls.slice(1).map((w, i) => w.t - p.walls[i].t);
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: got ${a.toFixed?.(2) ?? a}, expected ${b.toFixed?.(2) ?? b} ±${tol}`);

test('one swimmer per lane: every length, split times, stroke rate and type', () => {
  const { session, plans } = simulate({
    swimmers: [
      { lane: 0, lengths: 4, speed: 1.6, stroke: 'free', rate: 48, start: 6 },
      { lane: 2, lengths: 4, speed: 1.2, stroke: 'breast', rate: 38, start: 7, dwell: 1.0 },
    ],
    clockAt: 6,
  });
  for (const plan of plans) {
    const [sw] = session.lanes[plan.lane].swimmers;
    assert.equal(sw.lengths.length, 4, `lane ${plan.lane} lengths`);
    const truth = truthSplits(plan);
    sw.lengths.forEach((len, i) => {
      // Lengths after the first are touch to touch; the first runs from the
      // clock (which only one swimmer really started on).
      if (i > 0 || plan.walls[0].t === 6) near(len.time, truth[i], 0.4, `lane ${plan.lane} length ${i + 1}`);
      near(len.rate, plan.rate, 1.5, `lane ${plan.lane} stroke rate`);
      assert.equal(len.family, plan.stroke === 'free' ? 'alternating' : 'simultaneous');
    });
    // Strokes per length: hand entries on the surface.
    const surface = (25 - 4) / (plan.stroke === 'free' ? 1.6 : 1.2);
    const perStroke = 60 / plan.rate / (plan.stroke === 'free' ? 2 : 1);
    sw.lengths.slice(1).forEach((len) => near(len.strokes, surface / perStroke, 2, `lane ${plan.lane} stroke count`));
  }
  assert.equal(session.lanes[1], null, 'untracked lanes are skipped');
});

test('two swimmers sharing a lane (circle swimming) keep their own times and rates', () => {
  const { session, plans } = simulate({
    lanes: 3,
    swimmers: [
      { lane: 1, lengths: 4, speed: 1.5, stroke: 'free', rate: 44, start: 6, lateral: -0.2 },
      { lane: 1, lengths: 4, speed: 1.5, stroke: 'free', rate: 50, start: 14, lateral: -0.2 },
    ],
    laneSetup: { 1: { swimmers: 2 } },
  });
  const sws = session.lanes[1].swimmers;
  assert.equal(sws.length, 2);
  sws.forEach((sw, k) => {
    const plan = plans[k];
    assert.equal(sw.lengths.length, 4, `swimmer ${k} lengths`);
    const truth = truthSplits(plan);
    sw.lengths.slice(1, 3).forEach((len, i) => near(len.time, truth[i + 1], 0.5, `swimmer ${k} length ${i + 2}`));
    sw.lengths.forEach((len) => near(len.rate, plan.rate, 1.5, `swimmer ${k} rate`));
  });
});

test('50 m pool at 15 fps', () => {
  const { session, plans } = simulate({
    L: 50,
    lanes: 3,
    fps: 15,
    swimmers: [{ lane: 1, lengths: 3, speed: 1.5, stroke: 'free', rate: 44, start: 6 }],
  });
  const [sw] = session.lanes[1].swimmers;
  const truth = truthSplits(plans[0]);
  assert.equal(sw.lengths.length, 3);
  sw.lengths.slice(1).forEach((len, i) => near(len.time, truth[i + 1], 0.5, `length ${i + 2}`));
  sw.lengths.forEach((len) => near(len.rate, 44, 1.5, 'rate'));
});

test('session record and CSV export', () => {
  const { session } = simulate({ swimmers: [{ lane: 0, lengths: 2, speed: 1.6, stroke: 'free', rate: 48, start: 6 }], clockAt: 6 });
  session.setup.lane[0].name = 'Sam, "fast" lane';
  const rec = sessionRecord(session, new Date('2026-09-28T07:00:00Z'));
  assert.equal(rec.swimmers.length, 1);
  assert.equal(rec.swimmers[0].lengths.length, 2);
  const csv = sessionCSV(rec).split('\n');
  assert.equal(csv.length, 3);
  assert.match(csv[1], /^"Sam, ""fast"" lane",1,25 m,/);
});
