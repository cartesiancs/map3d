import assert from 'node:assert/strict';
import {test} from 'node:test';
import rhino3dm from 'rhino3dm';
import {exportRhino} from '../src/three/exportRhino.ts';
import {initialLayers,vectorLayers} from '../src/data/layers.ts';
const rhino=await rhino3dm();
const point=(x,y)=>({lat:y/111320,lon:x/111320});
const ring=(x=0,y=0,size=20)=>[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]].map(([x,y])=>point(x,y));
const feature=(id,layer,kind,tags)=>({type:kind==='point'?'node':'way',id,key:`${kind==='point'?'node':'way'}/${id}`,layer,kind,tags,geometry:kind==='point'?[point(10,10)]:kind==='line'?[point(0,0),point(10,20),point(40,20)]:ring()});
const input=(features,overrides={})=>({features,points:[{lat:0,lng:0},{lat:0,lng:.001},{lat:.001,lng:.001},{lat:.001,lng:0}],location:'Test location',layers:{...initialLayers},sublayers:{},terrain:null,layerStatus:{Buildings:'ready',Roads:'error'},incomplete:true,...overrides});
const read=(data)=>{const result=exportRhino(rhino,data);assert.ok(result.bytes.length>1000);const file=rhino.File3dm.fromByteArray(result.bytes);assert.ok(file);return {file,result};};
const objects=(file)=>Array.from({length:file.objects().count},(_,i)=>file.objects().get(i));
const layers=(file)=>Array.from({length:file.layers().count},(_,i)=>file.layers().get(i));
const strings=(file)=>Object.fromEntries(Array.from({length:file.strings().count},(_,i)=>file.strings().get(i)));
const dispose=(file)=>{file.destroy();file.delete();};

test('Rhino round trip retains every geometry layer, nested types, hidden state, groups, source tags and color materials',()=>{
  const features=[feature(1,'Buildings','area',{building:'house',name:'Named house',height:'20','roof:shape':'gabled','roof:height':'3','building:colour':'#f08090'}),
    feature(2,'Roads','line',{highway:'residential'}),feature(3,'Roads','line',{highway:'service'}),
    feature(4,'Walking & cycling','line',{highway:'cycleway'}),feature(5,'Transit','line',{railway:'tram'}),
    feature(6,'Trees & woodland','point',{natural:'tree'}),feature(7,'Water','area',{natural:'water',water:'pond'}),
    feature(8,'Waterways','line',{waterway:'stream'}),feature(9,'Green spaces','area',{leisure:'park'}),
    feature(10,'Land use','area',{landuse:'commercial'}),feature(11,'Points of interest','point',{amenity:'cafe',name:'Corner café'}),feature(12,'Recreation & parking','area',{amenity:'parking'})];
  const {file,result}=read(input(features,{sublayers:{'Roads|highway:service':false}}));
  try {
    assert.equal(result.featureCount,12);assert.equal(result.objectCount,15);assert.equal(file.groups().count,12);
    const layerList=layers(file),root=layerList.find(l=>l.name==='Map3d');
    assert.deepEqual(layerList.filter(l=>l.parentLayerId===root.id).map(l=>l.name),vectorLayers);
    const roads=layerList.find(l=>l.name==='Roads'),roadChildren=layerList.filter(l=>l.parentLayerId===roads.id);
    assert.deepEqual(roadChildren.map(l=>l.name),['Residential streets','Service roads']);
    assert.equal(roadChildren[1].visible,false);assert.notDeepEqual(roadChildren[0].color,roadChildren[1].color);
    assert.equal(layerList.find(l=>l.name==='Points of interest').visible,false);
    assert.notDeepEqual(roads.color,layerList.find(l=>l.name==='Water').color);
    for(const object of objects(file)) {
      assert.ok(object.geometry().isValid,object.attributes().name);assert.equal(object.attributes().groupCount,1);
      const attr=object.attributes();assert.ok(attr.name.includes(attr.getUserString('OSM ID')));assert.ok(attr.getUserString('OSM:building') || attr.userStringCount>5);
      assert.equal(attr.colorSource.value,attr.name.includes('Roof')||attr.name.includes('Trunk')||attr.name.includes('Building')?rhino.ObjectColorSource.ColorFromObject.value:rhino.ObjectColorSource.ColorFromLayer.value);
      assert.ok(file.layers().get(attr.layerIndex).renderMaterialIndex>=0);
    }
    const house=objects(file).filter(o=>o.attributes().getUserString('OSM ID')==='way/1');
    assert.equal(house.length,2);assert.deepEqual(house[0].attributes().getGroupList(),house[1].attributes().getGroupList());
    assert.deepEqual(house[0].attributes().objectColor,{r:240,g:128,b:144,a:255});
    assert.deepEqual(file.materials().get(house[0].attributes().materialIndex).diffuseColor,{r:240,g:128,b:144,a:255});
    assert.match(strings(file)['map3d:source'],/OpenStreetMap contributors.*ODbL/);
    assert.match(strings(file)['map3d:accuracy'],/at your own risk/);
    assert.equal(JSON.parse(strings(file)['map3d:snapshot']).incomplete,true);
    assert.equal(JSON.parse(strings(file)['map3d:layerStatus']).Roads,'error');
  } finally {dispose(file);}
});

