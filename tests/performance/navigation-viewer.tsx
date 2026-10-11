import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useThree,useFrame} from '@react-three/fiber';
import * as THREE from 'three';
import {Space} from '../../src/three/Space';
import {initialLayers,type Feature} from '../../src/data/layers';
import {collectExportScene} from '../../src/three/exportScene';
import '../../src/index.css';
const ring=[[-10,-10],[10,-10],[10,10],[-10,10],[-10,-10]].map(([x,z])=>({lat:-z/111320,lon:x/111320}));
const features:Feature[]=[{id:1,key:'building',type:'way',kind:'area',layer:'Buildings',tags:{building:'yes',height:'20'},geometry:ring}];
const large=new URLSearchParams(location.search).has('large');
if(large)for(let i=0;i<260;i++)features.push({...features[0],key:`background/${i}`,id:i+2,geometry:ring.map(p=>({lat:p.lat+.003+(i%20)*.0003,lon:p.lon+.003+Math.floor(i/20)*.0003}))});
const points=[[-60,-60],[60,-60],[60,60],[-60,60]].map(([x,z])=>({lat:-z/111320,lng:x/111320}));
function Probe(){
  const state=useThree();
  useFrame(()=>{
    const {camera,controls,scene}=state,target=(controls as any)?.target || new THREE.Vector3();
    (window as any).__navigation={type:camera.type,position:camera.position.toArray(),target:target.toArray(),direction:camera.position.clone().sub(target).normalize().toArray(),zoom:camera.zoom,measurements:scene.getObjectByName('measurements')?.children.map(child=>child.userData.measurement),ready:!large || scene.getObjectByName('map-features')?.userData.preparing===0};
  });
  (window as any).__screenPoint=(point:number[])=>{
    state.camera.updateMatrixWorld();const p=new THREE.Vector3(...point).project(state.camera),rect=state.gl.domElement.getBoundingClientRect();
    return {x:rect.x+(p.x+1)*rect.width/2,y:rect.y+(1-p.y)*rect.height/2};
  };
  (window as any).__names=()=>{const result=collectExportScene(state.scene),names=result.root.children.map(child=>child.name);result.dispose();return names;};
  return null;
}
function App(){const [selected,onSelect]=useState<Feature|null>(null);return <div className="workspace viewer-mode" style={{display:'block'}}><main style={{height:'100dvh'}}><Space features={features} points={points} layers={initialLayers} terrain={null} selected={selected} onSelect={onSelect} reset={0} exportRequest={{id:0,format:'glb'}} onExport={()=>{}} onError={message=>{throw Error(message);}}><Probe/></Space><output style={{position:'absolute',top:0,left:0}}>{selected?'Selected building':'No selection'}</output></main></div>;}
createRoot(document.getElementById('root')!).render(<App/>);
