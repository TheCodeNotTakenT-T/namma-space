/**
 * The shape of the space, worked out from the data alone: which way the walls run and where they are.
 * Used to draw the map square to the screen and to cut stray reconstruction away in the bird's-eye view.
 */

/**
 * The direction most walls run in, as an angle in radians within 0..90 degrees.
 * @param {Array<number[]>} edges boundary segments [ax, az, bx, bz] of the walkable area
 */
export function dominantAngle(edges) {
  const bins = new Float64Array(90);
  for (const [ax, az, bx, bz] of edges) {
    const angle = ((Math.atan2(bz - az, bx - ax) * 180 / Math.PI) % 90 + 90) % 90;
    bins[Math.floor(angle) % 90] += Math.hypot(bx - ax, bz - az);
  }
  let best = 0, bestWeight = -1;
  for (let i = 0; i < 90; i++) {
    const weight = bins[(i + 89) % 90] + 2 * bins[i] + bins[(i + 1) % 90];
    if (weight > bestWeight) { bestWeight = weight; best = i; }
  }
  return (best + 0.5) * Math.PI / 180;
}

/**
 * A wall-aligned box around the bulk of the reconstruction.
 *
 * Most of a scan's points sit on the walls, floor and furniture of the space; stray points outside are few.
 * Taking percentiles along the two wall directions therefore finds the walls without any model of the room.
 * @param {ArrayLike<number>} points x, y, z triples in the walking frame (metres, +y up)
 * @param {number} angle wall direction from `dominantAngle`
 * @param {{low?: number, high?: number, minHeight?: number, maxHeight?: number, margin?: number}} [options]
 * @returns {{centre: {x:number, z:number}, u: {x:number, z:number}, v: {x:number, z:number}, halfU: number, halfV: number} | null}
 */
export function roomBox(points, angle, { low = 0.015, high = 0.985, minHeight = 0.2, maxHeight = 2.2, margin = 0.35 } = {}) {
  const u = { x: Math.cos(angle), z: Math.sin(angle) }, v = { x: -Math.sin(angle), z: Math.cos(angle) };
  const us = [], vs = [];
  for (let i = 0; i < points.length; i += 3) {
    if (points[i + 1] < minHeight || points[i + 1] > maxHeight) continue;
    us.push(points[i] * u.x + points[i + 2] * u.z);
    vs.push(points[i] * v.x + points[i + 2] * v.z);
  }
  if (us.length < 100) return null;
  const pick = (values, q) => values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))];
  us.sort((a, b) => a - b); vs.sort((a, b) => a - b);
  const [u0, u1, v0, v1] = [pick(us, low) - margin, pick(us, high) + margin, pick(vs, low) - margin, pick(vs, high) + margin];
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return { centre: { x: cu * u.x + cv * v.x, z: cu * u.z + cv * v.z }, u, v, halfU: (u1 - u0) / 2, halfV: (v1 - v0) / 2 };
}
