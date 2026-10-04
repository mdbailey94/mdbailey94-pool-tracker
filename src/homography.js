// Planar homography: maps pool coordinates (lanes across, metres along) to
// camera image coordinates, from the four corners the coach taps.

// Solve the 3×3 homography H (h33 = 1) taking src[i] → dst[i] for four point
// pairs. Points are [x, y].
export function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const h = solve(A, b);
  if (!h) throw new Error('Those four corners do not form a usable shape. Spread them out around the pool.');
  return [...h, 1];
}

// Gaussian elimination with partial pivoting; null if singular.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

export function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

export function invertH(H) {
  const [a, b, c, d, e, f, g, h, i] = H;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) throw new Error('Homography is not invertible.');
  const inv = [
    A, -(b * i - c * h), b * f - c * e,
    B, a * i - c * g, -(a * f - c * d),
    C, -(a * h - b * g), a * e - b * d,
  ].map((v) => v / det);
  return inv.map((v) => v / inv[8]);
}

// Corners are tapped in this order (normalised image coordinates 0–1):
// start wall at the first lane, start wall at the last lane, turn wall at the
// last lane, turn wall at the first lane. Pool coordinates: x = lanes across
// (0 … lanes), y = distance from the start wall (0 … length).
export function poolToImage(corners, lanes, length) {
  const pool = [[0, 0], [lanes, 0], [lanes, length], [0, length]];
  return homography(pool, corners);
}

// Reject corner sets that are twisted (edges crossing) or collapsed, which
// would make the lane grid meaningless.
export function cornersValid(corners) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    const [cx, cy] = corners[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1e-4) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
  }
  return true;
}

// Least-squares homography through any number (≥ 4) of point pairs, each
// with a weight: the best compromise when some points are surer than others.
export function fitHomography(src, dst, weights = src.map(() => 1)) {
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row, rhs, w) => {
    for (let i = 0; i < 8; i++) {
      Atb[i] += w * row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += w * row[i] * row[j];
    }
  };
  src.forEach(([x, y], i) => {
    const [u, v] = dst[i];
    const w = weights[i];
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u, w);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v, w);
  });
  const h = solve(AtA, Atb);
  return h ? [...h, 1] : null;
}
