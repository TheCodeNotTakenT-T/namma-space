/**
 * The route drawn in the 3D scene: a ribbon on the floor, arrows flowing towards the destination and a
 * beacon standing on it. Built from ordinary meshes in the renderer's scene, so benches and walls of the
 * reconstruction hide the parts of the route behind them.
 *
 * Geometry is computed in the walking frame (metres) and converted to reconstruction coordinates, the space
 * the splat is rendered in.
 */
import { BufferGeometry, BufferAttribute, Mesh, MeshBasicMaterial, Color } from '@manycore/aholo-viewer';
import { markersAlong, pathLength, simplifyPath } from '../../src/route.js';

const RIBBON_WIDTH = 0.26;      // metres
const RIBBON_LIFT = 0.05;       // above the walkable surface, clear of floor noise
const ARROW_LIFT = 0.065;
const ARROW_SPACING = 0.85;
const ARROW_SPEED = 0.9;        // metres per second
const MAX_ARROWS = 96;
const BEACON_HEIGHT = 2.1;

const DOUBLE_SIDE = 2;
// Signal yellow, the colour of the route on the radar and of the direction sign.
const ribbonColour = () => new Color(1.0, 0.83, 0.0);
const arrowColour = () => new Color(0.07, 0.07, 0.08);
const beaconColour = () => new Color(1.0, 0.83, 0.0);

export function createPathLayer({ scene, walk, dirty }) {
  let ribbon = null, arrows = null, beacon = null, route = null, length = 0, phase = 0, from = 0;

  const raw = (x, y, z) => walk.toRaw({ x, y, z });

  function mesh(positions, indices, colour, { dynamic = false } = {}) {
    const geometry = new BufferGeometry();
    const attribute = new BufferAttribute(positions, 3);
    if (dynamic) attribute.dynamic = true;
    geometry.setAttribute('position', attribute);
    geometry.setIndex(indices);
    const object = new Mesh(geometry, new MeshBasicMaterial({ color: colour, side: DOUBLE_SIDE }));
    scene.add(object);
    return object;
  }

  function dispose(object) {
    if (!object) return;
    scene.remove(object);
    object.freeAllGpuResourceOwned?.();
  }

  /** A flat strip along the route with mitred corners. */
  function buildRibbon(points) {
    const positions = new Float32Array(points.length * 6), indices = [];
    for (let i = 0; i < points.length; i++) {
      const before = points[Math.max(0, i - 1)], here = points[i], after = points[Math.min(points.length - 1, i + 1)];
      const unit = (a, b) => { const dx = b.x - a.x, dz = b.z - a.z, n = Math.hypot(dx, dz) || 1; return [dx / n, dz / n]; };
      const [ax, az] = i > 0 ? unit(before, here) : unit(here, after);
      const [bx, bz] = i < points.length - 1 ? unit(here, after) : [ax, az];
      // The corner normal bisects the two segment normals; widen it so the strip keeps its width, within reason.
      let nx = -(az + bz), nz = ax + bx;
      const n = Math.hypot(nx, nz);
      if (n < 1e-6) { nx = -az; nz = ax; } else { nx /= n; nz /= n; }
      const mitre = Math.min(2.2, 1 / Math.max(0.2, Math.abs(nx * -az + nz * ax)));
      const half = (RIBBON_WIDTH / 2) * mitre;
      positions.set(raw(here.x + nx * half, here.y + RIBBON_LIFT, here.z + nz * half), i * 6);
      positions.set(raw(here.x - nx * half, here.y + RIBBON_LIFT, here.z - nz * half), i * 6 + 3);
      if (i) indices.push(2 * i - 2, 2 * i - 1, 2 * i, 2 * i - 1, 2 * i + 1, 2 * i);
    }
    return mesh(positions, new Uint32Array(indices), ribbonColour());
  }

  /** One buffer holding every arrow; positions are rewritten each frame as the arrows flow. */
  function buildArrows() {
    const indices = new Uint32Array(MAX_ARROWS * 6);
    for (let a = 0; a < MAX_ARROWS; a++) indices.set([a * 4, a * 4 + 1, a * 4 + 3, a * 4, a * 4 + 3, a * 4 + 2], a * 6);
    return mesh(new Float32Array(MAX_ARROWS * 12), indices, arrowColour(), { dynamic: true });
  }

  function writeArrows() {
    if (!arrows || !route) return;
    const attribute = arrows.geometry.getAttribute('position');
    const markers = markersAlong(route, { spacing: ARROW_SPACING, phase, from, margin: 0.4 }).slice(0, MAX_ARROWS);
    const tip = 0.11, back = 0.09, notch = 0.02, half = 0.085;
    for (let a = 0; a < MAX_ARROWS; a++) {
      const marker = markers[a];
      if (!marker) { for (let v = 0; v < 4; v++) attribute.setXYZ(a * 4 + v, 0, 0, 0); continue; }
      const { point, direction } = marker, y = point.y + ARROW_LIFT;
      const sideX = -direction.z, sideZ = direction.x;
      const corners = [
        [point.x + direction.x * tip, point.z + direction.z * tip],                                         // tip
        [point.x - direction.x * back + sideX * half, point.z - direction.z * back + sideZ * half],         // left wing
        [point.x - direction.x * back - sideX * half, point.z - direction.z * back - sideZ * half],         // right wing
        [point.x - direction.x * notch, point.z - direction.z * notch],                                     // inner notch
      ];
      corners.forEach(([x, z], v) => attribute.setXYZ(a * 4 + v, ...raw(x, y, z)));
    }
    attribute.needsUpdate = true;
  }

  /** A slim four-sided column standing on the destination. */
  function buildBeacon(point) {
    const r = 0.045, positions = new Float32Array(8 * 3);
    const base = [[-r, -r], [r, -r], [r, r], [-r, r]];
    base.forEach(([dx, dz], i) => {
      positions.set(raw(point.x + dx, point.y + 0.02, point.z + dz), i * 3);
      positions.set(raw(point.x + dx, point.y + BEACON_HEIGHT, point.z + dz), (i + 4) * 3);
    });
    const indices = [];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; indices.push(i, j, i + 4, j, j + 4, i + 4); }
    return mesh(positions, new Uint32Array(indices), beaconColour());
  }

  return {
    /** Show a route (walking-frame points from the walker to the destination). */
    show(points) {
      this.clear();
      route = simplifyPath(points, { minAngle: 1 });
      if (route.length < 2) { route = null; return; }
      length = pathLength(route);
      ribbon = buildRibbon(route);
      arrows = buildArrows();
      beacon = buildBeacon(route.at(-1));
      phase = 0; from = 0;
      writeArrows();
      dirty();
    },
    /** Hide the arrows already passed, so they only run ahead of the walker. */
    setProgress(travelled) { from = Math.max(0, Math.min(length, travelled)); },
    /** Advance the arrow animation. Returns true while a route is shown (the view needs redrawing). */
    tick(seconds) {
      if (!route) return false;
      phase = (phase + seconds * ARROW_SPEED) % ARROW_SPACING;
      writeArrows();
      return true;
    },
    clear() {
      dispose(ribbon); dispose(arrows); dispose(beacon);
      ribbon = arrows = beacon = route = null;
      dirty();
    },
    active: () => Boolean(route),
  };
}
