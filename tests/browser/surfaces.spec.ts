import { test, expect } from '@playwright/test';

test('overlapping ground surfaces stay visually ordered while buildings occlude them', async ({ page }) => {
  await page.goto('/');
  const results = await page.evaluate(async () => {
    // Exercise the actual shared geometry and depth policy with a real WebGL renderer.
    const module = (path: string) => import(/* @vite-ignore */ path);
    const THREE = await module('/node_modules/three/build/three.module.js');
    const { buildBatches } = await module('/src/three/batches.ts');
    const { surfaceMaterial, surfaceOrder } = await module('/src/three/surfaces.ts');
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(256,256);
    const target = new THREE.WebGLRenderTarget(256,256);
    renderer.setRenderTarget(target);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#ffffff');
    const camera = new THREE.PerspectiveCamera(45,1,1,1000);
    const grid = new THREE.Mesh(new THREE.PlaneGeometry(200,200),new THREE.MeshBasicMaterial({color:'#aaaaaa',transparent:true,opacity:.5,depthWrite:false,side:THREE.DoubleSide}));
    grid.rotation.x=-Math.PI/2; grid.position.y=-.1; scene.add(grid);
    const colors: Record<string,string> = {'Land use':'#ff0000','Green spaces':'#00ff00',Water:'#0000ff'};
    const features = ['Water','Land use','Green spaces'].map((layer,index) => ({
      key:`surface/${index}`, layer, kind:'area', tags:{},
      geometry:[[-50,-50],[50,-50],[50,50],[-50,50],[-50,-50]].map(([x,y]) => ({lon:x/111320,lat:y/111320})),
    }));
    const meshes = buildBatches(features,{lat:0,lng:0},null).map((batch: any) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.BufferAttribute(batch.positions,3));
      const mesh = new THREE.Mesh(geometry,new THREE.MeshBasicMaterial({color:colors[batch.layer],side:THREE.DoubleSide,...surfaceMaterial()}));
      mesh.renderOrder = surfaceOrder(batch.layer); scene.add(mesh); return mesh;
    });
    const building = new THREE.Mesh(new THREE.BoxGeometry(12,12,12),new THREE.MeshBasicMaterial({color:'#ffff00'}));
    building.position.set(0,6,0); building.renderOrder=10; scene.add(building);
    const pixel = (world: any) => {
      const p = world.clone().project(camera);
      const buffer = new Uint8Array(4);
      renderer.readRenderTargetPixels(target,Math.floor((p.x+1)*128),Math.floor((p.y+1)*128),1,1,buffer);
      return [...buffer].slice(0,3);
    };
    const samples = [];
    for (const position of [[0,180,100],[120,160,80],[-100,140,-120]]) {
      camera.position.set(...position); camera.lookAt(0,0,0); camera.updateMatrixWorld();
      // Reversing insertion order must not change which surface is visible.
      for (const mesh of [...meshes].reverse()) { scene.remove(mesh); scene.add(mesh); }
      renderer.render(scene,camera);
      samples.push({ surface:pixel(new THREE.Vector3(-20,.35,0)), building:pixel(new THREE.Vector3(0,12,0)) });
    }
    scene.traverse((object: any) => { object.geometry?.dispose(); object.material?.dispose(); });
    target.dispose(); renderer.dispose();
    return samples;
  });
  for (const sample of results) {
    expect(sample.surface).toEqual([0,0,255]);
    expect(sample.building).toEqual([255,255,0]);
  }
});
