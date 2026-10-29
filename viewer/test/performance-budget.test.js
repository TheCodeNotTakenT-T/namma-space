import test from 'node:test';
import assert from 'node:assert/strict';
import {ResolutionBudget} from '../aholo/performance.js';

test('sustained slow frames reduce resolution within bounds, then recover gradually',()=>{
  const b=new ResolutionBudget();
  for(let i=0;i<1000;i++)b.sample(35);
  assert.equal(b.scale,.5);
  for(let i=0;i<3000;i++)b.sample(12);
  assert.equal(b.scale,1);
});
test('idle, background gaps and brief stalls do not turn into quality reductions',()=>{
  const b=new ResolutionBudget();
  for(let i=0;i<100;i++){b.sample(35,false);b.sample(1000);}
  assert.equal(b.scale,1);
  for(let i=0;i<100;i++)b.sample(16.7);
  assert.equal(b.scale,1);
  b.sample(80);
  assert.equal(b.scale,1);
});

test('sustained very low foreground FPS still triggers adaptation',()=>{
  const b=new ResolutionBudget();
  for(let i=0;i<120;i++)b.sample(300,true);
  assert.equal(b.scale,.5);
});
