/**
 * The search column (top left) and the direction sign (top centre).
 *
 * Column: where you are, a search field, kind filters, results and the selected place.
 * Sign: once directions start, one overhead-style sign carries the next instruction, the distance left
 * and the two things you can do about it. Both only render and report intent; index.js owns the data.
 */
import { CATEGORIES, categoryOf } from '../../src/venue.js';
import { formatDuration } from '../../src/route.js';
import { h, icon, formatDistance } from './dom.js';

export function createPanel({ app, actions }) {
  const venueName = h('span', { class: 'wf-venue' });
  const input = h('input', { id: 'wf-search-input', class: 'wf-search-input', type: 'search', placeholder: 'Where to?', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search places', 'aria-controls': 'wf-results' });
  const shortcut = h('kbd', { class: 'wf-search-key', title: 'Press / to search' }, '/');
  const clear = h('button', { class: 'wf-icon-button', type: 'button', title: 'Clear search', hidden: true, html: icon('close', 15) });
  const mic = h('button', { class: 'wf-icon-button wf-mic', type: 'button', title: 'Search by voice: say a place, e.g. “take me to the projector”', hidden: true, html: icon('mic', 17) });
  const searchBox = h('label', { class: 'wf-search', for: 'wf-search-input' }, h('span', { class: 'wf-search-icon', html: icon('search', 18) }), input, shortcut, clear, mic);
  const chips = h('div', { class: 'wf-chips', role: 'toolbar', 'aria-label': 'Show one kind of place' });
  const results = h('ul', { id: 'wf-results', class: 'wf-results', role: 'listbox', hidden: true });
  const card = h('section', { class: 'wf-card', hidden: true, 'aria-live': 'polite' });
  const visitPlate = h('section', { class: 'wf-visit', hidden: true, 'aria-label': 'Your visit' });
  const root = h('aside', { class: 'wf-panel', hidden: true },
    h('header', { class: 'wf-masthead' }, h('span', { class: 'wf-wordmark' }, 'Namma Space'), venueName),
    h('div', { class: 'wf-plate' }, searchBox, chips, results), visitPlate, card);
  const plate = searchBox.parentElement;
  const sign = h('section', { class: 'wf-sign', hidden: true, 'aria-live': 'polite' });
  app.append(root, sign);

  let category = null, cursor = -1, shown = [];

  const runSearch = () => {
    clear.hidden = !input.value; shortcut.hidden = Boolean(input.value);
    shown = actions.search(input.value, category);
    cursor = -1;
    renderResults();
  };

  function renderResults() {
    const open = document.activeElement === input || input.value || category;
    results.hidden = !open || !card.hidden;
    if (results.hidden) return;
    if (!shown.length) {
      results.replaceChildren(h('li', { class: 'wf-empty' }, input.value ? `Nothing here is called “${input.value}”.` : 'No places have been tagged in this space yet.'));
      return;
    }
    results.replaceChildren(...shown.map((result, i) => {
      const place = result.entry, kind = categoryOf(place.category);
      return h('li', {
        class: `wf-result${i === cursor ? ' active' : ''}`, role: 'option', 'aria-selected': i === cursor ? 'true' : 'false',
        onmousedown: event => event.preventDefault(), onclick: () => choose(place),
      },
      h('span', { class: 'wf-tile', html: icon(place.kind === 'zone' ? 'zone' : place.category, 17) }),
      h('span', { class: 'wf-result-text' }, h('strong', {}, place.name), h('small', {}, [kind.label, place.zoneName].filter(Boolean).join(' · '))),
      h('span', { class: 'wf-result-distance' }, Number.isFinite(result.distance) ? formatDistance(result.distance) : ''));
    }));
  }

  function choose(place) {
    input.value = place.name; clear.hidden = false; shortcut.hidden = true;
    input.blur();
    actions.select(place);
  }

  input.addEventListener('input', runSearch);
  input.addEventListener('focus', () => { card.hidden = true; runSearch(); });
  input.addEventListener('blur', () => setTimeout(renderResults, 80));
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!shown.length) return;
      cursor = (cursor + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      renderResults();
      results.children[cursor]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      const pick = shown[Math.max(0, cursor)];
      if (pick) choose(pick.entry);
    } else if (event.key === 'Escape') {
      if (input.value) { input.value = ''; runSearch(); } else input.blur();
    }
    event.stopPropagation();
  });
  clear.addEventListener('click', () => { input.value = ''; input.focus(); runSearch(); });

  // Voice search: words appear in the field as they are heard; the final phrase picks a place.
  let stopListening = null;
  const finishListening = () => { stopListening = null; plate.classList.remove('listening'); input.placeholder = 'Where to?'; mic.title = 'Search by voice'; };
  mic.addEventListener('click', event => {
    event.preventDefault();
    if (stopListening) { stopListening(); finishListening(); return; }
    plate.classList.add('listening'); input.value = ''; input.placeholder = 'Listening… say a place'; mic.title = 'Stop listening';
    stopListening = actions.listen((text, final) => {
      input.value = text; runSearch();
      if (final) { finishListening(); input.blur(); actions.voicePick(text); }
    }, error => { finishListening(); if (error) actions.notify(error); });
  });

  function setCategories(present) {
    chips.hidden = present.size < 2;
    chips.replaceChildren(...Object.entries(CATEGORIES).filter(([id]) => present.has(id)).map(([id, kind]) =>
      h('button', {
        class: `wf-chip${category === id ? ' active' : ''}`, type: 'button', 'aria-pressed': category === id ? 'true' : 'false',
        onclick: () => { category = category === id ? null : id; setCategories(present); card.hidden = true; actions.clearSelection(); runSearch(); },
      }, h('span', { html: icon(id, 14) }), kind.label)));
  }

  /** Show one place: what it is, how far, and what you can do with it. */
  function showPlace(place, { distance, studio, inVisit = false } = {}) {
    const kind = categoryOf(place.category);
    const reachable = Number.isFinite(distance), here = reachable && distance < 1.2;
    const meta = [kind.label, place.zoneName, place.levelName].filter(Boolean).join(' · ');
    card.replaceChildren(...[
      h('header', { class: 'wf-card-head' },
        h('span', { class: 'wf-tile large', html: icon(place.kind === 'zone' ? 'zone' : place.category, 22) }),
        h('div', { class: 'wf-card-title' }, h('h2', {}, place.name), h('p', {}, meta)),
        h('button', { class: 'wf-icon-button', type: 'button', title: 'Close (Esc)', html: icon('close', 16), onclick: () => actions.clearSelection() })),
      place.description ? h('p', { class: 'wf-card-description' }, place.description) : null,
      h('dl', { class: 'wf-facts' },
        h('div', {}, h('dt', {}, 'Distance'), h('dd', {}, here ? 'You are here' : reachable ? formatDistance(distance) : 'No route')),
        h('div', {}, h('dt', {}, 'On foot'), h('dd', {}, here || !reachable ? '–' : formatDuration(distance / 1.3)))),
      h('div', { class: 'wf-actions' },
        h('button', { class: 'wf-button primary', type: 'button', disabled: !reachable || here, onclick: () => actions.directions(place) }, h('span', { html: icon('route', 17) }), 'Directions'),
        h('button', { class: 'wf-button', type: 'button', disabled: !place.reachable, title: 'Skip the walk and stand in front of it', onclick: () => actions.jump(place) }, h('span', { html: icon('jump', 16) }), 'Jump there')),
      h('button', { class: `wf-button quiet wide${inVisit ? ' added' : ''}`, type: 'button', disabled: !place.reachable && !inVisit, onclick: () => actions.toggleVisit(place) },
        h('span', { html: icon(inVisit ? 'check' : 'plus', 15) }), inVisit ? 'In your visit · remove' : 'Add to a visit with several stops'),
      studio ? h('div', { class: 'wf-actions quiet' },
        h('button', { class: 'wf-button quiet', type: 'button', onclick: () => actions.edit(place) }, h('span', { html: icon('edit', 15) }), 'Edit'),
        h('button', { class: 'wf-button quiet danger', type: 'button', onclick: () => actions.remove(place) }, h('span', { html: icon('trash', 15) }), 'Delete')) : null,
    ].filter(Boolean));
    card.hidden = false; sign.hidden = true; results.hidden = true;
  }

  let signArrow = null, signStep = null, signLeft = null, signName = null, walkButton = null, speaker = null;
  const paintSpeaker = () => {
    if (!speaker) return;
    const on = actions.voiceEnabled();
    speaker.innerHTML = icon(on ? 'volume' : 'mute', 17);
    speaker.title = on ? 'Spoken directions are on' : 'Spoken directions are off';
    speaker.setAttribute('aria-pressed', String(on));
  };
  /** Put up the direction sign: next instruction, distance left, walk-for-me, voice and end. */
  function showDirections(place, description) {
    signArrow = h('span', { class: 'wf-sign-arrow' });
    signStep = h('strong', { class: 'wf-sign-step' });
    signLeft = h('span', { class: 'wf-sign-left' });
    signName = h('span', {}, place.name);
    walkButton = h('button', { class: 'wf-sign-button', type: 'button', onclick: () => actions.toggleGuide() });
    speaker = actions.canSpeak() ? h('button', { class: 'wf-sign-button plain icon', type: 'button', onclick: () => { actions.setVoice(!actions.voiceEnabled()); paintSpeaker(); } }) : null;
    paintSpeaker();
    sign.replaceChildren(
      signArrow,
      h('div', { class: 'wf-sign-text' }, signStep, h('span', { class: 'wf-sign-to' }, h('span', {}, 'to '), signName, h('span', { class: 'wf-sign-dot' }, '·'), signLeft)),
      h('div', { class: 'wf-sign-actions' }, walkButton, speaker,
        h('button', { class: 'wf-sign-button plain', type: 'button', title: 'End directions (Esc)', onclick: () => actions.endRoute() }, 'End')),
      h('details', { class: 'wf-sign-steps' }, h('summary', {}, `All ${description.steps.length} step${description.steps.length === 1 ? '' : 's'}`),
        h('ol', {}, ...description.steps.map(step => h('li', {}, h('span', { html: icon(step.type, 16) }), step.text)))));
    card.hidden = true; results.hidden = true; sign.hidden = false;
    updateDirections({ remaining: description.length, step: description.steps[0], guiding: false });
  }

  function updateDirections({ remaining, step, guiding, arrived, destination }) {
    if (sign.hidden || !signStep) return;
    if (destination) signName.textContent = destination;
    signArrow.innerHTML = icon(arrived ? 'arrive' : step?.type ?? 'straight', 34);
    signStep.textContent = arrived ? 'You have arrived' : step?.text ?? 'Follow the line';
    signLeft.textContent = arrived ? 'here' : `${formatDistance(remaining)} · ${formatDuration(remaining / 1.3)}`;
    walkButton.replaceChildren(h('span', { html: icon(guiding ? 'stop' : 'play', 14) }), guiding ? 'Stop' : 'Walk me there');
    walkButton.hidden = Boolean(arrived);
    sign.classList.toggle('arrived', Boolean(arrived));
  }

  /**
   * The visit plate: the stops you collected, numbered in walking order, and the plan for them.
   * @param {Array<object>} stops places in the order they will be walked
   * @param {{length: number, saved: number}|null} plan the best order's length and how much it saves
   */
  function showVisit(stops, plan) {
    visitPlate.hidden = !stops.length;
    if (!stops.length) return;
    const ready = stops.length >= 2;
    visitPlate.replaceChildren(...[
      h('header', { class: 'wf-visit-head' },
        h('span', { class: 'wf-visit-icon', html: icon('stops', 17) }),
        h('h3', {}, 'Your visit'),
        h('span', { class: 'wf-visit-count' }, `${stops.length} stop${stops.length === 1 ? '' : 's'}`),
        h('button', { class: 'wf-icon-button', type: 'button', title: 'Clear the visit', html: icon('close', 15), onclick: () => actions.clearVisit() })),
      h('ol', { class: 'wf-visit-stops' }, ...stops.map((place, i) => h('li', {},
        h('span', { class: 'wf-visit-number' }, String(i + 1)),
        h('button', { class: 'wf-visit-name', type: 'button', title: `Show ${place.name}`, onclick: () => actions.select(place) }, place.name),
        h('button', { class: 'wf-icon-button small', type: 'button', title: `Remove ${place.name}`, html: icon('close', 13), onclick: () => actions.toggleVisit(place) })))),
      plan ? h('p', { class: 'wf-visit-plan' },
        h('strong', {}, `Shortest order · ${formatDistance(plan.length)}`),
        plan.saved >= 1 ? ` · ${Math.round(plan.saved)} m less than the order you picked` : ' · your order was already the shortest') : null,
      h('button', { class: 'wf-button primary', type: 'button', disabled: !ready, onclick: () => actions.startVisit() },
        h('span', { html: icon('route', 17) }), ready ? 'Walk the shortest route' : 'Add one more place to plan'),
    ].filter(Boolean));
  }

  return {
    setCategories, showPlace, showDirections, updateDirections, showVisit,
    enableVoice(canListen) { mic.hidden = !canListen; },
    show() { root.hidden = false; },
    /** 'setup' shows only the masthead and whatever is docked below it; 'walk' shows search and the rest. */
    setMode(mode) { root.classList.toggle('setup', mode === 'setup'); },
    dock(element) { root.append(element); },
    setTitle(title) { venueName.textContent = title; },
    closeCard() { card.hidden = true; renderResults(); },
    closeDirections() { sign.hidden = true; renderResults(); },
    refresh: runSearch,
    focus() { input.focus(); input.select(); },
    isTyping: () => document.activeElement === input,
  };
}
