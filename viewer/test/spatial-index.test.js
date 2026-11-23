import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpatialIndex, pointInPolygon, polygonArea } from '../src/spatial-index.js';

const room = [[0, 0], [6, 0], [6, 4], [0, 4]];
const lShape = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];

test('point in polygon handles concave shapes and edges', () => {
  assert.ok(pointInPolygon(1, 3, lShape));
  assert.ok(!pointInPolygon(3, 3, lShape), 'the notch of the L is outside');
  assert.ok(pointInPolygon(0, 2, lShape), 'a point on an edge is inside');
  assert.ok(!pointInPolygon(-0.01, 2, lShape));
  assert.equal(Math.abs(polygonArea(lShape)), 12);
});

test('zoneAt returns the containing zone, the smallest when zones nest, per level', () => {
  const index = new SpatialIndex();
  index.insertZone('room', room, 'L1', { id: 'room' });
  index.insertZone('desk-area', [[1, 1], [2, 1], [2, 2], [1, 2]], 'L1', { id: 'desk-area' });
  index.insertZone('upstairs', room, 'L2', { id: 'upstairs' });
  assert.equal(index.zoneAt(5, 3, 'L1').id, 'room');
  assert.equal(index.zoneAt(1.5, 1.5, 'L1').id, 'desk-area');
  assert.equal(index.zoneAt(1.5, 1.5, 'L2').id, 'upstairs');
  assert.equal(index.zoneAt(7, 3, 'L1'), null);
  index.remove('desk-area');
  assert.equal(index.zoneAt(1.5, 1.5, 'L1').id, 'room');
});

test('nearest agrees with a brute-force scan on random points', () => {
  const index = new SpatialIndex({ cellSize: 2 });
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const points = Array.from({ length: 400 }, (_, i) => ({ id: `p${i}`, x: random() * 60 - 30, z: random() * 40 - 20 }));
  for (const point of points) index.insertPoint(point.id, point.x, point.z, 'L1', point);
  for (let trial = 0; trial < 50; trial++) {
    const x = random() * 70 - 35, z = random() * 50 - 25;
    const expected = points.map(point => ({ id: point.id, distance: Math.hypot(point.x - x, point.z - z) }))
      .sort((a, b) => a.distance - b.distance).slice(0, 5);
    const found = index.nearest(x, z, 'L1', { count: 5 });
    assert.deepEqual(found.map(hit => hit.item.id), expected.map(hit => hit.id));
    assert.ok(Math.abs(found[0].distance - expected[0].distance) < 1e-9);
  }
});

test('nearest respects levels, filters, distance limits and removal', () => {
  const index = new SpatialIndex();
  index.insertPoint('a', 0, 0, 'L1', { id: 'a', category: 'washroom' });
  index.insertPoint('b', 3, 0, 'L1', { id: 'b', category: 'room' });
  index.insertPoint('c', 0.5, 0, 'L2', { id: 'c', category: 'room' });
  assert.equal(index.nearest(0.4, 0, 'L1')[0].item.id, 'a');
  assert.equal(index.nearest(0.4, 0, 'L2')[0].item.id, 'c');
  assert.equal(index.nearest(0.4, 0, 'L1', { filter: item => item.category === 'room' })[0].item.id, 'b');
  assert.deepEqual(index.nearest(0.4, 0, 'L1', { maxDistance: 0.1 }), []);
  assert.deepEqual(index.within(0, 0, 'L1', 3.5).map(hit => hit.item.id), ['a', 'b']);
  assert.deepEqual(index.nearest(0, 0, 'L3'), []);
  index.remove('a');
  assert.equal(index.nearest(0.4, 0, 'L1')[0].item.id, 'b');
  index.insertPoint('b', 100, 100, 'L1', { id: 'b' });
  assert.equal(index.within(0, 0, 'L1', 10).length, 0, 're-inserting an id moves it');
});
