import fs from 'node:fs';
import path from 'node:path';
export function sceneLibrary(root) {
  const base=path.resolve(root,'data/scene-library');
  const inside=p=>{const rel=path.relative(base,fs.realpathSync(p));return rel&&!rel.startsWith('..')&&!path.isAbsolute(rel);};
  function read(id) {
    if(!/^[a-zA-Z0-9-]{1,100}$/.test(id))throw Error('Invalid scene id');
    const file=path.join(base,id,'scene.json');
    if(!inside(file))throw Error('Scene path escaped library');
    const m=JSON.parse(fs.readFileSync(file,'utf8'));
    if(m.type!=='namma-viewer-scene'||m.id!==id||m.coordinateSpace!=='raw-ply-v1'||
       m.splat.file!=='preview.spz'||m.collision.file!=='collision.glb')throw Error('Invalid scene manifest');
    return m;
  }
  return (req,res,next)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(!pathname.startsWith('/__scenes'))return next();
    if(req.method!=='GET'){res.statusCode=405;return res.end();}
    res.setHeader('Cache-Control','no-store');
    try{
      if(pathname==='/__scenes'){
        const scenes=[];
        if(fs.existsSync(base))for(const id of fs.readdirSync(base)){
          try{const m=read(id);scenes.push({id,title:m.title});}catch{/* Incomplete jobs are hidden. */}
        }
        res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(scenes));
      }
      const match=pathname.match(/^\/__scenes\/([a-zA-Z0-9-]{1,100})\/(scene\.json|preview\.spz|collision\.glb)$/);
      if(!match){res.statusCode=404;return res.end('Unknown scene asset');}
      const [,id,name]=match;const m=read(id);
      if(name==='scene.json'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(m));}
      const target=path.join(base,id,name);if(!inside(target))throw Error('Asset path escaped library');
      res.setHeader('Content-Type',name.endsWith('.glb')?'model/gltf-binary':'application/octet-stream');
      res.setHeader('Content-Length',fs.statSync(target).size);
      const stream=fs.createReadStream(target);stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch{res.statusCode=404;res.end('Scene unavailable or incomplete');}
  };
}
