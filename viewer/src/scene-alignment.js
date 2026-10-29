import {Quaternion, Vector3} from 'three';

// Three clicks on a bumpy reconstructed floor can tilt the plane by a few degrees, which shows as a swinging
// horizon while turning. When the room's up (from all training cameras) agrees within 15 degrees, use it.
const ROOM_UP_TOLERANCE=Math.cos(15*Math.PI/180);

export function floorAlignment(points, approximateUp=new Vector3(0,1,0), roomUp=null) {
  if(points.length!==3)throw new Error('Select three floor points.');
  const normal=new Vector3().subVectors(points[1],points[0]).cross(new Vector3().subVectors(points[2],points[0]));
  if(normal.length()<0.0001)throw new Error('Choose three floor points spread across an area, not on a straight line.');
  normal.normalize();if(normal.dot(approximateUp)<0)normal.negate();
  if(roomUp){const up=roomUp.clone().normalize();if(normal.dot(up)>ROOM_UP_TOLERANCE)normal.copy(up);}
  return {quaternion:new Quaternion().setFromUnitVectors(normal,new Vector3(0,1,0)),origin:points[0].clone()};
}

export function copySceneTransform(source,target){
  target.position.copy(source.position);target.quaternion.copy(source.quaternion);target.scale.copy(source.scale);target.updateMatrixWorld(true);
}

// Locations are meaningful only for the exact asset and its applied transform.
export function calibratedSceneKey(sourceKey, object) {
  object.updateMatrix();
  return sourceKey + ':' + JSON.stringify(object.matrix.elements.map(value=>Number(value.toFixed(8))));
}
