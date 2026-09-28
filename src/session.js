// One tracking session: camera frames in, swimmers' lengths and strokes out.
// Pure (no DOM), so the whole pipeline can be tested on synthetic video.

import { applyH, cornersValid, poolToImage } from './homography.js';
import { Background, makeGeometry, Rectifier } from './grid.js';
import { LaneTracker, laneDetections } from './tracker.js';
import { FAMILY_LABEL, STROKES } from './strokes.js';

export const YARD = 0.9144;

// Below this many pixels across a lane (typical of far lanes seen from the
// side of the pool) arm splash can't reliably be told left from right.
const MIN_LANE_PX = 20;

// How wide lane `i` looks on screen at mid-pool, in processing pixels.
export function lanePixels(H, i, length, width, height) {
  const [ax, ay] = applyH(H, i, length / 2);
  const [bx, by] = applyH(H, i + 1, length / 2);
  return Math.hypot((ax - bx) * width, (ay - by) * height);
}

// Where the camera stands. Corners are always tapped in the same order
// (start wall first-lane side, start wall last-lane side, turn wall last-lane
// side, turn wall first-lane side); only their starting positions and names
// differ. From the side, the left wall is the start wall.
export const VIEWS = {
  side: {
    label: 'Side of the pool (swimmers go left ↔ right)',
    corners: [[0.04, 0.9], [0.14, 0.3], [0.86, 0.3], [0.96, 0.9]],
    names: ['Left wall, first-lane side', 'Left wall, last-lane side', 'Right wall, last-lane side', 'Right wall, first-lane side'],
  },
  end: {
    label: 'End of the pool (swimmers go up and down)',
    corners: [[0.08, 0.92], [0.92, 0.92], [0.7, 0.18], [0.3, 0.18]],
    names: ['Start wall, first-lane side', 'Start wall, last-lane side', 'Turn wall, last-lane side', 'Turn wall, first-lane side'],
  },
};

// Common pools; anything else is entered by hand.
export const POOLS = [
  { key: '25yd', label: '25 yards (short course)', length: 25, unit: 'yd' },
  { key: '25m', label: '25 metres (short course)', length: 25, unit: 'm' },
  { key: '50m', label: '50 metres (long course)', length: 50, unit: 'm' },
];

export function defaultSetup() {
  return {
    view: 'side',
    corners: VIEWS.side.corners.map((c) => [...c]),
    length: 25,
    unit: 'yd',
    lanes: 6,
    firstLane: 1,
    lane: {}, // lane index → { track: bool, name, stroke, swimmers }
  };
}

export const laneSettings = (setup, i) => ({ track: true, name: '', stroke: 'auto', swimmers: 1, ...(setup.lane?.[i] || {}) });
export const laneLabel = (setup, i) => laneSettings(setup, i).name || `Lane ${setup.firstLane + i}`;
export const lengthMetres = (setup) => setup.length * (setup.unit === 'yd' ? YARD : 1);

export class PoolSession {
  constructor(setup, width, height) {
    if (!cornersValid(setup.corners)) throw new Error('The pool corners cross over. Drag them back into order.');
    this.setup = setup;
    this.L = lengthMetres(setup);
    this.geom = makeGeometry({ lanes: setup.lanes, length: this.L });
    this.H = poolToImage(setup.corners, setup.lanes, this.L);
    this.rect = new Rectifier(this.H, this.geom, width, height);
    this.bg = new Background(this.geom.nCells);
    this.lanes = Array.from({ length: setup.lanes }, (_, i) => {
      const s = laneSettings(setup, i);
      if (!s.track) return null;
      const lateral = lanePixels(this.H, i, this.L, width, height) >= MIN_LANE_PX;
      return new LaneTracker({ lane: i, length: this.L, maxSwimmers: s.swimmers, stroke: s.stroke, lateral });
    });
    this.t = null;
    this.startT = null;
    this.clockStart = null;
    this.fg = null;
    this.frames = 0;
  }

  get learning() { return !this.bg.ready; }

