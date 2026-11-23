/**
 * Bounding-volume hierarchy over a triangle mesh, for fast ray queries against the collision surface:
 * what did the visitor click, and is a place hidden behind a wall?
 *
 * The renderer's own ray cast walks every triangle (about 27 ms per ray on a 200,000-triangle room, measured
 * in the browser); this tree answers in microseconds, so sight lines can be checked every frame.
 * Nodes live in flat typed arrays; a leaf holds up to LEAF_SIZE triangles.
 */

const LEAF_SIZE = 6;
const EPSILON = 1e-9;

export class TriangleBVH {
  /**
   * @param {ArrayLike<number>} positions x, y, z per vertex
   * @param {ArrayLike<number>} [indices] three vertex indices per triangle; omitted for unindexed triangles
   */
  constructor(positions, indices) {
    const count = Math.floor((indices ? indices.length : positions.length / 3) / 3);
    this.count = count;
    // Triangle corners copied out once, so queries never chase indices.
    const corners = this.corners = new Float32Array(count * 9);
    for (let t = 0; t < count; t++) {
      for (let c = 0; c < 3; c++) {
        const v = (indices ? indices[t * 3 + c] : t * 3 + c) * 3;
        corners[t * 9 + c * 3] = positions[v]; corners[t * 9 + c * 3 + 1] = positions[v + 1]; corners[t * 9 + c * 3 + 2] = positions[v + 2];
      }
    }
    const centres = new Float32Array(count * 3);
    for (let t = 0; t < count; t++) {
      for (let axis = 0; axis < 3; axis++) centres[t * 3 + axis] = (corners[t * 9 + axis] + corners[t * 9 + 3 + axis] + corners[t * 9 + 6 + axis]) / 3;
    }
    this.order = new Uint32Array(count);
    for (let t = 0; t < count; t++) this.order[t] = t;
    const capacity = Math.max(1, 2 * Math.ceil(count / 1) + 1);
    this.bounds = new Float32Array(capacity * 6);     // min x, y, z, max x, y, z per node
    this.left = new Int32Array(capacity);             // child index, or -1 for a leaf
    this.right = new Int32Array(capacity);
    this.start = new Uint32Array(capacity);           // leaf: first slot in `order`
    this.size = new Uint32Array(capacity);            // leaf: triangle count
    this.nodes = 0;
    if (count) this.#build(centres);
  }

