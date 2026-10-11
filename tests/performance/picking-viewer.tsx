import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {useFrame,useThree} from '@react-three/fiber';
import * as THREE from 'three';
import {Space} from '../../src/three/Space';
import {initialLayers,type Feature} from '../../src/data/layers';
import '../../src/index.css';
const point=(x:number,z:number)=>({lat:-z/111320,lon:x/111320});
const ring=(x:number,z:number,size:number)=>[[x,z],[x+size,z],[x+size,z+size],[x,z+size],[x,z]].map(([x,z])=>point(x,z));
const features:Feature[]=[
  {id:1,key:'building',type:'way',kind:'area',layer:'Buildings',tags:{building:'yes',height:'20'},geometry:ring(-10,-10,20)},
  {id:2,key:'indoor-cafe',type:'node',kind:'point',layer:'Points of interest',tags:{amenity:'cafe',name:'Indoor cafe'},geometry:[point(0,0)]},
  {id:3,key:'outdoor-cafe',type:'node',kind:'point',layer:'Points of interest',tags:{amenity:'cafe',name:'Outdoor cafe'},geometry:[point(-25,0)]},
  {id:4,key:'road',type:'way',kind:'line',layer:'Roads',tags:{highway:'residential'},geometry:[point(-30,10.5),point(30,10.5)]},
  {id:5,key:'tree',type:'node',kind:'point',layer:'Trees & woodland',tags:{natural:'tree'},geometry:[point(25,0)]},
  ...(['Land use','Green spaces','Water','Recreation & parking'] as const).map((layer,index)=>({id:10+index,key:layer,type:'way' as const,kind:'area' as const,layer,tags:{},geometry:ring(-10,-10,20)})),
];
const large=new URLSearchParams(location.search).has('large');
if(large)for(let i=0;i<260;i++)features.push({...features[0],id:100+i,key:`background/${i}`,geometry:ring(250+(i%20)*10,250+Math.floor(i/20)*10,5)});
const points=ring(-60,-60,120).slice(0,4).map(p=>({lat:p.lat,lng:p.lon}));
function Probe(){
  const state=useThree();
  useFrame(()=>{
    const {camera,scene,controls}=state,target=(controls as any)?.target || new THREE.Vector3();
    let buildings=0,buildingObject='';scene.traverseVisible(object=>{if(object.name==='building' || object.userData.mapBatch?.features.some((feature:Feature)=>feature.key==='building') && object.userData.mapBatch.batch.layer==='Buildings'){buildings++;buildingObject=object.uuid;}});
    (window as any).__picking={buildings,buildingObject,ready:!large || scene.getObjectByName('map-features')?.userData.preparing===0,direction:camera.position.clone().sub(target).normalize().toArray(),distance:camera.position.distanceTo(target)};
  });
  (window as any).__screenPoint=(point:number[])=>{
    state.camera.updateMatrixWorld();const p=new THREE.Vector3(...point).project(state.camera),rect=state.gl.domElement.getBoundingClientRect();
    return {x:rect.x+(p.x+1)*rect.width/2,y:rect.y+(1-p.y)*rect.height/2};
  };
  return null;
}
function App(){
  const [selected,onSelect]=useState<Feature|null>(null),[buildings,setBuildings]=useState(true);
  const [currentFeatures,setFeatures]=useState(features);
  const layers=Object.fromEntries(Object.keys(initialLayers).map(layer=>[layer,layer==='Buildings'?buildings:layer!=='Terrain'])) as typeof initialLayers;
  return <><div style={{height:40}}><output>{selected?.key || 'No selection'}</output><button onClick={()=>setBuildings(value=>!value)}>Toggle buildings</button><button onClick={()=>onSelect(features[1])}>Select indoor cafe</button><button onClick={()=>setFeatures(previous=>previous.map(feature=>({...feature,tags:{...feature.tags,height:feature.key==='building'?'21':feature.tags.height}})))}>Stream updated geometry</button><span data-testid="selected-height">{selected?.tags.height}</span></div><div style={{height:'calc(100dvh - 40px)'}}><Space features={currentFeatures} points={points} layers={layers} terrain={null} selected={selected} onSelect={onSelect} reset={0} exportRequest={{id:0,format:'glb'}} onExport={()=>{}} onError={message=>{throw Error(message);}}><Probe/></Space></div></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