  // Process one RGBA frame at time t (seconds). Returns lengths completed.
  process(rgba, t) {
    if (this.startT === null) this.startT = t;
    this.t = t;
    this.frames++;
    const cells = this.rect.sample(rgba);
    if (!this.bg.ready) {
      this.bg.learn(cells, t);
      return [];
    }
    this.fg = this.bg.update(cells, t);
    const done = [];
    this.lanes.forEach((lt, i) => {
      if (!lt) return;
      const dets = laneDetections(this.fg, this.geom, i);
      for (const len of lt.update(t, dets)) done.push({ lane: i, ...len });
    });
    return done;
  }

  startClock(t = this.t) {
    this.clockStart = t;
    this.lanes.forEach((lt) => lt?.setClock(t));
  }

  setStroke(lane, stroke) {
    this.lanes[lane]?.setStroke(stroke);
  }

  finish() {
    this.lanes.forEach((lt) => lt?.finish());
  }

  // Everything the screen needs, in plain objects.
  snapshot() {
    const t = this.t;
    return {
      t,
      learning: this.learning ? this.bg.progress(t ?? 0) : null,
      clock: this.clockStart !== null ? t - this.clockStart : null,
      lanes: this.lanes.map((lt, i) => {
        if (!lt) return null;
        return {
          lane: i,
          label: laneLabel(this.setup, i),
          stroke: lt.stroke,
          tracks: lt.tracks.filter((k) => k.confirmed).map((k) => ({
            id: k.id, x: k.x, y: k.y, v: k.v, hidden: t - k.seenT > 0.3, slot: k.swimmer?.slot ?? 0,
          })),
          swimmers: lt.swimmers.map((s) => {
            const live = s.trackId !== null ? s.liveRhythm(t) : null;
            return {
              slot: s.slot,
              active: s.trackId !== null,
              lengths: s.lengths,
              current: s.open ? { from: s.open.wall, elapsed: t - s.open.t } : null,
              liveRate: live?.rate ?? null,
              family: live?.family ?? s.family,
            };
          }),
        };
      }),
    };
  }
}

// Label for how a length's stroke was decided.
export function strokeName(stroke, family) {
  if (stroke && stroke !== 'auto') return STROKES[stroke].label;
  return family ? FAMILY_LABEL[family] : '–';
}

export const swimmerLabel = (setup, lane, slot, count) => {
  const base = laneLabel(setup, lane);
  return count > 1 ? `${base} · ${String.fromCharCode(65 + slot)}` : base;
};

// mm:ss.s or ss.s
export function formatTime(sec) {
  if (!Number.isFinite(sec)) return '–';
  const neg = sec < 0;
  const s = Math.abs(sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const txt = m ? `${m}:${rest.toFixed(1).padStart(4, '0')}` : rest.toFixed(1);
  return neg ? `-${txt}` : txt;
}

// CSV of every length in a finished (or running) session.
export function sessionCSV(record) {
  const head = ['Swimmer', 'Length', 'Distance', 'Split (s)', 'Cumulative (s)', 'Pace /100', 'Strokes', 'Stroke rate (cycles/min)', 'Stroke', 'Notes'];
  const rows = [head];
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  for (const sw of record.swimmers) {
    let cum = 0;
    for (const len of sw.lengths) {
      cum += len.time;
      rows.push([
        sw.name, len.n, `${len.n * record.length} ${record.unit}`,
        len.time.toFixed(2), cum.toFixed(2), formatTime((len.time / record.length) * 100),
        len.strokes ?? '', len.rate ? len.rate.toFixed(1) : '', strokeName(sw.stroke, len.family),
        len.estimated ? 'start estimated' : '',
      ]);
    }
  }
  return rows.map((r) => r.map(q).join(',')).join('\n');
}

// A saved copy of the session's results (no video, no tracking state).
export function sessionRecord(session, date = new Date()) {
  const { setup } = session;
  const swimmers = [];
  session.lanes.forEach((lt, i) => {
    if (!lt) return;
    lt.swimmers.forEach((s) => {
      if (!s.lengths.length) return;
      swimmers.push({
        name: swimmerLabel(setup, i, s.slot, lt.swimmers.length),
        stroke: lt.stroke,
        lengths: s.lengths.map(({ n, time, strokes, rate, family, estimated }) => ({ n, time, strokes, rate, family, estimated })),
      });
    });
  });
  return { id: date.toISOString(), date: date.toISOString(), length: setup.length, unit: setup.unit, swimmers };
}
