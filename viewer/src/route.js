/**
 * Route guidance on top of a navmesh path: length and time, turn-by-turn steps, progress while walking,
 * positions for the moving floor arrows, and clearance measurements that show a path keeps off obstacles.
 *
 * Points are {x, y, z} in the walking frame: metres, +y up, the floor near y = 0. All turning maths is done
 * on the floor plane (x/z).
 */

export const WALKING_SPEED = 1.3; // metres per second, an unhurried indoor pace

const flat = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

/** Length of a polyline in metres, measured along the floor. */
export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += flat(points[i - 1], points[i]);
  return total;
}

/** Drop repeated points and corners that bend less than `minAngle` degrees or sit closer than `minStep`. */
export function simplifyPath(points, { minStep = 0.05, minAngle = 3 } = {}) {
  const distinct = points.filter((point, i) => i === 0 || flat(points[i - 1], point) > 1e-4);
  if (distinct.length <= 2) return distinct;
  const kept = [distinct[0]];
  for (let i = 1; i < distinct.length - 1; i++) {
    const previous = kept.at(-1), point = distinct[i], next = distinct[i + 1];
    if (flat(previous, point) < minStep) continue;
    if (Math.abs(turnAngle(previous, point, next)) < minAngle) continue;
    kept.push(point);
  }
  kept.push(distinct.at(-1));
  return kept;
}

/**
 * Signed turn at `corner` when walking from `before` towards `after`, in degrees.
 * Positive is a left turn, negative a right turn (the walker's own left and right, +y up).
 */
export function turnAngle(before, corner, after) {
  const ax = corner.x - before.x, az = corner.z - before.z;
  const bx = after.x - corner.x, bz = after.z - corner.z;
  return Math.atan2(az * bx - ax * bz, ax * bx + az * bz) * 180 / Math.PI;
}

function turnName(angle) {
  const size = Math.abs(angle), side = angle > 0 ? 'left' : 'right';
  if (size < 25) return null;
  if (size < 55) return { type: `slight-${side}`, text: `Bear ${side}` };
  if (size < 125) return { type: side, text: `Turn ${side}` };
  if (size < 165) return { type: `sharp-${side}`, text: `Turn sharply ${side}` };
  return { type: 'u-turn', text: 'Turn around' };
}

const metres = value => (value < 9.5 ? `${Math.max(1, Math.round(value))} m` : `${Math.round(value / 5) * 5} m`);

/** "a few seconds", "about 20 s", "about 1 min", "about 3 min". */
export function formatDuration(seconds) {
  if (seconds < 8) return 'a few seconds';
  if (seconds < 50) return `about ${Math.round(seconds / 5) * 5} s`;
  return `about ${Math.max(1, Math.round(seconds / 60))} min`;
}

/**
 * Describe a route for display: totals and a short list of steps.
 * @param {Array<{x:number,y:number,z:number}>} points path from start to destination
 * @param {{destination?: string, speed?: number}} [options]
 * @returns {{length: number, seconds: number, steps: Array<{type: string, text: string, distance: number, at: number}>}}
 */
export function describeRoute(points, { destination = 'your destination', speed = WALKING_SPEED } = {}) {
  const path = simplifyPath(points, { minAngle: 8 });
  const length = pathLength(path);
  const steps = [];
  let legStart = 0, travelled = 0;
  const leg = () => pathLength(path.slice(legStart));
  for (let i = 1; i < path.length - 1; i++) {
    travelled += flat(path[i - 1], path[i]);
    const turn = turnName(turnAngle(path[i - 1], path[i], path[i + 1]));
    if (!turn) continue;
    const walked = pathLength(path.slice(legStart, i + 1));
    steps.push({ ...turn, distance: walked, at: travelled, text: `${turn.text} in ${metres(walked)}` });
    legStart = i;
  }
  const last = path.length > 1 ? leg() : 0;
  steps.push({ type: 'arrive', distance: last, at: length, text: `Arrive at ${destination}${last >= 1 ? ` in ${metres(last)}` : ''}` });
  if (steps.length === 1 && length >= 1) steps.unshift({ type: 'straight', distance: length, at: 0, text: `Go straight for ${metres(length)}` });
  return { length, seconds: length / speed, steps };
}

/**
 * Where a walker is along a route.
 * `from` and `to` (metres along the route) limit the search to a stretch of it. A route that passes the
 * same corridor twice (a visit with several stops) is then followed in order instead of jumping ahead.
 * @returns {{offRoute: number, travelled: number, remaining: number, segment: number, point: object}}
 *   `offRoute` is the floor distance from the walker to the nearest point of the route.
 */
