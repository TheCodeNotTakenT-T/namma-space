// Portable calibration belongs to this exact visual/collision pair, never a title.
export const WALK_PROFILE = 'recast-cs005-ch004-height120-climb030-radius015-floorfill-v3';
// Setups store calibration and entrance only, so ones saved under earlier walker settings stay valid.
const EARLIER_PROFILES = ['recast-cs005-ch004-height170-radius025-v2', 'recast-cs008-ch004-height170-radius025-v1'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);
const demand = (ok, message) => { if (!ok) throw Error(message); };

export function sceneIdentity(scene) {
  if (!scene || !sha(scene.splatHash) || !sha(scene.collisionHash)) return null;
  return `${scene.splatHash}:${scene.collisionHash}`;
}

export function validateWalk(saved, scene) {
  demand(saved?.version === 1 && saved.type === 'namma-aholo-walk', 'Unsupported walking setup.');
  demand(saved.sceneIdentity === sceneIdentity(scene) && sceneIdentity(scene), 'Walking setup belongs to different scene files.');
  // These records contain calibration/entrance, never cached nav polygons.
  // Resume rebuilds navigation and checks the entrance using the current grid.
  demand([WALK_PROFILE, ...EARLIER_PROFILES].includes(saved.profile) && saved.coordinateSpace === 'raw-ply-v1', 'Walking settings changed; rebuild this setup.');
  demand(vector(saved.floor?.origin, 3) && vector(saved.floor?.quaternion, 4), 'Invalid saved floor.');
  demand(Math.abs(Math.hypot(...saved.floor.quaternion) - 1) < 1e-5, 'Invalid saved floor rotation.');
  demand(Number.isFinite(saved.metresPerUnit) && saved.metresPerUnit > 0 && saved.metresPerUnit < 1e5, 'Invalid saved scale.');
  demand(Number.isFinite(saved.eyeHeight) && saved.eyeHeight >= 1.2 && saved.eyeHeight <= 1.7, 'Invalid saved eye height.');
  demand(vector(saved.entrance, 3) && vector(saved.forward, 3) && Math.hypot(...saved.forward) > .001, 'Invalid saved entrance.');
  demand(saved.reviewed === true, 'Review the walking surfaces before saving.');
  const m = saved.measurement;
  demand(Number.isFinite(m?.metres) && m.metres > 0 && m.metres <= 40 && Array.isArray(m.endpoints) && m.endpoints.length === 2 && m.endpoints.every(p => vector(p, 3)), 'Invalid saved measurement.');
  const distance = Math.hypot(...m.endpoints[0].map((x, i) => x - m.endpoints[1][i]));
  demand(distance > .001 && Math.abs(m.metres / distance / saved.metresPerUnit - 1) < 1e-6, 'Saved endpoints do not match the scale.');
  // Review/assumed measurements are never upgraded to metric verification.
  return {
    version: 1, type: 'namma-aholo-walk', profile: WALK_PROFILE,
    coordinateSpace: 'raw-ply-v1', sceneIdentity: saved.sceneIdentity,
    floor: {origin: [...saved.floor.origin], quaternion: [...saved.floor.quaternion]},
    metresPerUnit: saved.metresPerUnit, eyeHeight: saved.eyeHeight,
    measurement: {metres: m.metres, endpoints: m.endpoints.map(p => [...p])},
    entrance: [...saved.entrance], forward: [...saved.forward], reviewed: true,
    metricVerified: false,
  };
}

export function loadWalk(storage, scene) {
  const identity = sceneIdentity(scene);
  if (!identity) return null;
  const raw = storage.getItem('namma:walk:v1:' + identity);
  return raw ? validateWalk(JSON.parse(raw), scene) : null;
}

export function saveWalk(storage, scene, saved) {
  const checked = validateWalk(saved, scene);
  storage.setItem('namma:walk:v1:' + checked.sceneIdentity, JSON.stringify(checked));
  return checked;
}

export function validateViewerManifest(m) {
  demand(m?.version === 1 && m.type === 'namma-viewer-scene' && m.coordinateSpace === 'raw-ply-v1', 'Unsupported room manifest.');
  demand(typeof m.title === 'string' && m.title.length > 0 && m.title.length <= 200, 'Invalid room title.');
  demand(m.splat?.file === 'preview.spz' && m.collision?.file === 'collision.glb', 'Unsupported room asset paths.');
  demand(sha(m.splat.sha256) && sha(m.collision.sha256), 'Missing room file identities.');
  demand(Number.isSafeInteger(m.splat.bytes) && m.splat.bytes > 0 && m.splat.bytes <= 150 * 1024 ** 2, 'Room file exceeds the supported browser size.');
  demand(Number.isSafeInteger(m.collision.triangles) && m.collision.triangles > 0 && m.collision.triangles <= 250000, 'Room collision geometry exceeds the walking budget.');
  const clean = {version: 1, type: m.type, coordinateSpace: m.coordinateSpace, title: m.title,
    splat: {...m.splat}, collision: {...m.collision}};
  if (m.initialView) {
    const v = m.initialView;
    demand(vector(v.position, 3) && Array.isArray(v.rotation) && v.rotation.length === 3 && v.rotation.every(r => vector(r, 3)) && Number.isFinite(v.height) && v.height > 0 && Number.isFinite(v.fy) && v.fy > 0, 'Invalid initial camera.');
    clean.initialView = {position: v.position, rotation: v.rotation, height: v.height, fy: v.fy};
    // Room up from all training cameras (older scenes lack it and fall back to the first camera).
    if (vector(v.up, 3) && Math.abs(Math.hypot(...v.up) - 1) < 1e-3) clean.initialView.up = v.up;
  }
  if (m.walkingSetup) clean.walkingSetup = validateWalk(m.walkingSetup, {splatHash: m.splat.sha256, collisionHash: m.collision.sha256});
  return clean;
}
