// Finding swimmers in each lane and following them from frame to frame.

import { cellIndex } from './grid.js';
import { Swimmer, WallDetector } from './laps.js';

const STROKE_WINDOW = 1.25; // m either side of the swimmer where splash is measured

// Swimmers in one lane this frame: stretches along the lane where the
// foreground is strong. Returns [{ x, lo, hi, mass, e, y }] in metres, with
// splash energy `e` and its sideways offset `y` (fraction of the lane width)
// for the stroke analysis.
export function laneDetections(fg, geom, lane, { threshold = 0.9, minMass = 6, mergeGap = 1.5 } = {}) {
  const { nx, across, cellLen } = geom;
  const prof = new Float32Array(nx);
  const lat = new Float32Array(nx);
  for (let j = 0; j < across; j++) {
    const off = (j + 0.5) / across - 0.5;
    const base = cellIndex(geom, lane, j, 0);
    for (let i = 0; i < nx; i++) {
      const f = fg[base + i];
      prof[i] += f;
      lat[i] += f * off;
    }
  }
  // Triangular smoothing over ±0.5 m joins a swimmer's head, arms and kick.
  const r = Math.max(1, Math.round(0.5 / cellLen));
  const sm = new Float32Array(nx);
  for (let i = 0; i < nx; i++) {
    let s = 0, w = 0;
    for (let k = -r; k <= r; k++) {
      const q = i + k;
      if (q < 0 || q >= nx) continue;
      const wk = r + 1 - Math.abs(k);
      s += prof[q] * wk; w += wk;
    }
    sm[i] = s / w;
  }
  const segs = [];
  let start = -1;
  for (let i = 0; i <= nx; i++) {
    const on = i < nx && sm[i] > threshold;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      const prev = segs[segs.length - 1];
      if (prev && (start - prev.hi) * cellLen < mergeGap) prev.hi = i - 1;
      else segs.push({ lo: start, hi: i - 1 });
      start = -1;
    }
  }
  const out = [];
  for (const { lo, hi } of segs) {
    let m = 0, mx = 0;
    for (let i = lo; i <= hi; i++) { m += prof[i]; mx += prof[i] * (i + 0.5); }
    if (m < minMass) continue;
    const x = (mx / m) * cellLen;
    const w0 = Math.max(0, Math.floor((x - STROKE_WINDOW) / cellLen));
    const w1 = Math.min(nx - 1, Math.ceil((x + STROKE_WINDOW) / cellLen));
    let e = 0, ly = 0;
    for (let i = w0; i <= w1; i++) { e += prof[i]; ly += lat[i]; }
    out.push({ x, lo: lo * cellLen, hi: (hi + 1) * cellLen, mass: m, e, y: e > 0 ? ly / e : 0 });
  }
  return out;
}

let nextId = 1;

// One swimmer being followed: position and speed along the lane smoothed
// with an alpha-beta filter, plus a WallDetector for turns.
class Track {
  constructor(det, t, length) {
    this.id = nextId++;
    this.x = det.x;
    this.v = 0;
    this.t = t;
    this.seenT = t;
    this.seenX = det.x;
    this.born = t;
    this.hits = 1;
    this.confirmed = false;
    this.swimmer = null;
    this.walls = new WallDetector(length);
    this.L = length;
    this.y = det.y;
    this.quality = det.mass; // running average of how clearly it's seen
  }

  // Where the swimmer should be at time t. While out of sight (underwater
  // after a push-off, a big splash), keep the last speed; a swimmer who
  // reaches a wall turns, so bounce off it.
  predict(t) {
    let x = this.x + this.v * (t - this.t);
    let v = this.v;
    if (x > this.L) { x = 2 * this.L - x; v = -v; }
    if (x < 0) { x = -x; v = -v; }
    return { x: Math.min(this.L, Math.max(0, x)), v };
  }

  coast(t) {
    const p = this.predict(t);
    this.x = p.x; this.v = p.v; this.t = t;
    this.quality *= 0.97;
  }

  update(det, t) {
    const gap = t - this.seenT;
    if (gap > 0.6) {
      // Reappeared after a while: restart from the measurement.
      this.v = Math.max(-3, Math.min(3, (det.x - this.seenX) / gap));
      if (Math.abs(this.v) < 0.3) this.v = 0;
      this.x = det.x;
    } else {
      const p = this.predict(t);
      const dt = Math.max(1 / 60, t - this.t);
      const res = det.x - p.x;
      this.x = p.x + 0.2 * res;
      this.v = Math.max(-3, Math.min(3, p.v + (0.012 * res) / dt));
    }
    this.x = Math.min(this.L, Math.max(0, this.x));
    this.t = t;
    this.seenT = t;
    this.seenX = det.x;
    this.y = det.y;
    this.hits++;
    this.quality += 0.1 * (det.mass - this.quality);
  }
}

// All swimmers in one lane. `maxSwimmers` > 1 for circle swimming.
export class LaneTracker {
  constructor({ lane, length, maxSwimmers = 1, stroke = 'auto', lateral = true }) {
    this.lane = lane;
    this.lateral = lateral;
    this.L = length;
    this.max = maxSwimmers;
    this.stroke = stroke;
    this.tracks = [];
    this.swimmers = [];
    this.clockStart = null;
    this.maxCoast = 4.5;
  }

  setStroke(stroke) {
    this.stroke = stroke;
    this.swimmers.forEach((s) => { s.stroke = stroke; });
  }

  setClock(t) {
    this.clockStart = t;
    this.swimmers.forEach((s) => { s.clockStart = t; });
  }

