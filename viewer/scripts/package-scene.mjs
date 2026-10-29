import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {readColmapViews} from './colmap-views.mjs';
import {validateSetup, validateScenePackage} from '../src/scene-package.js';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
function demand(condition, message) { if (!condition) throw new Error(message); }
export async function existingInside(parent, target, label) {
  const base = await fs.realpath(parent), resolved = await fs.realpath(target);
  demand(within(base, resolved), `${label} must stay inside ${parent}.`);
  return resolved;
}
export async function newOutputInside(root, target) {
  demand(within(root, target), 'Output must be a new directory inside the workspace.');
  try { await fs.lstat(target); throw new Error('Output already exists; choose a new directory.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Resolve the nearest existing parent to reject junction/symlink escapes, even
  // when one or more output parent directories have not been created yet.
  let ancestor = path.dirname(target);
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      demand(real === root || within(root, real), 'Output parent resolves outside the workspace.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const next = path.dirname(ancestor);
      if (next === ancestor) throw error;
      ancestor = next;
    }
  }
}
export async function inventoryFiles(directory) {
  const result = [], visited = new Set();
  async function visit(current, relative = '') {
    const resolvedDirectory = await fs.realpath(current);
    demand(resolvedDirectory === directory || within(directory, resolvedDirectory), 'Build output resolves outside its directory.');
    demand(!visited.has(resolvedDirectory), 'Build output contains a directory cycle.');
    visited.add(resolvedDirectory);
    for (const entry of await fs.readdir(current, {withFileTypes:true})) {
      const file = path.join(current, entry.name), name = path.join(relative, entry.name);
      // OneDrive placeholders can be reported as reparse/symlink entries on
      // Windows. Resolve and bound them rather than rejecting normal files.
      const resolved = await fs.realpath(file), stat = await fs.stat(file);
      demand(within(directory, resolved), 'Build output resolves outside its directory.');
      if (stat.isDirectory()) await visit(file, name);
      else if (stat.isFile()) result.push({source:resolved, relative:name});
      else throw new Error('Unsupported build output entry: ' + name);
    }
  }
  await visit(directory);
  return result;
}
async function packageDirectory(name, from, boundary) {
  let cursor = from;
  while (true) {
    const candidate = path.join(cursor, 'node_modules', name);
    try { return await existingInside(boundary, candidate, 'Dependency'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (cursor === boundary) break;
    const parent = path.dirname(cursor);
    if (!within(boundary, parent) && parent !== boundary) break;
    cursor = parent;
  }
  throw new Error('Installed dependency not found: ' + name);
}
export async function collectLicences(prototype, root) {
  const visited = new Set(), packages = [], files = [];
  async function visit(name, from, optional = false) {
    let folder;
    try { folder = await packageDirectory(name, from, root); }
    catch (error) { if (optional && /not found/.test(error.message)) return; throw error; }
    if (visited.has(folder)) return;
    visited.add(folder);
    const info = await json(path.join(folder, 'package.json'));
    demand(typeof info.name === 'string' && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(info.name) && typeof info.version === 'string' && /^[a-z0-9.+_-]+$/i.test(info.version), 'Invalid dependency identity.');
    const notices = [];
    for (const entry of await fs.readdir(folder, {withFileTypes:true})) {
      if (/^(licen[sc]e|notice|copying)(?:[._-].*)?$/i.test(entry.name) && (await fs.stat(path.join(folder, entry.name))).isFile()) {
        const source = await existingInside(folder, path.join(folder, entry.name), 'Licence file');
        const relative = path.join('licenses', info.name.replaceAll('/', '__'), info.version, entry.name);
        files.push({source, relative});
        notices.push(relative.split(path.sep).join('/'));
      }
    }
    packages.push({name:info.name, version:info.version, license:info.license ?? 'See upstream package', notices});
    const dependencies = {...info.dependencies, ...info.optionalDependencies};
    for (const dependency of Object.keys(dependencies).sort()) {
      await visit(dependency, folder, Object.hasOwn(info.optionalDependencies ?? {}, dependency));
    }
  }
  const info = await json(path.join(prototype, 'package.json'));
  for (const name of Object.keys(info.dependencies ?? {}).sort()) await visit(name, prototype);
  return {packages:packages.sort((a,b) => a.name.localeCompare(b.name)), files};
}
function validateViews(views) {
  demand(Array.isArray(views) && views.length > 0, 'No captured viewpoints are available.');
  for (const view of views) {
    demand(typeof view.name === 'string' && view.name.length <= 500, 'Invalid viewpoint name.');
    for (const key of ['position', 'forward', 'up']) demand(Array.isArray(view[key]) && view[key].length === 3 && view[key].every(Number.isFinite), 'Invalid viewpoint vectors.');
    demand(Number.isFinite(view.fov) && view.fov > 0 && view.fov < 180, 'Invalid viewpoint field of view.');
  }
  return views.map(({name, position, forward, up, fov}) => ({name:name.replaceAll('\\', '/').split('/').at(-1), position, forward, up, fov}));
}

// The injectable root is solely for isolated automated fixtures. CLI callers
// always use the workspace containing this script.
export async function packageScene({job, cloudScene, setupPath, output, submission = false, execute = false, root = workspace}) {
  root = await fs.realpath(path.resolve(root));
  const prototype = await existingInside(root, path.join(root, 'viewer'), 'Application');
  demand(Boolean(job)!==Boolean(cloudScene), 'Choose exactly one --job PATH or --cloud-scene PATH.');
  output = path.resolve(output ?? path.join(root, 'output', 'web-demo-' + new Date().toISOString().replace(/[:.]/g, '-')));
  await newOutputInside(root, output);
  let splatBytes, sourceHash, collisionBytes, counts, views, diagnostic, title;
  if(cloudScene){
    const cloudRoot=await existingInside(root,path.join(root,'data','cloud-results'),'Cloud results');
    const manifestPath=await existingInside(cloudRoot,path.resolve(cloudScene),'Cloud scene');
    job=path.dirname(manifestPath);
    const imported=validateScenePackage(await json(manifestPath));
    demand(imported.assets.collision,'Cloud scene needs matching collision geometry.');
    const source=await existingInside(job,path.resolve(job,imported.assets.splat.url),'Cloud splat');
    const collider=await existingInside(job,path.resolve(job,imported.assets.collision.url),'Cloud collision');
    splatBytes=await fs.readFile(source);collisionBytes=await fs.readFile(collider);sourceHash=hash(splatBytes);
    demand(sourceHash===imported.sourceHash&&hash(collisionBytes)===imported.assets.collision.sha256,'Cloud asset hash changed; import the original matching result again.');
    counts={registeredImages:imported.capture?.registeredImages,inputImages:imported.capture?.inputImages,trainingSteps:imported.capture?.trainingSteps};
    views=validateViews(imported.views);diagnostic=imported.capture?.diagnostic!==false;title=imported.title;
  }else{
  const jobs = await existingInside(root, path.join(root, 'data', 'gaussian-jobs'), 'Jobs directory');
  job = await existingInside(jobs, path.resolve(job), 'Job');
  const state = await json(path.join(job, 'status.json'));
  demand(state.splat && Array.isArray(state.splat.files) && state.splat.files.length, 'Job has no completed splat export.');
  const latestFile = [...state.splat.files].sort((a,b) => a.localeCompare(b, undefined, {numeric:true})).at(-1);
  const source = await existingInside(job, path.resolve(state.splat.directory, latestFile), 'Splat');
  demand(path.extname(source).toLowerCase() === '.ply', 'Expected a PLY splat.');
  const pairing = await json(path.join(job, 'collision.json'));
  demand(pairing.coordinateSpace === 'raw-ply-v1', 'Regenerate collision geometry using raw-ply-v1 before packaging.');
  demand(pairing.exitCode === 0, 'Collision generation did not complete successfully.');
  const boundSource = await existingInside(job, path.resolve(pairing.source), 'Bound splat');
  demand(boundSource === source, 'Collision geometry belongs to a different splat.');
  splatBytes = await fs.readFile(source);sourceHash = hash(splatBytes);
  demand(sourceHash === pairing.sourceSha256, 'Splat hash changed; regenerate matching collision geometry.');
  const collision = await existingInside(job, path.resolve(pairing.path), 'Collision geometry');
  demand(path.extname(collision).toLowerCase() === '.glb', 'Expected GLB collision geometry.');
  collisionBytes = await fs.readFile(collision);
  const capture = await json(path.join(job, 'capture.json'));
  counts = {registeredImages:state.alignment?.best?.registeredImages, inputImages:capture.inputCount, trainingSteps:state.splat.trainingSteps};
  const sparse = await existingInside(job, path.join(job, 'dataset', 'sparse'), 'Camera data');
  for (const name of ['cameras.bin', 'images.bin']) await existingInside(job, path.join(sparse, name), 'Camera file');
  views = validateViews(readColmapViews(sparse));diagnostic=state.splat.diagnostic===true;title='Namma Space — '+path.basename(job);
  }
  for (const [key, value] of Object.entries(counts)) demand(Number.isSafeInteger(value) && value > 0, 'Invalid capture metadata: ' + key);
  demand(counts.registeredImages <= counts.inputImages, 'Registered image count exceeds input count.');
  demand(splatBytes.length<=150*1024**2&&collisionBytes.length<=150*1024**2,'A browser asset exceeds 150 MiB. Preserve the master and prepare a smaller web derivative before packaging.');
  let setup = null;
  if (setupPath) {
    const checked = validateSetup(await json(path.resolve(setupPath)), 'paired:' + sourceHash);
    const cleanPoint = p => p === null ? null : ({x:p.x, y:p.y, z:p.z});
    setup = {version:checked.version, sourceKey:checked.sourceKey, collisionHash:checked.collisionHash, transform:{position:checked.transform.position, quaternion:checked.transform.quaternion, scale:checked.transform.scale}, floor:checked.floor === null ? null : {origin:checked.floor.origin, quaternion:checked.floor.quaternion}, confirmed:true, pois:checked.pois.map(p => ({id:p.id, name:p.name, position:cleanPoint(p.position)})), start:cleanPoint(checked.start), checks:checked.checks.map(c => ({label:c.label, realMetres:c.realMetres, modelMetres:c.modelMetres, errorPercent:c.errorPercent}))};
    if(checked.rotationDegrees!==undefined)setup.rotationDegrees=checked.rotationDegrees;
  }
  if(submission){
    demand(setup?.start,'Submission packaging needs a saved floor/scale setup and entrance.');
    demand(setup.checks.length>=2&&setup.checks.every(check=>check.errorPercent<=5),'Submission packaging needs two independent distance checks, each within the project\'s 5% tolerance.');
    demand(counts.registeredImages/counts.inputImages>=0.9,'Submission packaging requires at least 90% registered views under the project quality gate.');
  }
  const dist = await existingInside(prototype, path.join(prototype, 'dist'), 'Built viewer');
  const buildFiles = await inventoryFiles(dist);
  demand(buildFiles.some(file => file.relative === 'index.html'), 'Build the viewer first: npm run build.');
  const reserved = new Set(['scene.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'package-evidence.json', 'license-inventory.json', 'vercel.json']);
  demand(!buildFiles.some(file => reserved.has(file.relative) || ['scene', 'licenses'].includes(file.relative.split(path.sep)[0])), 'Build contains reserved package paths. Use a clean viewer build.');
  const licences = await collectLicences(prototype, root);
  const credits = await fs.readFile(path.join(prototype, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const manifest = {
    version:1, title, sourceHash,
    capture:{id:path.basename(job), ...counts, diagnostic},
    assets:{splat:{url:'scene/room.ply', sha256:sourceHash}, collision:{url:'scene/room.collision.glb', sha256:hash(collisionBytes), coordinateSpace:'raw-ply-v1'}},
    views, setup,
    warning:setup ? 'Operator-confirmed setup. Measurements and collision coverage require independent validation; packaging is not accuracy certification.' : 'Inspection only: no confirmed metric scale, floor alignment or walkable setup. This capture may contain gaps.'
  };
  validateScenePackage(manifest);
  const totalAssetBytes=splatBytes.length+collisionBytes.length;
  const summary = {output, capture:manifest.capture, sourceHash, mode:setup ? 'operator-configured' : 'inspection-only', submissionChecksPassed:submission, viewpoints:views.length, includedLicencePackages:licences.packages.length,totalAssetBytes,hostingNote:totalAssetBytes>=95_000_000?'Scene assets approach or exceed the Vercel Hobby CLI source-upload allowance; check the complete deployment size.':'Check the complete deployment size and bandwidth against the selected hosting plan.'};
  if (!execute) return {...summary, created:false, message:'Preview only; add --execute to create a new local folder. Nothing is published.'};
  // Capture data is read into memory before creating output, so a concurrent
  // reconstruction cannot change an asset between its hash and its copy.
  await fs.mkdir(path.dirname(output), {recursive:true});
  await newOutputInside(root, output);
  await fs.mkdir(output, {recursive:false});
  for (const file of [...buildFiles, ...licences.files]) {
    const target = path.join(output, file.relative);
    await fs.mkdir(path.dirname(target), {recursive:true});
    await fs.copyFile(file.source, target, fs.constants.COPYFILE_EXCL);
  }
  await fs.mkdir(path.join(output, 'scene'));
  await fs.writeFile(path.join(output, 'scene', 'room.ply'), splatBytes, {flag:'wx'});
  await fs.writeFile(path.join(output, 'scene', 'room.collision.glb'), collisionBytes, {flag:'wx'});
  await fs.writeFile(path.join(output, 'scene.json'), JSON.stringify(manifest, null, 2), {flag:'wx'});
  await fs.writeFile(path.join(output,'vercel.json'),JSON.stringify({version:2,framework:null,buildCommand:null,outputDirectory:'.',headers:[{source:'/scene.json',headers:[{key:'Cache-Control',value:'no-cache'}]},{source:'/(.*)',headers:[{key:'X-Content-Type-Options',value:'nosniff'}]}]},null,2),{flag:'wx'});
  await fs.writeFile(path.join(output, 'THIRD_PARTY_NOTICES.md'), credits, {flag:'wx'});
  await fs.writeFile(path.join(output, 'license-inventory.json'), JSON.stringify(licences.packages, null, 2), {flag:'wx'});
  await fs.writeFile(path.join(output, 'package-evidence.json'), JSON.stringify({...summary, output:undefined, createdAt:new Date().toISOString(), assetsHashed:true, metricAccuracyCertified:false, navigationValidated:false, sourcePhotosIncluded:false, reconstructionBinariesIncluded:false, published:false}, null, 2), {flag:'wx'});
  await fs.writeFile(path.join(output, 'README.md'), `# Namma Space portable viewer\n\n${manifest.warning}\n\nCapture: ${manifest.capture.id}. ${counts.registeredImages}/${counts.inputImages} registered images; ${counts.trainingSteps} training steps. Diagnostic: ${manifest.capture.diagnostic}.\n\n## Preview locally\n\nServe this directory over HTTP; opening index.html as a file does not work. From this directory, use an installed Python 3 runtime:\n\n\`\`\`powershell\npython -m http.server 4173 --bind 127.0.0.1\n\`\`\`\n\nOpen http://127.0.0.1:4173/ . The packaged scene loads automatically. No COLMAP, Brush, GPU reconstruction server or source photos are needed to view it. Browser WebGL2 and enough GPU memory are required.\n\n## Host when ready\n\nUpload the contents of this folder to a static HTTPS host, keeping scene.json, scene/, assets/, licenses/ and notices together. Review the visible room and any personal information before sharing. This command did not publish anything. Test the public URL in a clean browser before submitting. Hosting from a subfolder requires a viewer build with relative base URLs.\n\n## What this proves\n\nThe hashes in scene.json bind the packaged assets. Collision geometry is a reconstructed approximation, not surveyed ground truth. A saved setup records the operator's calibration; it cannot prove physical accuracy. ${setup ? 'The supplied setup is included; inspect paths and obstruction handling in this package before submission.' : 'Walking is disabled until a genuine measured setup is supplied and its navigation surfaces can be generated. This package is a reconstruction inspection artifact, not the completed submission.'}\n\nOriginal camera photos, databases, machine paths, tool binaries and processing logs are excluded. Camera pose names remain in the viewer. Keep THIRD_PARTY_NOTICES.md, license-inventory.json and licenses/ with redistribution.\n`, {flag:'wx'});
  return {...summary, created:true};
}

async function main() {
  const flags = process.argv.slice(2), options = {};
  for (let i=0; i<flags.length; i++) {
    const flag = flags[i];
    if (flag === '--execute') { options.execute = true; continue; }
    if (flag === '--submission') { options.submission = true; continue; }
    demand(['--job', '--cloud-scene', '--setup', '--output'].includes(flag), 'Unknown argument: ' + flag);
    const value = flags[++i];
    demand(value && !value.startsWith('--'), 'Missing value for ' + flag);
    options[flag === '--setup' ? 'setupPath' : flag === '--cloud-scene' ? 'cloudScene' : flag.slice(2)] = value;
  }
  console.log(JSON.stringify(await packageScene(options), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
