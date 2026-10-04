// Single-lap finish timing, end to end on synthetic video, plus the pieces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RaceSim } from './support/race-sim.mjs';
import {
  FinishSession, LaneFinish, defaultRaceSetup, formatRaceTime, raceCSV, raceRecord, raceRows,
} from '../src/finish.js';

// Run a heat: Start pressed at `startAt`, frames until everyone is done.
function race({ view = 'head', finish = 'touch', at = 25, depth = 5, lanes = 4, racers, fps = 30, startAt = 1, width = 320, seed = 3, track }) {
  const sim = new RaceSim({ view, lanes, length: 25, width, height: Math.round(width * 0.625), seed });
  const rs = racers.map((r) => sim.addRacer(r));
  const lane = {};
  for (let i = 0; i < lanes; i++) lane[i] = { track: track ? track.includes(i) : rs.some((r) => r.lane === i && !r.distractor) };
  const setup = { ...defaultRaceSetup(), view, finish, corners: sim.band(at, depth), depth, lanes, lane, ignore: 2 };
  const session = new FinishSession(setup, sim.w, sim.h);
  const end = Math.max(...rs.filter((r) => !r.distractor).map((r) => sim.reaches(r, at))) + 2;
  const seen = [];
  for (let k = 0; k * (1 / fps) < end; k++) {
    // Frame times wobble a little, as real cameras' do.
    const t = k / fps + (sim.rand() - 0.5) * 0.004;
    if (!session.started && t >= startAt) session.start(startAt);
    seen.push(...session.process(sim.render(t), t));
  }
  return { sim, rs, session, seen, startAt };
}

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: got ${a?.toFixed?.(3) ?? a}, expected ${b.toFixed(3)} ±${tol}`);

test('head-on: hand touch on the wall in each lane', () => {
  const { sim, rs, session, seen, startAt } = race({
    racers: [
      { lane: 0, speed: 1.9, t0: 1.6, from: 0 },
      { lane: 1, speed: 1.6, t0: 1.7, from: 0 },
      { lane: 3, speed: 1.3, t0: 1.6, from: 0, rate: 36 },
    ],
  });
  assert.equal(seen.length, 3);
  for (const r of rs) {
    const res = session.result(r.lane);
    assert.equal(res.method, 'auto');
    near(res.time, sim.touchTime(r) - startAt, 0.15, `lane ${r.lane + 1}`);
  }
  assert.equal(session.lanes[2], null, 'unwatched lane');
  assert.ok(session.allDone);
});

test('side-on: touch, swimmers crossing the picture', () => {
  const { sim, rs, session } = race({
    view: 'side',
    racers: [
      { lane: 0, speed: 1.7, t0: 1.5, from: 0 },
      { lane: 2, speed: 1.45, t0: 1.6, from: 0 },
    ],
  });
  for (const r of rs) near(session.result(r.lane).time, sim.touchTime(r) - 1, 0.15, `lane ${r.lane + 1}`);
});

test('side-on: head crossing a line mid-pool, arms reaching ahead', () => {
  // At the app's own processing width: in a far lane seen from the side the
  // head is only a few pixels tall.
  const { sim, rs, session } = race({
    view: 'side',
    finish: 'line',
    at: 20,
    depth: 4,
    width: 480,
    racers: [
      { lane: 1, speed: 1.8, t0: 1.5, from: 0, through: true },
      { lane: 3, speed: 1.4, t0: 1.5, from: 0, through: true, rate: 40 },
    ],
  });
  // Timed on the head, not the hands that cross up to 0.6 m earlier.
  for (const r of rs) near(session.result(r.lane).time, sim.reaches(r, 20) - 1, 0.08, `lane ${r.lane + 1}`);
});

test('head-on: head crossing a line (e.g. 15 m mark)', () => {
  const { sim, rs, session } = race({
    finish: 'line',
    at: 15,
    depth: 4,
    racers: [
      { lane: 0, speed: 1.7, t0: 1.5, from: 0, through: true },
      { lane: 2, speed: 1.3, t0: 1.5, from: 0, through: true, rate: 34 },
    ],
  });
  for (const r of rs) near(session.result(r.lane).time, sim.reaches(r, 15) - 1, 0.08, `lane ${r.lane + 1}`);
});

test('the head is followed through the arm strokes', () => {
  const lf = new LaneFinish({ mode: 'line', depth: 5, over: 1.5 });
  // Head at 1.5 m/s reaching the line at t = 3; a hand 0.6 m ahead half the time.
  for (let t = 0; t < 2.5; t += 1 / 30) {
    const head = 4.5 - 1.5 * t;
    const reach = (t * 1.6) % 1 < 0.5 ? 0.6 : 0;
    lf.push(t, { lead: Math.floor((head - reach) / 0.1) * 0.1 + 0.05 }, false); // centre of the cell it is in
  }
  near(lf.head, 4.5 - 1.5 * 2.47, 0.08, "head estimate");
});

test('works at 25 fps and with a lower-resolution picture', () => {
  const { sim, rs, session } = race({
    fps: 25,
    width: 240,
    racers: [{ lane: 1, speed: 1.75, t0: 1.6, from: 0 }, { lane: 2, speed: 1.5, t0: 1.6, from: 0 }],
  });
  for (const r of rs) near(session.result(r.lane).time, sim.touchTime(r) - 1, 0.15, `lane ${r.lane + 1}`);
});

test('something sitting at the wall is not a finish', () => {
  const { session, seen } = race({
    racers: [
      { lane: 0, speed: 1.6, t0: 1.6, from: 0 },
      { lane: 2, distractor: true, from: 24.4 },
    ],
    track: [0, 2],
  });
  assert.equal(seen.length, 1);
  assert.equal(session.result(2), null);
});

test('an empty lane between two swimmers stays empty', () => {
  for (const view of ['head', 'side']) {
    const { session, seen } = race({
      view,
      racers: [{ lane: 0, speed: 1.7, t0: 1.6, from: 0 }, { lane: 2, speed: 1.6, t0: 1.6, from: 0 }],
      track: [0, 1, 2],
    });
    assert.equal(session.result(1), null, view);
    assert.equal(seen.length, 2, view);
  }
});

test('LaneFinish: needs an approach, ignores finishes before arming, manual and clear', () => {
  const lf = new LaneFinish({ mode: 'touch', depth: 5 });
  // Something appears right at the wall: no approach seen.
  for (let t = 0; t < 1; t += 0.04) assert.equal(lf.push(t, { lead: 0.05 }, true), null);
  lf.clear();
  // Approach at 2 m/s reaching the wall at t = 2, but the clock isn't armed.
  const at = (t) => ({ lead: Math.max(0.05, 4 - 2 * t) });
  for (let t = 0; t < 2.5; t += 0.04) assert.equal(lf.push(t, at(t), false), null);
  lf.clear();
  let res = null;
  for (let t = 0; t < 2.5 && !res; t += 1 / 30) res = lf.push(t, at(t), true);
  near(res.t, 1.975, 0.04, 'touch');
  lf.manual(2.3);
  assert.deepEqual(lf.result, { t: 2.3, method: 'manual' });
  lf.clear();
  assert.equal(lf.result, null);
});

test('heat record, sheet rows and CSV', () => {
  const setup = { ...defaultRaceSetup(), lanes: 3, firstLane: 4, lane: { 1: { name: 'Sam' }, 2: { track: false } }, event: '50 free', distance: 50 };
  const fake = {
    setup,
    lanes: [{}, {}, null],
    result: (i) => (i === 0 ? { time: 31.234, method: 'auto' } : null),
  };
  const rec = raceRecord(fake, { heat: 2, date: new Date(2026, 9, 4, 9, 5) });
  assert.deepEqual(rec.results.map((r) => [r.lane, r.name, r.time]), [[4, 'Lane 4', 31.234], [5, 'Sam', null]]);
  const rows = raceRows(rec);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, '2026-10-04');
  assert.equal(rows[0].time, '31.23');
  assert.equal(rows[0].seconds, 31.23);
  assert.equal(rows[0].method, 'camera');
  assert.equal(rows[0].distance, '50 m');
  assert.match(rows[0].id, /\/L4$/);
  const csv = raceCSV([rec]).split('\n');
  assert.equal(csv.length, 2);
  assert.match(csv[1], /^2026-10-04,09:05,50 free,2,4,Lane 4,50 m,Freestyle,31.23,31.23,camera,/);
  assert.equal(formatRaceTime(65.4), '1:05.40');
  assert.equal(formatRaceTime(9.999), '10.00');
});
