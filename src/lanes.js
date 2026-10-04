// Finding the lane ropes in a picture, to line the dots up with them.
//
// Starting from where the coach roughly put the dots, each lane line is
// looked for as a straight line in the picture near where the dots say it
// should be: a lane rope is a line of floats brighter or redder than the
// water around it (the dark lines on the pool floor don't count, so they
// aren't mistaken for ropes). Every rope found, plus a little of the coach's
// own placement, then sets the band through a least-squares homography (with
// only one or two ropes, the lanes just slide and stretch along the lines). The
// finish line and back line stay exactly where the coach put them; only
// where the lanes fall along them moves.

import { applyH, cornersValid, fitHomography, homography } from './homography.js';

// Band coordinates (x lanes across, y metres back from the finish) →
// normalised image coordinates.
const bandH = (corners, lanes, depth) => homography([[0, 0], [lanes, 0], [lanes, depth], [0, depth]], corners);

const median = (a) => {
  const s = Float32Array.from(a).sort();
  return s.length ? s[s.length >> 1] : 0;
};

export function findLaneLines(rgba, width, height, corners, lanes, depth, { search = 0.4, samples = 48 } = {}) {
  if (!cornersValid(corners)) return { corners, lines: [], found: 0 };
  const H = bandH(corners, lanes, depth);
  const px = (x, y) => {
    const [u, v] = applyH(H, x, y);
    return [u * width, v * height];
  };

  // What the water looks like: the middle of every lane.
  const R = [], G = [], B = [];
  for (let k = 0; k < lanes; k++) {
    for (let fx = 0.3; fx <= 0.71; fx += 0.1) {
      for (let fy = 0.05; fy < 1; fy += 0.05) {
        const [x, y] = px(k + fx, fy * depth);
        const ix = Math.floor(x), iy = Math.floor(y);
        if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue;
        const o = (iy * width + ix) * 4;
        R.push(rgba[o]); G.push(rgba[o + 1]); B.push(rgba[o + 2]);
      }
    }
  }
  const wr = median(R), wl = (wr + median(G) + median(B)) / 3;

  // How rope-like each pixel is: brighter (white, yellow floats) or redder
  // than the water. Darker things (floor lines, shadows) score nothing.
  const rope = new Float32Array(width * height);
  for (let i = 0, o = 0; i < rope.length; i++, o += 4) {
    const l = (rgba[o] + rgba[o + 1] + rgba[o + 2]) / 3;
    rope[i] = Math.max(0, rgba[o] - wr) + Math.max(0, l - wl);
  }

  // Mean rope score along the straight picture line from lane position f on
  // the finish line to b on the back line.
  const along = (f, b) => {
    const [x0, y0] = px(f, 0), [x1, y1] = px(b, depth);
    let s = 0, n = 0;
    for (let i = 0; i < samples; i++) {
      const t = 0.04 + (0.92 * i) / (samples - 1);
      const ix = Math.round(x0 + (x1 - x0) * t), iy = Math.round(y0 + (y1 - y0) * t);
      if (ix < 0 || iy < 0 || ix >= width || iy >= height) continue;
      s += rope[iy * width + ix];
      n++;
    }
    return n >= samples / 2 ? s / n : -Infinity;
  };
  // A rope stands out from the water on both sides of it (an edge of the
  // pool, bright deck on one side only, doesn't).
  const side = 0.15;
  const peak = (f, b) => along(f, b) - Math.max(along(f - side, b - side), along(f + side, b + side));

  // Best line in a grid around (f0, b0). A rope is several pixels wide, so
  // a line can slide a little within it and score the same: take the middle
  // of the near-best positions, not the first one met.
  const best = (f0, b0, span, step) => {
    const cand = [];
    for (let f = f0 - span; f <= f0 + span + 1e-9; f += step) {
      for (let b = b0 - span; b <= b0 + span + 1e-9; b += step) cand.push({ f, b, c: peak(f, b) });
    }
    const c = Math.max(...cand.map((x) => x.c));
    if (!(c > 0)) return { f: f0, b: b0, c };
    const top = cand.filter((x) => x.c >= 0.95 * c);
    return { f: top.reduce((s, x) => s + x.f, 0) / top.length, b: top.reduce((s, x) => s + x.b, 0) / top.length, c };
  };

  const lines = [];
  for (let k = 0; k <= lanes; k++) {
    const coarse = best(k, k, search, 0.04);
    lines.push({ k, ...best(coarse.f, coarse.b, 0.05, 0.01) });
  }
  // Ropes are much alike; a weaker line is something else (a pool edge).
  const strongest = Math.max(...lines.map((l) => l.c));
  lines.forEach((l) => { l.found = l.c >= 5 && l.c >= 0.6 * strongest; });
  const found = lines.filter((l) => l.found);
  if (!found.length) return { corners, lines, found: 0 };

  const ends = [[0, 0], [lanes, 0], [lanes, depth], [0, depth]];
  const toNorm = ([x, y]) => [x / width, y / height];
  if (found.length <= 2) {
    // Too few ropes to settle the perspective: keep the coach's, and just
    // slide the lanes along the finish and back lines to the ropes (and
    // stretch them, with two).
    const along1 = (key) => {
      if (found.length === 1) { const d = found[0][key] - found[0].k; return (k) => k + d; }
      const [a, b] = found;
      const scale = (b[key] - a[key]) / (b.k - a.k);
      return (k) => a[key] + (k - a.k) * scale;
    };
    const f = along1('f'), b = along1('b');
    const next = [px(f(0), 0), px(f(lanes), 0), px(b(lanes), depth), px(b(0), depth)].map(toNorm);
    return cornersValid(next) ? { corners: next, lines, found: found.length } : { corners, lines, found: 0 };
  }

  // Ropes found pin their lane lines (with a whisper of the coach's own
  // dots, to keep the sums steady).
  const src = [], dst = [], w = [];
  for (const l of found) {
    src.push([l.k, 0], [l.k, depth]);
    dst.push(toNorm(px(l.f, 0)), toNorm(px(l.b, depth)));
    w.push(1, 1);
  }
  ends.forEach((p, i) => { src.push(p); dst.push(corners[i]); w.push(0.001); });
  const fit = fitHomography(src, dst, w);
  if (!fit) return { corners, lines, found: 0 };
  const next = ends.map(([x, y]) => applyH(fit, x, y));
  if (!cornersValid(next)) return { corners, lines, found: 0 };
  return { corners: next, lines, found: found.length };
}
