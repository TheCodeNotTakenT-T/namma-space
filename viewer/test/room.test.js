import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dominantAngle, roomBox } from '../src/room.js';

test('the wall direction is found for a rotated rectangle', () => {
  const turn = 25 * Math.PI / 180, c = Math.cos(turn), s = Math.sin(turn);
  const corner = (x, z) => [x * c - z * s, x * s + z * c];
  const corners = [corner(0, 0), corner(10, 0), corner(10, 6), corner(0, 6)];
  const edges = corners.map((from, i) => [...from, ...corners[(i + 1) % 4]]);
  assert.ok(Math.abs(dominantAngle(edges) * 180 / Math.PI - 25) < 1.5);
});

test('the room box follows the bulk of the points and ignores strays outside', () => {
  let seed = 3;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const turn = 25 * Math.PI / 180, c = Math.cos(turn), s = Math.sin(turn);
  const points = [];
  for (let i = 0; i < 6000; i++) { const x = random() * 10, z = random() * 6; points.push(x * c - z * s, 0.3 + random() * 1.7, x * s + z * c); }
  for (let i = 0; i < 60; i++) points.push(random() * 80 - 40, 1, random() * 80 - 40);        // 1% stray points far outside
  for (let i = 0; i < 500; i++) points.push(random() * 80 - 40, 5, random() * 80 - 40);       // above the height band: ignored
  const box = roomBox(points, turn, { margin: 0 });
  assert.ok(Math.abs(box.halfU - 5) < 0.4 && Math.abs(box.halfV - 3) < 0.4, `half sizes ${box.halfU}, ${box.halfV}`);
  const centre = [5 * c - 3 * s, 5 * s + 3 * c];
  assert.ok(Math.hypot(box.centre.x - centre[0], box.centre.z - centre[1]) < 0.4);
  assert.equal(roomBox([0, 1, 0], 0), null, 'too few points to say');
});
