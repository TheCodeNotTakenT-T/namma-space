import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyVenue, validateVenue, upsertPoi, upsertZone, removePlace, places, slugify, zoneCentre, anchorOf, categoryOf } from '../src/venue.js';

const square = [[0, 0, 0], [4, 0, 0], [4, 0, 4], [0, 0, 4]];

test('a venue round-trips through validation with defaults filled in', () => {
  let venue = emptyVenue('Classroom');
  venue = upsertPoi(venue, { name: 'Whiteboard', category: 'display', position: [1, 2, 3], aliases: ['board'] });
  venue = upsertZone(venue, { name: 'Front rows', category: 'seating', polygon: square });
  const again = validateVenue(JSON.parse(JSON.stringify(venue)));
  assert.deepEqual(again, venue);
  assert.equal(venue.pois[0].id, 'whiteboard');
  assert.equal(venue.pois[0].level, 'L1');
  assert.equal(venue.zones[0].id, 'front-rows');
  assert.deepEqual(places(venue).map(place => place.kind), ['poi', 'zone']);
});

test('ids are unique slugs and adding the same name twice keeps both places', () => {
  assert.equal(slugify('Meeting Room 4'), 'meeting-room-4');
  assert.equal(slugify('Café – Level 2'), 'cafe-level-2');
  assert.equal(slugify('!!!'), 'place');
  let venue = emptyVenue('Hall');
  venue = upsertPoi(venue, { name: 'Door', position: [0, 0, 0] });
  venue = upsertPoi(venue, { name: 'Door', position: [5, 0, 0] });
  assert.deepEqual(venue.pois.map(poi => poi.id), ['door', 'door-2']);
});

test('editing by id replaces a place and removal works for points and zones', () => {
  let venue = upsertPoi(emptyVenue('Hall'), { name: 'Door', position: [0, 0, 0] });
  venue = upsertPoi(venue, { id: 'door', name: 'Main door', category: 'entrance', position: [1, 0, 0] });
  assert.equal(venue.pois.length, 1);
  assert.equal(venue.pois[0].name, 'Main door');
  venue = upsertZone(venue, { name: 'Stage', polygon: square });
  venue = removePlace(removePlace(venue, 'door'), 'stage');
  assert.equal(places(venue).length, 0);
});

test('untrusted files are rejected with a readable reason', () => {
  const base = emptyVenue('Hall');
  assert.throws(() => validateVenue(null), /not an object/);
  assert.throws(() => validateVenue({ ...base, version: 2 }), /Unsupported/);
  assert.throws(() => validateVenue({ ...base, coordinateSpace: 'metres' }), /coordinate space/);
  assert.throws(() => validateVenue({ ...base, pois: [{ id: 'a', name: 'A', position: [0, 0, NaN] }] }), /no valid position/);
  assert.throws(() => validateVenue({ ...base, pois: [{ id: 'A b', name: 'A', position: [0, 0, 0] }] }), /invalid id/);
  assert.throws(() => validateVenue({ ...base, pois: [{ id: 'a', name: 'A', position: [0, 0, 0] }, { id: 'a', name: 'B', position: [1, 0, 0] }] }), /share the id/);
  assert.throws(() => validateVenue({ ...base, pois: [{ id: 'a', name: 'A', level: 'L9', position: [0, 0, 0] }] }), /unknown level/);
  assert.throws(() => validateVenue({ ...base, zones: [{ id: 'z', name: 'Z', polygon: [[0, 0, 0], [1, 0, 0]] }] }), /corner points/);
  assert.throws(() => validateVenue({ ...base, pois: [{ id: 'a', name: 'x'.repeat(81), position: [0, 0, 0] }] }), /longer than/);
});

test('unknown categories fall back to Other; zone anchors are their centre', () => {
  const venue = upsertPoi(emptyVenue('Hall'), { name: 'Thing', category: 'spaceship', position: [0, 0, 0] });
  assert.equal(venue.pois[0].category, 'info');
  assert.equal(categoryOf('nope').label, 'Other');
  assert.deepEqual(zoneCentre({ polygon: square }), [2, 0, 2]);
  assert.deepEqual(anchorOf({ position: [1, 2, 3] }), [1, 2, 3]);
});
