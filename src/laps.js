// Walls, turns and length times.
//
// A WallDetector follows one tracked swimmer's position along the pool and
// reports what happens at the ends: a turn (swimmer reaches a wall and comes
// back), an arrival (reaches a wall and stays, e.g. finishing a rep) and a
// departure (pushes off). A Swimmer strings those into lengths with times and
// stroke numbers.
//
// The time of a turn or arrival is the moment the tracked position first
// reached its closest point to the wall (the touch), so turns and finishes
// are measured the same way and any constant offset cancels out of the
// split times.

import { analyzeStrokes, strokeCount } from './strokes.js';

export function wallOptions(length) {
  return {
    zone: Math.min(5, Math.max(3, 0.15 * length)), // "at the wall" if extreme is this close
    rev: Math.max(2.5, 0.1 * length), // must come back this far to count as a reversal
    near: 0.5, // positions this close to the extreme count as "at" it
    rest: 3, // seconds at a wall that make it an arrival + departure, not a turn
  };
}

export class WallDetector {
  constructor(length, opts = {}) {
    this.L = length;
    this.o = { ...wallOptions(length), ...opts };
    this.heading = 0; // +1 towards the turn wall, -1 towards the start wall, 0 unknown
    this.seg = []; // samples since the last extreme
    this.ext = null;
    this.anchorX = null;
    this.anchorT = null;
  }

  wallOf(h) { return h > 0 ? 1 : 0; }

  atWall(x, h) {
    return h > 0 ? x > this.L - this.o.zone : x < this.o.zone;
  }

  // First and last time (and index) the segment was within `near` of `ext`.
  // Those moments are a little before the swimmer really got there (and after
  // they really left), so each is shifted by the remaining distance at the
  // speed they were moving.
  dwell(h, ext) {
    const { near } = this.o;
    const seg = this.seg;
    let a = -1, b = -1;
    for (let i = 0; i < seg.length; i++) {
      if (h * (ext - seg[i].x) <= near) {
        if (a < 0) a = i;
        b = i;
      }
    }
    const speedAround = (i, dir) => {
      let j = i;
      while (j + dir >= 0 && j + dir < seg.length && Math.abs(seg[j + dir].t - seg[i].t) <= 1.5) j += dir;
      const dt = Math.abs(seg[j].t - seg[i].t);
      return dt >= 0.5 ? Math.abs(seg[j].x - seg[i].x) / dt : null;
    };
    const shift = (i, dir) => {
      const v = speedAround(i, dir);
      return v && v > 0.3 ? Math.min(0.6, (h * (ext - seg[i].x)) / v) : 0;
    };
    const ta = seg[a].t + shift(a, -1);
    const tl = Math.max(ta, seg[b].t - shift(b, 1));
    return { ta, tl, ia: a, il: b };
  }

  setHeading(h, fromIndex) {
    this.heading = h;
    this.seg = this.seg.slice(fromIndex);
    const xs = this.seg.map((s) => s.x);
    this.ext = h > 0 ? Math.max(...xs) : Math.min(...xs);
    const last = this.seg[this.seg.length - 1];
    this.anchorX = this.ext;
    this.anchorT = last.t;
  }

  push(t, x) {
    const { rev, near, rest } = this.o;
    const ev = [];
    this.seg.push({ t, x });
    const h = this.heading;

    if (h === 0) {
      let lo = 0, hi = 0;
      this.seg.forEach((s, i) => {
        if (s.x < this.seg[lo].x) lo = i;
        if (s.x > this.seg[hi].x) hi = i;
      });
      const dir = x - this.seg[lo].x > rev ? 1 : this.seg[hi].x - x > rev ? -1 : 0;
      if (!dir) return ev;
      const from = dir > 0 ? lo : hi; // the extreme being left behind
      const ext = this.seg[from].x;
      const wall = this.wallOf(-dir);
      const d = this.dwell(-dir, ext);
      if (this.atWall(ext, -dir)) {
        ev.push({ type: 'depart', wall, t: d.tl });
      } else if (Math.abs(this.seg[0].x - (wall ? this.L : 0)) < 0.4 * this.L) {
        // First seen already swimming away from a wall (e.g. surfacing after
        // the push-off): extrapolate back to the wall at the current speed.
        const s0 = this.seg[0];
        const speed = Math.abs(x - s0.x) / Math.max(0.1, t - s0.t);
        const dist = Math.abs(s0.x - (wall ? this.L : 0));
        // The glide off the wall is quicker than swimming.
        ev.push({ type: 'depart', wall, t: s0.t - dist / Math.max(0.3, 1.25 * speed), estimated: true });
      }
      this.setHeading(dir, d.il);
      return ev;
    }

    if (h * (x - this.ext) > 0) this.ext = x;
    if (h * (this.ext - this.anchorX) > near) { this.anchorX = this.ext; this.anchorT = t; }

    if (h * (this.ext - x) > rev) {
      const d = this.dwell(h, this.ext);
      if (this.atWall(this.ext, h)) {
        const wall = this.wallOf(h);
        if (d.tl - d.ta > rest) {
          ev.push({ type: 'arrive', wall, t: d.ta }, { type: 'depart', wall, t: d.tl });
        } else {
          ev.push({ type: 'turn', wall, t: d.ta });
        }
      } else {
        ev.push({ type: 'reverse', t: (d.ta + d.tl) / 2 });
      }
      this.setHeading(-h, d.il);
      return ev;
    }

    // Seen parked at the wall: that's an arrival (end of a rep); departure is
    // picked up when they leave. (Out of sight doesn't count: that's usually
    // the underwater push-off after a turn.)
    if (this.atWall(this.ext, h) && h * (this.ext - x) <= near && t - this.anchorT > rest) {
      const d = this.dwell(h, this.ext);
      ev.push({ type: 'arrive', wall: this.wallOf(h), t: d.ta });
      this.heading = 0;
      this.seg = this.seg.slice(d.ia);
    }
    return ev;
  }

