import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { buildBatches, featureAt, transferBuffers } from '../src/three/batches.ts';
import { collectExportScene } from '../src/three/exportScene.ts';

const point = (x, y) => ({ lon: x / 111320, lat: y / 111320 });
const building = {
  key: 'way/1', layer: 'Buildings', kind: 'area',
  geometry: [[0,0],[20,0],[20,20],[0,20],[0,0]].map(([x,y]) => point(x,y)),
  tags: { building:'yes', height:'20', min_height:'5', 'roof:shape':'gabled', 'roof:height':'3' },
};

test('batched building picking and exports retain feature names, roof heights and world orientation', () => {
  const features = [building, { ...building, key:'way/2', geometry: building.geometry.map(p => ({ ...p, lon:p.lon + 40/111320 })) }];
  const batches = buildBatches(features, { lat:0, lng:0 }, null);
  assert.equal(batches.length, 1);
  const batch = batches[0];
  assert.deepEqual(batch.ranges.map(range => range.name), ['way/1','way/1/roof','way/2','way/2/roof']);
  for (const range of batch.ranges) {
    assert.equal(featureAt(batch.ranges, range.start), range.feature);
    assert.equal(featureAt(batch.ranges, range.end - 1), range.feature);
  }
  assert.equal(featureAt(batch.ranges, batch.positions.length / 3), undefined);
  assert.ok(Math.abs(batch.bounds[1] - 5.2) < .001);
  assert.ok(Math.abs(batch.bounds[4] - 20.2) < .001);
  assert.ok(Math.abs(batch.bounds[2] + 20) < .001);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(batch.positions, 3));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.userData.mapBatch = { batch, features };
  const scene = new THREE.Scene(); scene.add(mesh);
  const exported = collectExportScene(scene);
  assert.deepEqual(exported.root.children.map(child => child.name), batch.ranges.map(range => range.name));
  assert.equal(exported.root.children.reduce((count, child) => count + child.geometry.getAttribute('position').count, 0), batch.positions.length / 3);
  exported.dispose(); geometry.dispose(); mesh.material.dispose();
});

test('line batching preserves disconnected ways and point instances keep feature identities', () => {
  const features = [
    {key:'way/road1', layer:'Roads', kind:'line', tags:{highway:'residential'}, geometry:[point(0,0),point(10,0),point(20,0)]},
    {key:'way/road2', layer:'Roads', kind:'line', tags:{highway:'residential'}, geometry:[point(100,0),point(110,0)]},
    {key:'node/tree1', layer:'Trees & woodland', kind:'point', tags:{natural:'tree'}, geometry:[point(10,20)]},
    {key:'node/tree2', layer:'Trees & woodland', kind:'point', tags:{natural:'tree'}, geometry:[point(30,40)]},
  ];
  const batches = buildBatches(features, {lat:0,lng:0}, null);
  const line = batches.find(batch => batch.kind === 'line');
  assert.equal(line.positions.length, 18);
  assert.deepEqual(line.ranges.map(range => range.end - range.start), [4,2]);
  const crown = batches.find(batch => batch.form === 'crown');
  assert.deepEqual([...crown.indices], [2,3]);
  assert.deepEqual([...crown.matrices.slice(12,15)], [10,6,-20]);
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(3.5,0), new THREE.MeshStandardMaterial(), 2);
  mesh.instanceMatrix = new THREE.InstancedBufferAttribute(crown.matrices,16);
  mesh.userData.mapBatch = {batch:crown, features};
  const scene = new THREE.Scene(); scene.add(mesh);
  const exported = collectExportScene(scene);
  assert.deepEqual(exported.root.children.map(child => child.name), ['node/tree1/crown','node/tree2/crown']);
  assert.deepEqual(exported.root.children[1].position.toArray(), [30,6,-40]);
  assert.ok(transferBuffers(batches).every(buffer => buffer instanceof ArrayBuffer));
  exported.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose();
});
