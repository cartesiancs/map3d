import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as THREE from 'three';
import {buildSelectionGeometry} from '../src/three/selection.ts';
import {projection} from '../src/three/batches.ts';

const ring=(min,max)=>[[min,min],[max,min],[max,max],[min,max],[min,min]].map(([x,y])=>({lon:x/111320,lat:y/111320}));
const feature={key:'area',kind:'area',layer:'Land use',tags:{landuse:'commercial'},geometry:ring(0,40),holes:[ring(10,20)]};
test('road selection follows the open route without adding a closing segment or fill',()=>{
  const road={...feature,kind:'line',layer:'Roads',geometry:[{lat:0,lon:0},{lat:0,lon:20/111320},{lat:20/111320,lon:20/111320}],holes:[]};
  const selection=buildSelectionGeometry(road,projection({lat:0,lng:0}),null);
  assert.deepEqual(selection.fills,[]);
  assert.equal(selection.points.length,4);
  assert.deepEqual(selection.points[0].toArray(),[0,selection.points[0].y,0]);
  assert.ok(Math.abs(selection.points[3].z+20)<.001);
  assert.ok(selection.points.every(point=>Math.abs(point.y-.8)<.001));
});
test('surface selection follows outer and courtyard boundaries without triangulation lines',()=>{
  const selection=buildSelectionGeometry(feature,projection({lat:0,lng:0}),null);
  assert.equal(selection.points.length,16);
  assert.ok(selection.points.every(point=>Math.abs(point.y-.2)<1e-6));
  assert.ok(selection.points.some(point=>point.x===10 && point.z===-10));
  selection.fills.forEach(geometry=>geometry.dispose());
});
test('building halo follows tagged foundation and roof heights, while terrain boundaries are draped',()=>{
  const building={...feature,layer:'Buildings',tags:{building:'yes',height:'20',min_height:'5','roof:shape':'gabled','roof:height':'3'}};
  const selected=buildSelectionGeometry(building,projection({lat:0,lng:0}),null);
  assert.equal(selected.fills.length,2);
  assert.ok(Math.abs(Math.min(...selected.points.map(p=>p.y))-5.2)<.001);
  assert.ok(Math.abs(Math.max(...selected.points.map(p=>p.y))-20.2)<.001);
  selected.fills.forEach(geometry=>geometry.dispose());
  const terrain={south:0,north:.001,west:0,east:.001,size:2,elevations:[0,10,20,30],baseline:0};
  const area=buildSelectionGeometry({...feature,geometry:ring(0,100),holes:[]},projection({lat:0,lng:0}),terrain);
  assert.ok(area.points.length>8);
  assert.ok(new Set(area.points.map(point=>point.y.toFixed(2))).size>2);
  area.fills.forEach(geometry=>geometry.dispose());
});
