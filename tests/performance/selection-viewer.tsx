import {useState} from 'react';
import '../../src/index.css';
import {createRoot} from 'react-dom/client';
import {useFrame,useThree} from '@react-three/fiber';
import {Space} from '../../src/three/Space';
import {initialLayers,type Feature} from '../../src/data/layers';
import {collectExportScene} from '../../src/three/exportScene';
import {featureSublayer} from '../../src/data/sublayers';
const origin={lat:40.8,lng:-73.95};
const point=(x:number,y:number)=>({lat:origin.lat+y/111320,lon:origin.lng+x/(111320*Math.cos(origin.lat*Math.PI/180))});
const ring=(x:number,y:number,size:number)=>[[x,y],[x+size,y],[x+size,y+size],[x,y+size],[x,y]].map(([a,b])=>point(a,b));
const features:Feature[]=[
  {id:1,key:'building',type:'way',kind:'area',layer:'Buildings',tags:{building:'yes',height:'42','roof:shape':'gabled','roof:height':'8'},geometry:ring(-22,-22,44)},
  {id:2,key:'use',type:'way',kind:'area',layer:'Land use',tags:{landuse:'commercial'},geometry:ring(-75,-75,150),holes:[ring(40,40,20)]},
  {id:3,key:'neighbor',type:'way',kind:'area',layer:'Buildings',tags:{building:'yes',height:'28'},geometry:ring(42,-32,25)},
  {id:4,key:'road',type:'way',kind:'line',layer:'Roads',tags:{highway:'residential'},geometry:[point(-70,-45),point(-30,-65),point(45,-65)]},
];
if(new URLSearchParams(location.search).has('large')) for(let i=0;i<260;i++) features.push({...features[2],id:100+i,key:`background/${i}`,geometry:ring(250+(i%20)*10,250+Math.floor(i/20)*10,5)});
const points=ring(-110,-110,220).slice(0,4).map(p=>({lat:p.lat,lng:p.lon}));
function Probe(){
  const {scene}=useThree();
  useFrame(()=>{
    const highlight=scene.getObjectByName('selection-highlight');
    (window as any).__selection={background:(scene.background as any)?.getHexString(),key:highlight?.userData.selectionFor || null,halos:highlight?.children.filter(child=>child.name.startsWith('selection-halo')).length || 0,width:(highlight?.getObjectByName('selection-halo-3') as any)?.material.linewidth,ready:features.length<250 || scene.getObjectByName('map-features')?.userData.preparing===0};
  });
  (window as any).__exportNames=()=>{const result=collectExportScene(scene);const names=result.root.children.map(child=>child.name);result.dispose();return names;};
  (window as any).__buildingUUID=()=>{
    let uuid='';scene.traverse(child=>{if(child.name==='building' || child.userData.mapBatch?.features.some((feature:Feature)=>feature.key==='building') && child.userData.mapBatch?.batch.layer==='Buildings') uuid=child.uuid;});return uuid;
  };
  return null;
}
function App(){
  const [selected,onSelect]=useState<Feature|null>(null),[visible,setVisible]=useState(true);
  const [roadVisible,setRoadVisible]=useState(true);
  const [sceneLighting,setSceneLighting]=useState<'day'|'night'>('day');
  return <><div style={{height:48,display:'flex',alignItems:'center',gap:12,padding:'0 20px'}}><button onClick={()=>onSelect(features[0])}>Select building</button><button onClick={()=>onSelect(features[1])}>Select use</button><button onClick={()=>onSelect(features[3])}>Select road</button><button onClick={()=>setRoadVisible(value=>!value)}>Toggle road subtype</button><button onClick={()=>onSelect(null)}>Clear selection</button><button onClick={()=>setVisible(value=>!value)}>Toggle land use</button><button onClick={()=>setSceneLighting(value=>value==='day'?'night':'day')}>Toggle lighting</button></div><div style={{height:'calc(100vh - 48px)'}}><Space sceneLighting={sceneLighting} sublayers={{[featureSublayer(features[3]).id]:roadVisible}} features={features} points={points} layers={{...initialLayers,'Land use':visible}} terrain={null} selected={selected} onSelect={onSelect} reset={0} exportRequest={{id:0,format:'glb'}} onExport={()=>{}} onError={message=>{throw Error(message);}}><Probe/></Space></div></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
