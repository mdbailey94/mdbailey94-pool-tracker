// Single-lap timing at a finish: the clock starts when the coach presses
// Start, and each lane stops when its swimmer's hand reaches the wall
// (touch) or their leading edge crosses a line across the pool (line).
//
// The coach marks a band of water in front of the finish with four dots: two
// on the finish line and two on a parallel line a few metres back (the
// backstroke flags are handy). The camera can look down the pool at
// swimmers coming towards it, or from the side at swimmers crossing the
// picture: the band is sampled into a top-down grid either way (as in the
// lap tracker), so everything here works in metres from the finish line.
// Per lane, the edge of the swimmer nearest the finish is followed as it
// closes in, and the finish time is where it meets the line, interpolated
// between frames. Pure (no DOM), so it can be tested on synthetic video.

import { cornersValid, homography } from './homography.js';
import { Background, cellIndex, makeGeometry, Rectifier } from './grid.js';
import { YARD } from './session.js';

export const CELL = 0.1; // m along the band; sets how finely the edge is located
const OVERSHOOT = 1; // m of water past a line finish, to see the swimmer cross it
const ACROSS = 12; // strips across each lane: narrow enough that an arm fills a good part of one

export const RACE_STROKES = ['Freestyle', 'Backstroke', 'Breaststroke', 'Butterfly', 'IM', 'Kick', 'Other'];

// Default dots (normalised image coordinates) for the two camera views. In
// order: finish line at the first lane, finish line at the last lane, back
// line at the last lane, back line at the first lane.
export const VIEW_CORNERS = {
  // Looking down the pool, swimmers coming towards the camera.
  head: [[0.06, 0.86], [0.94, 0.86], [0.8, 0.42], [0.2, 0.42]],
  // From the side, swimmers crossing left to right; lane 1 nearest.
  side: [[0.82, 0.92], [0.74, 0.3], [0.46, 0.3], [0.42, 0.92]],
};

export function defaultRaceSetup() {
  return {
    view: 'head',
    finish: 'touch', // 'touch' (hand on the wall) or 'line' (crossing a line)
    corners: VIEW_CORNERS.head.map((p) => [...p]),
    depth: 5, // distance from the finish line back to dots 3–4
    unit: 'm',
    lanes: 4,
    firstLane: 1,
    lane: {}, // lane index → { track, name }
    distance: 25,
    stroke: 'Freestyle',
    event: '',
    ignore: 5, // s after Start in which nothing counts as a finish
  };
}

export const raceLane = (setup, i) => ({ track: true, name: '', ...(setup.lane?.[i] || {}) });
export const raceLaneLabel = (setup, i) => raceLane(setup, i).name || `Lane ${setup.firstLane + i}`;
const metres = (setup, v) => v * (setup.unit === 'yd' ? YARD : 1);

// Band coordinates → normalised image coordinates. x = lanes across
// (0 … lanes); y = metres from `over` past the finish line back to the far
// dots, so the finish line itself is at y = over.
export function bandToImage(corners, lanes, depth, over = 0) {
  return homography([[0, over], [lanes, over], [lanes, over + depth], [0, over + depth]], corners);
}

// The swimmer nearest the finish in one lane: the closest stretch of the band
// that isn't water and is big enough to be a swimmer rather than a ripple.
// Returns { lead, back, mass }: metres from the finish line to the near and
// far ends of the swimmer (negative = past the line), or null.
export function leadingEdge(fg, geom, lane, over = 0, { rowOn = 0.6, minMass = 5, gap = 0.4 } = {}) {
  const { nx, across, cellLen } = geom;
  const row = new Float32Array(nx);
  for (let j = 0; j < across; j++) {
    const base = cellIndex(geom, lane, j, 0);
    for (let i = 0; i < nx; i++) row[i] += fg[base + i];
  }
  const maxGap = Math.max(1, Math.round(gap / cellLen));
  for (let i = 0; i < nx;) {
    if (row[i] <= rowOn) { i++; continue; }
    let last = i, mass = 0;
    for (let j = i; j < nx && j - last <= maxGap; j++) {
      if (row[j] > rowOn) last = j;
      mass += row[j];
    }
    // Middle of the first row: the true edge lies somewhere inside it.
    if (mass >= minMass) return { lead: (i + 0.5) * cellLen - over, back: (last + 1) * cellLen - over, mass };
    i = last + 1;
  }
  return null;
}

// One lane's finish. A finish needs the swimmer to be seen closing in on the
// line (not just something sitting at the wall, like the last heat's
// swimmer).
//
// Touch: the hand stops dead on the wall, so the touch is called once the
// edge has come in close and stopped, and timed where the approach meets
// that resting place. The edge seen is always a little behind the
// fingertips (a thin hand barely shows, and far corners of the picture are
// coarse), but it's behind by the same amount moving or stopped, so that
// cancels out.
//
// Line: the time the edge reaches the line, from the approach just before.
export class LaneFinish {
  constructor({ mode = 'touch', depth = 5, cellLen = CELL } = {}) {
    this.mode = mode;
    this.cell = cellLen;
    this.zone = Math.min(1, 0.3 * depth); // a stop this close to the wall is the touch
    this.travel = Math.min(1, 0.4 * depth); // must have come at least this far
    this.hist = [];
    this.lead = null;
    this.result = null; // { t, method: 'auto' | 'manual' }
  }

