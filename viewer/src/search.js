/**
 * Instant place search: typo-tolerant, prefix-aware and synonym-aware, with no network and no model download.
 *
 * Every keystroke runs a full query over an in-memory index, so results appear while typing. A query matches
 * a place when every meaningful query word matches one of the place's words exactly, as a prefix
 * ("wash" -> washroom), through a synonym ("toilet" -> washroom, "sit" -> seating) or within a small edit
 * distance ("extingisher"). Filler words are ignored, so "where can I sit" and "nearest washroom" work.
 * Ranking: where the word matched (name > other names > category > zone > description), how well it matched,
 * then walking distance when the caller supplies it. Asking for the "nearest" puts distance first.
 */
import { categoryOf } from './venue.js';

/** Words people use interchangeably indoors. Each group is expanded both ways. */
export const SYNONYM_GROUPS = [
  ['washroom', 'toilet', 'restroom', 'bathroom', 'wc', 'loo', 'lavatory'],
  ['stairs', 'staircase', 'stairway', 'steps'],
  ['lift', 'elevator'],
  ['exit', 'entrance', 'door', 'gate', 'entry', 'doorway'],
  ['seating', 'seat', 'sit', 'bench', 'chair', 'sofa', 'couch'],
  ['water', 'cooler', 'drinking', 'fountain', 'dispenser'],
  ['board', 'whiteboard', 'blackboard'],
  ['screen', 'projector', 'display', 'tv', 'monitor'],
  ['class', 'classroom', 'lecture', 'room', 'hall'],
  ['office', 'cabin', 'staffroom', 'faculty'],
  ['lab', 'laboratory'],
  ['canteen', 'cafeteria', 'cafe', 'mess', 'food'],
  ['printer', 'xerox', 'photocopy', 'photocopier'],
  ['power', 'socket', 'plug', 'charging', 'charger', 'outlet', 'switchboard'],
  ['bin', 'dustbin', 'trash', 'garbage', 'waste'],
  ['desk', 'table', 'podium', 'counter'],
  ['reception', 'helpdesk', 'enquiry', 'inquiry', 'information'],
  ['fire', 'extinguisher'],
];

/** Filler words in spoken-style queries. They carry no place meaning and are skipped. */
const STOP_WORDS = new Set(['where', 'is', 'are', 'the', 'a', 'an', 'i', 'can', 'could', 'do', 'does', 'how', 'to', 'get', 'go',
  'find', 'show', 'me', 'my', 'take', 'need', 'want', 'looking', 'for', 'there', 'any', 'some', 'please', 'at', 'in', 'of', 'on',
  'what', 'which', 'way', 'place', 'somewhere']);
/** Words that ask for the closest match rather than the best-named one. */
const NEAREST_WORDS = new Set(['nearest', 'closest', 'nearby', 'near', 'close']);

const FIELD_WEIGHT = { name: 5, alias: 4, category: 2.5, zone: 2, description: 1 };
const QUALITY = { exact: 1, prefix: 0.8, synonym: 0.7, fuzzy: 0.5 };

