import { init, NavMeshQuery } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import { Vector3 } from 'three';

export async function buildNavigation(root) {
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
  // Recast height, climb and radius are in voxels, not metres.
  const result = generateSoloNavMesh(positions, indices, {
    cs: 0.05, ch: 0.04, walkableSlopeAngle: 40,
    walkableHeight: Math.ceil(1.7 / 0.04), walkableClimb: Math.floor(0.18 / 0.04),
    // 5 cm cells represent the intended 25 cm radius exactly. The previous
    // 8 cm grid rounded it to 32 cm, unnecessarily eroding narrow aisles.
    walkableRadius: Math.ceil(0.25 / 0.05), minRegionArea: 8, mergeRegionArea: 20,
  });
  if (!result.success) throw new Error('Could not build walking surfaces. Check scale, orientation and floor coverage.');
  return new Navigation(result.navMesh);
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
