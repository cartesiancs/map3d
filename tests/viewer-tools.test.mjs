import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {metricScale,visibleHeight,measureDistance,pickModelPoint} from '../src/three/viewerMath.ts';

test('metric legend follows zoom and perspective depth using round distances',()=>{
  const camera=new THREE.PerspectiveCamera(45,2,.5,100000),target=new THREE.Vector3();
  camera.position.set(0,100,100);camera.lookAt(target);
  const height=visibleHeight(camera,target),scale=metricScale(height/800);
  assert.ok(scale.pixels<=120 && scale.pixels>=48);
  assert.ok(Math.abs(scale.pixels*height/800-scale.metres)<1e-10);
  camera.position.multiplyScalar(2);assert.ok(Math.abs(visibleHeight(camera,target)-height*2)<1e-8);
  const ortho=new THREE.OrthographicCamera(-100,100,50,-50,.5,100000);ortho.zoom=2;
  assert.equal(visibleHeight(ortho,target),50);ortho.position.set(0,500,500);
  assert.equal(visibleHeight(ortho,target),50);
  assert.equal(metricScale(0),null);assert.equal(metricScale(Infinity),null);
  assert.equal(metricScale(.001).metres,.1);
});
test('measurements report 3D length, plan length, and signed height difference',()=>{
  assert.deepEqual(measureDistance([0,0,0],[3,12,4]),{length:13,horizontal:5,height:12});
  assert.deepEqual(measureDistance([3,12,4],[0,0,0]),{length:13,horizontal:5,height:-12});
});
test('measurement raycasting uses visible transformed model faces, ignores overlays, and falls back to ground',()=>{
  const scene=new THREE.Scene(),material=new THREE.MeshBasicMaterial();
  const model=new THREE.Mesh(new THREE.BoxGeometry(20,20,20),material);model.position.set(30,10,0);model.userData.exportToGLB=true;scene.add(model);
  const overlay=new THREE.Mesh(new THREE.BoxGeometry(30,30,30),material);overlay.position.set(30,30,0);scene.add(overlay);
  const ray=new THREE.Raycaster(new THREE.Vector3(30,100,0),new THREE.Vector3(0,-1,0));
  assert.deepEqual(pickModelPoint(scene,ray),[30,20,0]);
  model.visible=false;assert.deepEqual(pickModelPoint(scene,ray),[30,0,0]);
  ray.ray.direction.set(0,1,0);assert.equal(pickModelPoint(scene,ray),null);
  scene.traverse(object=>{if(object.geometry)object.geometry.dispose();});material.dispose();
});
test('batched point instances and elevation meshes are valid measurement surfaces',()=>{
  const scene=new THREE.Scene(),geometry=new THREE.BoxGeometry(2,4,2),material=new THREE.MeshBasicMaterial();
  const instances=new THREE.InstancedMesh(geometry,material,1);instances.setMatrixAt(0,new THREE.Matrix4().makeTranslation(10,7,0));instances.userData.mapBatch={};scene.add(instances);
  const ray=new THREE.Raycaster(new THREE.Vector3(10,100,0),new THREE.Vector3(0,-1,0));
  assert.deepEqual(pickModelPoint(scene,ray),[10,9,0]);
  instances.visible=false;
  const terrain=new THREE.Mesh(new THREE.PlaneGeometry(100,100),material);terrain.rotation.x=-Math.PI/2;terrain.position.y=5;terrain.userData.exportToGLB=true;scene.add(terrain);
  assert.ok(Math.abs(pickModelPoint(scene,ray)[1]-5)<1e-8);
  geometry.dispose();terrain.geometry.dispose();material.dispose();instances.dispose();
});
