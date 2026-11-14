import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFeatures, geometryQuery, buildingDimensions } from '../src/data/layers.ts';
import { decodeElevation, terrainHeight, tilePosition } from '../src/data/terrain.ts';
const ring = [{lat:0,lon:0},{lat:0,lon:4},{lat:4,lon:4},{lat:4,lon:0},{lat:0,lon:0}];
test('nodes, paths, transit and dual-purpose buildings are classified without ID collisions', () => {
  const data = normalizeFeatures([
    {type:'way',id:1,tags:{building:'yes',amenity:'school'},geometry:ring},
    {type:'node',id:1,tags:{natural:'tree'},lat:1,lon:1},
    {type:'way',id:2,tags:{highway:'cycleway'},geometry:ring.slice(0,2)},
    {type:'node',id:3,tags:{highway:'bus_stop'},lat:2,lon:2},
    {type:'way',id:4,tags:{waterway:'stream'},geometry:ring.slice(0,2)},
    {type:'way',id:5,tags:{landuse:'residential'},geometry:ring},
    {type:'way',id:6,tags:{leisure:'pitch'},geometry:ring},
  ]);
  assert.deepEqual(data.map(f => f.layer), ['Buildings','Trees & woodland','Walking & cycling','Transit','Waterways','Land use','Recreation & parking','Points of interest']);
  assert.equal(new Set(data.map(f => f.key)).size, data.length);
  assert.equal(data[1].kind,'point'); assert.equal(data[2].kind,'line'); assert.equal(data[0].kind,'area');
  assert.match(geometryQuery([{lat:1,lng:2},{lat:3,lng:4},{lat:5,lng:6}]), /way\["building:part"\]\(poly:"1 2 3 4 5 6"\)/);
});
test('fragmented reversed multipolygon members preserve courtyard holes and suppress duplicate member ways', () => {
  const hole = [{lat:1,lon:1},{lat:1,lon:2},{lat:2,lon:2},{lat:2,lon:1},{lat:1,lon:1}];
  const data = normalizeFeatures([
    {type:'relation',id:10,tags:{type:'multipolygon',building:'yes'},members:[
      {type:'way',ref:11,role:'outer',geometry:ring.slice(0,3)},
      {type:'way',ref:12,role:'outer',geometry:[ring[0],ring[3],ring[2]]},
      {type:'way',ref:13,role:'inner',geometry:hole},
    ]},
    {type:'way',id:11,tags:{building:'yes'},geometry:ring},
  ]);
  assert.equal(data.length,1); assert.equal(data[0].kind,'area'); assert.deepEqual(data[0].holes,[hole]);
  assert.equal(data[0].geometry.length,5);
});
test('building parts replace an enclosing outline and height calculations respect offsets and roofs', () => {
  const part = [{lat:1,lon:1},{lat:1,lon:2},{lat:2,lon:2},{lat:2,lon:1},{lat:1,lon:1}];
  const data = normalizeFeatures([{type:'way',id:1,tags:{building:'yes'},geometry:ring},{type:'way',id:2,tags:{'building:part':'yes'},geometry:part}]);
  assert.equal(data.length,1); assert.equal(data[0].id,2);
  assert.deepEqual(buildingDimensions({height:'20',min_height:'5','roof:shape':'gabled','roof:height':'3'}), {height:20,base:5,roofHeight:3,bodyHeight:12,estimated:false,roofEstimated:false});
  assert.equal(buildingDimensions({height:'100 ft'}).height,30.48);
  assert.equal(buildingDimensions({'building:levels':'4'}).height,12);
  assert.equal(buildingDimensions({height:'-2'}).height,10);
});
test('Terrarium decoding, tile addressing and terrain interpolation preserve metric heights', () => {
  assert.equal(decodeElevation(128,10,128),10.5);
  assert.deepEqual(tilePosition({lat:0,lon:0},2),{x:2,y:2});
  const terrain = {south:0,north:1,west:0,east:1,size:2,elevations:[100,110,120,130],baseline:100};
  assert.equal(terrainHeight(terrain,{lat:.5,lon:.5}),15);
  assert.equal(terrainHeight(terrain,{lat:1,lon:1}),10);
  assert.equal(terrainHeight(null,{lat:0,lon:0}),0);
});


test('progressive requests keep building, transport and landscape selectors separate',()=>{
  const points=[{lat:1,lng:1},{lat:1,lng:2},{lat:2,lng:2}];
  const buildings=geometryQuery(points,'buildings'),transport=geometryQuery(points,'transport');
  assert.match(buildings,/building:part/);assert.doesNotMatch(buildings,/highway|amenity|landuse/);
  assert.match(transport,/highway/);assert.doesNotMatch(transport,/building|landuse/);
  assert.match(transport,/node\["highway"="bus_stop"\]/);assert.doesNotMatch(transport,/node\["highway"\]/);
  assert.match(transport,/way\["highway"\]/);assert.match(transport,/station\|halt\|tram_stop\|subway_entrance/);
  assert.match(geometryQuery(points,'landscape'),/landuse/);
  assert.match(geometryQuery(points,'places'),/amenity/);
});
