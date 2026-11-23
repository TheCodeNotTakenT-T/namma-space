/**
 * Visiting several places in the best order: the shortest walk that starts where you stand and passes
 * every stop once (an open travelling-salesman path over walking distances).
 *
 * Up to EXACT_LIMIT stops the answer is exact (Held-Karp dynamic programming over subsets); beyond that a
 * nearest-neighbour tour improved by 2-opt is returned, which is close to optimal for indoor layouts.
 */

export const EXACT_LIMIT = 12;

/**
 * @param {number[]} fromStart walking distance from the start to each stop (Infinity when unreachable)
 * @param {number[][]} between between[i][j]: walking distance from stop i to stop j
 * @returns {{order: number[], length: number}} stop indices in visiting order and the total distance;
 *   unreachable stops are left out
 */
export function bestOrder(fromStart, between) {
  const stops = fromStart.map((distance, i) => i).filter(i => Number.isFinite(fromStart[i]));
  const n = stops.length;
  if (n === 0) return { order: [], length: 0 };
  const start = stops.map(i => fromStart[i]);
  const d = stops.map(i => stops.map(j => between[i][j]));
  const local = n <= EXACT_LIMIT ? heldKarp(start, d) : twoOpt(nearestNeighbour(start, d), start, d);
  return { order: local.map(i => stops[i]), length: tourLength(local, start, d) };
}

export function tourLength(order, start, d) {
  let total = order.length ? start[order[0]] : 0;
  for (let i = 1; i < order.length; i++) total += d[order[i - 1]][order[i]];
  return total;
}

/** Exact: cost[mask][last] is the shortest way to visit the stops in `mask`, ending at `last`. */
function heldKarp(start, d) {
  const n = start.length, size = 1 << n;
  const cost = new Float64Array(size * n).fill(Infinity), parent = new Int8Array(size * n).fill(-1);
  for (let i = 0; i < n; i++) cost[(1 << i) * n + i] = start[i];
  for (let mask = 1; mask < size; mask++) {
    for (let last = 0; last < n; last++) {
      const here = cost[mask * n + last];
      if (!(mask & (1 << last)) || here === Infinity) continue;
      for (let next = 0; next < n; next++) {
        if (mask & (1 << next)) continue;
        const to = (mask | (1 << next)) * n + next, value = here + d[last][next];
        if (value < cost[to]) { cost[to] = value; parent[to] = last; }
      }
    }
  }
  let last = 0;
  for (let i = 1; i < n; i++) if (cost[(size - 1) * n + i] < cost[(size - 1) * n + last]) last = i;
  const order = [];
  for (let mask = size - 1; last !== -1; ) {
    order.push(last);
    const previous = parent[mask * n + last];
    mask &= ~(1 << last);
    last = previous;
  }
  return order.reverse();
}

function nearestNeighbour(start, d) {
  const n = start.length, left = new Set(start.map((_, i) => i)), order = [];
  let current = -1;
  while (left.size) {
    let best = -1, bestDistance = Infinity;
    for (const i of left) { const distance = current < 0 ? start[i] : d[current][i]; if (distance < bestDistance) { bestDistance = distance; best = i; } }
    if (best < 0) best = left.values().next().value;      // only unreachable legs remain: keep any order
    order.push(best); left.delete(best); current = best;
  }
  return order.slice(0, n);
}

/** Reverse segments of the tour while that shortens it. */
function twoOpt(order, start, d) {
  let best = tourLength(order, start, d), improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const candidate = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const length = tourLength(candidate, start, d);
        if (length < best - 1e-9) { order = candidate; best = length; improved = true; }
      }
    }
  }
  return order;
}
