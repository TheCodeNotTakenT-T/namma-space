/**
 * Tagging tools: add a point of interest by clicking it in the 3D view, outline a zone by clicking its
 * corners on the floor, edit or delete places, and save, export or import the venue file.
 * Shown only in studio mode (local development, or ?studio=1 on a hosted space).
 */
import { CATEGORIES } from '../../src/venue.js';
import { h, icon } from './dom.js';

export function createStudio({ app, actions }) {
  const hint = h('p', { class: 'wf-studio-hint', role: 'status' });
  const counts = h('p', { class: 'wf-studio-counts' });
  const form = h('form', { class: 'wf-studio-form', hidden: true, novalidate: true });
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const addPlace = h('button', { class: 'wf-button', type: 'button' }, h('span', { html: icon('pin', 15) }), 'Add place');
  const addZone = h('button', { class: 'wf-button', type: 'button' }, h('span', { html: icon('zone', 15) }), 'Add zone');
  const finishZone = h('button', { class: 'wf-button primary', type: 'button', hidden: true }, h('span', { html: icon('check', 15) }), 'Finish zone');
  const cancel = h('button', { class: 'wf-button quiet', type: 'button', hidden: true }, 'Cancel');
  const save = h('button', { class: 'wf-button quiet', type: 'button', title: 'Save into this scene (local development)' }, h('span', { html: icon('save', 15) }), 'Save');
  const exportButton = h('button', { class: 'wf-button quiet', type: 'button', title: 'Download venue.json' }, h('span', { html: icon('download', 15) }), 'Export');
  const importButton = h('button', { class: 'wf-button quiet', type: 'button', title: 'Load a venue.json' }, h('span', { html: icon('upload', 15) }), 'Import');
  const root = h('section', { class: 'wf-studio wf-glass', hidden: true },
    h('header', { class: 'wf-studio-head' }, h('span', { html: icon('tools', 16) }), h('h2', {}, 'Tag this space')),
    h('div', { class: 'wf-studio-row' }, addPlace, addZone, finishZone, cancel),
    hint, form, counts,
    h('div', { class: 'wf-studio-row' }, save, exportButton, importButton, fileInput));
  app.append(root);

  // mode: null | 'place' (waiting for one click) | 'zone' (collecting corners) | 'move' (re-placing a point)
  let mode = null, corners = [], draft = null;

  const say = text => { hint.textContent = text; };
  const idle = 'Add a place by clicking it in the room, or outline a zone on the floor.';

  function setMode(next) {
    mode = next;
    finishZone.hidden = mode !== 'zone';
    cancel.hidden = !mode && form.hidden;
    addPlace.disabled = addZone.disabled = Boolean(mode) || !form.hidden;
    app.classList.toggle('wf-picking', Boolean(mode));
    if (mode !== 'zone') { corners = []; actions.draftChanged([]); }
  }

  function reset(message = idle) {
    form.hidden = true; draft = null;
    setMode(null);
    say(message);
  }

  function openForm(place, title) {
    draft = place;
    const name = h('input', { id: 'wf-form-name', type: 'text', maxlength: '80', required: true, value: place.name ?? '', placeholder: place.polygon ? 'e.g. Front rows' : 'e.g. Whiteboard' });
    const category = h('select', { id: 'wf-form-category' }, ...Object.entries(CATEGORIES).map(([id, kind]) =>
      h('option', { value: id, selected: id === (place.category ?? (place.polygon ? 'room' : 'info')) }, kind.label)));
    const aliases = h('input', { id: 'wf-form-aliases', type: 'text', value: (place.aliases ?? []).join(', '), placeholder: 'Other names, comma separated' });
    const description = h('input', { id: 'wf-form-description', type: 'text', maxlength: '400', value: place.description ?? '', placeholder: 'Optional note' });
    const move = place.id && place.position ? h('button', { class: 'wf-button quiet', type: 'button', onclick: () => { setMode('move'); say('Click the new spot for this place.'); } }, 'Move') : null;
    form.replaceChildren(
      h('h3', {}, title),
      h('label', { for: 'wf-form-name' }, 'Name'), name,
      h('label', { for: 'wf-form-category' }, 'Kind'), category,
      h('label', { for: 'wf-form-aliases' }, 'Also called'), aliases,
      h('label', { for: 'wf-form-description' }, 'Note'), description,
      h('div', { class: 'wf-studio-row' }, h('button', { class: 'wf-button primary', type: 'submit' }, 'Save place'), move));
    form.onsubmit = event => {
      event.preventDefault();
      if (!name.value.trim()) { say('Give the place a name.'); name.focus(); return; }
      const result = {
        ...draft, name: name.value, category: category.value, description: description.value,
        aliases: aliases.value.split(',').map(alias => alias.trim()).filter(Boolean),
      };
      const error = draft.polygon ? actions.saveZone(result) : actions.savePoi(result);
      if (error) say(error); else reset(`Saved “${result.name.trim()}”.`);
    };
    form.hidden = false;
    setMode(null);
    cancel.hidden = false;
    name.focus();
  }

  addPlace.addEventListener('click', () => { setMode('place'); say('Click the spot in the room that you want to tag.'); });
  addZone.addEventListener('click', () => { setMode('zone'); say('Click the corners of the area on the floor, in order. Then choose Finish zone.'); });
  finishZone.addEventListener('click', () => {
    if (corners.length < 3) { say('A zone needs at least three corners.'); return; }
    const polygon = corners.map(corner => [...corner]);
    actions.draftChanged([]);
    openForm({ polygon }, 'New zone');
  });
  cancel.addEventListener('click', () => reset());
  save.addEventListener('click', async () => say(await actions.saveToLibrary()));
  exportButton.addEventListener('click', () => { actions.exportVenue(); say('venue.json downloaded. Keep it with the scene when you package the site.'); });
  importButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) say(await actions.importVenue(file));
  });

  return {
    dock(element) { root.append(element); },
    setVisible(visible) { root.hidden = !visible; if (visible && !hint.textContent) say(idle); else if (!visible) reset(); },
    visible: () => !root.hidden,
    /** True while the next click in the 3D view belongs to the studio. */
    isPicking: () => Boolean(mode),
    /** Feed a picked reconstruction-space point. */
    pick(raw) {
      if (mode === 'place') openForm({ position: raw }, 'New place');
      else if (mode === 'move' && draft) { draft = { ...draft, position: raw }; setMode(null); cancel.hidden = false; say('New spot chosen. Save place to keep it.'); }
      else if (mode === 'zone') {
        corners.push(raw);
        actions.draftChanged(corners);
        say(`${corners.length} corner${corners.length === 1 ? '' : 's'}. ${corners.length < 3 ? 'Keep clicking around the area.' : 'Add more, or choose Finish zone.'}`);
      }
    },
    edit(place) { openForm({ ...place }, `Edit ${place.kind === 'zone' ? 'zone' : 'place'}`); },
    setCounts(pois, zones) { counts.textContent = `${pois} place${pois === 1 ? '' : 's'} · ${zones} zone${zones === 1 ? '' : 's'} tagged`; },
    say,
  };
}