  // Track lost: if it was last seen swimming into a wall, that's an arrival.
  finish() {
    const h = this.heading;
    if (!h || !this.seg.length || !this.atWall(this.ext, h)) return [];
    const d = this.dwell(h, this.ext);
    this.heading = 0;
    return [{ type: 'arrive', wall: this.wallOf(h), t: d.ta }];
  }
}

const SAMPLE_KEEP = 180; // seconds of splash samples kept per swimmer

// One swimmer's session: lengths with split times and stroke numbers.
export class Swimmer {
  constructor({ lane, slot = 0, length, stroke = 'auto' }) {
    this.lane = lane;
    this.slot = slot;
    this.length = length;
    this.stroke = stroke;
    this.lengths = [];
    this.open = null; // { wall, t, estimated } — current length's start
    this.samples = [];
    this.trackId = null;
    this.lastX = null;
    this.lastT = null;
    this.clockStart = null;
  }

  get family() {
    return { free: 'alternating', back: 'alternating', breast: 'simultaneous', fly: 'simultaneous' }[this.stroke] || null;
  }

  addSample(s) {
    this.samples.push(s);
    this.lastX = s.x;
    this.lastT = s.t;
    const cutoff = s.t - SAMPLE_KEEP;
    if (this.samples[0].t < cutoff) this.samples = this.samples.filter((p) => p.t >= cutoff);
  }

  // Apply wall events; returns lengths completed by them.
  handle(events) {
    const done = [];
    for (const ev of events) {
      if (ev.type === 'reverse') { this.open = null; continue; }
      if ((ev.type === 'turn' || ev.type === 'arrive') && this.open && this.open.wall !== ev.wall) {
        done.push(this.complete(this.open, ev));
      }
      if (ev.type === 'arrive') { this.open = null; continue; }
      if (ev.type === 'depart' && ev.estimated && this.open && this.open.wall === ev.wall) continue;
      let start = { wall: ev.wall, t: ev.t, estimated: Boolean(ev.estimated) };
      // Race start: the first length runs from the clock, not the push-off.
      if (ev.type === 'depart' && this.clockStart !== null && !this.lengths.length
        && ev.t >= this.clockStart - 1 && ev.t - this.clockStart < 20) {
        start = { wall: ev.wall, t: this.clockStart, estimated: false, clock: true };
      }
      this.open = start;
    }
    return done;
  }

  complete(open, ev) {
    const { t: t0 } = open;
    const t1 = ev.t;
    const zone = Math.min(4, this.length * 0.2);
    // Stroke rate from mid-pool only: no walls, turns or glides.
    const mid = this.samples.filter((s) => s.t >= t0 && s.t <= t1 && s.x > zone && s.x < this.length - zone);
    const rhythm = mid.length ? analyzeStrokes(mid, mid[0].t, mid[mid.length - 1].t, this.family) : null;
    const len = {
      n: this.lengths.length + 1,
      from: open.wall,
      start: t0,
      end: t1,
      time: t1 - t0,
      estimated: open.estimated,
      rate: rhythm ? rhythm.rate : null,
      family: rhythm ? rhythm.family : this.family,
      strokes: rhythm ? this.countStrokes(t0, t1, rhythm.entryPeriod) : null,
    };
    this.lengths.push(len);
    return len;
  }

  // Strokes from the breakout (the swimmer reappearing after the underwater
  // glide that follows the wall) to the touch. If the glide was never out of
  // sight, fall back to the time spent visibly splashing.
  countStrokes(t0, t1, entryPeriod) {
    const inLen = this.samples.filter((s) => s.t >= t0 && s.t <= t1);
    let breakout = null;
    for (let i = 0; i < inLen.length; i++) {
      const prev = i ? inLen[i - 1].t : t0;
      if (prev - t0 > 3) break; // later gaps are something else (e.g. swimmers passing)
      if (inLen[i].t - prev > 0.8) breakout = inLen[i].t;
    }
    if (breakout === null) return strokeCount(this.samples, t0, t1, entryPeriod);
    return Math.max(0, Math.round((t1 - breakout) / entryPeriod));
  }

  // Stroke rate over the last few seconds while swimming mid-pool.
  liveRhythm(t, window = 8) {
    const zone = Math.min(4, this.length * 0.2);
    let recent = this.samples.filter((s) => s.t >= t - window && s.x > zone && s.x < this.length - zone);
    // Only the latest unbroken stretch (not across a turn).
    for (let i = recent.length - 1; i > 0; i--) {
      if (recent[i].t - recent[i - 1].t > 1) { recent = recent.slice(i); break; }
    }
    if (recent.length < 20) return null;
    return analyzeStrokes(recent, recent[0].t, recent[recent.length - 1].t, this.family);
  }
}
