import test from 'node:test';
import assert from 'node:assert/strict';
import {WALK_PROFILE, validateWalk, saveWalk, loadWalk, validateViewerManifest} from '../aholo/saved-walk.js';

const scene = {splatHash: 'a'.repeat(64), collisionHash: 'b'.repeat(64)};
const recipe = () => ({version:1, type:'namma-aholo-walk', profile:WALK_PROFILE,
  coordinateSpace:'raw-ply-v1', sceneIdentity:scene.splatHash+':'+scene.collisionHash,
  floor:{origin:[0,0,0],quaternion:[0,0,0,1]}, metresPerUnit:2, eyeHeight:1.65,
  measurement:{metres:4,endpoints:[[0,0,0],[2,0,0]]}, entrance:[1,0,1], forward:[0,0,-1], reviewed:true});

test('walking setup persists per exact asset pair without certifying measurement', () => {
  const memory = new Map();
  const storage = {getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)};
  saveWalk(storage, scene, {...recipe(), metricVerified:true});
  const saved = loadWalk(storage, scene);
  assert.equal(saved.metricVerified, false);
  assert.deepEqual(saved.entrance,[1,0,1]);
  assert.equal(loadWalk(storage,{...scene,collisionHash:'c'.repeat(64)}),null);
  assert.throws(()=>validateWalk(saved,{...scene,splatHash:'c'.repeat(64)}),/different scene/);
});

test('stale navigation, broken scale, nonfinite transforms and unreviewed setups are rejected', () => {
  for (const edit of [r=>r.profile='old', r=>r.metresPerUnit=4, r=>r.floor.origin[0]=NaN,
    r=>r.floor.quaternion=[0,0,0,2], r=>r.eyeHeight=12, r=>r.reviewed=false,
    r=>r.entrance=[Infinity,0,0], r=>r.forward=[0,0,0]]) {
    const saved=recipe();edit(saved);assert.throws(()=>validateWalk(saved,scene));
  }
});

test('previous grid calibration migrates without changing measured scale or entrance',()=>{
  const old={...recipe(),profile:'recast-cs008-ch004-height170-radius025-v1'};
  const migrated=validateWalk(old,scene);
  assert.equal(migrated.profile,WALK_PROFILE);
  assert.equal(migrated.metresPerUnit,old.metresPerUnit);
  assert.deepEqual(migrated.entrance,old.entrance);
});

test('portable manifest rejects remote/traversing assets and mismatched walking setup', () => {
  const m={version:1,type:'namma-viewer-scene',coordinateSpace:'raw-ply-v1',title:'Fixture',
    splat:{file:'preview.spz',sha256:scene.splatHash,bytes:100},
    collision:{file:'collision.glb',sha256:scene.collisionHash,triangles:100},walkingSetup:recipe()};
  assert.equal(validateViewerManifest(m).walkingSetup.eyeHeight,1.65);
  assert.throws(()=>validateViewerManifest({...m,splat:{...m.splat,file:'../private.spz'}}));
  assert.throws(()=>validateViewerManifest({...m,collision:{...m.collision,sha256:'c'.repeat(64)}}));
});

test('manifest keeps the room up only when it is a unit vector', () => {
  const view={position:[0,0,0],rotation:[[1,0,0],[0,1,0],[0,0,1]],height:720,fy:650};
  const m={version:1,type:'namma-viewer-scene',coordinateSpace:'raw-ply-v1',title:'Fixture',
    splat:{file:'preview.spz',sha256:scene.splatHash,bytes:100},
    collision:{file:'collision.glb',sha256:scene.collisionHash,triangles:100}};
  assert.deepEqual(validateViewerManifest({...m,initialView:{...view,up:[0,-1,0]}}).initialView.up,[0,-1,0]);
  assert.equal(validateViewerManifest({...m,initialView:{...view,up:[0,-3,0]}}).initialView.up,undefined);
  assert.equal(validateViewerManifest({...m,initialView:view}).initialView.up,undefined);
});
