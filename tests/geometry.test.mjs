import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyH, cornersValid, homography, invertH, poolToImage } from '../src/homography.js';
import { makeGeometry, Rectifier } from '../src/grid.js';

const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} ≈ ${b}`);

test('homography maps the four corners exactly and inverts', () => {
  const src = [[0, 0], [8, 0], [8, 25], [0, 25]];
  const dst = [[0.05, 0.95], [0.95, 0.9], [0.7, 0.1], [0.25, 0.12]];
  const H = homography(src, dst);
  src.forEach(([x, y], i) => {
    const [u, v] = applyH(H, x, y);
    close(u, dst[i][0]); close(v, dst[i][1]);
  });
  const Hi = invertH(H);
  const [u, v] = applyH(H, 3.3, 12.1);
  const [x, y] = applyH(Hi, u, v);
  close(x, 3.3, 1e-6); close(y, 12.1, 1e-6);
});

test('perspective: equal distances look shorter further away', () => {
  const H = poolToImage([[0.05, 0.95], [0.95, 0.95], [0.7, 0.1], [0.3, 0.1]], 8, 25);
  const near = applyH(H, 4, 0)[1] - applyH(H, 4, 5)[1];
  const far = applyH(H, 4, 20)[1] - applyH(H, 4, 25)[1];
  assert.ok(near > 2 * far, `near ${near} vs far ${far}`);
});

test('cornersValid rejects crossed or collapsed corners', () => {
  assert.equal(cornersValid([[0.1, 0.9], [0.9, 0.9], [0.7, 0.1], [0.3, 0.1]]), true);
  assert.equal(cornersValid([[0.1, 0.9], [0.9, 0.9], [0.3, 0.1], [0.7, 0.1]]), false); // twisted
  assert.equal(cornersValid([[0.1, 0.9], [0.5, 0.9], [0.9, 0.9], [0.3, 0.1]]), false); // three in a line
});

test('rectifier averages the right patch of the picture for each cell', () => {
  const w = 40, h = 40;
  // Picture: left half red, right half blue; pool fills the frame.
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(x < w / 2 ? [200, 0, 0, 255] : [0, 0, 200, 255], (y * w + x) * 4);
  const H = poolToImage([[0, 1], [1, 1], [1, 0], [0, 0]], 2, 10);
  const g = makeGeometry({ lanes: 2, length: 10, cellLen: 1, across: 2 });
  const cells = new Rectifier(H, g, w, h).sample(rgba);
  // Lane 0 (left) is red, lane 1 blue.
  assert.equal(cells[0], 200); assert.equal(cells[2], 0);
  const lane1 = (1 * g.across) * g.nx * 3;
  assert.equal(cells[lane1], 0); assert.equal(cells[lane1 + 2], 200);
});