test('Rhino meshes preserve courtyard voids, roof heights and Z up, while road curves remain continuous in metres',()=>{
  const building=feature(1,'Buildings','area',{building:'yes',height:'20',min_height:'5'});building.holes=[ring(5,5,5)];
  const roof=feature(2,'Buildings','area',{building:'yes',height:'30','roof:shape':'gabled','roof:height':'3'});roof.geometry=ring(40,0);
  const road=feature(3,'Roads','line',{highway:'residential'});
  const {file}=read(input([building,roof,road]));
  try {
    assert.equal(file.settings().modelUnitSystem.value,rhino.UnitSystem.Meters.value);
    const mesh=objects(file).find(o=>o.attributes().getUserString('OSM ID')==='way/1').geometry();
    const vertices=mesh.vertices().toPoint3dArray();
    assert.ok(Math.abs(Math.min(...vertices.map(p=>p[2]))-5.2)<.001);
    assert.ok(Math.abs(Math.max(...vertices.map(p=>p[2]))-20.2)<.001);
    let topArea=0;
    for(let i=0;i<mesh.faces().count;i++) {
      const [a,b,c]=mesh.faces().get(i).slice(0,3).map(j=>vertices[j]);
      if([a,b,c].every(p=>Math.abs(p[2]-20.2)<.001)) topArea+=Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2;
    }
    assert.ok(Math.abs(topArea-375)<.02,`Courtyard hole must stay open: ${topArea}`);
    const peak=objects(file).find(o=>o.attributes().getUserString('Part')==='Roof').geometry().vertices().toPoint3dArray();
    assert.ok(Math.abs(Math.max(...peak.map(p=>p[2]))-30.2)<.001);
    const curve=objects(file).find(o=>o.attributes().getUserString('OSM ID')==='way/3').geometry();
    assert.equal(curve.pointCount,3);assert.ok(Math.abs(curve.point(0)[2]-.8)<.001);
    assert.ok(Math.abs(curve.point(1)[1]-curve.point(0)[1]-20)<.001);
    assert.ok(Math.abs(curve.point(2)[0]-curve.point(1)[0]-30)<.001);
    const anchor=file.settings().earthAnchorPoint;assert.equal(anchor.modelNorth[1],1);assert.equal(anchor.modelEast[0],1);
    assert.ok(Math.abs(anchor.earthBasepointLatitude-.0005)<1e-8);
  } finally {dispose(file);}
});

test('loaded terrain exports with relative elevation and anchors all features to the same sampled ground',()=>{
  const terrain={south:0,north:.001,west:0,east:.001,size:2,elevations:[110,120,100,110],baseline:100};
  const layers={...initialLayers,Terrain:true};
  const {file}=read(input([feature(1,'Buildings','area',{building:'yes',height:'10'})],{terrain,layers}));
  try {
    const terrainObject=objects(file).find(o=>o.attributes().name==='Terrain · sampled elevation');
    assert.ok(terrainObject);assert.equal(terrainObject.geometry().faces().count,2);
    const heights=terrainObject.geometry().vertices().toPoint3dArray().map(p=>p[2]);assert.ok(Math.abs(Math.min(...heights))<.0001);assert.ok(Math.abs(Math.max(...heights)-20)<.0001);
    const mesh=objects(file).find(o=>o.attributes().getUserString('OSM ID')==='way/1').geometry();
    assert.ok(Math.min(...mesh.vertices().toPoint3dArray().map(p=>p[2]))>.2);
    assert.equal(file.settings().earthAnchorPoint.earthBasepointElevation,100);
    assert.match(strings(file)['map3d:terrainAttribution'],/attribution/);
  } finally {dispose(file);}
});

test('duplicate readable subtype labels get unique layers without losing source identity',()=>{
  const a=feature(1,'Points of interest','point',{amenity:'foo_bar'}),b=feature(2,'Points of interest','point',{amenity:'foo;bar'});
  const {file}=read(input([a,b]));
  try {const names=layers(file).filter(l=>l.name.startsWith('Foo bar')).map(l=>l.name);assert.equal(names.length,2);assert.equal(new Set(names).size,2);} finally {dispose(file);}
  assert.throws(()=>exportRhino(rhino,input([])),/No loaded geometry/);
});

test('disconnected pieces of one OSM relation share a group and have distinct object names',()=>{
  const lake=feature(25,'Water','area',{natural:'water',water:'lake',name:'Island lake'});lake.type='relation';lake.key='relation/25';
  const island={...lake,key:'relation/25/1',geometry:ring(40,0)};
  const {file}=read(input([lake,island]));
  try {assert.equal(file.groups().count,1);assert.equal(file.objects().count,2);const list=objects(file);assert.deepEqual(list[0].attributes().getGroupList(),list[1].attributes().getGroupList());assert.notEqual(list[0].attributes().name,list[1].attributes().name);} finally {dispose(file);}
});
