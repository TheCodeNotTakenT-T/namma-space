import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, Vector3 } from 'three';
import { buildNavigation } from '../src/navigation.js';
import { makeDemo } from '../src/demo.js';

test('a 75 cm aisle remains traversable without allowing passage through walls',async()=>{
  const root=new Group();
  const floor=new Mesh(new BoxGeometry(4,.2,8),new MeshBasicMaterial());
  floor.position.y=-.1;root.add(floor);
  for(const x of [-.875,.875]){
    const wall=new Mesh(new BoxGeometry(1,2.5,8),new MeshBasicMaterial());
    wall.position.set(x,1.25,0);root.add(wall);
  }
  const nav=await buildNavigation(root);
  try{
    assert.ok(nav.route(new Vector3(0,.04,-3),new Vector3(0,.04,3)),'clear aisle should connect');
    const state=nav.nearest(new Vector3(0,.04,0));assert.ok(state);
    for(let i=0;i<40;i++)nav.move(state,new Vector3(.04,0,0));
    assert.ok(state.point.x<.375,'body must not enter wall');
  }finally{nav.dispose();}
});

test('routes around the desk and walking cannot pass through it', async () => {
  const nav = await buildNavigation(makeDemo());
  try {
    const start = new Vector3(0,0.04,2.8), end = new Vector3(0,0.04,-2.8);
    const path = nav.route(start,end);
    assert.ok(path && path.length > 2, 'route must turn around the desk');
    for (let i=1;i<path.length;i++) for(let t=0;t<=1;t+=0.02) {
      const p=path[i-1].clone().lerp(path[i],t);
      assert.ok(!(Math.abs(p.x)<1.2 && Math.abs(p.z)<0.75),'route must avoid desk footprint');
    }
    const state=nav.nearest(start); assert.ok(state);
    for(let i=0;i<150;i++)nav.move(state,new Vector3(0,0,-0.04));
    assert.ok(state.point.z>0.75,'walking must stop at desk');
    assert.equal(nav.nearest(new Vector3(100,0,100)),null);
  } finally { nav.dispose(); }
});

test('rejects a partial path to a disconnected floor',async()=>{
  const root=new Group();
  for(const x of [-4,4]){const m=new Mesh(new BoxGeometry(4,0.2,4),new MeshBasicMaterial());m.position.set(x,-0.1,0);root.add(m);}
  const nav=await buildNavigation(root);
  try {assert.equal(nav.route(new Vector3(-4,0.04,0),new Vector3(4,0.04,0)),null);}
  finally {nav.dispose();}
});
