/**
 * Bird's-eye view of the real reconstruction, and the flights in and out of it.
 *
 * The camera lifts out of the room while the ceiling is cut away, so the whole space is seen from above as
 * a dollhouse: the actual scan, not a drawing. From there you orbit, pick a place or a spot on the floor,
 * and the camera dives back down to it. "Jump there" uses the same flight: up, across, down.
 *
 * Works in the walking frame (metres, +y up) and converts to reconstruction coordinates for the camera.
 */
import { Vector3 } from '@manycore/aholo-viewer';
import { cameraBasis, screenRay } from '../../src/projection.js';

const CEILING_CUT = 2.15;        // metres above the floor kept in the bird's-eye view
const RISE = 1.15, DIVE = 1.05;  // seconds
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const mix = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

export function createDollhouse({ app, container, camera, control, walk, effects, dirty, getRoomBox = () => null, onPickFloor, onClose }) {
  let active = false;          // in the bird's-eye view (or flying)
  let flight = null;           // {elapsed, duration, from, to, onEnd, midway}
  let orbit = null;            // {centre, distance, azimuth, elevation}
  let home = null;             // where the walker stood and faced when the view opened
  let drag = null;

  /** Aim the real camera: `eye` and `target` are walking-frame points. */
  function aim(eye, target) {
    const up = walk.upRaw();
    camera.position.set(...walk.toRaw(eye));
    camera.up.set(up[0], up[1], up[2]);
    camera.lookAt(new Vector3(...walk.toRaw(target)));
    dirty();
  }

  const orbitEye = () => ({
    x: orbit.centre.x + orbit.distance * Math.cos(orbit.elevation) * Math.sin(orbit.azimuth),
    y: orbit.centre.y + orbit.distance * Math.sin(orbit.elevation),
    z: orbit.centre.z + orbit.distance * Math.cos(orbit.elevation) * Math.cos(orbit.azimuth),
  });

  /** Where the walker's own eyes are and what they look at. */
  function walkerView(point, heading) {
    const eye = { x: point.x, y: point.y + walk.eyeHeight(), z: point.z };
    return { eye, target: { x: eye.x + heading.x * 3, y: eye.y, z: eye.z + heading.z * 3 } };
  }

  /** Frame the whole walkable area from above, behind the way the walker faces. */
  function frameAll() {
    const { positions } = walk.navigation().walkableMesh();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
      minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
    }
    const radius = Math.hypot(maxX - minX, maxZ - minZ) / 2 + 1.5;
    const half = Math.tan((camera.fov * Math.PI) / 360);
    const heading = walk.heading();
    orbit = {
      centre: { x: (minX + maxX) / 2, y: 0.6, z: (minZ + maxZ) / 2 },
      distance: Math.max(6, radius / half * 1.05),
      azimuth: Math.atan2(-heading.x, -heading.z),
      elevation: 58 * Math.PI / 180,
    };
  }

  function fly(from, to, duration, { midway, onEnd, arc = 0 } = {}) {
    flight = { elapsed: 0, duration, from, to, midway, onEnd, arc, passed: false };
  }

  function open() {
    if (active || !walk.ready()) return false;
    const player = walk.player(), heading = walk.heading();
    home = { point: { x: player.point.x, y: player.point.y, z: player.point.z }, heading };
    active = true;
    control.enabled = false;
    app.classList.add('wf-dollhouse');
    frameAll();
    effects.setBox(getRoomBox());
    effects.setCeiling(CEILING_CUT, RISE * 0.8);
    fly(walkerView(home.point, heading), { eye: orbitEye(), target: orbit.centre }, RISE);
    return true;
  }

  /** Dive to a walkable point and resume walking there, facing `toward` (a point) or `heading`. */
  function diveTo(point, { toward = null, heading = null } = {}) {
    if (!active) return;
    const face = toward ? (() => { const dx = toward.x - point.x, dz = toward.z - point.z, n = Math.hypot(dx, dz) || 1; return { x: dx / n, z: dz / n }; })() : heading ?? walk.heading();
    const from = flight ? currentView() : { eye: orbitEye(), target: orbit.centre };
    fly(from, walkerView(point, face), DIVE, {
      midway: () => effects.setCeiling(null, DIVE * 0.45),
      onEnd: () => {
        active = false; orbit = null;
        effects.setBox(null);
        app.classList.remove('wf-dollhouse');
        control.enabled = true;
        walk.teleport(point, { x: point.x + face.x, y: point.y, z: point.z + face.z });
        container.focus({ preventScroll: true });
        onClose?.();
      },
    });
  }

  function currentView() {
    const t = ease(Math.min(1, flight.elapsed / flight.duration));
    return { eye: mix(flight.from.eye, flight.to.eye, t), target: mix(flight.from.target, flight.to.target, t) };
  }

  /**
   * "Jump there" as one movement: lift off, cross above the room, come down at the place.
   * Short hops stay low; long ones rise high enough to see where you are going.
   */
  function jump(point, toward) {
    if (active || !walk.ready()) return false;
    const player = walk.player(), heading = walk.heading();
    const start = walkerView(player.point, heading);
    const span = Math.hypot(point.x - player.point.x, point.z - player.point.z);
    const height = Math.min(9, 3.2 + span * 0.55);
    const apex = {
      eye: { x: (player.point.x + point.x) / 2 - heading.x * 1.5, y: height, z: (player.point.z + point.z) / 2 - heading.z * 1.5 },
      target: { x: point.x, y: 0.8, z: point.z },
    };
    active = true;
    control.enabled = false;
    app.classList.add('wf-dollhouse', 'wf-flying');
    effects.setBox(getRoomBox());
    effects.setCeiling(CEILING_CUT, 0.5);
    fly(start, apex, 0.85, {
      onEnd: () => {
        orbit = { centre: apex.target, distance: 1, azimuth: 0, elevation: 1 };   // placeholder so diveTo has a state
        const from = apex;
        const dx = toward.x - point.x, dz = toward.z - point.z, n = Math.hypot(dx, dz) || 1, face = { x: dx / n, z: dz / n };
        fly(from, walkerView(point, face), 0.95, {
          midway: () => effects.setCeiling(null, 0.45),
          onEnd: () => {
            active = false; orbit = null;
            effects.setBox(null);
            app.classList.remove('wf-dollhouse', 'wf-flying');
            control.enabled = true;
            walk.teleport(point, { x: point.x + face.x, y: point.y, z: point.z + face.z });
            container.focus({ preventScroll: true });
            onClose?.();
          },
        });
      },
    });
    return true;
  }

  /** The floor point under a screen position, by intersecting the view ray with the floor plane. */
  function floorUnder(clientX, clientY) {
    const box = container.getBoundingClientRect();
    camera.updateMatrixWorld(true);
    const basis = cameraBasis(camera.matrixWorld.elements);
    const direction = screenRay(basis, camera.fov, box.width / box.height, (clientX - box.left) / box.width, (clientY - box.top) / box.height);
    const origin = walk.toNav(basis.position);
    const ahead = walk.toNav(basis.position.map((value, axis) => value + direction[axis]));
    const dy = ahead.y - origin.y;
    if (dy > -1e-6) return null;
    const t = -origin.y / dy;
    return { x: origin.x + (ahead.x - origin.x) * t, y: 0, z: origin.z + (ahead.z - origin.z) * t };
  }

  container.addEventListener('pointerdown', event => {
    if (!active || flight || !orbit) return;
    drag = { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, at: performance.now() };
    container.setPointerCapture(event.pointerId);
  });
  container.addEventListener('pointermove', event => {
    if (!drag || !active || flight) return;
    orbit.azimuth -= (event.clientX - drag.x) * 0.006;
    orbit.elevation = Math.min(86 * Math.PI / 180, Math.max(24 * Math.PI / 180, orbit.elevation + (event.clientY - drag.y) * 0.005));
    drag.x = event.clientX; drag.y = event.clientY;
    aim(orbitEye(), orbit.centre);
  });
  container.addEventListener('pointerup', event => {
    if (!drag) return;
    const still = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5 && performance.now() - drag.at < 450;
    drag = null;
    if (!still || !active || flight) return;
    const point = floorUnder(event.clientX, event.clientY);
    if (point) onPickFloor(point);
  });
  container.addEventListener('wheel', event => {
    if (!active || flight || !orbit) return;
    event.preventDefault();
    orbit.distance = Math.min(80, Math.max(3, orbit.distance * Math.exp(event.deltaY * 0.0012)));
    aim(orbitEye(), orbit.centre);
  }, { passive: false });

  return {
    open, jump, diveTo,
    /** Leave the bird's-eye view and land where you were. */
    close() { if (active && home && !app.classList.contains('wf-flying')) diveTo(home.point, { heading: home.heading }); },
    isActive: () => active,
    isFlying: () => Boolean(flight),
    /** Advance a flight. Returns true while the camera is moving. */
    frame(seconds) {
      if (!flight) return false;
      flight.elapsed += seconds;
      const raw = Math.min(1, flight.elapsed / flight.duration), t = ease(raw);
      if (!flight.passed && raw >= 0.5) { flight.passed = true; flight.midway?.(); }
      aim(mix(flight.from.eye, flight.to.eye, t), mix(flight.from.target, flight.to.target, t));
      if (raw >= 1) { const done = flight.onEnd; flight = null; done?.(); }
      return true;
    },
  };
}
