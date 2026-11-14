import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Space } from '../../src/three/Space';
import { Space as LegacySpace } from './LegacySpace';
import { initialLayers } from '../../src/data/layers';
import { cityFixture } from './fixtures';
import type { Terrain } from '../../src/data/terrain';
const query = new URLSearchParams(location.search);
const area = Number(query.get('area') || 4), density = Number(query.get('density') || 1), legacy=query.get('renderer') === 'legacy';
const started = performance.now();
const benchmark = { ready:false, done:false, error:'', firstFrameMs:0, frames:[] as number[], stats:{} as Record<string,unknown>, featureCount:0, areaKm2:area, density, renderer:legacy?'legacy':'batched' };
(window as any).__bench = benchmark;
function Probe() {
  const {gl,scene,camera,invalidate}=useThree();
  const state=useMemo(()=>({last:0,warm:0,angle:0,start:0}),[]);
  useFrame(()=>{
    if (benchmark.done) return;
    invalidate();
    const group=scene.getObjectByName('map-features');
    const ready=legacy || group?.userData.featureCount===benchmark.featureCount && group?.userData.preparing===0;
    if(!ready || !gl.info.render.calls) return;
    const now=performance.now();
    if(!benchmark.ready){ benchmark.ready=true;benchmark.firstFrameMs=now-started;state.start=now;
      const objects:THREE.Object3D[]=[],geometries=new Set<THREE.BufferGeometry>();let bytes=0;
      scene.traverse(object=>{objects.push(object);const mesh=object as THREE.Mesh;if(mesh.geometry)geometries.add(mesh.geometry);if(object instanceof THREE.InstancedMesh)bytes+=object.instanceMatrix.array.byteLength;});
      for(const geometry of geometries){for(const attribute of Object.values(geometry.attributes))bytes+=attribute.array.byteLength;if(geometry.index)bytes+=geometry.index.array.byteLength;}
      const context=gl.getContext(),ext=context.getExtension('WEBGL_debug_renderer_info');
      benchmark.stats={objects:objects.length,geometries:geometries.size,geometryMB:bytes/1048576,domMarkers:document.querySelectorAll('.feature-marker').length,gpu:ext?context.getParameter(ext.UNMASKED_RENDERER_WEBGL):context.getParameter(context.RENDERER),heapMB:(performance as any).memory?.usedJSHeapSize/1048576};
    }
    if(state.last && state.warm++>5) benchmark.frames.push(now-state.last);
    state.last=now;
    if(benchmark.frames.length>=45 || now-state.start>20000 && benchmark.frames.length>=8){benchmark.done=true; benchmark.stats={...benchmark.stats,drawCalls:gl.info.render.calls,triangles:gl.info.render.triangles,lines:gl.info.render.lines,domMarkers:document.querySelectorAll('.feature-marker').length};return;}
    state.angle+=.012;
    const distance=Math.sqrt(area)*1200;
    camera.position.set(Math.cos(state.angle)*distance,distance*.8,Math.sin(state.angle)*distance);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  });
  return null;
}
function App(){
  const fixture=useMemo(()=>cityFixture(area,density),[]);benchmark.featureCount=fixture.features.length;
  const [selected,onSelect]=useState(null);
  const terrain:Terrain|null=useMemo(()=>query.has('terrain')?{south:Math.min(...fixture.points.map(p=>p.lat)),north:Math.max(...fixture.points.map(p=>p.lat)),west:Math.min(...fixture.points.map(p=>p.lng)),east:Math.max(...fixture.points.map(p=>p.lng)),size:49,baseline:0,elevations:Array.from({length:49*49},(_,i)=>Math.sin((i%49)/8)*10+Math.cos(Math.floor(i/49)/10)*10+20)}:null,[fixture.points]);
  const Viewer=legacy?LegacySpace:Space;
  return <Viewer features={fixture.features} points={fixture.points} layers={{...initialLayers,'Points of interest':true,'Land use':true,Terrain:!!terrain}} terrain={terrain} selected={selected} onSelect={onSelect} reset={0} exportRequest={{id:0,format:'glb'}} onExport={()=>{}} onError={message=>benchmark.error=message}><Probe/></Viewer>;
}
createRoot(document.getElementById('root')!).render(<App/>);
