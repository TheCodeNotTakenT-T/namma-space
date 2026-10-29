import { init, NavMeshQuery } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import { Vector3 } from 'three';

export async function buildNavigation(root, {fillHoles = true} = {}) {
  await init();
  root.updateMatrixWorld(true);
  const positions = [], indices = [];
  const p = new Vector3();
  root.traverse(mesh => {
    if (!mesh.isMesh) return;
    const attr = mesh.geometry.attributes.position;
    const offset = positions.length / 3;
    for (let i = 0; i < attr.count; i++) {
      p.fromBufferAttribute(attr, i).applyMatrix4(mesh.matrixWorld);
      positions.push(p.x, p.y, p.z);
    }
    const index = mesh.geometry.index;
    for (let i = 0; i < (index?.count ?? attr.count); i++) indices.push(offset + (index ? index.getX(i) : i));
  });
  if (indices.length / 3 > 250000) throw new Error('Simplify the walking mesh to 250,000 triangles or fewer before importing.');
  if (fillHoles) fillFloor(positions, indices);
  // Forgiving walker for reconstructed rooms, whose noise (small floating blobs, floor bumps) is not furniture:
  // 1.2 m clearance ignores blobs above chest height, a 30 cm step crosses low bumps but not bench seats
  // (~45 cm) or desks, and a 15 cm radius fits between benches. Recast height, climb and radius are in voxels.
  const result = generateSoloNavMesh(positions, indices, {
    cs: 0.05, ch: 0.04, walkableSlopeAngle: 45,
    walkableHeight: Math.ceil(1.2 / 0.04), walkableClimb: Math.floor(0.3 / 0.04),
    walkableRadius: Math.ceil(0.15 / 0.05), minRegionArea: 8, mergeRegionArea: 20,
  });
  if (!result.success) throw new Error('Could not build walking surfaces. Check scale, orientation and floor coverage.');
  return new Navigation(result.navMesh);
}

// Reconstructions leave holes in the floor where it was poorly filmed, and a hole stops the walker. Lay a flat
// floor (two triangles) at the observed floor height under the area the observed floor spans; walls and
// furniture still block because they stand on top of it. Positions are metres with the picked floor at y = 0.
export function fillFloor(positions, indices) {
  const xs = [], zs = [], ys = [];
  let area = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t], indices[t + 1], indices[t + 2]].map(i => i * 3);
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const y = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3;
    if (Math.abs(ny) > 0.9 * Math.hypot(nx, ny, nz) && Math.abs(y) < 0.25) {
      for (const i of [a, b, c]) { xs.push(positions[i]); zs.push(positions[i + 2]); }
      ys.push(y);
      area += Math.hypot(nx, ny, nz) / 2;
    }
  }
  if (area < 1) return false;  // under 1 m² of observed floor: too little to trust its extent
  const pick = (values, q) => values.slice().sort((u, v) => u - v)[Math.min(values.length - 1, Math.floor(q * values.length))];
  const [x0, x1, z0, z1, y] = [pick(xs, 0.01), pick(xs, 0.99), pick(zs, 0.01), pick(zs, 0.99), pick(ys, 0.5)];
  const base = positions.length / 3;
  positions.push(x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z1);
  indices.push(base, base + 2, base + 1, base, base + 3, base + 2);  // counter-clockwise seen from above (+y)
  return true;
}

export class Navigation {
  constructor(mesh) { this.mesh = mesh; this.query = new NavMeshQuery(mesh); }
  nearest(point) {
    const r = this.query.findClosestPoint(point, { halfExtents: { x: 0.4, y: 0.35, z: 0.4 } });
    return r.success && r.polyRef && new Vector3().copy(r.point).distanceTo(point) < 0.45 ? r : null;
  }
  route(start, end) {
    const target = this.nearest(end);
    if (!target) return null;
    const r = this.query.computePath(start, target.point, { halfExtents: { x: 0.4, y: 0.35, z: 0.4 }, maxPathPolys: 2048 });
    // Detour may return a partial path to an unreachable island. Never present that as success.
    if (!r.success || !r.path.length || new Vector3().copy(r.path.at(-1)).distanceTo(target.point) > 0.12) return null;
    return r.path.map(p => new Vector3().copy(p));
  }
  move(state, delta) {
    // Small local steps keep moveAlongSurface from bridging disconnected surfaces.
    const steps = Math.max(1, Math.ceil(delta.length() / 0.08));
    const step = delta.clone().divideScalar(steps);
    for (let i = 0; i < steps; i++) {
      const r = this.query.moveAlongSurface(state.polyRef, state.point, new Vector3().copy(state.point).add(step));
      if (!r.success || !r.visited.length) break;
      state.polyRef = r.visited.at(-1);
      state.point = r.resultPosition;
      const h = this.query.getPolyHeight(state.polyRef, state.point);
      if (h.success) state.point.y = h.height;
    }
    return state;
  }
  dispose() { this.query.destroy(); this.mesh.destroy(); }
}
