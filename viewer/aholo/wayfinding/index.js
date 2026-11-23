/**
 * Wayfinding: turns a walkable reconstruction into a space you can search and be guided through.
 *
 * This controller owns the venue (places and zones), the indexes built from it, the selected place and the
 * active route. It listens to the walker, asks the navmesh for paths and drives four views: the search
 * column, the labels in the 3D view, the route drawn on the floor and the minimap.
 *
 * Frames: places are stored in reconstruction coordinates ("raw", arrays). Everything spatial here works in
 * the walking frame (metres, +y up), obtained through walk.toNav / walk.toRaw.
 */
import { validateVenue, emptyVenue, upsertPoi, upsertZone, removePlace, anchorOf } from '../../src/venue.js';
import { createSearchIndex } from '../../src/search.js';
import { SpatialIndex } from '../../src/spatial-index.js';
import { describeRoute, progressAlong, pathLength, pointAt } from '../../src/route.js';
import { createPathLayer } from './path-layer.js';
import { createLabels } from './labels.js';
import { createMinimap } from './minimap.js';
import { createPanel } from './panel.js';
import { createStudio } from './studio.js';
import { createEffects } from './effects.js';
import { createDollhouse } from './dollhouse.js';
import { boundaryEdges } from '../../src/route.js';
import { dominantAngle, roomBox } from '../../src/room.js';
import { bestOrder, tourLength } from '../../src/tour.js';
import { createVoice } from './voice.js';

const OFF_ROUTE = 1.2;      // metres off the line before the route is recalculated
const ARRIVED = 0.75;       // metres from the destination that count as arriving
const GUIDE_SPEED = 1.5;    // metres per second when the viewer walks you there
const LOOK_AHEAD = 1.5;     // metres ahead on the route that the guided camera faces
const CLICK_REACH = 0.8;    // metres around a click in which a tagged place is picked
const JUMP_STANDOFF = 1.8;  // metres short of a place at which "Jump there" sets you down
const POI_LABEL_LIFT = 0.12;
const ZONE_LABEL_HEIGHT = 1.35;
const PROGRESS_BACK = 2;    // metres: how far back along the route the walker is looked for
const PROGRESS_AHEAD = 4;   // metres: and how far ahead (keeps a route that doubles back in order)
const DWELL = 1.4;          // seconds a guided visit pauses at each stop, facing it

