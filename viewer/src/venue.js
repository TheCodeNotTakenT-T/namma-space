/**
 * Venue document: the searchable, navigable description of one reconstructed space.
 *
 * A venue holds points of interest (a spot: "Whiteboard"), zones (a floor area: "Front rows", "Room 204")
 * and levels (storeys). All geometry is stored in the reconstruction's own coordinates ("raw-ply-v1", the
 * same space as the splat and the collision mesh) so it stays valid when the floor, scale or entrance
 * calibration is redone. The viewer converts to metres only for navigation and distances.
 *
 * The shape follows indoor-mapping practice (Apple/OGC IMDF: venue > level > unit > amenity/anchor) without
 * its GeoJSON envelope: a reconstructed room has no latitude and longitude.
 */

export const VENUE_TYPE = 'namma-venue';
export const VENUE_VERSION = 1;
export const COORDINATE_SPACE = 'raw-ply-v1';
export const DEFAULT_LEVEL = 'L1';

export const LIMITS = { pois: 2000, zones: 500, levels: 20, name: 80, description: 400, aliases: 12, polygon: 64 };

/**
 * Categories drive the icon, the colour, the filter chips and extra search words.
 * `words` are terms people type when they mean this kind of place.
 */
export const CATEGORIES = {
  entrance: { label: 'Entrances & exits', color: '#34c98a', words: ['entrance', 'exit', 'door', 'gate', 'way out', 'entry'] },
  room: { label: 'Rooms & halls', color: '#5b8def', words: ['room', 'hall', 'class', 'classroom', 'lab', 'office', 'cabin'] },
  seating: { label: 'Seating', color: '#f2a03d', words: ['seat', 'seating', 'sit', 'bench', 'chair', 'sofa', 'couch'] },
  desk: { label: 'Desks & counters', color: '#c98a5b', words: ['desk', 'table', 'counter', 'reception', 'podium', 'workspace'] },
  display: { label: 'Boards & screens', color: '#9b7bf0', words: ['board', 'whiteboard', 'blackboard', 'screen', 'projector', 'display', 'notice'] },
  washroom: { label: 'Washrooms', color: '#3dbbd4', words: ['washroom', 'toilet', 'restroom', 'bathroom', 'wc', 'loo'] },
  stairs: { label: 'Stairs & lifts', color: '#8a94a8', words: ['stairs', 'staircase', 'steps', 'lift', 'elevator', 'escalator', 'ramp'] },
  food: { label: 'Food & water', color: '#ef7f6b', words: ['food', 'water', 'cooler', 'canteen', 'cafeteria', 'coffee', 'drink', 'vending'] },
  utility: { label: 'Power & utilities', color: '#e3c13f', words: ['power', 'socket', 'plug', 'charging', 'switch', 'switchboard', 'printer', 'wifi', 'ac', 'fan'] },
  safety: { label: 'Safety', color: '#ef5b6f', words: ['fire', 'extinguisher', 'first aid', 'emergency', 'alarm', 'safety'] },
  item: { label: 'Items & products', color: '#d86bd1', words: ['item', 'product', 'shelf', 'rack', 'stock', 'aisle'] },
  info: { label: 'Other', color: '#a3acbd', words: ['info', 'information', 'help', 'window', 'other'] },
};

export const categoryOf = id => CATEGORIES[id] ?? CATEGORIES.info;

class VenueError extends Error {}
const demand = (ok, message) => { if (!ok) throw new VenueError(message); };
const isVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const text = (value, max, what, { optional = false } = {}) => {
  if (optional && (value === undefined || value === null || value === '')) return '';
  demand(typeof value === 'string', `${what} must be text.`);
  const clean = value.replace(/\s+/g, ' ').trim();
  demand(clean.length > 0 || optional, `${what} is empty.`);
  demand(clean.length <= max, `${what} is longer than ${max} characters.`);
  return clean;
};

/** A URL- and id-safe name: "Meeting Room 4" -> "meeting-room-4"; unique within `taken`. */
export function slugify(name, taken = new Set()) {
  const base = String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'place';
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

export function emptyVenue(name = 'Untitled space') {
  return {
    version: VENUE_VERSION, type: VENUE_TYPE, coordinateSpace: COORDINATE_SPACE, name,
    levels: [{ id: DEFAULT_LEVEL, name: 'Ground floor' }], zones: [], pois: [], synonyms: {},
  };
}

function cleanShared(entry, what, levelIds, ids) {
  demand(entry && typeof entry === 'object', `${what} is not an object.`);
  const name = text(entry.name, LIMITS.name, `${what} name`);
  demand(typeof entry.id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id), `${what} "${name}" has an invalid id.`);
  demand(!ids.has(entry.id), `Two places share the id "${entry.id}".`);
  ids.add(entry.id);
  const level = entry.level ?? DEFAULT_LEVEL;
  demand(levelIds.has(level), `${what} "${name}" refers to an unknown level "${level}".`);
  const aliases = entry.aliases ?? [];
  demand(Array.isArray(aliases) && aliases.length <= LIMITS.aliases, `${what} "${name}" has too many other names.`);
  return {
    id: entry.id, name, category: CATEGORIES[entry.category] ? entry.category : 'info', level,
    aliases: aliases.map(alias => text(alias, LIMITS.name, `Other name of "${name}"`)),
    description: text(entry.description, LIMITS.description, `Description of "${name}"`, { optional: true }),
  };
}

