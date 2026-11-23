import fs from 'node:fs';
import path from 'node:path';
import {validateVenue} from '../src/venue.js';

const MAX_VENUE_BYTES = 2 * 1024 ** 2;

/**
 * Development-only middleware: serves imported rooms from <root>/data/scene-library at /__scenes, and
 * accepts the tagged places of a room (PUT /__scenes/<id>/venue.json) so tagging in the browser is saved
 * next to the scene and picked up by the packager.
 */
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
  function saveVenue(req,res,id) {
    const chunks=[];let size=0;
    req.on('data',chunk=>{size+=chunk.length;if(size>MAX_VENUE_BYTES){res.statusCode=413;res.end('Venue file is too large.');req.destroy();}else chunks.push(chunk);});
    req.on('end',()=>{
      if(res.writableEnded)return;
      try{
        read(id);
        const venue=validateVenue(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        const target=path.join(base,id,'venue.json'),temporary=target+'.tmp';
        fs.writeFileSync(temporary,JSON.stringify(venue,null,2)+'\n');
        fs.renameSync(temporary,target);
        res.statusCode=204;res.end();
      }catch(error){res.statusCode=400;res.end(error.message);}
    });
  }
  return (req,res,next)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(!pathname.startsWith('/__scenes'))return next();
    res.setHeader('Cache-Control','no-store');
    const match=pathname.match(/^\/__scenes\/([a-zA-Z0-9-]{1,100})\/(scene\.json|preview\.spz|collision\.glb|venue\.json)$/);
    if(req.method==='PUT'&&match?.[2]==='venue.json'){
      // Same-origin pages only: a stray website must not be able to write into the scene library.
      const origin=req.headers.origin;
      if(origin&&new URL(origin).host!==req.headers.host){res.statusCode=403;return res.end('Cross-origin save refused.');}
      return saveVenue(req,res,match[1]);
    }
    if(req.method!=='GET'){res.statusCode=405;return res.end();}
    try{
      if(pathname==='/__scenes'){
        const scenes=[];
        if(fs.existsSync(base))for(const id of fs.readdirSync(base)){
          try{const m=read(id);scenes.push({id,title:m.title});}catch{/* Incomplete jobs are hidden. */}
        }
        res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(scenes));
      }
      if(!match){res.statusCode=404;return res.end('Unknown scene asset');}
      const [,id,name]=match;const m=read(id);
      if(name==='scene.json'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(m));}
      const target=path.join(base,id,name);
      if(name==='venue.json'&&!fs.existsSync(target)){res.statusCode=404;return res.end('No places tagged yet');}
      if(!inside(target))throw Error('Asset path escaped library');
      res.setHeader('Content-Type',name.endsWith('.glb')?'model/gltf-binary':name.endsWith('.json')?'application/json':'application/octet-stream');
      res.setHeader('Content-Length',fs.statSync(target).size);
      const stream=fs.createReadStream(target);stream.on('error',()=>res.destroy());stream.pipe(res);
    }catch{res.statusCode=404;res.end('Scene unavailable or incomplete');}
  };
}