/** Directions as they are read aloud: "4 m" becomes "4 metres". */
const spoken = text => text.replace(/under 1 m\b/g, 'less than a metre').replace(/\b1 m\b/g, '1 metre').replace(/(\d+) m\b/g, '$1 metres').replace(/ \u00b7 /g, ', ');
const metresText = metres => (metres < 1 ? 'less than a metre' : `${Math.round(metres)} metre${Math.round(metres) === 1 ? '' : 's'}`);
/** Words around a spoken request that are not the place itself. */
const REQUEST_WORDS = /\b(hey|ok|okay|please|take me to|navigate to|go to|directions to|show me|walk me to|guide me to|i want to go to|i need|where is|where's|find)\b/gi;

export function createWayfinding({ app, container, viewer, camera, control, walk, dirty, toast, getSplat = () => null, getSplatSample = () => null, studioAllowed = false }) {
  let venue = emptyVenue();
  let scene = null;        // {identity, title, saveUrl}
  let studioMode = false;
  let runtime = null;      // indexes and per-place geometry, rebuilt when the venue or the walkable area changes
  let selected = null;     // id of the selected place
  let active = null;       // {place, target, points, description, guiding, arrived}
  let distances = { origin: null, values: new Map() };
  let rerouteAfter = 0, lastPose = '', fade = null;
  let visit = [], visitPlan = null;   // place ids of a visit with several stops, and its plan
  let spotlightTimer = 0, stopSpokenAt = 0;
  const voice = createVoice();

  // Controls reminder: shown on arrival, steps back once you have walked a few metres.
  const hint = app.appendChild(Object.assign(document.createElement('div'), { className: 'wf-hint', hidden: true }));
  hint.innerHTML = '<span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk</span><span><kbd>drag</kbd> look around</span><span><kbd>click</kbd> a place</span><span><kbd>/</kbd> search</span><span><kbd>M</kbd> bird\u2019s-eye</span>';
  let walked = 0, lastStep = null;

  // Corner tools: tagging (when allowed) and display settings. Everything else is in the view itself.
  const tools = app.appendChild(Object.assign(document.createElement('div'), { className: 'wf-tools', hidden: true }));
  const toolButton = (label, title, onclick, role = '') => {
    const button = Object.assign(document.createElement('button'), { className: 'wf-tool', type: 'button', textContent: label, title, onclick });
    if (role) button.dataset.role = role;
    tools.append(button);
    return button;
  };
  const tagButton = studioAllowed ? toolButton('Tag places', 'Add and edit places and zones, and set up walking', () => api.setStudio(!studioMode), 'tag') : null;
  // Display settings and the tagging plate share the right side: opening one closes the other.
  const sidebar = document.getElementById('sidebar');
  const displayButton = toolButton('Display', 'Display quality and view settings', () => {
    const opening = sidebar?.classList.contains('hidden');
    if (opening && studioMode) api.setStudio(false);
    sidebar?.classList.toggle('hidden', !opening);
    displayButton.classList.toggle('active', Boolean(opening));
  });
  document.getElementById('btn-close-sidebar')?.addEventListener('click', () => displayButton.classList.remove('active'));
  const credit = app.appendChild(Object.assign(document.createElement('p'), { className: 'wf-credit', hidden: true }));
  tools.hidden = false; credit.hidden = false;
  // Floor, scale and entrance setup: in the left column before walking, inside the tagging plate while walking.
  const setupPanel = app.querySelector('.namma-walking');
  credit.textContent = 'Team ruakpeedkahem (rpk) · NIT Goa · rendered with Aholo';

  const effects = createEffects({ getSplat, walk, dirty });
  // Bird's-eye view of the scan itself (M), also used for the flight of "Jump there".
  const overhead = app.appendChild(Object.assign(document.createElement('div'), { className: 'wf-overhead', hidden: true }));
  overhead.innerHTML = '<strong>Bird\u2019s-eye view</strong><span><kbd>drag</kbd> turn</span><span><kbd>scroll</kbd> zoom</span><span><kbd>click</kbd> the floor or a place to land there</span>';
  overhead.append(Object.assign(document.createElement('button'), { className: 'wf-overhead-back', type: 'button', textContent: 'Back to walking', onclick: () => dollhouse.close() }));
  const dollhouse = createDollhouse({
    app, container, camera, control, walk, effects, dirty,
    getRoomBox: () => runtime?.room ?? null,
    onPickFloor: point => { const target = walk.navigation()?.target(point); if (target) dollhouse.diveTo(target.point); },
    onClose: () => { overhead.hidden = true; labels.setSeeThrough(false); labels.setYou(null); lastPose = ''; if (selected && !active?.live) select(selected); updatePlayer(); },
  });
  function openOverhead() {
    if (!runtime || dollhouse.isActive()) return;
    if (active) active.guiding = false;
    const player = walk.player();
    if (!dollhouse.open()) return;
    overhead.hidden = false; labels.setSeeThrough(true);
    labels.setYou(walk.toRaw({ x: player.point.x, y: player.point.y + 0.1, z: player.point.z }));
  }

  const path = createPathLayer({ scene: viewer.getScene(), walk, dirty });
  const labels = createLabels({ app, container, camera, walk, onSelect: place => select(place.id) });
  const minimap = createMinimap({ app, onPickPlace: id => select(id), onPickFloor: point => walkTo({ x: point.x, y: 0, z: point.z }) });
  const panel = createPanel({
    app,
    actions: {
      search: (query, category) => runtime ? runtime.search.search(query, { category, limit: 30, distanceOf: entry => distanceTo(entry.id) }) : [],
      select: place => select(place.id),
      clearSelection: () => clearSelection(),
      directions: place => startDirections(place.id),
      toggleVisit: place => toggleVisit(place.id),
      clearVisit: () => setVisit([]),
      startVisit: () => startVisit(),
      listen: (onText, onEnd) => voice.listen(onText, onEnd),
      voicePick: text => voiceQuery(text),
      notify: message => toast(message, 'error'),
      canSpeak: () => voice.canSpeak,
      voiceEnabled: () => voice.enabled(),
      setVoice: on => { voice.setEnabled(on); if (on) voice.say('Spoken directions on.'); },
      jump: place => jumpTo(place.id),
      endRoute: () => clearSelection(),
      toggleGuide: () => setGuiding(!active?.guiding),
      edit: place => studio.edit(place),
      remove: place => { commit(removePlace(venue, place.id)); clearSelection(); toast(`Deleted ${place.name}`); },
    },
  });
  panel.enableVoice(voice.canListen);
  function setupMode() {
    panel.setMode('setup'); panel.show();
    if (setupPanel) { panel.dock(setupPanel); setupPanel.open = true; }
  }

  const studio = createStudio({
    app,
    actions: {
      savePoi: poi => attempt(() => commit(upsertPoi(venue, strip(poi)))),
      saveZone: zone => attempt(() => commit(upsertZone(venue, strip(zone)))),
      draftChanged: corners => {
        labels.setMarkers(corners);
        minimap.setDraft(corners.map(corner => { const p = walk.toNav(corner); return [p.x, p.z]; }));
        dirty();
      },
      exportVenue: () => download(`${JSON.stringify(venue, null, 2)}\n`, 'venue.json'),
      importVenue: async file => {
        try {
          if (file.size > 2 * 1024 ** 2) throw Error('That file is too large to be a venue.');
          commit(validateVenue(JSON.parse(await file.text())));
          return `Loaded ${venue.pois.length} places and ${venue.zones.length} zones.`;
        } catch (error) { return error.message; }
      },
      saveToLibrary,
    },
  });

  // ---- venue state ---------------------------------------------------------------------------------

  const storageKey = () => (scene?.identity ? `namma:venue:v1:${scene.identity}` : null);
  const strip = ({ kind, zoneName, levelName, reachable, ...place }) => place;
  const attempt = action => { try { action(); return null; } catch (error) { return error.message; } };

  /** Adopt a changed venue: keep a draft in this browser, rebuild the indexes and refresh every view. */
  function commit(next) {
    venue = next;
    if (studioMode && storageKey()) { try { localStorage.setItem(storageKey(), JSON.stringify(venue)); } catch { /* private window */ } }
    rebuild();
  }

  async function saveToLibrary() {
    if (!scene?.saveUrl) return 'Saving into the scene works in local development. Use Export on a hosted site.';
    try {
      const response = await fetch(scene.saveUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(venue) });
      if (!response.ok) throw Error((await response.text()) || 'The scene library refused the file.');
      try { localStorage.removeItem(storageKey()); } catch { /* private window */ }
      return 'Saved into the scene. It will be included when you package the site.';
    } catch (error) { return `Could not save: ${error.message}`; }
  }

  function download(text, name) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * Point the layer at a loaded scene.
   * @param {{identity: string|null, title: string, venueUrl?: string, saveUrl?: string, drafts?: boolean}} next
   *   `drafts`: this browser may hold unsaved tagging work for the scene (studio sessions only)
   */
  async function setScene(next) {
    scene = next;
    clearSelection();
    let loaded = emptyVenue(next.title);
    if (next.venueUrl) {
      try {
        const response = await fetch(next.venueUrl);
        if (response.ok) loaded = validateVenue(await response.json());
      } catch (error) { toast(`Places could not be loaded: ${error.message}`, 'error'); }
    }
    if (next.drafts && storageKey()) {
      // An unsaved draft from this browser wins over the packaged file, so tagging survives a reload.
      try { const draft = localStorage.getItem(storageKey()); if (draft) loaded = validateVenue(JSON.parse(draft)); } catch { /* damaged draft: ignore */ }
    }
    venue = loaded;
    panel.setTitle(next.title);
    studio.setVisible(studioMode && walk.ready());
    rebuild();
  }

  // ---- indexes -------------------------------------------------------------------------------------

  function rebuild() {
    runtime = null;
    if (!walk.ready()) return;
    const navigation = walk.navigation(), scale = walk.metresPerUnit(), up = walk.upRaw();
    const lifted = (raw, metres) => raw.map((value, axis) => value + up[axis] * metres / scale);
    const levelName = new Map(venue.levels.map(level => [level.id, level.name]));
    const spatial = new SpatialIndex();
    const entries = new Map();

    for (const zone of venue.zones) {
      const polygon = zone.polygon.map(corner => { const p = walk.toNav(corner); return [p.x, p.z]; });
      spatial.insertZone(zone.id, polygon, zone.level, zone);
      const floor = zone.polygon.reduce((sum, corner) => sum + walk.toNav(corner).y / zone.polygon.length, 0);
      const raw = anchorOf(zone), nav = walk.toNav(raw);
      entries.set(zone.id, {
        place: { ...zone, kind: 'zone' }, raw, nav, polygon,
        labelRaw: walk.toRaw({ x: nav.x, y: floor + ZONE_LABEL_HEIGHT, z: nav.z }),
      });
    }
    for (const poi of venue.pois) {
      const nav = walk.toNav(poi.position);
      const zone = spatial.zoneAt(nav.x, nav.z, poi.level);
      spatial.insertPoint(poi.id, nav.x, nav.z, poi.level, poi);
      entries.set(poi.id, { place: { ...poi, kind: 'poi', zoneName: zone?.name }, raw: poi.position, nav, labelRaw: lifted(poi.position, POI_LABEL_LIFT) });
    }
    for (const entry of entries.values()) {
      entry.place.levelName = venue.levels.length > 1 ? levelName.get(entry.place.level) : undefined;
      entry.target = navigation.target(entry.nav);
      entry.place.reachable = Boolean(entry.target);       // some walkable floor lies beside the place
    }

    const list = [...entries.values()].map(entry => entry.place);
    runtime = { entries, spatial, search: createSearchIndex(list, { synonyms: venue.synonyms }), room: measureRoom(navigation) };
    distances = { origin: null, values: new Map() };

    labels.setPlaces([...entries.values()].map(entry => ({ place: entry.place, raw: entry.labelRaw, sight: entry.raw })));
    minimap.setWalkable(navigation.walkableMesh());
    minimap.setPlaces(
      venue.zones.map(zone => ({ name: zone.name, polygon: entries.get(zone.id).polygon })),
      venue.pois.map(poi => ({ id: poi.id, name: poi.name, x: entries.get(poi.id).nav.x, z: entries.get(poi.id).nav.z })));
    minimap.setCaption(venue.name);
    panel.setCategories(new Set(list.map(place => place.category)));
    panel.show();
    panel.refresh();
    visit = visit.filter(id => entries.has(id));
    renderVisit();
    studio.setCounts(venue.pois.length, venue.zones.length);
    studio.setVisible(studioMode);
    if (selected && !entries.has(selected)) clearSelection();
    else if (selected) select(selected);
    updatePlayer();
    lastPose = '';
    dirty();
  }

  /** Where the walls are, from a sample of the splat centres: the bird's-eye view draws only what is inside. */
  function measureRoom(navigation) {
    const sample = getSplatSample();
    if (!sample) return null;
    const points = new Float32Array(sample.length);
    for (let i = 0; i < sample.length; i += 3) { const p = walk.toNav([sample[i], sample[i + 1], sample[i + 2]]); points[i] = p.x; points[i + 1] = p.y; points[i + 2] = p.z; }
    const mesh = navigation.walkableMesh();
    return roomBox(points, dominantAngle(boundaryEdges(mesh.positions, mesh.indices)));
  }

  /** Walking distance in metres from the walker to a place; Infinity when no route exists. Cached while standing still. */
  function distanceTo(id) {
    const player = walk.player(), entry = runtime?.entries.get(id);
    if (!player || !entry?.target) return Infinity;
    const origin = distances.origin;
    if (!origin || Math.hypot(origin.x - player.point.x, origin.z - player.point.z) > 0.4) {
      distances = { origin: { x: player.point.x, z: player.point.z }, values: new Map() };
    }
    if (!distances.values.has(id)) {
      const points = walk.navigation().route(player.point, entry.target.point);
      distances.values.set(id, points ? pathLength(points) : Infinity);
    }
    return distances.values.get(id);
  }

  // ---- selection and routes ------------------------------------------------------------------------

  function select(id) {
    const entry = runtime?.entries.get(id);
    if (!entry) return;
    selected = id; lastPose = '';
    labels.select(id); minimap.select(id);
    const shown = startRoute(id, { panel: false });
    if (!dollhouse.isFlying()) pingFrom(entry.target?.point ?? entry.nav, 6);
    panel.showPlace(entry.place, { distance: shown ? active.description.length : Infinity, studio: studioMode, inVisit: visit.includes(id) });
    dirty();
  }

  /** A ring of light across the room from a point: "here", or "this way". */
  function pingFrom(point, reach = 14) { effects.pulse({ x: point.x, y: point.y + 0.6, z: point.z }, reach); }

  function clearSelection() {
    selected = null; active = null; lastPose = '';
    path.clear(); labels.select(null); minimap.select(null); minimap.setRoute(null); minimap.setStatus('');
    panel.closeCard(); panel.closeDirections();
    dirty();
  }

  /** Directions to a place: route, sign, a ring of light from you and, with voice on, the first instruction. */
  function startDirections(id) {
    if (dollhouse.isActive()) dollhouse.close();
    if (!startRoute(id, { panel: true, intro: true })) return false;
    pingFrom(walk.player().point);
    return true;
  }

  /** Compute and draw the route to a place. With `panel` the live directions replace the place card. */
  function startRoute(id, { panel: openPanel, intro = false }) {
    const entry = runtime?.entries.get(id), player = walk.player();
    if (!entry?.target || !player) { path.clear(); minimap.setRoute(null); active = null; return false; }
    const points = walk.navigation().route(player.point, entry.target.point);
    if (!points) { path.clear(); minimap.setRoute(null); active = null; return false; }
    const description = describeRoute(points, { destination: entry.place.name });
    active = { place: entry.place, target: entry.target.point, points, description, travelled: 0, guiding: active?.guiding && active.place.id === id, arrived: false, live: openPanel || Boolean(active?.live && active.place.id === id),
      intro: intro ? `${entry.place.name}, ${metresText(description.length)}.` : '' };
    path.show(points);
    minimap.setRoute(points);
    if (openPanel) panel.showDirections(entry.place, description);
    updateProgress();
    return true;
  }

  /** Route to an untagged spot on the floor (a click on the minimap or a double click in the room). */
  function walkTo(point) {
    const player = walk.player(), target = walk.navigation()?.target(point);
    if (!player || !target) { toast('That spot cannot be reached on foot.', 'error'); return; }
    const points = walk.navigation().route(player.point, target.point);
    if (!points) { toast('That spot cannot be reached on foot.', 'error'); return; }
    const place = { id: '', name: 'Dropped pin', category: 'info', kind: 'pin' };
    selected = null; labels.select(null); minimap.select(null);
    active = { place, target: target.point, points, description: describeRoute(points, { destination: 'the pin' }), travelled: 0, guiding: false, arrived: false, live: true };
    path.show(points); minimap.setRoute(points);
    panel.showDirections(place, active.description);
    setGuiding(true);
  }

  function setGuiding(on) {
    if (!active) return;
    if (on && active.arrived) return;
    active.guiding = on;
    updateProgress();
    dirty();
  }

  /**
   * "Jump there": the camera lifts off, crosses above the room with the ceiling cut away and comes down a
   * couple of steps short of the place, facing it. Standing back keeps the place in view.
   */
  function jumpTo(id) {
    const entry = runtime?.entries.get(id), player = walk.player();
    if (!entry?.target || !player || dollhouse.isFlying()) return;
    const points = walk.navigation().route(player.point, entry.target.point);
    const length = points ? pathLength(points) : 0;
    const vantage = length > JUMP_STANDOFF ? pointAt(points, length - JUMP_STANDOFF).point : length > 0 ? player.point : entry.target.point;
    if (active) active.guiding = false;
    selected = id;                                           // the landing refreshes the card and the short route
    if (dollhouse.isActive()) dollhouse.diveTo(vantage, { toward: entry.nav });
    else { labels.setSeeThrough(true); dollhouse.jump(vantage, entry.nav); }
  }

  /** Progress along the active route, searched near the last known position so a route that doubles back is followed in order. */
  function progressNow(point, { keep = true } = {}) {
    const travelled = active.travelled ?? 0;
    const progress = progressAlong(active.points, point, { from: travelled - PROGRESS_BACK, to: travelled + PROGRESS_AHEAD });
    if (keep) active.travelled = progress.travelled;
    return progress;
  }

  /** Read a sentence aloud when directions are live. A stop just announced is not cut off by the next turn. */
  function announce(text, { interrupt = true } = {}) {
    if (!active?.live || !voice.enabled()) return;
    voice.say(spoken(text), { interrupt: interrupt && performance.now() - stopSpokenAt > 2500 });
  }

  /** For a moment everything but the place loses its colour: "this is it". */
  function spotlight(point) {
    clearTimeout(spotlightTimer);
    effects.focus({ x: point.x, y: point.y, z: point.z }, 2.4, 0.45);
    spotlightTimer = setTimeout(() => effects.focus(null, undefined, 0.8), 2200);
  }

  function updateProgress() {
    const player = walk.player();
    if (!active || !player) return;
    const progress = progressNow(player.point);
    path.setProgress(progress.travelled);
    const visiting = active.visit;

    // A visit passes its stops in order: each one is announced, lit up and, on a guided walk, faced for a moment.
    while (visiting && !active.arrived && visiting.next < visiting.stops.length - 1 && progress.travelled >= visiting.ends[visiting.next] - ARRIVED && progress.offRoute < OFF_ROUTE) {
      const stop = visiting.stops[visiting.next], number = visiting.done + visiting.next + 1;
      visiting.next++;
      toast(`Stop ${number} of ${visiting.total}: ${stop.place.name}`);
      announce(`${stop.place.name}. Stop ${number} of ${visiting.total}.`);
      stopSpokenAt = performance.now();
      spotlight(stop.nav);
      if (active.guiding) { active.dwell = DWELL; active.dwellAt = stop.nav; }
    }

    if (!active.arrived && progress.remaining < ARRIVED && progress.offRoute < OFF_ROUTE) {
      active.arrived = true; active.guiding = false;
      const name = visiting ? visiting.stops.at(-1).place.name : active.place.name;
      toast(visiting ? `Visit complete: ${name} was the last stop` : `You have arrived at ${name}`);
      announce(visiting ? `${name}. That was the last stop.` : `You have arrived at ${name}.`, { interrupt: true });
      const place = visiting ? visiting.stops.at(-1) : runtime?.entries.get(active.place.id);
      if (place) spotlight(place.nav);
      path.clear();                                       // the beacon would fill the view at arrival
    }
    const goal = visiting ? visiting.stops[visiting.next].place.name : active.place.name;
    minimap.setStatus(`${goal} \u00b7 ${Math.max(1, Math.round(progress.remaining))} m`);
    // Instructions for a stop already reached are behind you, even if its exact point is a few steps ahead.
    const reached = visiting && visiting.next > 0 ? visiting.ends[visiting.next - 1] + 0.01 : -Infinity;
    const step = active.description.steps.find(candidate => candidate.at > Math.max(progress.travelled + 0.3, reached)) ?? active.description.steps.at(-1);
    const untilTurn = Math.max(0, step.at - progress.travelled);
    const base = step.text.replace(/ in \d+ m$| for \d+ m$/, '');
    const text = step.type === 'arrive' ? base + (untilTurn >= 2 ? ` in ${Math.round(untilTurn)} m` : '') : base + (untilTurn >= 1 ? ` in ${Math.round(untilTurn)} m` : ' now');
    if (active.live && !active.arrived) {
      // Each instruction is read once when it comes up, and once more as "now" when the turn is close.
      const index = active.description.steps.indexOf(step), close = step.type !== 'arrive' && untilTurn < 1.5;
      if (index !== active.spokenIndex) {
        announce(`${active.intro ?? ''} ${text}`.trim(), { interrupt: !active.intro });
        active.intro = ''; active.spokenIndex = index; active.spokenClose = close;
      } else if (close && !active.spokenClose) {
        announce(`${base} now`);
        active.spokenClose = true;
      }
    }
    const destination = visiting ? `${goal} \u00b7 ${visiting.done + visiting.next + 1} of ${visiting.total}` : undefined;
    if (active.live) panel.updateDirections({ remaining: progress.remaining, step: { ...step, text }, guiding: active.guiding, arrived: active.arrived, destination });
    return progress;
  }

  // ---- visits with several stops -----------------------------------------------------------------

  function renderVisit() {
    if (!runtime) return;
    panel.showVisit(visit.map(id => runtime.entries.get(id).place), visitPlan);
    labels.setOrder(new Map(visit.map((id, i) => [id, i + 1])));
  }

  function setVisit(next) {
    visit = next.filter(id => runtime?.entries.has(id));
    visitPlan = null;
    renderVisit();
  }

  function toggleVisit(id) {
    setVisit(visit.includes(id) ? visit.filter(other => other !== id) : [...visit, id]);
    const entry = selected === id && runtime?.entries.get(id);
    if (entry && !active?.live) panel.showPlace(entry.place, { distance: active?.place.id === id ? active.description.length : distanceTo(id), studio: studioMode, inVisit: visit.includes(id) });
  }

  /**
   * The best order: walking distances from you to every stop and between every pair of stops come from
   * the navmesh, then the shortest open tour over them is solved exactly (up to 12 stops).
   */
  function planVisit() {
    const player = walk.player(), navigation = walk.navigation();
    const stops = visit.map(id => runtime.entries.get(id)).filter(entry => entry?.target);
    const measure = (from, to) => { const points = navigation.route(from, to); return points ? pathLength(points) : Infinity; };
    const fromStart = stops.map(stop => measure(player.point, stop.target.point));
    const between = stops.map((a, i) => stops.map((b, j) => (i === j ? 0 : measure(a.target.point, b.target.point))));
    const best = bestOrder(fromStart, between);
    const picked = stops.map((_, i) => i).filter(i => Number.isFinite(fromStart[i]));
    return { stops: best.order.map(i => stops[i]), length: best.length, saved: Math.max(0, tourLength(picked, fromStart, between) - best.length) };
  }

  /** One route through stops in the given order: points, the distance at which each stop is reached, and steps. */
  function visitRoute(start, stops) {
    const navigation = walk.navigation(), points = [], ends = [], steps = [];
    let at = 0, from = start;
    for (const stop of stops) {
      const leg = navigation.route(from, stop.target.point);
      if (!leg) return null;
      for (const step of describeRoute(leg, { destination: stop.place.name }).steps) steps.push({ ...step, at: step.at + at });
      points.push(...(points.length ? leg.slice(1) : leg));
      at += pathLength(leg);
      ends.push(at);
      from = stop.target.point;
    }
    return { points, ends, steps, length: at };
  }

  function startVisit() {
    if (!runtime || visit.length < 2 || !walk.player()) return;
    if (dollhouse.isActive()) dollhouse.close();
    const plan = planVisit();
    const route = plan.stops.length ? visitRoute(walk.player().point, plan.stops) : null;
    if (!route) { toast('These places cannot all be reached on foot from here.', 'error'); return; }
    visit = plan.stops.map(stop => stop.place.id);
    visitPlan = { length: plan.length, saved: plan.saved };
    renderVisit();
    selected = null; labels.select(null); minimap.select(null);
    const last = plan.stops.at(-1);
    const order = plan.stops.map(stop => stop.place.name).join(', then ');
    active = {
      place: { id: '', name: last.place.name, category: 'info', kind: 'visit' }, target: last.target.point,
      points: route.points, description: { length: route.length, seconds: route.length / 1.3, steps: route.steps }, travelled: 0,
      guiding: false, arrived: false, live: true,
      visit: { stops: plan.stops, ends: route.ends, next: 0, done: 0, total: plan.stops.length },
      intro: `${plan.stops.length} stops: ${order}. ${metresText(route.length)}${plan.saved >= 1 ? `, ${metresText(plan.saved)} shorter than your order` : ''}.`,
    };
    path.show(route.points); minimap.setRoute(route.points);
    panel.showDirections({ name: plan.stops[0].place.name }, active.description);
    pingFrom(walk.player().point);
    updateProgress();
  }

  /** Off the line during a visit: a new route from here through the stops not yet reached, in the same order. */
  function rerouteVisit() {
    const v = active.visit, remaining = v.stops.slice(v.next);
    const route = visitRoute(walk.player().point, remaining);
    if (!route) return;
    Object.assign(active, { points: route.points, travelled: 0, description: { length: route.length, seconds: route.length / 1.3, steps: route.steps } });
    active.visit = { stops: remaining, ends: route.ends, next: 0, done: v.done + v.next, total: v.total };
    path.show(route.points); minimap.setRoute(route.points);
  }

  /** A spoken request: the best matching place, then directions to it. */
  function voiceQuery(text) {
    if (!runtime) return;
    const query = text.replace(REQUEST_WORDS, ' ').replace(/\s+/g, ' ').trim() || text;
    const [best] = runtime.search.search(query, { limit: 1, distanceOf: entry => distanceTo(entry.id) });
    if (!best) { toast(`Nothing here matches \u201c${text}\u201d.`, 'error'); voice.say(`Sorry, I could not find ${query}.`); return; }
    if (!startDirections(best.entry.id)) { toast(`${best.entry.name} cannot be reached on foot from here.`, 'error'); select(best.entry.id); }
  }

  function updatePlayer() {
    const player = walk.player();
    if (player) minimap.setPlayer(player.point, walk.heading());
  }

  function onMove() {
    updatePlayer();
    const here = walk.player()?.point;
    if (here && lastStep && walked < 4) {
      walked += Math.hypot(here.x - lastStep.x, here.z - lastStep.z);
      if (walked >= 4) hint.classList.add('seen');
    }
    if (here) lastStep = { x: here.x, z: here.z };
    if (!active) return;
    const progress = updateProgress();
    // Wandering off the line recalculates it from where you are, at most a few times a second.
    if (progress && !active.arrived && progress.offRoute > OFF_ROUTE && performance.now() > rerouteAfter) {
      rerouteAfter = performance.now() + 350;
      const { place, guiding, live } = active;
      if (active.visit) rerouteVisit();
      else if (place.id) { startRoute(place.id, { panel: false }); if (active) { active.guiding = guiding; active.live = live; } } else {
        const points = walk.navigation().route(walk.player().point, active.target);
        if (points) { active.points = points; active.travelled = 0; active.description = describeRoute(points, { destination: 'the pin' }); path.show(points); minimap.setRoute(points); }
      }
      updateProgress();
    }
  }

  // ---- walker events and frames --------------------------------------------------------------------

  walk.on(type => {
    if (type === 'walk-start') {
      app.classList.add('wf-on'); hint.hidden = false;
      panel.setMode('walk');
      if (setupPanel) { studio.dock(setupPanel); setupPanel.open = false; }
      document.getElementById('sidebar')?.classList.add('hidden');   // display settings stay one click away
      rebuild();
      container.focus({ preventScroll: true });           // so W A S D work without a first click
    } else if (type === 'walk-stop') {
      clearSelection(); runtime = null;
      labels.setPlaces([]); minimap.hide(); studio.setVisible(false);
      app.classList.remove('wf-on'); hint.hidden = true;
      setupMode();
    } else if (type === 'move') onMove();
  });

  /**
   * Once per animation frame. Advances the guided walk and the route animation and keeps the labels on
   * their places. Returns true when the 3D view must be redrawn.
   */
  function frame(seconds) {
    if (!runtime) return false;
    let redraw = false;
    if (dollhouse.frame(seconds)) redraw = true;
    if (active?.guiding && !dollhouse.isActive()) {
      if (control.getState().moving) setGuiding(false);       // taking the controls ends the guided walk
      else if (active.dwell > 0) {
        active.dwell -= seconds;
        const player = walk.player().point;
        walk.setHeading({ x: active.dwellAt.x - player.x, z: active.dwellAt.z - player.z }, 1 - Math.exp(-seconds * 4));
        redraw = true;
      } else {
        const player = walk.player(), progress = progressNow(player.point);
        const aim = pointAt(active.points, progress.travelled + 0.5).point;
        const dx = aim.x - player.point.x, dz = aim.z - player.point.z, gap = Math.hypot(dx, dz);
        const step = Math.min(GUIDE_SPEED * seconds, progress.remaining);
        if (gap > 1e-4 && step > 0) walk.advance({ x: dx / gap * step, z: dz / gap * step });
        const ahead = pointAt(active.points, progress.travelled + LOOK_AHEAD);
        const look = progress.remaining > 0.6 ? { x: ahead.point.x - player.point.x, z: ahead.point.z - player.point.z } : ahead.direction;
        walk.setHeading(look, 1 - Math.exp(-seconds * 5));
        redraw = true;
      }
    }
    if (path.tick(seconds)) redraw = true;
    if (effects.frame(seconds)) redraw = true;
    const direction = walk.heading(), p = camera.position;
    const pose = `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z.toFixed(3)},${direction.x.toFixed(3)},${direction.z.toFixed(3)},${camera.fov},${container.clientWidth},${container.clientHeight}`;
    if (pose !== lastPose) { lastPose = pose; labels.update(); updatePlayer(); }
    return redraw;
  }

  // ---- pointer and keyboard ------------------------------------------------------------------------

  let press = null;
  container.addEventListener('pointerdown', event => { press = event.button === 0 ? { x: event.clientX, y: event.clientY, at: performance.now() } : null; });
  container.addEventListener('pointerup', event => {
    if (!press || !runtime) return;
    const still = Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5 && performance.now() - press.at < 450;
    press = null;
    if (!still || !control.enabled) return;                    // a drag looks around; only a clean click picks
    const hit = walk.pickSurface(event.clientX, event.clientY);
    if (!hit) {
      if (studio.isPicking()) studio.say('No solid surface was reconstructed there. Click a wall, the floor or furniture nearby.');
      return;
    }
    if (studio.isPicking()) { studio.pick(hit.raw); return; }
    const point = walk.toNav(hit.raw);
    let best = null;
    for (const entry of runtime.entries.values()) {
      if (entry.place.kind !== 'poi') continue;
      const distance = Math.hypot(entry.nav.x - point.x, entry.nav.y - point.y, entry.nav.z - point.z);
      if (distance < CLICK_REACH && (!best || distance < best.distance)) best = { id: entry.place.id, distance };
    }
    const zone = best ? null : runtime.spatial.zoneAt(point.x, point.z, venue.levels[0].id);
    if (best) select(best.id); else if (zone) select(zone.id); else if (selected && !active?.live) clearSelection();
  });
  container.addEventListener('dblclick', event => {
    if (!runtime || studio.isPicking() || dollhouse.isActive()) return;
    const hit = walk.pickSurface(event.clientX, event.clientY);
    if (hit) walkTo(walk.toNav(hit.raw));
  });
  window.addEventListener('keydown', event => {
    if (!runtime || event.ctrlKey || event.metaKey || event.altKey) return;
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement;
    if (event.key === 'Escape' && !typing) { if (minimap.isOpen()) minimap.close(); else if (dollhouse.isActive()) dollhouse.close(); else if (active || selected) clearSelection(); }
    else if (typing) return;
    else if (event.key === '/') { event.preventDefault(); panel.focus(); }
    else if (event.key === 'm' || event.key === 'M') { if (dollhouse.isActive()) dollhouse.close(); else openOverhead(); }
  });

  setupMode();

  const api = {
    setScene, frame,
    /** Move one of the viewer's own controls (scene list, open file) into the corner tools. */
    adoptTool(element) { element.classList.add('wf-tool'); element.classList.remove('btn'); tools.prepend(element); },
    setStudio(on) {
      studioMode = on;
      app.classList.toggle('wf-studio-on', on);
      tagButton?.classList.toggle('active', on);
      tagButton?.setAttribute('aria-pressed', String(on));
      if (on) { sidebar?.classList.add('hidden'); displayButton.classList.remove('active'); }
      studio.setVisible(on && Boolean(runtime));
      if (selected) select(selected);
    },
    studio: () => studioMode,
    effects, dollhouse, openOverhead,
    /** Called once the loading screen has lifted: the room assembles around the visitor. */
    arrive() {
      const player = walk.player();
      if (!player || !runtime) return;
      const { positions } = walk.navigation().walkableMesh();
      let reach = 6;
      for (let i = 0; i < positions.length; i += 3) reach = Math.max(reach, Math.hypot(positions[i] - player.point.x, positions[i + 2] - player.point.z));
      effects.reveal({ x: player.point.x, y: player.point.y + 1, z: player.point.z }, reach + 4);
    },
    /** For tests and deep links. */
    select, clearSelection, jumpTo, voiceQuery, startVisit, toggleVisit, voice, venue: () => venue,
    visit: () => ({ stops: [...visit], plan: visitPlan }),
    state: () => ({ selected, routing: Boolean(active), guiding: Boolean(active?.guiding), arrived: Boolean(active?.arrived),
      remaining: active ? progressNow(walk.player().point, { keep: false }).remaining : null, places: runtime?.entries.size ?? 0,
      stop: active?.visit ? active.visit.done + active.visit.next + 1 : null, spoken: voice.last() }),
  };
  return api;
}