  // Which swimmer a newly confirmed track belongs to. With one swimmer per
  // lane it's always them; otherwise whoever was last seen nearby, first in
  // first out (circle swimmers leave the wall in the order they arrived).
  assignSwimmer(track) {
    const free = this.swimmers.filter((s) => !this.tracks.some((k) => k !== track && k.swimmer === s));
    let s = null;
    if (this.max === 1) s = this.swimmers[0] || null;
    else {
      const nearby = free.filter((q) => Math.abs(q.lastX - track.x) < 5).sort((a, b) => a.lastT - b.lastT);
      s = nearby[0] || (this.swimmers.length >= this.max
        ? free.sort((a, b) => Math.abs(a.lastX - track.x) - Math.abs(b.lastX - track.x))[0]
        : null);
    }
    if (!s) {
      s = new Swimmer({ lane: this.lane, slot: this.swimmers.length, length: this.L, stroke: this.stroke, lateral: this.lateral });
      s.clockStart = this.clockStart;
      this.swimmers.push(s);
    }
    track.swimmer = s;
    s.trackId = track.id;
  }

  retire(track) {
    if (track.swimmer) {
      track.swimmer.handle(track.walls.finish());
      if (track.swimmer.trackId === track.id) track.swimmer.trackId = null;
    }
  }

  // Feed this frame's detections; returns lengths completed.
  update(t, dets) {
    const done = [];
    // Nearest-first matching of tracks to detections within a gate that
    // widens the longer a track has been out of sight.
    const pairs = [];
    const preds = this.tracks.map((tr) => tr.predict(t));
    // Two swimmers passing each other merge into one blob for a moment.
    // Neither track takes it (it would drag one of them the wrong way):
    // both carry on at their own speed until they separate.
    const shared = new Set();
    dets.forEach((d, b) => {
      const near = this.tracks.filter((tr, a) => tr.confirmed && Math.abs(d.x - preds[a].x) < 2.5);
      if (near.some((p) => near.some((q) => Math.sign(p.v) * Math.sign(q.v) < 0 && Math.abs(p.v) > 0.4 && Math.abs(q.v) > 0.4))) {
        shared.add(b);
      }
    });
    this.tracks.forEach((tr, a) => {
      const p = preds[a];
      const gate = Math.min(9, 2 + 2 * (t - tr.seenT));
      dets.forEach((d, b) => {
        if (shared.has(b)) return;
        const dist = Math.abs(d.x - p.x);
        if (dist < gate) pairs.push({ a, b, cost: dist - (tr.confirmed ? 0.5 : 0) });
      });
    });
    pairs.sort((p, q) => p.cost - q.cost);
    const usedT = new Set(), usedD = new Set();
    for (const { a, b } of pairs) {
      if (usedT.has(a) || usedD.has(b)) continue;
      usedT.add(a); usedD.add(b);
      const tr = this.tracks[a];
      const d = dets[b];
      tr.update(d, t);
      if (!tr.confirmed && tr.hits >= 8) {
        tr.confirmed = true;
        // Lane already full: the new one replaces the least convincing.
        const others = this.tracks.filter((k) => k.confirmed && k !== tr);
        if (others.length >= this.max) {
          const weakest = others.reduce((w, k) => (k.quality < w.quality ? k : w));
          this.retire(weakest);
          this.tracks = this.tracks.filter((k) => k !== weakest);
        }
        this.assignSwimmer(tr);
      }
      if (tr.confirmed) {
        // Splash can't be told apart while two swimmers overlap.
        const crowded = this.tracks.some((o) => o !== tr && Math.abs(o.x - d.x) < 3);
        tr.swimmer.addSample({ t, x: tr.x, e: crowded ? NaN : d.e, y: crowded ? NaN : d.y });
        done.push(...tr.swimmer.handle(tr.walls.push(t, tr.x)));
      }
    }
    this.tracks.forEach((tr, a) => { if (!usedT.has(a)) tr.coast(t); });

    // Drop tracks gone too long, unconfirmed flickers, and duplicates
    // sitting on top of an older track.
    this.tracks = this.tracks.filter((tr) => {
      const gone = t - tr.seenT;
      if (!tr.confirmed && (gone > 0.3 || (t - tr.born > 1.5 && tr.hits < 8))) return false;
      if (gone > this.maxCoast) { this.retire(tr); return false; }
      return true;
    });
    const duplicate = (tr) => this.tracks.some((o) => o !== tr && o.born < tr.born
      && Math.abs(o.x - tr.x) < 1 && Math.sign(o.v) === Math.sign(tr.v)
      && t - tr.seenT < 0.2 && t - o.seenT < 0.2 && (!tr.confirmed || o.confirmed));
    this.tracks = this.tracks.filter((tr) => {
      if (!duplicate(tr)) return true;
      if (tr.confirmed) this.retire(tr);
      return false;
    });

    // New tracks from unmatched detections, strongest first. One spare
    // candidate is allowed in a full lane so that a track stuck on ripples
    // can be replaced by the real swimmer.
    dets
      .map((d, b) => ({ d, b }))
      .filter(({ b }) => !usedD.has(b) && !shared.has(b))
      .sort((p, q) => q.d.mass - p.d.mass)
      .forEach(({ d }) => {
        const confirmed = this.tracks.filter((k) => k.confirmed);
        const candidates = this.tracks.length - confirmed.length;
        const room = this.tracks.length < this.max
          || (candidates === 0 && confirmed.length && d.mass > 2 * Math.min(...confirmed.map((k) => k.quality)));
        if (room) this.tracks.push(new Track(d, t, this.L));
      });
    return done;
  }

  // Close off everything (end of session).
  finish() {
    this.tracks.forEach((tr) => this.retire(tr));
    this.tracks = [];
  }
}