  // Leading edge `det` (or null) measured at time t; `armed` once the clock
  // is running. Returns the result the moment the finish is seen.
  push(t, det, armed) {
    if (this.result) return null;
    this.lead = det ? det.lead : null;
    if (det) this.hist.push({ t, lead: det.lead });
    while (this.hist.length && this.hist[0].t < t - 3) this.hist.shift();
    if (!det || !armed) return null;
    const farthest = Math.max(...this.hist.map((h) => h.lead));
    if (farthest - det.lead < this.travel) return null;
    const at = this.mode === 'touch' ? this.touch(t, det.lead) : this.cross(t, det.lead);
    if (at === null) return null;
    this.result = { t: at, method: 'auto' };
    return this.result;
  }

  touch(t, lead) {
    if (lead > this.zone) return null;
    // Stopped: held within a cell for a moment (longer than the pause
    // between two arm strokes).
    const recent = this.hist.filter((h) => h.t >= t - 0.3);
    const leads = recent.map((h) => h.lead);
    if (t - recent[0].t < 0.27 || Math.max(...leads) - Math.min(...leads) > 1.01 * this.cell) return null;
    // At rest the edge can flicker between two neighbouring cells: the
    // resting place is their average, reached somewhere between first
    // entering the farther one and first entering the nearer one.
    const lo = Math.min(...leads), hi = Math.max(...leads);
    const level = leads.reduce((a, b) => a + b, 0) / leads.length;
    let k = this.hist.length - 1;
    while (k > 0 && this.hist[k - 1].lead <= hi + 0.01) k--;
    const arrived = this.hist.slice(k).find((h) => h.lead <= lo + 0.01).t;
    const approach = this.hist.slice(0, k).filter((h) => h.t >= this.hist[k].t - 0.6);
    const est = meets(approach, level);
    if (est === null) return arrived;
    return Math.min(arrived, Math.max(approach[approach.length - 1].t, est));
  }

  cross(t, lead) {
    if (lead > 0) return null;
    const before = this.hist.filter((h) => h.t < t && h.lead > 0);
    const prev = before[before.length - 1];
    if (!prev) return t;
    const est = meets([...before.filter((h) => h.t >= t - 0.5), { t, lead }], 0);
    if (est !== null) return Math.min(t, Math.max(prev.t, est));
    // Too few points for a fit: between the last two measurements.
    return prev.t + (prev.lead / (prev.lead - lead)) * (t - prev.t);
  }

  manual(t) {
    this.result = { t, method: 'manual' };
    return this.result;
  }

  clear() {
    this.result = null;
    this.hist = [];
  }
}

// When a straight-line fit of the approach (which evens out the stop-start
// of arm strokes) reaches `level` metres from the line; null if it isn't
// clearly closing in.
function meets(pts, level) {
  if (pts.length < 3) return null;
  const n = pts.length;
  const mt = pts.reduce((s, p) => s + p.t, 0) / n;
  const ml = pts.reduce((s, p) => s + p.lead, 0) / n;
  let sxy = 0, sxx = 0;
  for (const p of pts) { sxy += (p.t - mt) * (p.lead - ml); sxx += (p.t - mt) ** 2; }
  const slope = sxx > 0 ? sxy / sxx : 0;
  return slope < -0.2 ? mt + (level - ml) / slope : null;
}

export class FinishSession {
  constructor(setup, width, height) {
    if (!cornersValid(setup.corners)) throw new Error('The dots cross over. Drag them back into order.');
    this.setup = setup;
    this.depth = metres(setup, setup.depth);
    if (!(this.depth >= 1)) throw new Error('Set how far dots 3 and 4 are from the finish line (at least 1 m).');
    this.over = setup.finish === 'line' ? OVERSHOOT : 0;
    this.geom = makeGeometry({ lanes: setup.lanes, length: this.over + this.depth, cellLen: CELL, across: ACROSS });
    this.H = bandToImage(setup.corners, setup.lanes, this.depth, this.over);
    this.rect = new Rectifier(this.H, this.geom, width, height);
    this.bg = new Background(this.geom.nCells, { warmup: 2, warmFrames: 16 });
    this.lanes = Array.from({ length: setup.lanes }, (_, i) => (raceLane(setup, i).track
      ? new LaneFinish({ mode: setup.finish, depth: this.depth, cellLen: this.geom.cellLen })
      : null));
    this.t = null;
    this.prevT = null;
    this.startT = null;
    this.fg = null;
  }

