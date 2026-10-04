// Synthetic pool camera: renders RGBA frames of swimmers doing lengths, seen
// in perspective from the end of the pool, with rippling water, glare, lane
// ropes, underwater glides, turns and a splash for every hand entry. The
// ground truth (wall times, stroke rate) is known exactly, so the tracking
// pipeline can be tested end to end without real footage.

import { applyH, invertH, poolToImage } from '../../src/homography.js';

export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// Timeline for one swimmer. Lengths are swum at `speed` (m/s) on the surface,
// with an underwater glide of `glide` metres at 1.3× speed after each wall,
// and `dwell` seconds at each wall for the turn.
export function planSwimmer({ lane, length, lengths, speed, stroke = 'free', rate = 50, start = 1, glide = 4, dwell = 0.7, lateral = 0 }) {
  const legs = [];
  let t = start;
  const walls = [{ t, wall: 0 }];
  for (let k = 0; k < lengths; k++) {
    const dir = k % 2 === 0 ? 1 : -1;
    const tGlide = glide / (speed * 1.3);
    const tSwim = (length - glide) / speed;
    legs.push({ t0: t, t1: t + tGlide + tSwim, dir, tGlide, speed });
    t += tGlide + tSwim;
    walls.push({ t, wall: dir > 0 ? 1 : 0 });
    if (k < lengths - 1) t += dwell;
  }
  return { lane, length, stroke, rate, legs, walls, end: t, lateral, dwell };
}

// Position (m from start wall), whether underwater, and phase within the stroke.
function stateAt(sw, t) {
  const { legs, length } = sw;
  if (t < legs[0].t0) return { x: 0.3, under: false, turning: false, stroking: false, dir: 1 };
  for (let i = 0; i < legs.length; i++) {
    const g = legs[i];
    const from = g.dir > 0 ? 0 : length;
    if (t >= g.t0 && t <= g.t1) {
      const dt = t - g.t0;
      const glideDist = Math.min(dt, g.tGlide) * g.speed * 1.3;
      const swimDist = Math.max(0, dt - g.tGlide) * g.speed;
      const d = glideDist + swimDist;
      return { x: from + g.dir * d, under: dt < g.tGlide, turning: false, stroking: dt >= g.tGlide, dir: g.dir, since: dt - g.tGlide };
    }
    const next = legs[i + 1];
    if (next && t > g.t1 && t < next.t0) {
      const wall = g.dir > 0 ? length : 0;
      return { x: wall - g.dir * 0.4, under: false, turning: true, stroking: false, dir: g.dir };
    }
  }
  const last = legs[legs.length - 1];
  return { x: last.dir > 0 ? length - 0.4 : 0.4, under: false, turning: false, stroking: false, dir: last.dir, resting: true };
}

