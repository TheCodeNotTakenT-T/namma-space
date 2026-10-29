import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {BufferGeometry, BufferAttribute, Mesh, MeshBasicMaterial, Color, Raycaster, Vector2, Vector3 as ViewVector3} from '@manycore/aholo-viewer';
import {buildNavigation} from '../src/navigation.js';
import {floorAlignment} from '../src/scene-alignment.js';
import {WALK_PROFILE, sceneIdentity, validateWalk, loadWalk, saveWalk} from './saved-walk.js';

// Render in raw reconstruction coordinates; transform only navigation queries to metres/Y-up.
// This keeps appearance, pick geometry and player position in the same source frame.
export function createWalkingTools({viewer,camera,control,container,dirty,onWalkingStart=()=>{}}) {
  const panel=document.createElement('details');panel.className='namma-walking glass-panel';
  panel.innerHTML=`<summary>Walking setup · experimental</summary>
    <button data-action="resume" disabled>Enter saved walking setup</button>
    <p>Reconstructed surfaces are not yet validated room geometry. Inspect floor coverage and obstacles before walking.</p>
    <button data-action="load">Load matching collision estimate</button>
    <label><input type="checkbox" data-field="overlay" checked> Show estimated surfaces</label>
    <button data-action="floor" disabled>1. Pick three floor points</button>
    <label>Measured distance (metres)<input data-field="distance" type="number" value="" min="0.01" step="0.01"></label>
    <button data-action="measure" disabled>2. Pick measurement endpoints</button>
    <button data-action="build" disabled>3. Build walking surfaces</button>
    <label><input data-field="review" type="checkbox"> I reviewed the surfaces and want to test experimental walking</label>
    <button data-action="spawn" disabled>4. Pick a walking start</button>
    <label>Eye height above floor (metres)<input data-field="eye" type="number" value="1.65" min="1.2" max="1.7" step="0.05"></label>
    <button data-action="level" disabled>Look straight ahead</button>
    <button data-action="pause" disabled>Pause walking</button>
    <button data-action="save" disabled>Save this walking entrance</button>
    <button data-action="export" disabled>Download walking setup</button>
    <button data-action="import">Load a saved setup file</button>
    <input data-field="import" type="file" accept=".json" hidden>
    <p data-field="saved" role="status">Setup is saved on this browser after you choose a walking start. Download it to carry it to another browser or demo package.</p>
    <p data-field="status" role="status">Load a supported scene. No automatic floor filling.</p>
    <canvas width="240" height="180" aria-label="Top-down estimated geometry and player position"></canvas>`;
  document.getElementById('app').append(panel);
  const button=name=>panel.querySelector(`[data-action="${name}"]`);
  const field=name=>panel.querySelector(`[data-field="${name}"]`);
  const say=message=>{field('status').textContent=message;};
  let root=null,drawables=[],navigation=null,alignment=null,scale=null,mode=null,picks=[],state=null;
  let rawToNav=new THREE.Matrix4(),navToRaw=new THREE.Matrix4(),bounds=null,mapPoints=[];
  let generation=0, recovered=false, savedControls=null, eyeHeight=1.65;
  let measurement=null, savedSetup=null, restoring=false;
  let previousCameraMode=null;
  const raycaster=new Raycaster();
  const canvas=panel.querySelector('canvas'),ctx=canvas.getContext('2d');
  const mapBase=document.createElement('canvas');mapBase.width=240;mapBase.height=180;
  const mapCtx=mapBase.getContext('2d');let mapDirty=true,lastMapTime=0;
  function pause(){state=null;button('pause').disabled=true;button('level').disabled=true;button('save').disabled=true;control.stop();if(savedControls){Object.assign(control,savedControls);savedControls=null;}if(previousCameraMode!==null){document.getElementById('select-camera-mode').value=previousCameraMode;previousCameraMode=null;}setWalkStatus(false);}
  function setWalkStatus(active){const label=document.getElementById('walk-status');if(label)label.textContent=active?'Experimental walking · Scale uses the supplied measurement.':'Explore the reconstruction · Open Walking setup to enter.';}
  function invalidate(){generation++;pause();navigation?.dispose();navigation=null;button('spawn').disabled=true;field('review').checked=false;}
  function clear(){generation++;invalidate();for(const mesh of drawables){viewer.getScene().remove(mesh);mesh.freeAllGpuResourceOwned?.();}drawables=[];
    root?.traverse(o=>{o.geometry?.dispose();if(o.material){for(const m of [o.material].flat())m.dispose?.();}});
    control.enabled=true;root=null;alignment=null;scale=null;measurement=null;mode=null;picks=[];mapPoints=[];bounds=null;mapDirty=true;drawMap();
    for(const name of ['floor','measure','build'])button(name).disabled=true;dirty();}
  function setSource(scene){clear();recovered=scene;button('load').disabled=!scene;
    field('distance').value='';
    savedSetup=null;button('resume').disabled=true;button('export').disabled=true;
    let savedOrigin='this browser',savedError='';
    try{savedSetup=loadWalk(localStorage,scene);}catch(e){savedError='Browser setup could not be restored: '+e.message+' ';}
    if(!savedSetup)savedOrigin='the scene package';
    if(!savedSetup&&scene?.walkingSetup){try{savedSetup=validateWalk(scene.walkingSetup,scene);}catch(e){field('saved').textContent=e.message;}}
    button('resume').disabled=!savedSetup;button('export').disabled=!savedSetup;
    field('saved').textContent=savedError+(savedSetup?`Saved setup found in ${savedOrigin} for these exact files. Enter it without picking the floor and measurement again. Physical scale still depends on the supplied measurement.`:'Choose a walking start to save setup on this browser. Existing sessions from older versions cannot be recovered after refresh.');
    say(scene?`${typeof scene==='object'?scene.title:scene} selected. Load its matching surfaces. Scale is unverified.`:'No paired collision estimate for this file.');}

  async function load(){
    if(!recovered)return;clear();const token=generation;say('Loading estimated surfaces…');
    try{
      const response=await fetch(recovered.collisionUrl);if(!response.ok)throw Error('Collision estimate unavailable.');
      const bytes=await response.arrayBuffer();
      if(typeof recovered==='object'){
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
        if(hash!==recovered.collisionHash)throw Error('Collision file changed. Re-import this scene before walking.');
      }
      const parsed=await new GLTFLoader().parseAsync(bytes,'');
      if(token!==generation)return false;
      root=parsed.scene;root.updateMatrixWorld(true);
      root.traverse(o=>{if(!o.isMesh)return;const g=o.geometry.clone();g.applyMatrix4(o.matrixWorld);
        const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(new Float32Array(g.attributes.position.array),3));
        if(g.index)geometry.setIndex(new Uint32Array(g.index.array));
        const material=new MeshBasicMaterial({color:new Color(0.15,0.85,0.65),side:2});
        const mesh=new Mesh(geometry,material);mesh.visible=field('overlay').checked;viewer.getScene().add(mesh);drawables.push(mesh);g.dispose();});
      button('floor').disabled=false;button('measure').disabled=false;dirty();say('Green surfaces are estimates. Pick three widely spaced points on the actual floor.');
      return true;
    }catch(e){say(e.message);return false;}
  }
  button('load').onclick=load;
  field('overlay').onchange=()=>{drawables.forEach(m=>m.visible=field('overlay').checked);dirty();};
  for(const name of ['floor','measure','spawn'])button(name).onclick=()=>{
    pause();mode=name;picks=[];control.enabled=false;
    say(name==='floor'?'Click three floor points, spread apart.':name==='measure'?'Click the two exact endpoints of your tape measurement.':'Click a verified floor location. Escape cancels.');
  };
  container.addEventListener('click',event=>{
    if(!mode||!root)return;
    const box=container.getBoundingClientRect();camera.updateMatrixWorld(true);
    // Pick against the same mesh used for navigation, even when the overlay is hidden.
    drawables.forEach(m=>{m.visible=true;m.updateMatrixWorld(true);});
    raycaster.setFromCamera(new Vector2((event.clientX-box.left)/box.width*2-1,1-(event.clientY-box.top)/box.height*2),camera);
    const hit=raycaster.intersectObjects(drawables,true)[0];
    drawables.forEach(m=>m.visible=field('overlay').checked);
    if(!hit){say('No estimated surface here. Choose an observed surface; missing floor cannot be walked on.');return;}
    const point=new THREE.Vector3(hit.point.x,hit.point.y,hit.point.z);picks.push(point);
    try{
      if(mode==='floor'&&picks.length===3){invalidate();const roomUp=recovered?.initialView?.up;alignment=floorAlignment(picks,new THREE.Vector3(camera.up.x,camera.up.y,camera.up.z),roomUp&&new THREE.Vector3(...roomUp));finish(scale?'Floor reference selected. You can now build walking surfaces; scale still needs verification.':'Floor reference selected. Now pick the measured endpoints.');}
      else if(mode==='measure'&&picks.length===2){
        const metres=Number(field('distance').value),distance=picks[0].distanceTo(picks[1]);
        if(!(metres>0&&metres<=40&&distance>0.001))throw Error('Use a valid measurement and distinct endpoints.');
        invalidate();scale=metres/distance;measurement={metres,endpoints:picks.map(p=>p.toArray())};finish(`Scale estimate: ${scale.toFixed(4)} metres/unit. ${alignment ? "Floor reference is set; you can build walking surfaces." : "Floor reference is missing: choose Pick three floor points and click three separated floor locations."} An assumed distance is not verified scale.`);
      }else if(mode==='spawn'){
        if(!navigation||!field('review').checked)throw Error('Review the geometry and scale first.');
        const nearest=navigation.nearest(point.applyMatrix4(rawToNav));if(!nearest)throw Error('No walkable surface near that point.');
        beginWalk(nearest);
        finish('Experimental walking: WASD; drag to look. Escape pauses. Test walls and furniture before relying on it.');
        persist();
      }else say(`${picks.length} point(s) selected.`);
      button('build').disabled=!(alignment&&scale);
    }catch(e){finish(e.message);}
  });
  function finish(message){mode=null;picks=[];control.enabled=true;say(message);dirty();}
  button('pause').onclick=()=>{pause();say('Walking paused.');};
  button('level').onclick=()=>{upright(true);dirty();};
  field('eye').onchange=()=>{const value=Number(field('eye').value);if(!Number.isFinite(value)||value<1.2||value>1.7){field('eye').value=String(eyeHeight);say('Choose an eye height between 1.2 and 1.7 metres. Check measured scale if furniture still looks too large.');return;}eyeHeight=value;placeCamera();if(state)persist();dirty();};
  window.addEventListener('keydown',event=>{if(event.key==='Escape'){pause();finish('Selection/walking paused.');}});
  field('distance').oninput=()=>{scale=null;measurement=null;invalidate();button('build').disabled=true;};
  field('review').onchange=()=>{if(!field('review').checked)pause();button('spawn').disabled=!navigation||!field('review').checked;};
  async function build(){
    invalidate();const token=generation;button('build').disabled=true;say('Building constrained walking surfaces…');
    try{
      rawToNav=new THREE.Matrix4().compose(new THREE.Vector3(),alignment.quaternion,new THREE.Vector3(scale,scale,scale));
      const origin=alignment.origin.clone().applyMatrix4(rawToNav);rawToNav.setPosition(origin.negate());navToRaw.copy(rawToNav).invert();
      const aligned=new THREE.Group();aligned.add(root.clone(true));aligned.applyMatrix4(rawToNav);aligned.updateMatrixWorld(true);
      const box=new THREE.Box3().setFromObject(aligned),size=box.getSize(new THREE.Vector3());
      if(size.x>40||size.z>40)throw Error('Scale makes this room exceed 40 metres. Check endpoints and outliers.');
      const nav=await buildNavigation(aligned);if(token!==generation){nav.dispose();return false;}navigation=nav;bounds=box;
      mapPoints=[];aligned.traverse(o=>{if(!o.isMesh)return;const a=o.geometry.attributes.position;for(let i=0;i<a.count;i+=12){const p=new THREE.Vector3().fromBufferAttribute(a,i).applyMatrix4(o.matrixWorld);mapPoints.push(p);}});
      mapDirty=true;drawMap();say('Walking surfaces generated, not validated. Inspect coverage, check the review box, then choose a start.');
      return true;
    }catch(e){say(e.message);return false;}finally{button('build').disabled=!(alignment&&scale);}
  }
  button('build').onclick=build;
  function beginWalk(nearest, forward=null){
    // Keep the collision geometry for navigation, but do not draw its debug layer while walking.
    field('overlay').checked=false;drawables.forEach(m=>m.visible=false);
    pause();state=nearest;savedControls={useOrbit:control.useOrbit,moveSpeed:control.moveSpeed,wheelSpeed:control.wheelSpeed};
    const modeSelect=document.getElementById('select-camera-mode');previousCameraMode=modeSelect.value;modeSelect.value='flight';onWalkingStart();
    control.useOrbit=false;control.moveSpeed=1.8/scale;control.wheelSpeed=0;control.enabled=true;
    const up=new THREE.Vector3(0,1,0).transformDirection(navToRaw);camera.up.set(up.x,up.y,up.z);
    placeCamera();
    if(forward)camera.lookAt(new ViewVector3(camera.position.x+forward[0],camera.position.y+forward[1],camera.position.z+forward[2]));
    upright(!forward);button('pause').disabled=false;button('level').disabled=false;button('save').disabled=!sceneIdentity(recovered);
    drawMap();setWalkStatus(true);dirty();
  }
  function persist(){
    if(!state||!sceneIdentity(recovered))return;
    const direction=camera.getWorldDirection(new ViewVector3());
    const raw=new THREE.Vector3().copy(state.point).applyMatrix4(navToRaw);
    try{
      savedSetup=validateWalk({version:1,type:'namma-aholo-walk',profile:WALK_PROFILE,coordinateSpace:'raw-ply-v1',
        sceneIdentity:sceneIdentity(recovered),floor:{origin:alignment.origin.toArray(),quaternion:alignment.quaternion.toArray()},
        metresPerUnit:scale,measurement,eyeHeight,entrance:raw.toArray(),forward:[direction.x,direction.y,direction.z],reviewed:field('review').checked},recovered);
      button('resume').disabled=false;button('export').disabled=false;
      saveWalk(localStorage,recovered,savedSetup);
      field('saved').textContent='Walking entrance saved on this browser. Download setup for a portable backup. This does not certify physical dimensions.';
    }catch(e){field('saved').textContent='Could not save on this browser: '+e.message+(savedSetup?' Download the setup to preserve it.':'');}
  }
  button('save').onclick=persist;
  button('export').onclick=()=>{
    if(!savedSetup)return;
    const blob=new Blob([JSON.stringify(validateWalk(savedSetup,recovered),null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='namma-walking-setup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  };
  button('import').onclick=()=>field('import').click();
  field('import').onchange=async()=>{
    const file=field('import').files?.[0],scene=recovered,token=generation;field('import').value='';if(!file)return;
    try{
      if(file.size>65536)throw Error('Walking setup file is too large.');
      const checked=validateWalk(JSON.parse(await file.text()),scene);
      if(token!==generation||scene!==recovered)return;
      savedSetup=checked;button('resume').disabled=false;button('export').disabled=false;
      try{saveWalk(localStorage,recovered,savedSetup);}catch{/* Keep the imported setup usable in this session. */}
      field('saved').textContent='Matching setup loaded. Choose Enter saved walking setup to rebuild and check the entrance.';
    }catch(e){say(e.message);}
  };
  button('resume').onclick=async()=>{
    if(!savedSetup||restoring)return;
    const saved=validateWalk(savedSetup,recovered);restoring=true;button('resume').disabled=true;
    try{
      if(!await load())return;
      const token=generation;
      alignment={origin:new THREE.Vector3().fromArray(saved.floor.origin),quaternion:new THREE.Quaternion().fromArray(saved.floor.quaternion)};
      scale=saved.metresPerUnit;measurement=saved.measurement;eyeHeight=saved.eyeHeight;
      field('distance').value=String(measurement.metres);field('eye').value=String(eyeHeight);
      if(!await build())return;
      // build() increments generation; a source switch during its async work is rejected by build itself.
      if(generation!==token+1)return;
      const nearest=navigation.nearest(new THREE.Vector3().fromArray(saved.entrance).applyMatrix4(rawToNav));
      if(!nearest)throw Error('Saved entrance is no longer walkable. Inspect the surfaces and choose a new start.');
      field('review').checked=true;button('spawn').disabled=false;
      field('overlay').checked=false;drawables.forEach(m=>m.visible=false);
      beginWalk(nearest,saved.forward);say('Saved walking setup restored. WASD to walk; drag to look; Escape pauses.');
    }catch(e){say(e.message);}finally{restoring=false;button('resume').disabled=!savedSetup;}
  };
  function upright(level=false){
    if(!state)return;
    const up=new THREE.Vector3(0,1,0).transformDirection(navToRaw);
    const direction=camera.getWorldDirection(new ViewVector3());
    const forward=new THREE.Vector3(direction.x,direction.y,direction.z);
    const pitch=forward.dot(up);
    const horizontal=forward.clone().addScaledVector(up,-pitch);
    if(horizontal.lengthSq()<1e-8)horizontal.set(0,0,-1).transformDirection(navToRaw);
    horizontal.normalize();
    // Keep mouse-look pitch, but remove roll; avoid a singular look-at at the poles.
    const angle=level?0:Math.asin(THREE.MathUtils.clamp(pitch,-0.996,0.996));
    forward.copy(horizontal).multiplyScalar(Math.cos(angle)).addScaledVector(up,Math.sin(angle));
    camera.up.set(up.x,up.y,up.z);
    camera.lookAt(new ViewVector3(camera.position.x+forward.x,camera.position.y+forward.y,camera.position.z+forward.z));
  }
  function placeCamera(){if(!state)return;const raw=new THREE.Vector3().copy(state.point).add(new THREE.Vector3(0,eyeHeight,0)).applyMatrix4(navToRaw);camera.position.set(raw.x,raw.y,raw.z);}
  function tick(cameraMoved=false){if(!state||!cameraMoved)return false;
    const proposed=new THREE.Vector3(camera.position.x,camera.position.y,camera.position.z).applyMatrix4(rawToNav);
    const delta=proposed.sub(new THREE.Vector3().copy(state.point).add(new THREE.Vector3(0,eyeHeight,0)));delta.y=0;
    // Cap accidental teleports from nonwalking controls, then constrain all motion to the navmesh.
    if(delta.length()>0.3)delta.setLength(0.3);if(delta.lengthSq()>1e-12)navigation.move(state,delta);placeCamera();upright();
    const now=performance.now();if(now-lastMapTime>=100){drawMap();lastMapTime=now;}return true;
  }
  function drawMap(){ctx.clearRect(0,0,240,180);if(!bounds)return;const size=bounds.getSize(new THREE.Vector3());const k=Math.min(220/Math.max(size.x,.1),160/Math.max(size.z,.1));
    const xy=p=>[10+(p.x-bounds.min.x)*k,10+(p.z-bounds.min.z)*k];
    if(mapDirty){mapCtx.clearRect(0,0,240,180);mapCtx.fillStyle='#667c86';for(const p of mapPoints){const[x,y]=xy(p);mapCtx.fillRect(x,y,1,1);}mapDirty=false;}
    ctx.drawImage(mapBase,0,0);if(state){const[x,y]=xy(state.point);ctx.fillStyle='#39e6b4';ctx.beginPath();ctx.arc(x,y,4,0,Math.PI*2);ctx.fill();}}
  return {setSource,tick,pause,isWalking:()=>Boolean(state),hasSavedSetup:()=>Boolean(savedSetup),resumeSaved:()=>button('resume').click()};
}
