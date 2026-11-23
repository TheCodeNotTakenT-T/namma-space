import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSearchIndex, normalise, tokenise, editDistance, parseQuery, stem } from '../src/search.js';

const PLACES = [
  { id: 'meeting-room-4', name: 'Meeting Room 4', category: 'room', level: 'L1' },
  { id: 'meeting-room-14', name: 'Meeting Room 14', category: 'room', level: 'L2' },
  { id: 'washroom-men', name: "Men's Washroom", category: 'washroom', level: 'L1' },
  { id: 'sofas', name: '3-seater sofas', category: 'item', level: 'L1', aliases: ['lounge couches'] },
  { id: 'extinguisher', name: 'Fire extinguisher', category: 'safety', level: 'L1' },
  { id: 'whiteboard', name: 'Whiteboard', category: 'display', level: 'L1', zoneName: 'Room 204' },
  { id: 'reception', name: 'Reception', category: 'desk', level: 'L1', description: 'Visitor passes and parcels' },
  { id: 'stairs-a', name: 'Staircase A', category: 'stairs', level: 'L1' },
];
const index = createSearchIndex(PLACES);
const ids = (query, options) => index.search(query, options).map(result => result.entry.id);

test('text is normalised: case, accents, punctuation, letters split from digits', () => {
  assert.equal(normalise('  Café – Room204B '), 'cafe room 204 b');
  assert.deepEqual(tokenise("Men's Washroom"), ['men', 's', 'washroom']);
  assert.deepEqual(tokenise(''), []);
  assert.deepEqual(['sofas', 'benches', 'stairs', 'glass', 'bus', 'boxes'].map(stem), ['sofa', 'bench', 'stair', 'glass', 'bus', 'box']);
});

test('filler words are dropped, identifiers kept, and "nearest" is understood as an intent', () => {
  assert.deepEqual(parseQuery('Where can I sit?'), { words: ['sit'], nearest: false });
  assert.deepEqual(parseQuery('take me to the nearest washroom'), { words: ['washroom'], nearest: true });
  assert.deepEqual(parseQuery('Staircase A'), { words: ['staircase', 'a'], nearest: false });
  assert.deepEqual(parseQuery('is there a printer'), { words: ['printer'], nearest: false });
  assert.deepEqual(parseQuery('where is the'), { words: ['where', 'is', 'the'], nearest: false }, 'only filler: search it literally');
  assert.deepEqual(parseQuery(''), { words: [], nearest: false });
});

test('edit distance counts one swap as one edit and gives up beyond the limit', () => {
  assert.equal(editDistance('washroom', 'washroom'), 0);
  assert.equal(editDistance('recieve', 'receive'), 1);
  assert.equal(editDistance('stairs', 'stars'), 1);
  assert.equal(editDistance('sofa', 'reception', 2), 3);
});

test('exact names rank first and numbers are matched as whole words', () => {
  assert.equal(ids('meeting room 4')[0], 'meeting-room-4');
  assert.equal(ids('room 14')[0], 'meeting-room-14');
  assert.deepEqual(ids('Reception'), ['reception']);
});

test('results appear while typing: every word may be a prefix', () => {
  assert.equal(ids('wash')[0], 'washroom-men');
  assert.equal(ids('meet')[0], 'meeting-room-4');
  assert.deepEqual(ids('fire ext'), ['extinguisher']);
  assert.ok(ids('s').includes('sofas'), 'a single letter completes the last word');
});

test('typos are forgiven in longer words only', () => {
  assert.deepEqual(ids('extingisher'), ['extinguisher']);
  assert.deepEqual(ids('recepton'), ['reception']);
  assert.deepEqual(ids('whitebaord'), ['whiteboard']);
  assert.deepEqual(ids('xyz'), []);
});

test('synonyms and category words find places by meaning', () => {
  assert.equal(ids('toilet')[0], 'washroom-men');
  assert.equal(ids('couch')[0], 'sofas');
  assert.equal(ids('where can i sit')[0], 'sofas', 'a spoken-style question finds seating');
  assert.deepEqual(ids('purple sofas'), [], 'every meaningful word must match; no result is better than a wrong one');
  assert.equal(ids('sit')[0], 'sofas');
  assert.equal(ids('steps')[0], 'stairs-a');
  const [byCategory] = index.search('lift'), [byName] = index.search('staircase');
  assert.equal(byCategory.entry.id, 'stairs-a', 'no lift is tagged: the "Stairs & lifts" category still answers');
  assert.ok(byCategory.score < byName.score, 'a category match ranks below a name match');
  assert.ok(ids('emergency').includes('extinguisher'), 'category words are searchable');
});

test('other names, zone names and descriptions are searched with lower weight', () => {
  assert.equal(ids('lounge')[0], 'sofas');
  assert.equal(ids('204')[0], 'whiteboard');
  assert.equal(ids('parcels')[0], 'reception');
  const [name, description] = [index.search('reception')[0], index.search('parcels')[0]];
  assert.ok(name.score > description.score);
});

test('filters and walking distance shape the list', () => {
  assert.deepEqual(ids('meeting', { level: 'L2' }), ['meeting-room-14']);
  assert.deepEqual(ids('', { category: 'room' }).sort(), ['meeting-room-14', 'meeting-room-4']);
  const distanceOf = entry => ({ 'meeting-room-4': 40, 'meeting-room-14': 12 }[entry.id] ?? Infinity);
  assert.deepEqual(ids('meeting room', { distanceOf }), ['meeting-room-14', 'meeting-room-4'], 'equal matches: nearer first');
  assert.equal(ids('', { distanceOf, limit: 1 })[0], 'meeting-room-14', 'an empty query lists the nearest places');
  assert.equal(ids('meeting room 4', { distanceOf })[0], 'meeting-room-4', 'an exact name beats a nearer partial match');
  assert.equal(ids('nearest room', { distanceOf })[0], 'meeting-room-14', '"nearest" puts walking distance first');
  assert.deepEqual(ids('nearest meeting room 4', { distanceOf }), ['meeting-room-4'], 'but never adds places that do not match');
  assert.deepEqual(ids('meeting'), ['meeting-room-4', 'meeting-room-14'], 'numbers sort naturally: 4 before 14');
});

test('venue-specific synonyms extend the built-in table', () => {
  const custom = createSearchIndex(PLACES, { synonyms: { hod: ['reception'] } });
  assert.deepEqual(custom.search('hod').map(result => result.entry.id), ['reception']);
});
