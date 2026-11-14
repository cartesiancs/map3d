import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as THREE from 'three';
import {filterSceneHits, featureForHit} from '../src/three/picking.ts';

test('line picking rejects hidden roads and uses a pixel tolerance even without a mesh hit',()=>{
  const camera=new THREE.OrthographicCamera(-50,50,50,-50,.1,1000);
  camera.position.set(0,100,0);camera.up.set(0,0,-1);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const context={camera,pointer:new THREE.Vector2(),size:{width:1000,height:1000}};
  const roof={object:new THREE.Mesh(),distance:80,point:new THREE.Vector3(0,20,0)};
  const hiddenRoad={object:new THREE.Line(),distance:100,point:new THREE.Vector3(0,0,0)};
  const farRoad={...hiddenRoad,point:new THREE.Vector3(1,0,0)};
  assert.deepEqual(filterSceneHits([roof,hiddenRoad],context),[roof]);
  assert.deepEqual(filterSceneHits([farRoad],context),[]);
  assert.deepEqual(filterSceneHits([hiddenRoad],context),[hiddenRoad]);
});
test('picking resolves the current triangle, segment and instance to its original feature',()=>{
  const features=[{key:'first'},{key:'second'}],object=new THREE.Mesh();
  const ranges=[{start:0,end:6,feature:0},{start:6,end:12,feature:1}];
  object.userData.mapBatch={batch:{kind:'mesh',ranges},features};
  assert.equal(featureForHit({object,faceIndex:2}),features[1]);
  object.userData.mapBatch={batch:{kind:'line',ranges},features};
  assert.equal(featureForHit({object,index:0}),features[0]);
  object.userData.mapBatch={batch:{kind:'instances',indices:[1,0]},features};
  assert.equal(featureForHit({object,instanceId:0}),features[1]);
  delete object.userData.mapBatch;object.userData.mapFeature=features[0];
  assert.equal(featureForHit({object}),features[0]);
});
