import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';
import { pathLength, simplifyPath, turnAngle, describeRoute, progressAlong, pointAt, markersAlong, boundaryEdges, clearance, formatDuration } from '../src/route.js';
import { cameraBasis, projectPoint, screenRay, mapTransform, boundsOf } from '../src/projection.js';
import { buildNavigation } from '../src/navigation.js';
import { makeDemo } from '../src/demo.js';

const p = (x, z, y = 0) => ({ x, y, z });
// Walk 4 m along +x, turn left (towards -z with +y up), walk 3 m.
const leftTurn = [p(0, 0), p(4, 0), p(4, -3)];

test('length, turn direction and simplification', () => {
  assert.equal(pathLength(leftTurn), 7);
  assert.equal(Math.round(turnAngle(...leftTurn)), 90, 'facing +x, -z is on the left');
  assert.equal(Math.round(turnAngle(p(0, 0), p(4, 0), p(4, 3))), -90);
  const noisy = [p(0, 0), p(0, 0), p(2, 0.001), p(4, 0), p(4, -3)];
  assert.deepEqual(simplifyPath(noisy), leftTurn);
});

test('a route is described as steps with distances and a time', () => {
  const route = describeRoute(leftTurn, { destination: 'Whiteboard' });
  assert.equal(route.length, 7);
  assert.ok(Math.abs(route.seconds - 7 / 1.3) < 1e-9);
  assert.deepEqual(route.steps.map(step => step.type), ['left', 'arrive']);
  assert.equal(route.steps[0].text, 'Turn left in 4 m');
  assert.equal(route.steps[1].text, 'Arrive at Whiteboard in 3 m');
  const straight = describeRoute([p(0, 0), p(12, 0)], { destination: 'Door' });
  assert.deepEqual(straight.steps.map(step => step.text), ['Go straight for 10 m', 'Arrive at Door in 10 m']);
  assert.deepEqual(describeRoute([p(0, 0), p(3, 0), p(5, 1.2)]).steps.map(step => step.type), ['slight-right', 'arrive']);
  assert.equal(formatDuration(4), 'a few seconds');
  assert.equal(formatDuration(12), 'about 10 s');
  assert.equal(formatDuration(200), 'about 3 min');
});

test('progress along a route: travelled, remaining and distance off the route', () => {
  const on = progressAlong(leftTurn, p(3, 0));
  assert.deepEqual([on.travelled, on.remaining, on.offRoute, on.segment], [3, 4, 0, 0]);
  const off = progressAlong(leftTurn, p(5, -1));
  assert.deepEqual([off.travelled, off.remaining, off.offRoute, off.segment], [5, 2, 1, 1]);
  assert.equal(progressAlong(leftTurn, p(-2, 0)).travelled, 0);
});

test('markers flow along the route and stop short of the destination', () => {
  const at = pointAt(leftTurn, 5);
  assert.deepEqual([at.point.x, at.point.z, at.direction.x, at.direction.z], [4, -1, 0, -1]);
  const still = markersAlong(leftTurn, { spacing: 1, phase: 0 });
  const moved = markersAlong(leftTurn, { spacing: 1, phase: 0.5 });
  assert.ok(still.length >= 5 && still.every(marker => marker.distance < 7 - 0.35));
  assert.equal(moved[0].distance, 0.5);
  assert.deepEqual(markersAlong(leftTurn, { spacing: 1, phase: 1.5 }).map(m => m.distance), moved.map(m => m.distance), 'phase wraps');
});

test('clearance measures the distance from a route to the edge of the walkable area', () => {
  // A 4 m x 2 m rectangle made of two triangles; the shared diagonal is not a boundary.
  const positions = [0, 0, 0, 4, 0, 0, 4, 0, 2, 0, 0, 2], indices = [0, 1, 2, 0, 2, 3];
  const edges = boundaryEdges(positions, indices);
  assert.equal(edges.length, 4);
  const middle = clearance([p(0.5, 1), p(3.5, 1)], edges);
  assert.ok(Math.abs(middle.min - 0.5) < 1e-9 && middle.mean > 0.9);
  assert.ok(Math.abs(clearance([p(1, 0.25), p(3, 0.25)], edges).min - 0.25) < 1e-9);
});

