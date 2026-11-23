/**
 * The map, generated from the walkable area itself: no floor plan has to be drawn by hand.
 *
 * Two views of the same data:
 *  - Radar (always on, bottom left): the way a driving game shows it. You sit still at the centre, the
 *    world turns so that "up" is the way you face, the route is one bold line, and the destination
 *    sticks to the rim when it is out of range.
 *  - Overview (press M): the whole floor, north up, for picking a place or a spot to walk to.
 */
import { mapTransform } from '../../src/projection.js';
import { boundaryEdges } from '../../src/route.js';
import { dominantAngle } from '../../src/room.js';
import { h, icon } from './dom.js';

const RADAR = { width: 248, height: 176, scale: 22, centreY: 0.66 };   // scale: pixels per metre
const OVERVIEW = { width: 760, height: 520 };
const INK = '#16181c', FLOOR = '#565b64', FLOOR_EDGE = '#9096a1', SIGNAL = '#ffd400', PAPER = '#f4f2ec';

export function createMinimap({ app, onPickPlace, onPickFloor }) {
  const radarCanvas = h('canvas', { class: 'wf-radar-canvas', 'aria-label': 'Radar: the floor around you, turned to the way you face' });
  const place = h('span', { class: 'wf-radar-place' });
  const status = h('span', { class: 'wf-radar-status' });
  const expand = h('button', { class: 'wf-radar-expand', type: 'button', title: 'Open the full map (M)', html: icon('expand', 14) });
  const radar = h('section', { class: 'wf-radar', hidden: true }, radarCanvas, expand, h('footer', { class: 'wf-radar-strip' }, place, status));
  const overviewCanvas = h('canvas', { class: 'wf-overview-canvas', 'aria-label': 'Map of the whole floor' });
  const overviewTitle = h('h2', {});
  const overview = h('section', { class: 'wf-overview', hidden: true, role: 'dialog', 'aria-label': 'Full map' },
    h('header', {}, overviewTitle, h('p', {}, 'Click a place to select it, or any open floor to be walked there.'),
      h('button', { class: 'wf-icon-button', type: 'button', title: 'Close the map (M)', html: icon('close', 16), onclick: () => setOverview(false) })),
    overviewCanvas);
  app.append(radar, overview);

  let walkable = null, edges = [], floorPath = null, edgePath = null, angle = 0, fit = null;
  let zones = [], pois = [], route = null, player = null, draft = null, selected = null;

  const ratio = () => Math.min(window.devicePixelRatio || 1, 2);
  function size(canvas, width, height) {
    canvas.width = Math.round(width * ratio()); canvas.height = Math.round(height * ratio());
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  }

  /** Canvas transform that maps walking-frame (x, z) to screen for a given "up" direction and anchor. */
  function worldTransform(ctx, up, origin, anchorX, anchorY, scale) {
    const right = { x: -up.z, z: up.x };
    const k = ratio();
    ctx.setTransform(right.x * scale * k, -up.x * scale * k, right.z * scale * k, -up.z * scale * k,
      (anchorX - scale * (origin.x * right.x + origin.z * right.z)) * k, (anchorY + scale * (origin.x * up.x + origin.z * up.z)) * k);
    return { toScreen: (x, z) => [anchorX + scale * ((x - origin.x) * right.x + (z - origin.z) * right.z), anchorY - scale * ((x - origin.x) * up.x + (z - origin.z) * up.z)] };
  }

  /** Floor, walls, zones and route in world coordinates; the caller has set the world transform. */
  function drawWorld(ctx, scale, { routeWidth }) {
    ctx.fillStyle = FLOOR; ctx.fill(floorPath);
    for (const zone of zones) {
      ctx.beginPath();
      zone.polygon.forEach(([x, z], i) => (i ? ctx.lineTo(x, z) : ctx.moveTo(x, z)));
      ctx.closePath();
      ctx.fillStyle = 'rgba(244, 242, 236, 0.10)'; ctx.fill();
      ctx.strokeStyle = 'rgba(244, 242, 236, 0.45)'; ctx.lineWidth = 1 / scale; ctx.setLineDash([4 / scale, 3 / scale]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.strokeStyle = FLOOR_EDGE; ctx.lineWidth = 1.2 / scale; ctx.lineCap = 'round'; ctx.stroke(edgePath);
    if (draft?.length) {
      ctx.beginPath(); draft.forEach(([x, z], i) => (i ? ctx.lineTo(x, z) : ctx.moveTo(x, z)));
      ctx.strokeStyle = PAPER; ctx.lineWidth = 2 / scale; ctx.setLineDash([5 / scale, 4 / scale]); ctx.stroke(); ctx.setLineDash([]);
    }
    if (route?.length > 1) {
      const trace = () => { ctx.beginPath(); route.forEach((point, i) => (i ? ctx.lineTo(point.x, point.z) : ctx.moveTo(point.x, point.z))); };
      ctx.lineJoin = 'round';
      trace(); ctx.strokeStyle = INK; ctx.lineWidth = (routeWidth + 3) / scale; ctx.stroke();
      trace(); ctx.strokeStyle = SIGNAL; ctx.lineWidth = routeWidth / scale; ctx.stroke();
    }
  }

  function blip(ctx, x, y, { active = false, target = false } = {}) {
    if (target) {
      ctx.fillStyle = SIGNAL; ctx.strokeStyle = INK; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.rect(x - 5, y - 5, 10, 10); ctx.fill(); ctx.stroke();
      return;
    }
    ctx.beginPath(); ctx.arc(x, y, active ? 5 : 3.4, 0, Math.PI * 2);
    ctx.fillStyle = active ? SIGNAL : PAPER; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = INK; ctx.stroke();
  }

  function arrow(ctx, x, y, bearing) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(bearing);
    ctx.beginPath(); ctx.moveTo(0, -10); ctx.lineTo(7, 8); ctx.lineTo(0, 4); ctx.lineTo(-7, 8); ctx.closePath();
    ctx.fillStyle = PAPER; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = INK; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.restore();
  }

  function drawRadar() {
    if (!walkable || !player || radar.hidden) return;
    const ctx = radarCanvas.getContext('2d'), { width, height, scale } = RADAR, k = ratio();
    const cx = width / 2, cy = height * RADAR.centreY;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = INK; ctx.fillRect(0, 0, width, height);
    const view = worldTransform(ctx, player.heading, player, cx, cy, scale);
    drawWorld(ctx, scale, { routeWidth: 5 });
    ctx.setTransform(k, 0, 0, k, 0, 0);

    // Sight cone, then places, then you.
    const cone = ctx.createRadialGradient(cx, cy, 4, cx, cy, 70);
    cone.addColorStop(0, 'rgba(244, 242, 236, 0.22)'); cone.addColorStop(1, 'rgba(244, 242, 236, 0)');
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, 70, -Math.PI / 2 - 0.6, -Math.PI / 2 + 0.6); ctx.closePath(); ctx.fillStyle = cone; ctx.fill();
    for (const poi of pois) {
      const [x, y] = view.toScreen(poi.x, poi.z);
      if (x > -6 && x < width + 6 && y > -6 && y < height + 6) blip(ctx, x, y, { active: poi.id === selected });
    }
    if (route?.length > 1) {
      // The destination stays on the rim when it is out of range, as mission markers do.
      let [x, y] = view.toScreen(route.at(-1).x, route.at(-1).z);
      const inset = 9, dx = x - cx, dy = y - cy;
      const reach = Math.min(1, ...[dx > 0 ? (width - inset - cx) / dx : dx < 0 ? (inset - cx) / dx : Infinity, dy > 0 ? (height - inset - cy) / dy : dy < 0 ? (inset - cy) / dy : Infinity]);
      x = cx + dx * reach; y = cy + dy * reach;
      blip(ctx, x, y, { target: true });
    }
    arrow(ctx, cx, cy, 0);

    // North marker on the rim. North is "up" on the overview.
    const north = { x: Math.sin(angle), z: -Math.cos(angle) };
    const nx = north.x * -player.heading.z + north.z * player.heading.x, ny = -(north.x * player.heading.x + north.z * player.heading.z);
    const edge = Math.min((width / 2 - 13) / Math.abs(nx || 1e-6), (cy - 13) / Math.abs(ny || 1e-6), ny > 0 ? (height - cy - 13) / ny : Infinity);
    const mx = cx + nx * edge, my = cy + ny * edge;
    ctx.beginPath(); ctx.arc(mx, my, 9, 0, Math.PI * 2); ctx.fillStyle = INK; ctx.fill(); ctx.lineWidth = 1; ctx.strokeStyle = FLOOR_EDGE; ctx.stroke();
    ctx.fillStyle = PAPER; ctx.font = '700 11px "Barlow Condensed", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('N', mx, my + 0.5);
  }

  function overviewUp() { return { x: Math.sin(angle), z: -Math.cos(angle) }; }

  function layoutOverview() {
    const width = Math.min(OVERVIEW.width, window.innerWidth - 48), height = Math.min(OVERVIEW.height, window.innerHeight - 170);
    size(overviewCanvas, width, height);
    const up = overviewUp(), right = { x: -up.z, z: up.x };
    const bounds = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (let i = 0; i < walkable.positions.length; i += 3) {
      const x = walkable.positions[i], z = walkable.positions[i + 2];
      const u = x * right.x + z * right.z, v = -(x * up.x + z * up.z);
      bounds.minX = Math.min(bounds.minX, u); bounds.maxX = Math.max(bounds.maxX, u);
      bounds.minZ = Math.min(bounds.minZ, v); bounds.maxZ = Math.max(bounds.maxZ, v);
    }
    const map = mapTransform(bounds, width, height, 36);
    // Anchor: the world origin's place on screen, so the shared world transform can be reused.
    const [ox, oy] = map.toMap(0, 0);
    fit = { width, height, scale: map.scale, ox, oy, up, right };
  }

  function drawOverview() {
    if (!walkable || overview.hidden) return;
    if (!fit) layoutOverview();
    const ctx = overviewCanvas.getContext('2d'), k = ratio(), { width, height, scale, ox, oy, up } = fit;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = INK; ctx.fillRect(0, 0, width, height);
    const view = worldTransform(ctx, up, { x: 0, z: 0 }, ox, oy, scale);
    drawWorld(ctx, scale, { routeWidth: 5 });
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const zone of zones) {
      const centre = zone.polygon.reduce((sum, [x, z]) => [sum[0] + x / zone.polygon.length, sum[1] + z / zone.polygon.length], [0, 0]);
      ctx.font = '600 11px "Barlow Condensed", sans-serif'; ctx.fillStyle = 'rgba(244, 242, 236, 0.8)';
      ctx.fillText(zone.name.toUpperCase(), ...view.toScreen(...centre));
    }
    ctx.textAlign = 'left';
    for (const poi of pois) {
      const [x, y] = view.toScreen(poi.x, poi.z), active = poi.id === selected;
      blip(ctx, x, y, { active });
      ctx.font = `${active ? 600 : 500} 12px Barlow, sans-serif`; ctx.fillStyle = active ? SIGNAL : PAPER;
      // Names sit to the right of their dot, or to the left when that would run off the map.
      const flip = x + 12 + ctx.measureText(poi.name).width > width - 8;
      ctx.textAlign = flip ? 'right' : 'left';
      const tx = flip ? x - 9 : x + 9;
      ctx.lineWidth = 3; ctx.strokeStyle = INK; ctx.strokeText(poi.name, tx, y); ctx.fillText(poi.name, tx, y);
    }
    if (route?.length > 1) blip(ctx, ...view.toScreen(route.at(-1).x, route.at(-1).z), { target: true });
    if (player) {
      const [x, y] = view.toScreen(player.x, player.z);
      const bearing = Math.atan2(player.heading.x * fit.right.x + player.heading.z * fit.right.z, player.heading.x * up.x + player.heading.z * up.z);
      arrow(ctx, x, y, bearing);
    }
    overview.view = view;
  }

  const draw = () => { drawRadar(); drawOverview(); };

  function setOverview(open) {
    overview.hidden = !open;
    app.classList.toggle('wf-map-open', open);
    if (open) { fit = null; drawOverview(); }
  }

  overviewCanvas.addEventListener('click', event => {
    if (!fit) return;
    const box = overviewCanvas.getBoundingClientRect(), px = event.clientX - box.left, py = event.clientY - box.top;
    let nearest = null, best = 12;
    for (const poi of pois) { const [x, y] = overview.view.toScreen(poi.x, poi.z), d = Math.hypot(x - px, y - py); if (d < best) { best = d; nearest = poi; } }
    setOverview(false);
    if (nearest) { onPickPlace(nearest.id); return; }
    const u = (px - fit.ox) / fit.scale, v = (fit.oy - py) / fit.scale;
    onPickFloor({ x: u * fit.right.x + v * fit.up.x, z: u * fit.right.z + v * fit.up.z });
  });
  expand.addEventListener('click', () => setOverview(true));
  radarCanvas.addEventListener('click', () => setOverview(true));
  window.addEventListener('resize', () => { fit = null; draw(); });

  return {
    /** @param {{positions: number[], indices: number[]}} mesh triangles of the walkable area */
    setWalkable(mesh) {
      walkable = mesh;
      edges = boundaryEdges(mesh.positions, mesh.indices);
      angle = dominantAngle(edges);
      floorPath = new Path2D(); edgePath = new Path2D();
      for (let t = 0; t < mesh.indices.length; t += 3) {
        for (let c = 0; c < 3; c++) {
          const v = mesh.indices[t + c] * 3;
          if (c) floorPath.lineTo(mesh.positions[v], mesh.positions[v + 2]); else floorPath.moveTo(mesh.positions[v], mesh.positions[v + 2]);
        }
        floorPath.closePath();
      }
      for (const [ax, az, bx, bz] of edges) { edgePath.moveTo(ax, az); edgePath.lineTo(bx, bz); }
      size(radarCanvas, RADAR.width, RADAR.height);
      radar.hidden = false; fit = null;
      draw();
    },
    /** @param nextZones [{name, polygon: [[x, z]]}]  @param points [{id, name, x, z}] */
    setPlaces(nextZones, points) { zones = nextZones; pois = points; draw(); },
    setRoute(points) { route = points; draw(); },
    setDraft(points) { draft = points; draw(); },
    setPlayer(point, heading) { player = { x: point.x, z: point.z, heading }; draw(); },
    select(id) { selected = id; draw(); },
    /** The strip under the radar: where you are on the left, what you are heading for on the right. */
    setCaption(text) { place.textContent = text; overviewTitle.textContent = text; },
    setStatus(text) { status.textContent = text; },
    toggleSize: () => setOverview(overview.hidden),
    isOpen: () => !overview.hidden,
    close: () => setOverview(false),
    hide() { radar.hidden = true; setOverview(false); },
  };
}