export function progressAlong(points, position, { from = -Infinity, to = Infinity } = {}) {
  let best = { offRoute: Infinity, travelled: 0, segment: 0, point: points[0] };
  let before = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dx = b.x - a.x, dz = b.z - a.z, squared = dx * dx + dz * dz, length = Math.sqrt(squared);
    if (before + length >= from && before <= to) {
      let t = squared > 1e-12 ? Math.min(1, Math.max(0, ((position.x - a.x) * dx + (position.z - a.z) * dz) / squared)) : 0;
      if (length > 1e-9) t = Math.min(Math.max(t, (from - before) / length, 0), (to - before) / length, 1);
      const point = lerp(a, b, t);
      const offRoute = flat(point, position);
      if (offRoute < best.offRoute) best = { offRoute, travelled: before + length * t, segment: i - 1, point };
    }
    before += length;
  }
  if (best.offRoute === Infinity && (from > -Infinity || to < Infinity)) return progressAlong(points, position);
  return { ...best, remaining: Math.max(0, before - best.travelled) };
}

/** The point `distance` metres along the route and the unit walking direction there. */
export function pointAt(points, distance) {
  let before = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], step = flat(a, b);
    if (step > 1e-9 && distance <= before + step) {
      return { point: lerp(a, b, Math.max(0, distance - before) / step), direction: { x: (b.x - a.x) / step, z: (b.z - a.z) / step }, segment: i - 1 };
    }
    before += step;
  }
  const end = points.at(-1), previous = points.at(-2) ?? end, step = flat(previous, end) || 1;
  return { point: { ...end }, direction: { x: (end.x - previous.x) / step, z: (end.z - previous.z) / step }, segment: Math.max(0, points.length - 2) };
}

/**
 * Evenly spaced markers along a route, used for the moving floor arrows.
 * `phase` (0..spacing) slides the whole set forward; animate it to make the arrows flow to the destination.
 */
export function markersAlong(points, { spacing = 0.9, phase = 0, from = 0, margin = 0.35 } = {}) {
  const length = pathLength(points);
  const markers = [];
  for (let distance = from + ((phase % spacing) + spacing) % spacing; distance < length - margin; distance += spacing) {
    if (distance >= from + margin * 0.5) markers.push({ distance, ...pointAt(points, distance) });
  }
  return markers;
}

/** Unique boundary edges of a triangle mesh in x/z: the outline of the walkable area. */
export function boundaryEdges(positions, indices, { weld = 1e-3 } = {}) {
  const ids = new Map(), vertex = [];
  const idOf = index => {
    const x = positions[index * 3], z = positions[index * 3 + 2];
    const name = `${Math.round(x / weld)}|${Math.round(positions[index * 3 + 1] / weld)}|${Math.round(z / weld)}`;
    if (!ids.has(name)) { ids.set(name, vertex.length); vertex.push([x, z]); }
    return ids.get(name);
  };
  const uses = new Map();
  for (let t = 0; t < indices.length; t += 3) {
    const corner = [idOf(indices[t]), idOf(indices[t + 1]), idOf(indices[t + 2])];
    for (let e = 0; e < 3; e++) {
      const a = corner[e], b = corner[(e + 1) % 3];
      if (a === b) continue;
      const name = a < b ? `${a}|${b}` : `${b}|${a}`;
      uses.set(name, (uses.get(name) ?? 0) + 1);
    }
  }
  const edges = [];
  for (const [name, count] of uses) {
    if (count !== 1) continue;
    const [a, b] = name.split('|').map(Number);
    edges.push([vertex[a][0], vertex[a][1], vertex[b][0], vertex[b][1]]);
  }
  return edges;
}

function distanceToEdge(x, z, [ax, az, bx, bz]) {
  const dx = bx - ax, dz = bz - az, squared = dx * dx + dz * dz;
  const t = squared > 1e-12 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / squared)) : 0;
  return Math.hypot(x - ax - dx * t, z - az - dz * t);
}

/**
 * How far a route stays from the edge of the walkable area. The walkable area is already shrunk by the
 * walker's body radius, so a clearance of zero still leaves that radius of free space to the obstacle.
 * @returns {{min: number, mean: number, samples: number}} metres
 */
export function clearance(points, edges, { step = 0.1 } = {}) {
  const length = pathLength(points);
  let min = Infinity, sum = 0, samples = 0;
  for (let distance = 0; distance <= length; distance += step) {
    const { point } = pointAt(points, distance);
    let nearest = Infinity;
    for (const edge of edges) nearest = Math.min(nearest, distanceToEdge(point.x, point.z, edge));
    min = Math.min(min, nearest); sum += nearest; samples++;
  }
  return { min: samples ? min : 0, mean: samples ? sum / samples : 0, samples };
}