test('camera projection and the minimap transform invert correctly', () => {
  // Camera at the origin looking down -z with +y up: identity world matrix.
  const basis = cameraBasis([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const centre = projectPoint([0, 0, -5], basis, 60, 16 / 9);
  assert.deepEqual([centre.x, centre.y, centre.depth, centre.visible], [0.5, 0.5, 5, true]);
  const upRight = projectPoint([1, 1, -5], basis, 60, 16 / 9);
  assert.ok(upRight.x > 0.5 && upRight.y < 0.5, 'right is right and up is towards the top of the screen');
  assert.equal(projectPoint([0, 0, 5], basis, 60, 16 / 9).visible, false, 'behind the camera');
  assert.equal(projectPoint([50, 0, -5], basis, 60, 16 / 9).visible, false, 'outside the view');
  // A click ray is the inverse of projection: the ray through a projected point passes through that point.
  const ray = screenRay(basis, 60, 16 / 9, upRight.x, upRight.y), length = Math.hypot(1, 1, 5);
  assert.deepEqual(ray.map(value => Math.round(value * 1e6)), [1, 1, -5].map(value => Math.round(value / length * 1e6)));
  const map = mapTransform(boundsOf([0, 0, 0, 8, 0, 4]), 200, 200, 10);
  const [px, py] = map.toMap(8, 4);
  assert.deepEqual(map.toWorld(px, py).map(value => Math.round(value * 1e6) / 1e6), [8, 4]);
  assert.equal(map.scale, 22.5);
});

test('a tagged place off the floor routes to the nearest walkable spot beside it', async () => {
  const nav = await buildNavigation(makeDemo());
  try {
    const start = nav.nearest(new Vector3(0, 0.04, 2.8));
    assert.ok(start);
    const onDesk = new Vector3(0, 0.9, 0);                 // on top of the demo desk
    assert.equal(nav.nearest(onDesk), null, 'the desk top itself is not walkable');
    const target = nav.target(onDesk);
    assert.ok(target && target.point.y < 0.3, 'target is on the floor');
    assert.ok(Math.hypot(target.point.x, target.point.z) < 2.5, 'and close to the desk');
    const path = nav.routeTo(start.point, onDesk);
    assert.ok(path && path.length >= 2);
    assert.equal(nav.target(new Vector3(100, 0, 100)), null);
    const mesh = nav.walkableMesh();
    assert.ok(mesh.indices.length >= 3 && mesh.positions.length >= 9);
    const edges = boundaryEdges(mesh.positions, mesh.indices);
    assert.ok(clearance(path, edges).min >= -1e-6);
  } finally { nav.dispose(); }
});

test('navmesh routes stay within 2% of the shortest path found by an exhaustive grid search', async () => {
  // Floor 10 m x 10 m with a wall that leaves a single gap: the only way through is around the wall end.
  const box = (w, h, d, x, y, z) => { const m = new Mesh(new BoxGeometry(w, h, d), new MeshBasicMaterial()); m.position.set(x, y, z); return m; };
  const root = new Group();
  root.add(box(10, 0.2, 10, 0, -0.1, 0), box(7, 2.5, 0.4, -1.5, 1.25, 0));
  const nav = await buildNavigation(root, { fillHoles: false });
  try {
    const start = new Vector3(-3, 0, -3), end = new Vector3(-3, 0, 3);
    const path = nav.route(nav.nearest(start).point, end);
    assert.ok(path);
    // Exhaustive reference: Dijkstra over a 10 cm grid of the same walkable area, 16-connected.
    const { positions, indices } = nav.walkableMesh();
    const inside = (x, z) => {
      for (let t = 0; t < indices.length; t += 3) {
        const [ax, az, bx, bz, cx, cz] = [0, 1, 2].flatMap(k => [positions[indices[t + k] * 3], positions[indices[t + k] * 3 + 2]]);
        const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz), d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz), d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
        if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
      }
      return false;
    };
    const step = 0.1, size = 101, cell = (x, z) => Math.round((x + 5) / step) + size * Math.round((z + 5) / step);
    const free = new Uint8Array(size * size);
    for (let iz = 0; iz < size; iz++) for (let ix = 0; ix < size; ix++) free[ix + size * iz] = inside(-5 + ix * step, -5 + iz * step) ? 1 : 0;
    const moves = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) if ((dx || dz) && (Math.abs(dx) === 2 || Math.abs(dz) === 2 || Math.max(Math.abs(dx), Math.abs(dz)) === 1)) moves.push([dx, dz, Math.hypot(dx, dz) * step]);
    const distance = new Float64Array(size * size).fill(Infinity), done = new Uint8Array(size * size);
    distance[cell(start.x, start.z)] = 0;
    for (;;) {
      let current = -1, best = Infinity;
      for (let i = 0; i < distance.length; i++) if (!done[i] && distance[i] < best) { best = distance[i]; current = i; }
      if (current < 0 || current === cell(end.x, end.z)) break;
      done[current] = 1;
      const ix = current % size, iz = Math.floor(current / size);
      for (const [dx, dz, cost] of moves) {
        const nx = ix + dx, nz = iz + dz;
        if (nx < 0 || nz < 0 || nx >= size || nz >= size || !free[nx + size * nz]) continue;
        if (Math.abs(dx) === 2 || Math.abs(dz) === 2) { if (!free[ix + Math.sign(dx) * (Math.abs(dx) > 1 ? 1 : 0) + size * (iz + Math.sign(dz) * (Math.abs(dz) > 1 ? 1 : 0))]) continue; }
        if (best + cost < distance[nx + size * nz]) distance[nx + size * nz] = best + cost;
      }
    }
    const reference = distance[cell(end.x, end.z)];
    assert.ok(Number.isFinite(reference), 'the reference search reaches the goal');
    const ratio = pathLength(path) / reference;
    assert.ok(ratio < 1.02, `navmesh path ${pathLength(path).toFixed(2)} m vs grid optimum ${reference.toFixed(2)} m`);
  } finally { nav.dispose(); }
});

test('a route that doubles back is followed in order when the search is kept near the last position', () => {
  // Out along a corridor to a stop at x = 6 and back past the start to x = -2.
  const outAndBack = [p(0, 0), p(6, 0), p(6, 0.4), p(-2, 0.4)];
  const walker = p(2, 0.2);
  const anywhere = progressAlong(outAndBack, walker);
  const early = progressAlong(outAndBack, walker, { from: 0, to: 4 });
  const late = progressAlong(outAndBack, walker, { from: 9, to: 14 });
  assert.ok(Math.abs(early.travelled - 2) < 1e-9, 'on the way out');
  assert.ok(Math.abs(late.travelled - 10.4) < 1e-9, 'on the way back');
  assert.ok([early.travelled, late.travelled].some(value => Math.abs(value - anywhere.travelled) < 1e-9));
  const outside = progressAlong(outAndBack, walker, { from: 100, to: 120 });
  assert.equal(outside.travelled, anywhere.travelled, 'a window beyond the route falls back to the whole route');
});
