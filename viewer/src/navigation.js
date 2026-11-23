import { init, NavMeshQuery, getNavMeshPositionsAndIndices } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import { Vector3 } from 'three';

// Search boxes (half-width, half-height, half-depth in metres) tried in turn to bring a tagged place to the
// floor: a point on the floor first, then one on a desk or wall, then one above furniture.
const REACH = [{ x: 0.4, y: 0.35, z: 0.4 }, { x: 0.9, y: 1.2, z: 0.9 }, { x: 1.8, y: 2.4, z: 1.8 }, { x: 3.5, y: 3, z: 3.5 }];

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
  removeIslands(result.navMesh);
  return new Navigation(result.navMesh);
}

/**
 * Flat tops of desks, benches and shelves, and specks of reconstruction noise, also come out of Recast as
 * walkable patches that nobody can reach. Left in, they capture clicks and tagged places ("nearest walkable
 * point" lands on a desk) and routes to them fail. Keep each connected area that is at least `keepFraction`
 * of the largest one (so a second storey or a second room survives) and switch the rest off: Detour's
 * default filter skips polygons whose flags are zero.
 * Works on single-tile (solo) navmeshes, where a polygon's neighbours are listed in the polygon itself.
 * @returns {{kept: number, removed: number}} polygon counts
 */
export function removeIslands(navMesh, keepFraction = 0.25) {
  let kept = 0, removed = 0;
  for (let t = 0; t < navMesh.getMaxTiles(); t++) {
    const tile = navMesh.getTile(t), count = tile?.header()?.polyCount() ?? 0;
    if (!count) continue;
    const component = new Int32Array(count).fill(-1), areas = [];
    for (let seed = 0; seed < count; seed++) {
      if (component[seed] !== -1) continue;
      const id = areas.length, stack = [seed];
      let area = 0;
      component[seed] = id;
      while (stack.length) {
        const poly = tile.polys(stack.pop()), corners = poly.vertCount();
        const xs = [], zs = [];
        for (let c = 0; c < corners; c++) { const v = poly.verts(c) * 3; xs.push(tile.verts(v)); zs.push(tile.verts(v + 2)); }
        for (let c = 1; c < corners - 1; c++) area += Math.abs((xs[c] - xs[0]) * (zs[c + 1] - zs[0]) - (xs[c + 1] - xs[0]) * (zs[c] - zs[0])) / 2;
        for (let c = 0; c < corners; c++) {
          const neighbour = poly.neis(c);
          if (!neighbour || neighbour & 0x8000) continue;        // 0: outer edge; 0x8000: link to another tile
          if (component[neighbour - 1] === -1) { component[neighbour - 1] = id; stack.push(neighbour - 1); }
        }
      }
      areas.push(area);
    }
    const threshold = Math.max(...areas) * keepFraction, base = navMesh.getPolyRefBase(tile);
    for (let i = 0; i < count; i++) {
      if (areas[component[i]] >= threshold) { kept++; continue; }
      navMesh.setPolyFlags(base | i, 0);
      removed++;
    }
  }
  return { kept, removed };
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
  /**
   * The walkable spot from which a tagged place is reached: the place itself when it lies on the floor,
   * otherwise the nearest floor beside it (a whiteboard on a wall, a projector above the desks).
   * Returns {point, polyRef} or null when no floor lies within 3.5 m.
   */
  target(point) {
    for (const halfExtents of REACH) {
      const r = this.query.findClosestPoint(point, { halfExtents });
      if (r.success && r.polyRef) return { point: new Vector3().copy(r.point), polyRef: r.polyRef };
    }
    return null;
  }
  /** Route from a walkable start to a tagged place. Returns the path points, or null when unreachable. */
  routeTo(start, place) {
    const target = this.target(place);
    return target ? this.route(start, target.point) : null;
  }
  /** Triangles of the reachable walkable area {positions, indices}, for the minimap and clearance measurements. */
  walkableMesh() {
    const [positions, indices] = getNavMeshPositionsAndIndices(this.mesh, 1);
    return { positions, indices };
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