export class PoolSim {
  constructor({ width = 240, height = 150, lanes = 4, length = 25, corners, seed = 7, glare = 0.004 } = {}) {
    this.w = width; this.h = height; this.lanes = lanes; this.L = length;
    this.corners = corners || [[0.04, 0.96], [0.96, 0.96], [0.72, 0.1], [0.28, 0.1]];
    this.H = poolToImage(this.corners, lanes, length);
    this.Hinv = invertH(this.H);
    this.rand = rng(seed);
    this.glare = glare;
    this.swimmers = [];
    // Pool coordinates of every pixel, and a fixed texture for the water.
    const n = width * height;
    this.pu = new Float32Array(n); this.pv = new Float32Array(n);
    this.inside = new Uint8Array(n);
    this.base = new Uint8ClampedArray(n * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const [u, v] = applyH(this.Hinv, (x + 0.5) / width, (y + 0.5) / height);
        this.pu[i] = u; this.pv[i] = v;
        const inPool = u >= 0 && u <= lanes && v >= 0 && v <= length;
        this.inside[i] = inPool ? 1 : 0;
        let c;
        if (!inPool) c = [150, 150, 145];
        else if (Math.abs(u - Math.round(u)) < 0.05 && Math.round(u) > 0 && Math.round(u) < lanes) {
          c = Math.floor(v / 1.5) % 2 ? [220, 60, 50] : [235, 235, 230]; // lane rope
        } else {
          const tex = (this.rand() - 0.5) * 16;
          c = [35 + tex, 115 + tex, 175 + tex];
        }
        this.base.set([c[0], c[1], c[2], 255], i * 4);
      }
    }
    this.frame = new Uint8ClampedArray(n * 4);
  }

  add(plan) { this.swimmers.push(plan); return plan; }

  // Render the frame at time t.
  render(t) {
    const { frame, base, w, h, rand } = this;
    frame.set(base);
    // Sensor noise and glare over the water.
    for (let i = 0; i < w * h; i++) {
      if (!this.inside[i]) continue;
      const o = i * 4;
      const nz = (rand() - 0.5) * 10;
      frame[o] += nz; frame[o + 1] += nz; frame[o + 2] += nz;
      if (rand() < this.glare) { frame[o] += 90; frame[o + 1] += 80; frame[o + 2] += 60; }
    }
    for (const sw of this.swimmers) this.drawSwimmer(sw, t);
    return frame;
  }

  // Paint pixels whose pool coordinates fall within a swimmer's shapes.
  drawSwimmer(sw, t) {
    const s = stateAt(sw, t);
    const cx = sw.lane + 0.5 + sw.lateral * s.dir; // lane units (circle swimmers keep to one side)
    const laneW = 2.5; // metres per lane, for round shapes
    const shapes = [];
    const body = { x: s.x - s.dir * 0.7, y: cx, rx: 1.0, ry: 0.22, col: [25, 30, 45], a: s.under ? 0.15 : 0.85 };
    shapes.push(body);
    if (s.turning) shapes.push({ x: s.x, y: cx, rx: 0.9, ry: 0.35, col: [235, 240, 245], a: 0.8 });
    if (s.stroking) {
      const cycle = 60 / sw.rate;
      const alt = sw.stroke === 'free' || sw.stroke === 'back';
      const entryP = alt ? cycle / 2 : cycle;
      const k = Math.floor(s.since / entryP);
      const ph = s.since - k * entryP;
      const amp = Math.exp(-ph / 0.18);
      const hx = s.x + s.dir * 0.5;
      if (alt) {
        const side = k % 2 ? 1 : -1;
        shapes.push({ x: hx, y: cx + (side * 0.3) / laneW, rx: 0.45, ry: 0.28, col: [240, 245, 250], a: 0.95 * amp });
      } else {
        shapes.push({ x: hx, y: cx - 0.3 / laneW, rx: 0.4, ry: 0.25, col: [240, 245, 250], a: 0.9 * amp });
        shapes.push({ x: hx, y: cx + 0.3 / laneW, rx: 0.4, ry: 0.25, col: [240, 245, 250], a: 0.9 * amp });
      }
      // Kick: a restless patch of white behind the body.
      shapes.push({ x: s.x - s.dir * 1.8, y: cx, rx: 0.5, ry: 0.2, col: [225, 235, 240], a: 0.25 + 0.3 * this.rand() });
    }
    this.paint(cx, s.x, shapes);
  }

  // Paint shapes ({ x: m along the pool, y: lane units, rx, ry: m, col, a })
  // within 3 m of position x in the lane strip around cx.
  paint(cx, sx, shapes) {
    const laneW = 2.5;
    // Bounding box in pixels (via the corners of the swimmer's area).
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of [[cx - 0.5, sx - 3], [cx + 0.5, sx - 3], [cx - 0.5, sx + 3], [cx + 0.5, sx + 3]]) {
      const [u, v] = applyH(this.H, px, Math.max(0, Math.min(this.L, py)));
      x0 = Math.min(x0, u * this.w); x1 = Math.max(x1, u * this.w);
      y0 = Math.min(y0, v * this.h); y1 = Math.max(y1, v * this.h);
    }
    const X0 = Math.max(0, Math.floor(x0) - 1), X1 = Math.min(this.w - 1, Math.ceil(x1) + 1);
    const Y0 = Math.max(0, Math.floor(y0) - 1), Y1 = Math.min(this.h - 1, Math.ceil(y1) + 1);
    for (let y = Y0; y <= Y1; y++) {
      for (let x = X0; x <= X1; x++) {
        const i = y * this.w + x;
        if (!this.inside[i]) continue;
        const u = this.pu[i], v = this.pv[i];
        for (const sh of shapes) {
          const dx = (v - sh.x) / sh.rx, dy = ((u - sh.y) * laneW) / (sh.ry * 1);
          if (dx * dx + dy * dy > 1 || sh.a <= 0) continue;
          const o = i * 4;
          for (let c = 0; c < 3; c++) this.frame[o + c] += (sh.col[c] - this.frame[o + c]) * sh.a;
        }
      }
    }
  }
}