/**
 * Check an untrusted venue document and return a clean copy with defaults filled in.
 * Throws an Error whose message can be shown to the person who supplied the file.
 */
export function validateVenue(input) {
  demand(input && typeof input === 'object', 'Venue file is not an object.');
  demand(input.type === VENUE_TYPE && input.version === VENUE_VERSION, 'Unsupported venue file.');
  demand(input.coordinateSpace === COORDINATE_SPACE, 'Venue uses an unknown coordinate space.');
  const venue = emptyVenue(text(input.name, 200, 'Venue name'));
  if (typeof input.sceneIdentity === 'string' && input.sceneIdentity.length <= 200) venue.sceneIdentity = input.sceneIdentity;

  const levels = input.levels ?? venue.levels;
  demand(Array.isArray(levels) && levels.length >= 1 && levels.length <= LIMITS.levels, 'Venue needs 1 to 20 levels.');
  const levelIds = new Set();
  venue.levels = levels.map(level => {
    demand(typeof level?.id === 'string' && /^[A-Za-z0-9-]{1,16}$/.test(level.id) && !levelIds.has(level.id), 'Invalid or repeated level id.');
    levelIds.add(level.id);
    const clean = { id: level.id, name: text(level.name ?? level.id, LIMITS.name, 'Level name') };
    if (Number.isFinite(level.elevation)) clean.elevation = level.elevation;
    return clean;
  });

  const ids = new Set();
  const pois = input.pois ?? [], zones = input.zones ?? [];
  demand(Array.isArray(pois) && pois.length <= LIMITS.pois, `A venue holds at most ${LIMITS.pois} points of interest.`);
  demand(Array.isArray(zones) && zones.length <= LIMITS.zones, `A venue holds at most ${LIMITS.zones} zones.`);
  venue.zones = zones.map(zone => {
    const clean = cleanShared(zone, 'Zone', levelIds, ids);
    demand(Array.isArray(zone.polygon) && zone.polygon.length >= 3 && zone.polygon.length <= LIMITS.polygon && zone.polygon.every(isVector),
      `Zone "${clean.name}" needs 3 to ${LIMITS.polygon} corner points.`);
    return { ...clean, polygon: zone.polygon.map(point => [...point]) };
  });
  venue.pois = pois.map(poi => {
    const clean = cleanShared(poi, 'Point of interest', levelIds, ids);
    demand(isVector(poi.position), `"${clean.name}" has no valid position.`);
    return { ...clean, position: [...poi.position] };
  });

  const synonyms = input.synonyms ?? {};
  demand(synonyms && typeof synonyms === 'object' && !Array.isArray(synonyms) && Object.keys(synonyms).length <= 200, 'Invalid synonym table.');
  for (const [word, others] of Object.entries(synonyms)) {
    demand(Array.isArray(others) && others.length <= 20 && others.every(other => typeof other === 'string' && other.length <= 40), `Invalid synonyms for "${word}".`);
    venue.synonyms[text(word, 40, 'Synonym')] = others.map(other => other.trim()).filter(Boolean);
  }
  return venue;
}

const taken = venue => new Set([...venue.pois, ...venue.zones].map(entry => entry.id));

/** Add a point of interest or replace the one with the same id. Returns a new, validated venue. */
export function upsertPoi(venue, poi) {
  const id = poi.id ?? slugify(poi.name, taken(venue));
  const pois = venue.pois.filter(existing => existing.id !== id);
  return validateVenue({ ...venue, pois: [...pois, { ...poi, id }] });
}

/** Add a zone or replace the one with the same id. Returns a new, validated venue. */
export function upsertZone(venue, zone) {
  const id = zone.id ?? slugify(zone.name, taken(venue));
  const zones = venue.zones.filter(existing => existing.id !== id);
  return validateVenue({ ...venue, zones: [...zones, { ...zone, id }] });
}

/** Remove a point of interest or zone by id. Returns a new, validated venue. */
export function removePlace(venue, id) {
  return validateVenue({ ...venue, pois: venue.pois.filter(poi => poi.id !== id), zones: venue.zones.filter(zone => zone.id !== id) });
}

/** Every searchable place, points and zones alike, tagged with its kind. */
export function places(venue) {
  return [...venue.pois.map(poi => ({ ...poi, kind: 'poi' })), ...venue.zones.map(zone => ({ ...zone, kind: 'zone' }))];
}

/** Centre of a zone's corner points (raw coordinates); the anchor used for labels and routing. */
export function zoneCentre(zone) {
  const sum = [0, 0, 0];
  for (const point of zone.polygon) for (let axis = 0; axis < 3; axis++) sum[axis] += point[axis];
  return sum.map(value => value / zone.polygon.length);
}

/** The raw-coordinate anchor of any place. */
export const anchorOf = place => place.position ?? zoneCentre(place);