  get learning() { return !this.bg.ready; }
  get started() { return this.startT !== null; }
  get allDone() { return this.lanes.every((lf) => !lf || lf.result); }

  // Press of the Start button, on the same clock as the frames.
  start(t) {
    this.startT = t;
    this.lanes.forEach((lf) => lf?.clear());
  }

  // Process one RGBA frame at time t (seconds). Returns lanes that finished.
  process(rgba, t) {
    const cells = this.rect.sample(rgba);
    this.t = t;
    if (!this.bg.ready) {
      this.bg.learn(cells, t);
      this.prevT = t;
      return [];
    }
    this.fg = this.bg.update(cells, t);
    // A cell only counts as swimmer once it has differed in two frames
    // running, so the edge seen now is where the swimmer was a frame ago.
    const tm = this.prevT ?? t;
    this.prevT = t;
    const armed = this.started && tm >= this.startT + (this.setup.ignore || 0);
    const done = [];
    this.lanes.forEach((lf, i) => {
      if (!lf) return;
      const r = lf.push(tm, leadingEdge(this.fg, this.geom, i, this.over), armed);
      if (r) done.push(this.result(i));
    });
    return done;
  }

  // Coach taps the lane's finish by hand (detection missed it).
  manualFinish(lane, t = this.t) {
    if (!this.started || !this.lanes[lane]) return null;
    this.lanes[lane].manual(t);
    return this.result(lane);
  }

  // Throw away a lane's finish (a false one) and watch for it again.
  clearFinish(lane) {
    this.lanes[lane]?.clear();
  }

  result(i) {
    const lf = this.lanes[i];
    if (!lf?.result) return null;
    return { lane: i, label: raceLaneLabel(this.setup, i), time: lf.result.t - this.startT, method: lf.result.method };
  }

  snapshot() {
    const { t } = this;
    return {
      t,
      learning: this.learning ? this.bg.progress(t ?? 0) : null,
      // Stops on the last swimmer in.
      clock: !this.started || t === null ? null
        : this.allDone ? Math.max(...this.lanes.map((lf, i) => (lf ? this.result(i).time : 0)))
          : Math.max(0, t - this.startT),
      lanes: this.lanes.map((lf, i) => (lf ? { lane: i, label: raceLaneLabel(this.setup, i), lead: lf.lead, result: this.result(i) } : null)),
    };
  }
}

// ss.hh or m:ss.hh (race times are read to the hundredth).
export function formatRaceTime(sec) {
  if (!Number.isFinite(sec)) return '–';
  const cs = Math.round(Math.abs(sec) * 100);
  const m = Math.floor(cs / 6000);
  const rest = ((cs % 6000) / 100).toFixed(2);
  return `${sec < 0 ? '-' : ''}${m ? `${m}:${rest.padStart(5, '0')}` : rest}`;
}

// A saved heat: who swam, and their times.
export function raceRecord(session, { heat = 1, date = new Date() } = {}) {
  const { setup } = session;
  const results = session.lanes.map((lf, i) => {
    if (!lf) return null;
    const r = session.result(i);
    return { lane: setup.firstLane + i, name: raceLaneLabel(setup, i), time: r ? r.time : null, method: r ? r.method : null };
  }).filter(Boolean);
  return {
    id: date.toISOString(),
    date: date.toISOString(),
    heat,
    event: setup.event || '',
    distance: setup.distance,
    unit: setup.unit,
    stroke: setup.stroke,
    results,
  };
}

const pad = (n) => String(n).padStart(2, '0');

// One row per finished swimmer, as sent to the sheet (and in the CSV).
export function raceRows(record) {
  const d = new Date(record.date);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeOfDay = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return record.results.filter((r) => Number.isFinite(r.time)).map((r) => ({
    id: `${record.id}/L${r.lane}`,
    date,
    timeOfDay,
    event: record.event,
    heat: record.heat,
    lane: r.lane,
    swimmer: r.name,
    distance: `${record.distance} ${record.unit}`,
    stroke: record.stroke,
    time: formatRaceTime(r.time),
    seconds: Math.round(r.time * 100) / 100,
    method: r.method === 'manual' ? 'manual' : 'camera',
  }));
}

export const RACE_COLUMNS = [
  ['date', 'Date'], ['timeOfDay', 'Time of day'], ['event', 'Event'], ['heat', 'Heat'], ['lane', 'Lane'],
  ['swimmer', 'Swimmer'], ['distance', 'Distance'], ['stroke', 'Stroke'], ['time', 'Time'], ['seconds', 'Seconds'],
  ['method', 'Timing'], ['id', 'ID'],
];

export function raceCSV(records) {
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const rows = [RACE_COLUMNS.map(([, h]) => h)];
  for (const rec of records) for (const r of raceRows(rec)) rows.push(RACE_COLUMNS.map(([k]) => r[k] ?? ''));
  return rows.map((r) => r.map(q).join(',')).join('\n');
}
