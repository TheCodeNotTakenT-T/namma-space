import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateViewerManifest, validateWalk} from '../aholo/saved-walk.js';
import {existingInside, newOutputInside, inventoryFiles, collectLicences} from './package-scene.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readJSON = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Packaging only. This never uploads a room or provisions a host.
export async function packageAholoScene({scenePath, setupPath, output, inspection=false, root=workspace}) {
  root = await fs.realpath(root);
  const library = await existingInside(root, path.join(root, 'data/scene-library'), 'Scene library');
  const input = await existingInside(library, path.resolve(scenePath), 'Imported scene');
  const m = validateViewerManifest(await readJSON(input));
  const scene = {splatHash:m.splat.sha256, collisionHash:m.collision.sha256};
  const setup = setupPath ? validateWalk(await readJSON(path.resolve(setupPath)), scene) : null;
  if (!inspection && !setup) throw Error('Download the walking setup from this room first, then select that JSON file.');
  output = path.resolve(output ?? path.join(root, 'output', 'aholo-demo-' + new Date().toISOString().replace(/[:.]/g, '-')));
  await newOutputInside(root, output);
  const prototype = await existingInside(root, path.join(root, 'viewer'), 'Application');
  const dist = await existingInside(prototype, path.join(prototype, 'dist'), 'Built application');
  const files = (await inventoryFiles(dist)).filter(f => f.relative === path.join('aholo','index.html') || f.relative.startsWith('assets' + path.sep));
  if (!files.some(f => f.relative === path.join('aholo','index.html'))) throw Error('Build the Aholo viewer before packaging.');
  const html = await fs.readFile(path.join(dist,'aholo/index.html'),'utf8');
  const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1]);
  const code = (await Promise.all(scripts.map(s => fs.readFile(path.resolve(dist,'aholo',s),'utf8')))).join('\n');
  if (!code.includes('Room manifest must be hosted with this viewer.')) throw Error('The viewer build predates portable scenes. Build again.');
  const assets = {};
  for (const [kind, item] of [['splat',m.splat],['collision',m.collision]]) {
    const file = await existingInside(path.dirname(input), path.join(path.dirname(input), item.file), kind);
    const bytes = await fs.readFile(file);
    if (digest(bytes) !== item.sha256 || (kind === 'splat' && bytes.length !== m.splat.bytes)) throw Error('Changed or incomplete ' + kind + ' file; import the original result again.');
    assets[kind] = bytes;
  }
  const licences = await collectLicences(prototype, root);
  const credits = await fs.readFile(path.join(prototype,'THIRD_PARTY_NOTICES.md'),'utf8');
  // Deliberate whitelist: no source images, local paths, source reports or raw master PLY.
  const manifest = {version:1,type:'namma-viewer-scene',coordinateSpace:'raw-ply-v1',title:m.title,
    splat:{file:'preview.spz',sha256:m.splat.sha256,bytes:assets.splat.length},
    collision:{file:'collision.glb',sha256:m.collision.sha256,triangles:m.collision.triangles},
    ...(m.initialView ? {initialView:m.initialView} : {}), ...(setup ? {walkingSetup:setup} : {}),
    metricVerified:false, warning:'Experimental reconstruction. Walking uses the supplied measurement and reviewed surfaces; physical accuracy is not certified.'};
  await fs.mkdir(output, {recursive:true});
  for (const file of [...files,...licences.files]) {
    const target = path.join(output,file.relative);await fs.mkdir(path.dirname(target),{recursive:true});
    await fs.copyFile(file.source,target,fs.constants.COPYFILE_EXCL);
  }
  await fs.mkdir(path.join(output,'scene'));
  for (const [name, contents] of [
    ['index.html','<!doctype html><html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=./aholo/?manifest=../scene/scene.json"><title>Namma Space · Team rpk</title><a href="./aholo/?manifest=../scene/scene.json">Open the room walkthrough</a></html>'],
    ['scene/scene.json',JSON.stringify(manifest,null,2)],
    ['scene/preview.spz',assets.splat], ['scene/collision.glb',assets.collision],
    ['THIRD_PARTY_NOTICES.md',credits], ['license-inventory.json',JSON.stringify(licences.packages,null,2)],
    ['vercel.json',JSON.stringify({version:2,framework:null,buildCommand:null,outputDirectory:'.',headers:[{source:'/(.*)',headers:[{key:'X-Content-Type-Options',value:'nosniff'},{key:'Cache-Control',value:'no-cache'}]}]},null,2)],
    ['README.md',`# Portable Namma Space room\n\nBy Team rpk (Akarsh Shrivastav, Mayan S Hiremath, NIT Goa): https://github.com/TheCodeNotTakenT-T/namma-space\n\nServe this folder over HTTP for local preview or HTTPS for visitors. Start at index.html. Opening a file:// URL will not work.\n\n${setup ? 'Open Walking setup and choose Enter saved walking setup. Floor, scale, height and entrance are included. Surfaces are rebuilt and the entrance checked before movement.' : 'Inspection package only. No saved walking entrance is included.'}\n\nThis package has NOT been published or certified as geometrically accurate. Test the complete walking route and performance on another device before submitting. It contains visible room details; review the scene before sharing. No source photos, master PLY, local paths or cloud logs are included. Keep licenses/ and THIRD_PARTY_NOTICES.md with redistribution.\n\nThis is a static walkthrough, not a hosted video-training service.\n`],
  ]) await fs.writeFile(path.join(output,name),contents,{flag:'wx'});
  return {output,walkingSetupIncluded:Boolean(setup),published:false,splatBytes:assets.splat.length,collisionBytes:assets.collision.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), options={};
  try {
    for(let i=0;i<args.length;i++){
      const arg=args[i];if(arg==='--inspection'){options.inspection=true;continue;}
      if(!['--scene','--setup','--output'].includes(arg)||!args[i+1]||args[i+1].startsWith('--'))throw Error('Use --scene PATH --setup PATH [--output PATH].');
      options[arg==='--scene'?'scenePath':arg==='--setup'?'setupPath':'output']=args[++i];
    }
    if(!options.scenePath)throw Error('Choose an imported scene.json.');
    console.log(JSON.stringify(await packageAholoScene(options),null,2));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
