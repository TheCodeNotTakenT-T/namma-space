import fs from 'node:fs';
import path from 'node:path';
import { Quaternion, Vector3 } from 'three';

// Undistorted COLMAP camera poses, in the same world coordinates Brush imports.
export function cameraView(qvec, tvec) {
  const inverse = new Quaternion(qvec[1], qvec[2], qvec[3], qvec[0]).normalize().conjugate();
  return {
    position: new Vector3(...tvec).negate().applyQuaternion(inverse).toArray(),
    forward: new Vector3(0,0,1).applyQuaternion(inverse).toArray(),
    up: new Vector3(0,-1,0).applyQuaternion(inverse).toArray(),
  };
}
export function readColmapViews(directory) {
  const cameras = fs.readFileSync(path.join(directory,'cameras.bin'));
  let offset = 8;
  const count = Number(cameras.readBigUInt64LE(0)), intrinsics = new Map();
  if(count>10000)throw new Error('Too many cameras.');
  for(let i=0;i<count;i++){
    const id=cameras.readUInt32LE(offset), model=cameras.readInt32LE(offset+4);
    const height=Number(cameras.readBigUInt64LE(offset+16));offset+=24;
    if(model!==0&&model!==1)throw new Error('Expected undistorted pinhole cameras.');
    const fy=cameras.readDoubleLE(offset+(model===1?8:0));
    offset+=(model===1?4:3)*8;
    intrinsics.set(id,2*Math.atan(height/(2*fy))*180/Math.PI);
  }
  const images=fs.readFileSync(path.join(directory,'images.bin')), views=[];
  const imageCount=Number(images.readBigUInt64LE(0));offset=8;
  if(imageCount>10000)throw new Error('Too many views.');
  for(let i=0;i<imageCount;i++){
    const values=Array.from({length:7},(_,k)=>images.readDoubleLE(offset+4+k*8));
    const cameraId=images.readUInt32LE(offset+60);offset+=64;
    const end=images.indexOf(0,offset);if(end<0)throw new Error('Truncated image name.');
    const name=images.toString('utf8',offset,end);offset=end+1;
    const points=Number(images.readBigUInt64LE(offset));offset+=8+points*24;
    if(!Number.isSafeInteger(offset)||offset>images.length)throw new Error('Truncated image observations.');
    views.push({name,fov:intrinsics.get(cameraId)||55,...cameraView(values.slice(0,4),values.slice(4))});
  }
  return views.sort((a,b)=>a.name.localeCompare(b.name));
}
