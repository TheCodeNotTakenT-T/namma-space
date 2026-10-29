// Convert an already trained model and its paired mesh; never generate geometry.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PLYLoader} from 'three/addons/loaders/PLYLoader.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
const [model, mesh, destination] = process.argv.slice(2);
if (!model || !mesh || !destination) throw Error('Expected model, mesh and output directory.');
const out=path.resolve(destination);
fs.mkdirSync(out,{recursive:true});
const bytes=fs.readFileSync(mesh);
let triangleCount=0, bounds;
if (mesh.toLowerCase().endsWith('.glb')) {
  const {scene}=await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  scene.traverse(o=>{if(o.isMesh)triangleCount+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;});
  if(!triangleCount || triangleCount>250000)throw Error('Collision mesh must contain 1–250,000 triangles.');
  fs.copyFileSync(mesh,path.join(out,'collision.glb'));
} else {
  const geometry=new PLYLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
  const pos=geometry.attributes.position;
  if(!geometry.index)throw Error('Expected a triangle PLY with faces, not a point cloud.');
  const indices=new Uint32Array(geometry.index.array);
  const positions=new Float32Array(pos.array);
  triangleCount=indices.length/3;
  if(!triangleCount || triangleCount>250000 || indices.length%3)throw Error('Mesh exceeds the navigation triangle budget or has no triangles.');
  if(!positions.every(Number.isFinite)||!indices.every(i=>i<pos.count))throw Error('Invalid mesh coordinates or indices.');
  geometry.computeBoundingBox();
  const min=geometry.boundingBox.min.toArray(),max=geometry.boundingBox.max.toArray();bounds={min,max};
  // Raw positions, identity node transform. No renderer-specific axis conversion.
  const binary=Buffer.concat([Buffer.from(positions.buffer),Buffer.from(indices.buffer)]);
  const gltf={asset:{version:'2.0',generator:'Namma scene importer'},scene:0,scenes:[{nodes:[0]}],
    nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1,mode:4}]}],
    buffers:[{byteLength:binary.length}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength,target:34962},
      {buffer:0,byteOffset:positions.byteLength,byteLength:indices.byteLength,target:34963}],
    accessors:[{bufferView:0,componentType:5126,count:pos.count,type:'VEC3',min,max},
      {bufferView:1,componentType:5125,count:indices.length,type:'SCALAR'}]};
  let json=Buffer.from(JSON.stringify(gltf));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
  const header=Buffer.alloc(12);header.writeUInt32LE(0x46546c67);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);
  const jh=Buffer.alloc(8);jh.writeUInt32LE(json.length);jh.writeUInt32LE(0x4e4f534a,4);
  const bh=Buffer.alloc(8);bh.writeUInt32LE(binary.length);bh.writeUInt32LE(0x004e4942,4);
  const glb=Buffer.concat([header,jh,json,bh,binary]);
  const parsed=await new GLTFLoader().parseAsync(glb.buffer.slice(glb.byteOffset,glb.byteOffset+glb.byteLength),'');
  let actual=0;parsed.scene.traverse(o=>{if(o.isMesh)actual+=o.geometry.index.count/3;});
  if(actual!==triangleCount)throw Error('GLB roundtrip changed triangle count.');
  fs.writeFileSync(path.join(out,'collision.glb'),glb);
}
const cli=fileURLToPath(new URL('../node_modules/@playcanvas/splat-transform/bin/cli.mjs',import.meta.url));
const result=spawnSync(process.execPath,[cli,path.resolve(model),path.join(out,'preview.spz')],{
  stdio:'inherit',windowsHide:true,timeout:600000});
if(result.error)throw result.error;
if(result.status!==0)throw Error('SPZ conversion failed; the original model is preserved.');
fs.writeFileSync(path.join(out,'asset-report.json'),JSON.stringify({
  triangleCount,bounds,coordinateSpace:'raw-ply-v1',meshTransform:'identity',
  preview:'SPZ quantized derivative; source PLY preserved',walkingValidated:false},null,2));
