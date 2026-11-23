import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestOrder, tourLength, EXACT_LIMIT } from '../src/tour.js';

let seed = 5;
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function layout(n) {
  const points = Array.from({ length: n + 1 }, () => [random() * 40, random() * 25]);
  const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const stops = points.slice(1);
  return { start: stops.map(p => distance(points[0], p)), between: stops.map(a => stops.map(b => distance(a, b))) };
}

function bruteForce(start, between) {
  let best = Infinity;
  const visit = (order, left) => {
    if (!left.length) { best = Math.min(best, tourLength(order, start, between)); return; }
    for (const next of left) visit([...order, next], left.filter(i => i !== next));
  };
  visit([], start.map((_, i) => i));
  return best;
}

test('up to the exact limit the order is the true shortest walk', () => {
  for (const n of [1, 2, 3, 5, 7]) {
    for (let trial = 0; trial < 6; trial++) {
      const { start, between } = layout(n);
      const result = bestOrder(start, between);
      assert.equal(result.order.length, n);
      assert.deepEqual([...result.order].sort((a, b) => a - b), start.map((_, i) => i), 'every stop exactly once');
      assert.ok(Math.abs(result.length - bruteForce(start, between)) < 1e-9, `n=${n} trial=${trial}`);
    }
  }
});

test('a simple corridor is walked end to end, not back and forth', () => {
  // Stops at 2, 8, 4, 6 metres along a corridor, starting at 0.
  const at = [2, 8, 4, 6];
  const result = bestOrder(at, at.map(a => at.map(b => Math.abs(a - b))));
  assert.deepEqual(result.order, [0, 2, 3, 1]);
  assert.equal(result.length, 8);
});

test('unreachable stops are left out and an empty list is fine', () => {
  const result = bestOrder([3, Infinity, 1], [[0, 9, 2], [9, 0, 9], [2, 9, 0]]);
  assert.deepEqual(result.order, [2, 0]);
  assert.equal(result.length, 3);
  assert.deepEqual(bestOrder([], []), { order: [], length: 0 });
});

test('beyond the exact limit the heuristic visits every stop and stays near a good tour', () => {
  const n = EXACT_LIMIT + 8, { start, between } = layout(n);
  const result = bestOrder(start, between);
  assert.deepEqual([...result.order].sort((a, b) => a - b), start.map((_, i) => i));
  // Nearest neighbour alone is the reference; 2-opt must not be worse.
  let current = -1, greedy = 0;
  const left = new Set(start.map((_, i) => i));
  while (left.size) {
    let best = -1, bestDistance = Infinity;
    for (const i of left) { const distance = current < 0 ? start[i] : between[current][i]; if (distance < bestDistance) { bestDistance = distance; best = i; } }
    greedy += bestDistance; left.delete(best); current = best;
  }
  assert.ok(result.length <= greedy + 1e-9);
});
