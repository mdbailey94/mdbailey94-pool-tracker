// One tracking session: camera frames in, swimmers' lengths and strokes out.
// Pure (no DOM), so the whole pipeline can be tested on synthetic video.

import { cornersValid, poolToImage } from './homography.js';
import { Background, makeGeometry, Rectifier } from './grid.js';
import { LaneTracker, laneDetections } from './tracker.js';
import { FAMILY_LABEL, STROKES } from './strokes.js';

export const YARD = 0.9144;

export function defaultSetup() {
  return {
    corners: [[0.08, 0.92], [0.92, 0.92], [0.7, 0.18], [0.3, 0.18]],
    length: 25,
    unit: 'm',
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
      return s.track ? new LaneTracker({ lane: i, length: this.L, maxSwimmers: s.swimmers, stroke: s.stroke }) : null;
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
