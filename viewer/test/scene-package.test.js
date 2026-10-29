import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSetup,validateScenePackage} from '../src/scene-package.js';
const hash='a'.repeat(64);
const setup=()=>({version:1,sourceKey:'paired:'+hash,collisionHash:hash,transform:{position:[1,2,3],quaternion:[0,0,0,1],scale:0.5},floor:{origin:[0,0,0],quaternion:[0,0,0,1]},confirmed:true,pois:[],start:null,checks:[]});
test('setup round trip preserves floor, physical check and asset identity',()=>{
  const data=setup();data.checks.push({label:'Door width',realMetres:1,modelMetres:1.02,errorPercent:2});
  assert.deepEqual(validateSetup(JSON.parse(JSON.stringify(data)),data.sourceKey),data);
  assert.throws(()=>validateSetup(data,'paired:'+'b'.repeat(64)),/different model/);
  data.transform.scale=NaN;assert.throws(()=>validateSetup(data,data.sourceKey),/transform/);
});
test('invalid floor, duplicate locations and made-up error percentages are rejected',()=>{
  let d=setup();d.floor=null;assert.throws(()=>validateSetup(d,d.sourceKey),/selected floor/);
  d=setup();d.pois=[{id:'one',name:'Door',position:{x:0,y:0,z:0}},{id:'one',name:'Desk',position:{x:1,y:0,z:1}}];assert.throws(()=>validateSetup(d,d.sourceKey),/location/);
  d=setup();d.checks=[{label:'Width',realMetres:1,modelMetres:2,errorPercent:0}];assert.throws(()=>validateSetup(d,d.sourceKey),/error/);
});
test('portable manifest permits inspection-only scenes and rejects remote or traversing assets',()=>{
  const d={version:1,title:'Room',sourceHash:hash,assets:{splat:{url:'scene/room.ply',sha256:hash}},views:[],setup:null};
  assert.equal(validateScenePackage(d),d);
  for(const url of ['../private.ply','https://example.com/room.ply','/private.ply']){d.assets.splat.url=url;assert.throws(()=>validateScenePackage(d),/asset/);}
});
