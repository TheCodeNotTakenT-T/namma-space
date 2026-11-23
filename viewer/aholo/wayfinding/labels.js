/**
 * Place labels drawn as HTML over the 3D view: crisp text at any resolution, real buttons for clicks and
 * keyboard focus. Each frame a label is placed where its 3D anchor projects on screen; labels far away
 * shrink to their icon, labels hidden behind a wall dim, and overlapping labels yield to nearer ones.
 */
import { cameraBasis, projectPoint } from '../../src/projection.js';
import { categoryOf } from '../../src/venue.js';
import { h, icon } from './dom.js';

const FULL_RANGE = 9;       // metres within which a label shows its name
const HIDE_RANGE = 30;      // metres beyond which a label is not drawn
const SIGHT_CHECKS = 3;     // occlusion rays per frame, spread over the labels in turn

export function createLabels({ app, container, camera, walk, onSelect }) {
  const layer = h('div', { class: 'wf-labels', 'aria-label': 'Places in view' });
  app.append(layer);
  let items = [], selected = null, cursor = 0, extra = [], seeThrough = false;
  // "You are here", shown while the camera is away from the walker (bird's-eye view).
  const you = h('span', { class: 'wf-you', hidden: true }, h('span', {}, 'You'));
  let youAt = null;

  function setPlaces(entries) {
    layer.replaceChildren(you);
    items = entries.map(entry => {
      const category = categoryOf(entry.place.category);
      const element = h('button', {
        class: `wf-label${entry.place.kind === 'zone' ? ' wf-label-zone' : ''}`, type: 'button', title: entry.place.name,
        style: { '--place': category.color }, onclick: event => { event.stopPropagation(); onSelect(entry.place); },
      }, h('span', { class: 'wf-label-icon', html: icon(entry.place.kind === 'zone' ? 'zone' : entry.place.category, 14) }),
      h('span', { class: 'wf-label-name' }, entry.place.name));
      layer.append(element);
      return { ...entry, element, hidden: false, width: 0 };
    });
    for (const item of items) item.width = item.element.offsetWidth;
    markSelected();
  }

  /** Number the stops of a planned visit on their labels; an empty map removes the numbers. */
  function setOrder(order) {
    for (const item of items) {
      item.element.querySelector('.wf-label-order')?.remove();
      const number = order.get(item.place.id);
      if (number) item.element.prepend(h('span', { class: 'wf-label-order' }, String(number)));
      item.element.classList.toggle('in-visit', Boolean(number));
    }
  }

  function markSelected() {
    for (const item of items) item.element.classList.toggle('selected', item.place.id === selected);
  }

  /** Temporary markers (corners of a zone being drawn, a dropped pin). */
  function setMarkers(points) {
    for (const marker of extra) marker.element.remove();
    extra = points.map(raw => {
      const element = h('span', { class: 'wf-marker' });
      layer.append(element);
      return { raw, element };
    });
  }

  function update() {
    const width = container.clientWidth, height = container.clientHeight;
    if (!width || !height) return;
    camera.updateMatrixWorld(true);
    const basis = cameraBasis(camera.matrixWorld.elements);
    const scale = walk.metresPerUnit() || 1;
    const taken = [];

    for (const marker of extra) {
      const at = projectPoint(marker.raw, basis, camera.fov, width / height);
      marker.element.hidden = !at.visible;
      if (at.visible) marker.element.style.transform = `translate(${(at.x * width).toFixed(1)}px, ${(at.y * height).toFixed(1)}px)`;
    }

    you.hidden = !youAt;
    if (youAt) {
      const at = projectPoint(youAt, basis, camera.fov, width / height);
      you.hidden = !at.visible;
      if (at.visible) you.style.transform = `translate(${(at.x * width).toFixed(1)}px, ${(at.y * height).toFixed(1)}px)`;
    }

    // Occlusion is sampled a few labels per frame; a label keeps its last answer in between.
    // From above, with the ceiling cut away, nothing is treated as hidden.
    for (let n = 0; n < Math.min(SIGHT_CHECKS, items.length); n++) {
      const item = items[cursor++ % items.length];
      if (item.place.kind !== 'zone') item.hidden = !seeThrough && walk.occluded(item.sight ?? item.raw);
    }

    const placed = items.map(item => ({ item, at: projectPoint(item.raw, basis, camera.fov, width / height) }))
      .sort((a, b) => (b.item.place.id === selected) - (a.item.place.id === selected) || a.at.depth - b.at.depth);
    for (const { item, at } of placed) {
      const metres = at.depth * scale, isSelected = item.place.id === selected;
      const show = at.visible && (isSelected || metres < HIDE_RANGE);
      item.element.hidden = !show;
      if (!show) continue;
      const x = at.x * width, y = at.y * height;
      let compact = !isSelected && metres > FULL_RANGE;
      const box = () => { const w = compact ? 26 : item.width || 120; return [x - w / 2, y - 30, x + w / 2, y]; };
      let rect = box();
      const overlaps = () => taken.some(other => rect[0] < other[2] && rect[2] > other[0] && rect[1] < other[3] && rect[3] > other[1]);
      if (!isSelected && !compact && overlaps()) { compact = true; rect = box(); }
      if (!isSelected && compact && overlaps()) { item.element.hidden = true; continue; }
      taken.push(rect);
      item.element.classList.toggle('compact', compact);
      item.element.classList.toggle('behind', item.hidden && !isSelected);
      item.element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      item.element.style.zIndex = String(isSelected ? 5000 : 4000 - Math.min(3999, Math.round(metres * 10)));
    }
  }

  return {
    setPlaces, setMarkers, update,
    select(id) { selected = id; markSelected(); },
    setVisible(visible) { layer.hidden = !visible; },
    setOrder,
    setSeeThrough(on) { seeThrough = on; if (on) for (const item of items) item.hidden = false; },
    /** Mark the walker's position (reconstruction coordinates), or null to remove the mark. */
    setYou(raw) { youAt = raw; },
  };
}
