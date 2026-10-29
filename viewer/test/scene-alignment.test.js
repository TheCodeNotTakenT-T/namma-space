import test from 'node:test';
import assert from 'node:assert/strict';
import {Object3D,Vector3} from 'three';
import {floorAlignment,copySceneTransform,calibratedSceneKey} from '../src/scene-alignment.js';
test('tilted floor becomes horizontal and a paired asset keeps identical coordinates',()=>{
  const p=[new Vector3(0,1,0),new Vector3(2,2,0),new Vector3(0,1,2)];
  const aligned=floorAlignment(p);
  const transformed=p.map(v=>v.clone().applyQuaternion(aligned.quaternion));
  assert.ok(Math.abs(transformed[0].y-transformed[1].y)<1e-8);
  assert.ok(Math.abs(transformed[0].y-transformed[2].y)<1e-8);
  const mesh=new Object3D(), splat=new Object3D();mesh.quaternion.copy(aligned.quaternion);mesh.scale.setScalar(0.42);mesh.position.set(3,-2,1);mesh.updateMatrixWorld();
  copySceneTransform(mesh,splat);
  assert.deepEqual(splat.matrixWorld.elements,mesh.matrixWorld.elements);
});
test('slightly tilted floor picks snap to the room up; a different plane does not',()=>{
  const roomUp=new Vector3(0,-1,0);
  const bumpy=[new Vector3(0,0,0),new Vector3(2,-0.1,0),new Vector3(0,0.05,2)];  // ~3 degrees off level
  const snapped=floorAlignment(bumpy,new Vector3(0,-1,0),roomUp);
  assert.ok(roomUp.clone().applyQuaternion(snapped.quaternion).distanceTo(new Vector3(0,1,0))<1e-9);
  const wall=[new Vector3(0,0,0),new Vector3(0,1,0),new Vector3(0,0,1)];
  const kept=floorAlignment(wall,new Vector3(1,0,0),roomUp);
  assert.ok(new Vector3(1,0,0).applyQuaternion(kept.quaternion).distanceTo(new Vector3(0,1,0))<1e-9);
});
test('floor picking rejects a straight line',()=>{
  assert.throws(()=>floorAlignment([new Vector3(),new Vector3(1,0,0),new Vector3(2,0,0)]),/straight line/);
});

test('saved locations cannot cross a change of floor plane or source export',()=>{
  const model=new Object3D(), first=calibratedSceneKey('export-a',model);
  model.rotation.z=0.2;
  assert.notEqual(calibratedSceneKey('export-a',model),first);
  const tilted=calibratedSceneKey('export-a',model);
  model.position.y=1;
  assert.notEqual(calibratedSceneKey('export-a',model),tilted);
  assert.notEqual(calibratedSceneKey('export-b',model),calibratedSceneKey('export-a',model));
});
