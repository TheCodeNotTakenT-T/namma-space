import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TriangleBVH } from '../src/bvh.js';

/** Brute-force reference: nearest hit over every triangle. */
function slowRaycast(positions, indices, origin, direction) {
  let best = Infinity;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map(k => [0, 1, 2].map(axis => positions[indices[t + k] * 3 + axis]));
    const e1 = b.map((v, i) => v - a[i]), e2 = c.map((v, i) => v - a[i]);
    const p = [direction[1] * e2[2] - direction[2] * e2[1], direction[2] * e2[0] - direction[0] * e2[2], direction[0] * e2[1] - direction[1] * e2[0]];
    const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
    if (Math.abs(det) < 1e-9) continue;
    const s = origin.map((v, i) => v - a[i]);
    const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) / det;
    if (u < 0 || u > 1) continue;
    const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
    const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) / det;
    if (v < 0 || u + v > 1) continue;
    const distance = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
    if (distance > 1e-9 && distance < best) best = distance;
  }
  return best;
}

let seed = 11;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function randomMesh(triangles) {
  const positions = [], indices = [];
  for (let t = 0; t < triangles; t++) {
    const centre = [random() * 20 - 10, random() * 4, random() * 20 - 10];
    for (let c = 0; c < 3; c++) positions.push(centre[0] + random() - 0.5, centre[1] + random() - 0.5, centre[2] + random() - 0.5);
    indices.push(t * 3, t * 3 + 1, t * 3 + 2);
  }
  return { positions, indices };
}

test('a ray hits the floor quad from above at the expected point', () => {
  const bvh = new TriangleBVH([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5], [0, 1, 2, 0, 2, 3]);
  const hit = bvh.raycast([1, 3, 2], [0, -1, 0]);
  assert.ok(hit);
  assert.ok(Math.abs(hit.distance - 3) < 1e-6);
  assert.deepEqual(hit.point.map(v => Math.round(v * 1e6) / 1e6), [1, 0, 2]);
  assert.equal(bvh.raycast([1, 3, 2], [0, 1, 0]), null, 'pointing away');
  assert.equal(bvh.raycast([9, 3, 2], [0, -1, 0]), null, 'beside the quad');
  assert.equal(bvh.raycast([1, 3, 2], [0, -1, 0], 2.5), null, 'beyond the limit');
});

test('nearest hits agree with a brute-force scan on a random mesh', () => {
  const { positions, indices } = randomMesh(3000);
  const bvh = new TriangleBVH(positions, indices);
  let hits = 0;
  for (let trial = 0; trial < 300; trial++) {
    const origin = [random() * 24 - 12, random() * 6 - 1, random() * 24 - 12];
    const d = [random() - 0.5, random() - 0.5, random() - 0.5], n = Math.hypot(...d);
    const direction = d.map(v => v / n);
    const expected = slowRaycast(positions, indices, origin, direction);
    const found = bvh.raycast(origin, direction);
    if (expected === Infinity) assert.equal(found, null);
    else { hits++; assert.ok(found && Math.abs(found.distance - expected) < 1e-4, `trial ${trial}: ${found?.distance} vs ${expected}`); }
  }
  assert.ok(hits > 30, 'the test exercised real hits');
});

test('sight lines: a wall blocks, a margin forgives the surface a place is tagged on', () => {
  // A wall in the plane x = 0, 4 m wide and 3 m tall.
  const bvh = new TriangleBVH([0, 0, -2, 0, 0, 2, 0, 3, 2, 0, 3, -2], [0, 1, 2, 0, 2, 3]);
  assert.ok(bvh.blocked([-3, 1, 0], [3, 1, 0]), 'the wall is between the two points');
  assert.ok(!bvh.blocked([-3, 1, 0], [-1, 1, 0]), 'both points on the same side');
  assert.ok(!bvh.blocked([-3, 1, 0], [3, 1, 5]), 'the line passes beside the wall');
  assert.ok(bvh.blocked([-3, 1, 0], [0.05, 1, 0]), 'a point just behind the wall is hidden');
  assert.ok(!bvh.blocked([-3, 1, 0], [0.05, 1, 0], 0.3), 'unless it is within the margin: a poster on that wall');
});

test('degenerate input is safe and unindexed triangles work', () => {
  assert.equal(new TriangleBVH([], []).raycast([0, 0, 0], [0, 1, 0]), null);
  const soup = new TriangleBVH([-1, 0, -1, 1, 0, -1, 0, 0, 1]);
  assert.ok(soup.raycast([0, 2, 0], [0, -1, 0]));
  const many = new TriangleBVH(Array.from({ length: 50 }, () => [0, 0, 0, 1, 0, 0, 0, 0, 1]).flat());
  assert.ok(Math.abs(many.raycast([0.2, 1, 0.2], [0, -1, 0]).distance - 1) < 1e-6, 'identical triangles do not break the split');
});
