const hashPattern=/^[a-f0-9]{64}$/;
const finite=(value,limit=1e5)=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=limit;
const vector=(value,n)=>Array.isArray(value)&&value.length===n&&value.every(x=>finite(x));
const point=value=>value&&['x','y','z'].every(k=>finite(value[k]));
const quaternion=value=>vector(value,4)&&Math.abs(Math.hypot(...value)-1)<0.001;
const requireValue=(condition,message)=>{if(!condition)throw new Error(message);};

export function validatePois(pois) {
  requireValue(Array.isArray(pois)&&pois.length<=1000,'Invalid location list.');
  const ids=new Set();
  for(const p of pois){
    requireValue(p&&typeof p.id==='string'&&p.id.length>0&&p.id.length<=100&&!ids.has(p.id)&&typeof p.name==='string'&&p.name.trim().length>0&&p.name.length<=60&&point(p.position),'Invalid location.');
    ids.add(p.id);
  }
  return pois;
}

export function validateSetup(data,expectedKey) {
  requireValue(data?.version===1&&data.sourceKey===expectedKey&&typeof expectedKey==='string'&&expectedKey.length<=150,'This setup belongs to a different model.');
  const t=data.transform;
  requireValue(t&&vector(t.position,3)&&quaternion(t.quaternion)&&finite(t.scale,1000)&&t.scale>0,'Invalid scene transform.');
  requireValue(data.confirmed===true,'Confirm floor and scale before saving a walking setup.');
  if(data.floor!==null)requireValue(data.floor&&vector(data.floor.origin,3)&&quaternion(data.floor.quaternion),'Invalid floor setup.');
  if(expectedKey.startsWith('paired:')){requireValue(data.floor!==null,'A Gaussian walking setup needs a selected floor.');requireValue(hashPattern.test(data.collisionHash),'A Gaussian setup needs its collision hash.');}
  if(data.rotationDegrees!==undefined)requireValue([0,-90,90,180].includes(data.rotationDegrees),'Invalid orientation preset.');
  validatePois(data.pois);
  requireValue(data.start===null||point(data.start),'Invalid starting point.');
  requireValue(Array.isArray(data.checks)&&data.checks.length<=20,'Invalid measurement checks.');
  for(const c of data.checks){
    requireValue(c&&typeof c.label==='string'&&c.label.length<=100&&finite(c.realMetres,40)&&c.realMetres>0&&finite(c.modelMetres,100)&&c.modelMetres>0&&finite(c.errorPercent),'Invalid measurement check.');
    requireValue(Math.abs(c.errorPercent-Math.abs(c.modelMetres-c.realMetres)/c.realMetres*100)<0.01,'Measurement error does not match its distances.');
  }
  return data;
}

function validateAsset(asset,extension) {
  requireValue(asset&&typeof asset.url==='string'&&asset.url.length<300&&/^[a-zA-Z0-9_./-]+$/.test(asset.url)&&!asset.url.startsWith('/')&&!asset.url.split('/').some(part=>part==='..')&&asset.url.endsWith(extension)&&hashPattern.test(asset.sha256),'Invalid packaged asset.');
}

export function validateScenePackage(data) {
  requireValue(data?.version===1&&typeof data.title==='string'&&data.title.length<=150&&hashPattern.test(data.sourceHash),'Invalid scene package.');
  validateAsset(data.assets?.splat,'.ply');
  requireValue(data.assets.splat.sha256===data.sourceHash,'Scene source hash does not match its splat.');
  if(data.assets.collision){validateAsset(data.assets.collision,'.glb');requireValue(data.assets.collision.coordinateSpace==='raw-ply-v1','Unsupported collision coordinates.');}
  requireValue(Array.isArray(data.views)&&data.views.length<=10000,'Invalid captured viewpoints.');
  for(const v of data.views)requireValue(v&&typeof v.name==='string'&&v.name.length<=250&&vector(v.position,3)&&vector(v.forward,3)&&Math.hypot(...v.forward)>0.1&&vector(v.up,3)&&Math.hypot(...v.up)>0.1&&finite(v.fov,160)&&v.fov>=10,'Invalid captured viewpoint.');
  if(data.setup!==null&&data.setup!==undefined){requireValue(!!data.assets.collision,'A walking scene needs collision geometry.');validateSetup(data.setup,'paired:'+data.sourceHash);requireValue(data.setup.collisionHash===data.assets.collision.sha256,'Setup belongs to different collision geometry.');}
  return data;
}
