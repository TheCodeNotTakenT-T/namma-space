import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {packageAholoScene} from '../scripts/package-aholo-scene.mjs';
import {WALK_PROFILE} from '../aholo/saved-walk.js';

const base=fileURLToPath(new URL('../test-results/',import.meta.url));
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t){
  await fs.mkdir(base,{recursive:true});
  const root=await fs.mkdtemp(path.join(base,'aholo-package-'));
  t.after(async()=>{assert.equal(path.dirname(root),path.resolve(base));await fs.rm(root,{recursive:true,force:true});});
  const write=async(p,data)=>{await fs.mkdir(path.dirname(p),{recursive:true});await fs.writeFile(p,typeof data==='string'?data:JSON.stringify(data));};
  const folder=path.join(root,'data/scene-library/fixture'),scenePath=path.join(folder,'scene.json'),output=path.join(root,'output/demo');
  const splat='fixture splats',mesh='fixture collider',splatHash=hash(splat),collisionHash=hash(mesh);
  const manifest={version:1,type:'namma-viewer-scene',coordinateSpace:'raw-ply-v1',title:'Fixture',
    splat:{file:'preview.spz',sha256:splatHash,bytes:splat.length},collision:{file:'collision.glb',sha256:collisionHash,triangles:12},
    provenance:{privatePath:'C:/private/original'}};
  await write(scenePath,manifest);await write(path.join(folder,'preview.spz'),splat);await write(path.join(folder,'collision.glb'),mesh);
  const setupPath=path.join(root,'setup.json');
  await write(setupPath,{version:1,type:'namma-aholo-walk',profile:WALK_PROFILE,coordinateSpace:'raw-ply-v1',sceneIdentity:splatHash+':'+collisionHash,
    floor:{origin:[0,0,0],quaternion:[0,0,0,1]},metresPerUnit:1,eyeHeight:1.65,
    measurement:{metres:4,endpoints:[[0,0,0],[4,0,0]]},entrance:[0,.04,2],forward:[0,0,-1],reviewed:true});
  await write(path.join(root,'viewer/dist/aholo/index.html'),'<script src="../assets/app.js"></script>');
  await write(path.join(root,'viewer/dist/assets/app.js'),'Room manifest must be hosted with this viewer.');
  await write(path.join(root,'viewer/package.json'),{dependencies:{}});
  await write(path.join(root,'viewer/THIRD_PARTY_NOTICES.md'),'Fixture notices');
  return {root,scenePath,setupPath,output,folder,manifest,write};
}
test('portable Aholo package has relative scene URLs and setup but no private provenance',async t=>{
  const f=await fixture(t);const result=await packageAholoScene(f);
  assert.equal(result.walkingSetupIncluded,true);assert.equal(result.published,false);
  const manifest=JSON.parse(await fs.readFile(path.join(f.output,'scene/scene.json'),'utf8'));
  assert.equal(manifest.walkingSetup.metricVerified,false);assert.equal(manifest.provenance,undefined);
  assert.equal(hash(await fs.readFile(path.join(f.output,'scene/preview.spz'))),manifest.splat.sha256);
  assert.match(await fs.readFile(path.join(f.output,'index.html'),'utf8'),/\.\/aholo\/\?manifest=\.\.\/scene\/scene.json/);
  await assert.rejects(packageAholoScene(f),/already exists/);
});
test('wrong assets, missing setup, stale build and output escapes stop before writing',async t=>{
  const f=await fixture(t);
  await assert.rejects(packageAholoScene({...f,setupPath:undefined}),/walking setup/);
  await assert.rejects(packageAholoScene({...f,output:path.join(f.root,'../escaped-demo')}),/inside the workspace/);
  await f.write(path.join(f.folder,'collision.glb'),'changed');
  await assert.rejects(packageAholoScene(f),/Changed or incomplete collision/);
  await assert.rejects(fs.access(f.output),{code:'ENOENT'});
  await f.write(path.join(f.root,'viewer/dist/assets/app.js'),'old viewer');
  await assert.rejects(packageAholoScene(f),/predates portable/);
});
