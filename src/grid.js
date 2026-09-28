// Turns camera frames into a small top-down grid of the pool and finds what
// isn't water.
//
// Each lane is cut into `across` strips and the length into cells of
// `cellLen` metres. Every cell is sampled from the matching patch of the
// camera picture (through the homography), so later stages work in metres
// rather than pixels and don't care where the camera stands.

import { applyH } from './homography.js';

export function makeGeometry({ lanes, length, cellLen = 0.25, across = 6 }) {
  const nx = Math.max(8, Math.round(length / cellLen));
  return { lanes, length, nx, across, cellLen: length / nx, nCells: lanes * across * nx };
}

// Cell index: lane-major, then strip across the lane, then along the length.
export const cellIndex = (g, lane, j, i) => (lane * g.across + j) * g.nx + i;

export class Rectifier {
  // H maps pool coordinates to normalised image coordinates (0–1).
  constructor(H, geom, width, height) {
    this.geom = geom;
    const { lanes, across, nx, cellLen, nCells } = geom;
    const px = (x, y) => {
      const [u, v] = applyH(H, x, y);
      return [u * width, v * height];
    };
    const starts = new Int32Array(nCells + 1);
    const offs = [];
    for (let lane = 0; lane < lanes; lane++) {
      for (let j = 0; j < across; j++) {
        for (let i = 0; i < nx; i++) {
          const c = cellIndex(geom, lane, j, i);
          starts[c] = offs.length;
          const x0 = lane + j / across, x1 = lane + (j + 1) / across;
          const y0 = i * cellLen, y1 = (i + 1) * cellLen;
          // Size of the cell on screen decides how many pixels to average:
          // near cells cover many pixels, far ones only a few.
          const a = px(x0, y0), b = px(x1, y0), d = px(x0, y1);
          const w = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const h = Math.hypot(d[0] - a[0], d[1] - a[1]);
          const kx = Math.max(1, Math.min(4, Math.round(w / 2)));
          const ky = Math.max(1, Math.min(4, Math.round(h / 2)));
          for (let sy = 0; sy < ky; sy++) {
            for (let sx = 0; sx < kx; sx++) {
              const [u, v] = px(x0 + ((sx + 0.5) / kx) * (x1 - x0), y0 + ((sy + 0.5) / ky) * (y1 - y0));
              const ix = Math.floor(u), iy = Math.floor(v);
              if (ix >= 0 && iy >= 0 && ix < width && iy < height) offs.push((iy * width + ix) * 4);
            }
          }
        }
      }
    }
    starts[nCells] = offs.length;
    this.starts = starts;
    this.offs = Int32Array.from(offs);
    this.out = new Float32Array(nCells * 3);
    this.visible = new Uint8Array(nCells);
    for (let c = 0; c < nCells; c++) this.visible[c] = starts[c + 1] > starts[c] ? 1 : 0;
  }

  // Mean RGB of every cell (cells off-screen stay 0 and are ignored later).
  sample(rgba) {
    const { starts, offs, out } = this;
    const n = this.geom.nCells;
    for (let c = 0; c < n; c++) {
      let r = 0, g = 0, b = 0;
      const s = starts[c], e = starts[c + 1];
      for (let k = s; k < e; k++) {
        const o = offs[k];
        r += rgba[o]; g += rgba[o + 1]; b += rgba[o + 2];
      }
      const k = e - s || 1;
      out[c * 3] = r / k; out[c * 3 + 1] = g / k; out[c * 3 + 2] = b / k;
    }
    return out;
  }
}

const median = (arr) => {
  const s = Float32Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// What the empty water looks like, cell by cell, and how much it normally
// flickers (ripples, glare). Starts from the per-cell median of a few seconds
// of frames, so swimmers passing through don't get baked in, then follows
// slow light changes. Anything that stays put for long (a swimmer resting,
// a kickboard) fades into the background.
export class Background {
  constructor(nCells, { warmup = 4, warmFrames = 24 } = {}) {
    this.n = nCells;
    this.warmup = warmup;
    this.warmFrames = warmFrames;
    this.frames = [];
    this.t0 = null;
    this.lastT = null;
    this.ready = false;
    this.bg = new Float32Array(nCells * 3);
    this.dev = new Float32Array(nCells * 3);
    this.fg = new Float32Array(nCells);
    this.raw = new Float32Array(nCells);
    this.prev = new Float32Array(nCells);
    this.still = new Float32Array(nCells); // seconds each cell has been foreground
  }

  progress(t) {
    return this.t0 === null ? 0 : Math.min(1, (t - this.t0) / this.warmup);
  }

  // Collect frames while learning; returns true once the model is ready.
  learn(cells, t) {
    if (this.t0 === null) this.t0 = t;
    const step = this.warmup / this.warmFrames;
    const last = this.frames.length ? this.frames[this.frames.length - 1].t : -Infinity;
    if (t - last >= step * 0.9) this.frames.push({ t, cells: Float32Array.from(cells) });
    if (t - this.t0 < this.warmup || this.frames.length < 5) return false;
    const vals = new Float32Array(this.frames.length);
    for (let k = 0; k < this.n * 3; k++) {
      for (let f = 0; f < this.frames.length; f++) vals[f] = this.frames[f].cells[k];
      const m = median(vals);
      for (let f = 0; f < this.frames.length; f++) vals[f] = Math.abs(vals[f] - m);
      this.bg[k] = m;
      this.dev[k] = Math.max(1, median(vals) * 1.4826);
    }
    this.frames = [];
    this.ready = true;
    this.lastT = t;
    return true;
  }

  // Foreground strength per cell: 0 for water, up to 3 for a clear swimmer
  // or splash. A cell has to differ in two frames running, which drops
  // one-frame sparkles of sunlight. Then nudges the model toward this frame.
  update(cells, t) {
    const dt = Math.min(0.5, Math.max(0, t - this.lastT));
    this.lastT = t;
    const { bg, dev, raw, prev, fg, still } = this;
    prev.set(raw);
    const rate = 5 * dt; // colour levels per second: a slow approximate median
    for (let c = 0; c < this.n; c++) {
      const o = c * 3;
      const d0 = cells[o] - bg[o], d1 = cells[o + 1] - bg[o + 1], d2 = cells[o + 2] - bg[o + 2];
      const dist = Math.abs(d0) + Math.abs(d1) + Math.abs(d2);
      const s = dist / (3 * (dev[o] + dev[o + 1] + dev[o + 2]) + 18);
      const f = s > 1 ? Math.min(3, s - 1) : 0;
      raw[c] = f;
      fg[c] = Math.min(f, prev[c]);
      still[c] = f > 0 ? still[c] + dt : 0;
      // Moving swimmers barely touch the model; anything parked for 8 s is
      // absorbed quickly.
      const r = f > 0 ? (still[c] > 8 ? rate * 6 : rate * 0.3) : rate;
      for (let k = 0; k < 3; k++) {
        const d = cells[o + k] - bg[o + k];
        bg[o + k] += d > 0 ? Math.min(r, d) : Math.max(-r, d);
        if (f === 0) {
          const e = Math.abs(d) * 1.4826 - dev[o + k];
          dev[o + k] = Math.max(1, dev[o + k] + (e > 0 ? Math.min(r * 0.5, e) : Math.max(-r * 0.5, e)));
        }
      }
    }
    return fg;
  }
}