  #build(centres) {
    const { corners, order, bounds } = this;
    const stack = [[this.nodes++, 0, this.count]];
    while (stack.length) {
      const [node, from, to] = stack.pop();
      const box = node * 6;
      let cMin = [Infinity, Infinity, Infinity], cMax = [-Infinity, -Infinity, -Infinity];
      for (let axis = 0; axis < 3; axis++) { bounds[box + axis] = Infinity; bounds[box + 3 + axis] = -Infinity; }
      for (let i = from; i < to; i++) {
        const t = order[i] * 9;
        for (let axis = 0; axis < 3; axis++) {
          const low = Math.min(corners[t + axis], corners[t + 3 + axis], corners[t + 6 + axis]);
          const high = Math.max(corners[t + axis], corners[t + 3 + axis], corners[t + 6 + axis]);
          if (low < bounds[box + axis]) bounds[box + axis] = low;
          if (high > bounds[box + 3 + axis]) bounds[box + 3 + axis] = high;
          const centre = centres[order[i] * 3 + axis];
          if (centre < cMin[axis]) cMin[axis] = centre;
          if (centre > cMax[axis]) cMax[axis] = centre;
        }
      }
      const spans = [cMax[0] - cMin[0], cMax[1] - cMin[1], cMax[2] - cMin[2]];
      const axis = spans[0] >= spans[1] && spans[0] >= spans[2] ? 0 : spans[1] >= spans[2] ? 1 : 2;
      if (to - from <= LEAF_SIZE || spans[axis] < EPSILON) {
        this.left[node] = -1; this.start[node] = from; this.size[node] = to - from;
        continue;
      }
      // Split at the middle of the centroid box; triangles are swapped into two runs in place.
      const middle = (cMin[axis] + cMax[axis]) / 2;
      let i = from, j = to - 1;
      while (i <= j) {
        if (centres[order[i] * 3 + axis] < middle) i++;
        else { const swap = order[i]; order[i] = order[j]; order[j] = swap; j--; }
      }
      const split = i === from || i === to ? (from + to) >> 1 : i;
      const leftChild = this.nodes++, rightChild = this.nodes++;
      this.left[node] = leftChild; this.right[node] = rightChild;
      stack.push([leftChild, from, split], [rightChild, split, to]);
    }
  }

  /** Distance at which a ray enters a node's box, or Infinity when it misses or the box lies beyond `limit`. */
  #enter(node, ox, oy, oz, ix, iy, iz, limit) {
    const b = this.bounds, box = node * 6;
    let near = 0, far = limit;
    let a = (b[box] - ox) * ix, c = (b[box + 3] - ox) * ix;
    if (a > c) { const s = a; a = c; c = s; }
    if (a > near) near = a; if (c < far) far = c;
    a = (b[box + 1] - oy) * iy; c = (b[box + 4] - oy) * iy;
    if (a > c) { const s = a; a = c; c = s; }
    if (a > near) near = a; if (c < far) far = c;
    a = (b[box + 2] - oz) * iz; c = (b[box + 5] - oz) * iz;
    if (a > c) { const s = a; a = c; c = s; }
    if (a > near) near = a; if (c < far) far = c;
    return near <= far ? near : Infinity;
  }

  /**
   * Nearest intersection of a ray with the mesh (both faces count).
   * @param {number[]} origin [x, y, z]
   * @param {number[]} direction unit vector [x, y, z]
   * @param {number} [limit] ignore hits farther than this
   * @returns {{distance: number, point: number[], triangle: number} | null}
   */
  raycast(origin, direction, limit = Infinity) {
    if (!this.count) return null;
    const [ox, oy, oz] = origin, [dx, dy, dz] = direction;
    const ix = 1 / (Math.abs(dx) > EPSILON ? dx : EPSILON), iy = 1 / (Math.abs(dy) > EPSILON ? dy : EPSILON), iz = 1 / (Math.abs(dz) > EPSILON ? dz : EPSILON);
    const corners = this.corners, stack = [0];
    let best = limit, hit = -1;
    while (stack.length) {
      const node = stack.pop();
      if (this.#enter(node, ox, oy, oz, ix, iy, iz, best) === Infinity) continue;
      if (this.left[node] === -1) {
        for (let i = this.start[node], end = i + this.size[node]; i < end; i++) {
          const t = this.order[i] * 9;
          // Moller-Trumbore.
          const e1x = corners[t + 3] - corners[t], e1y = corners[t + 4] - corners[t + 1], e1z = corners[t + 5] - corners[t + 2];
          const e2x = corners[t + 6] - corners[t], e2y = corners[t + 7] - corners[t + 1], e2z = corners[t + 8] - corners[t + 2];
          const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
          const det = e1x * px + e1y * py + e1z * pz;
          if (det > -EPSILON && det < EPSILON) continue;
          const inv = 1 / det, sx = ox - corners[t], sy = oy - corners[t + 1], sz = oz - corners[t + 2];
          const u = (sx * px + sy * py + sz * pz) * inv;
          if (u < 0 || u > 1) continue;
          const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
          const v = (dx * qx + dy * qy + dz * qz) * inv;
          if (v < 0 || u + v > 1) continue;
          const distance = (e2x * qx + e2y * qy + e2z * qz) * inv;
          if (distance > EPSILON && distance < best) { best = distance; hit = this.order[i]; }
        }
      } else {
        // Visit the nearer child first so the farther one is often skipped.
        const a = this.left[node], b = this.right[node];
        const da = this.#enter(a, ox, oy, oz, ix, iy, iz, best), db = this.#enter(b, ox, oy, oz, ix, iy, iz, best);
        if (da < db) { if (db !== Infinity) stack.push(b); if (da !== Infinity) stack.push(a); }
        else { if (da !== Infinity) stack.push(a); if (db !== Infinity) stack.push(b); }
      }
    }
    return hit < 0 ? null : { distance: best, point: [ox + dx * best, oy + dy * best, oz + dz * best], triangle: hit };
  }

  /**
   * Is the straight line from `from` to `to` blocked by the mesh? `margin` is a distance before `to` that
   * may be blocked without counting, so a point tagged on a wall is not hidden by that wall.
   */
  blocked(from, to, margin = 0) {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], distance = Math.hypot(dx, dy, dz);
    if (distance - margin <= EPSILON) return false;
    return this.raycast(from, [dx / distance, dy / distance, dz / distance], distance - margin) !== null;
  }
}
