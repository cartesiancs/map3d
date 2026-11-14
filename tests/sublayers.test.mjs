import assert from 'node:assert/strict';
import {test} from 'node:test';
import {featureSublayer,collectSublayers,isFeatureVisible} from '../src/data/sublayers.ts';
import {initialLayers,normalizeFeatures,vectorLayers} from '../src/data/layers.ts';
import {buildBatches} from '../src/three/batches.ts';
const geometry=[{lat:0,lon:0},{lat:.0001,lon:.0001}];
const feature=(layer,tags,key='test')=>({layer,tags,key,geometry,kind:'line'});
test('loaded sublayers expose precise known and unknown tagged types without collisions',()=>{
  const features=[
    feature('Roads',{highway:'residential'},'road1'),feature('Roads',{highway:'residential'},'road2'),
    feature('Roads',{highway:'service'},'road3'),feature('Roads',{highway:'primary_link'},'road4'),
    feature('Points of interest',{amenity:'cafe'},'poi1'),feature('Points of interest',{shop:'bakery'},'poi2'),
    feature('Points of interest',{tourism:'bakery'},'poi3'),feature('Points of interest',{amenity:'unusual_local_use'},'poi4'),
  ];
  const groups=collectSublayers(features);
  assert.equal(groups.Roads.length,3);
  assert.equal(groups.Roads.find(type=>type.label==='Residential streets').count,2);
  assert.equal(groups['Points of interest'].length,4);
  assert.ok(groups['Points of interest'].some(type=>type.label==='Cafés'));
  assert.ok(groups['Points of interest'].some(type=>type.label==='Shops · Bakery'));
  assert.ok(groups['Points of interest'].some(type=>type.label==='Tourism · Bakery'));
  assert.equal(new Set(features.map(feature=>featureSublayer(feature).id)).size,7);
  assert.deepEqual(groups.Buildings,[]);
});
test('every vector layer has a subtype and child filters obey parent visibility',()=>{
  for(const layer of vectorLayers) assert.ok(featureSublayer(feature(layer,{})).id.startsWith(`${layer}|`));
  const road=feature('Roads',{highway:'residential'}),other=feature('Roads',{highway:'service'});
  const hidden={[featureSublayer(road).id]:false};
  assert.equal(isFeatureVisible(road,initialLayers,hidden),false);
  assert.equal(isFeatureVisible(other,initialLayers,hidden),true);
  assert.equal(isFeatureVisible(other,{...initialLayers,Roads:false},{}),false);
  assert.equal(isFeatureVisible(road,initialLayers,{}),true);
});
test('equivalent reservoir tags share one toggle and explicitly disabled building parts stay unspecified',()=>{
  const water=[feature('Water',{natural:'water',water:'reservoir'}),feature('Water',{landuse:'reservoir'})];
  assert.equal(collectSublayers(water).Water.length,1);
  assert.equal(collectSublayers(water).Water[0].count,2);
  assert.equal(featureSublayer(feature('Buildings',{building:'yes','building:part':'no'})).label,'Unspecified buildings');
});
test('road and instanced POI batches separate subtypes while retaining original feature indices',()=>{
  const features=[feature('Roads',{highway:'residential'},'road1'),feature('Roads',{highway:'service'},'road2'),
    {...feature('Points of interest',{amenity:'cafe'},'poi1'),kind:'point',geometry:[geometry[0]]},
    {...feature('Points of interest',{amenity:'restaurant'},'poi2'),kind:'point',geometry:[geometry[0]]}];
  const batches=buildBatches(features,{lat:0,lng:0},null);
  const roads=batches.filter(batch=>batch.layer==='Roads');
  assert.equal(roads.length,2);
  assert.notEqual(roads[0].sublayer,roads[1].sublayer);
  assert.deepEqual(roads.flatMap(batch=>batch.ranges.map(range=>range.feature)).sort(),[0,1]);
  const cafes=batches.filter(batch=>batch.sublayer===featureSublayer(features[2]).id);
  assert.equal(cafes.length,2);
  assert.ok(cafes.every(batch=>batch.indices[0]===2));
});
test('amenity buildings keep independent building and POI filters',()=>{
  const features=normalizeFeatures([{type:'way',id:1,tags:{building:'school',amenity:'school'},geometry:[geometry[0],{lat:0,lon:.0001},geometry[1],{lat:.0001,lon:0},geometry[0]]}]);
  assert.equal(features.length,2);
  const building=features.find(feature=>feature.layer==='Buildings'),poi=features.find(feature=>feature.layer==='Points of interest');
  const layers={...initialLayers,'Points of interest':true};
  const hidden={[featureSublayer(poi).id]:false};
  assert.equal(isFeatureVisible(building,layers,hidden),true);
  assert.equal(isFeatureVisible(poi,layers,hidden),false);
});