/** Lower-case, strip accents and punctuation, and split letters from digits ("Room204" -> "room 204"). */
export function normalise(value) {
  return String(value ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Singular form, enough for place names: sofas -> sofa, benches -> bench, stairs -> stair. */
export function stem(word) {
  if (word.length > 4 && /(ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

/** Words of a text, normalised and singular. */
export const tokenise = value => { const clean = normalise(value); return clean ? clean.split(' ').map(stem) : []; };

/**
 * Split a query into the words to match and the intent behind it.
 * A single letter after a real word is an identifier ("Staircase A", "Block I") and is kept.
 * @returns {{words: string[], nearest: boolean}}
 */
export function parseQuery(query) {
  const raw = normalise(query).split(' ').filter(Boolean);
  const words = [];
  let nearest = false, previousKept = false;
  for (const word of raw) {
    if (NEAREST_WORDS.has(word)) { nearest = true; previousKept = false; continue; }
    const identifier = word.length === 1 && previousKept;
    if (STOP_WORDS.has(word) && !identifier) { previousKept = false; continue; }
    words.push(stem(word));
    previousKept = true;
  }
  // A query made only of filler ("where is the") still searches for those words rather than matching everything.
  return { words: words.length || !raw.length || nearest ? words : raw.map(stem), nearest };
}

/** Damerau-Levenshtein distance (one swap of neighbours counts as one edit), abandoned above `limit`. */
export function editDistance(a, b, limit = 2) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous2 = null, previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (previous2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, previous2[j - 2] + 1);
      current.push(value);
      if (value < best) best = value;
    }
    if (best > limit) return limit + 1;
    previous2 = previous; previous = current;
  }
  return previous[b.length];
}

/** Allowed typos by word length: short words must match exactly, long ones forgive more. */
const typoBudget = word => (word.length >= 8 ? 2 : word.length >= 4 ? 1 : 0);

function synonymTable(extra = {}) {
  const table = new Map();
  const link = (a, b) => { if (a !== b) (table.get(a) ?? table.set(a, new Set()).get(a)).add(b); };
  for (const group of SYNONYM_GROUPS) for (const a of group) for (const b of group) link(stem(a), stem(b));
  for (const [word, others] of Object.entries(extra)) {
    for (const a of tokenise(word)) for (const other of others) for (const b of tokenise(other)) { link(a, b); link(b, a); }
  }
  return table;
}

/**
 * Build a search index over places.
 * @param {Array<object>} entries places from `places(venue)`; a `zoneName` field is searched too when present
 * @param {{synonyms?: Record<string, string[]>}} [options] extra venue-specific synonyms
 */
export function createSearchIndex(entries, { synonyms = {} } = {}) {
  const table = synonymTable(synonyms);
  const documents = entries.map(entry => {
    const category = categoryOf(entry.category);
    const fields = [
      ['name', tokenise(entry.name)],
      ['alias', (entry.aliases ?? []).flatMap(tokenise)],
      ['category', [...tokenise(category.label), ...category.words.flatMap(tokenise)]],
      ['zone', tokenise(entry.zoneName)],
      ['description', tokenise(entry.description)],
    ];
    return { entry, fields, name: tokenise(entry.name).join(' ') };
  });

  function matchWord(word, document, allowPrefix) {
    let best = null;
    const consider = (field, quality) => {
      const score = FIELD_WEIGHT[field] * quality;
      if (!best || score > best.score) best = { score, field };
    };
    const related = table.get(word);
    const budget = typoBudget(word);
    for (const [field, tokens] of document.fields) {
      for (const token of tokens) {
        if (token === word) consider(field, QUALITY.exact);
        else if (allowPrefix && token.startsWith(word)) consider(field, QUALITY.prefix);
        else if (related?.has(token)) consider(field, QUALITY.synonym);
        else if (budget && Math.abs(token.length - word.length) <= budget && token[0] === word[0] &&
                 editDistance(word, token, budget) <= budget) consider(field, QUALITY.fuzzy);
      }
    }
    return best;
  }

  /**
   * @param {string} query what the person typed
   * @param {{limit?: number, category?: string, level?: string, distanceOf?: (entry: object) => number}} [options]
   *   `distanceOf` returns the walking distance in metres to a place (Infinity when unreachable); nearer
   *   places win ties, an empty query lists places nearest first, and "nearest ..." sorts by distance.
   * @returns {Array<{entry: object, score: number, distance: number|undefined, matched: string[]}>}
   */
  function search(query, { limit = 8, category, level, distanceOf } = {}) {
    const { words, nearest } = parseQuery(query);
    const results = [];
    for (const document of documents) {
      const { entry } = document;
      if (category && entry.category !== category) continue;
      if (level && entry.level !== level) continue;
      let score = 0, complete = true;
      const matched = [];
      for (let i = 0; i < words.length; i++) {
        // Any word may still be unfinished while typing; one- and two-letter fragments only complete the last word.
        const hit = matchWord(words[i], document, i === words.length - 1 || words[i].length >= 3);
        if (!hit) { complete = false; break; }
        score += hit.score;
        matched.push(hit.field);
      }
      if (!complete) continue;
      if (words.length) {
        const phrase = words.join(' ');
        if (document.name === phrase) score += 6;
        else if (document.name.startsWith(phrase)) score += 3;
        score /= words.length;
      }
      results.push({ entry, score, distance: distanceOf ? distanceOf(entry) : undefined, matched });
    }
    const far = value => (Number.isFinite(value) ? value : Number.MAX_VALUE);
    const byName = (a, b) => a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true });
    const byDistance = (a, b) => far(a.distance) - far(b.distance);
    const byScore = (a, b) => b.score - a.score;
    results.sort(nearest
      ? (a, b) => byDistance(a, b) || byScore(a, b) || byName(a, b)
      : (a, b) => (Math.abs(b.score - a.score) > 0.25 ? byScore(a, b) : 0) || byDistance(a, b) || byScore(a, b) || byName(a, b));
    return results.slice(0, limit);
  }

  return { search, size: documents.length };
}
