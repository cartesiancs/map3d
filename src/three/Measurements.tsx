import { useEffect, type MutableRefObject } from 'react';
import { useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { sceneColors } from './palette';
import { formatDistance, measureDistance, pickModelPoint, type ModelPoint } from './viewerMath';

export type Measurement = { id: number; a: ModelPoint; b: ModelPoint };
export type MeasurementInput = { active: boolean; onPick: (point: ModelPoint) => void; onPreview: (point: ModelPoint | null) => void };
type Props = { interaction: MutableRefObject<MeasurementInput>; active: boolean; start: ModelPoint | null; preview: ModelPoint | null; measurements: Measurement[] };
const noRaycast=()=>null;
export function Measurements({ active,start,preview,measurements,interaction }: Props) {
  const { gl,get }=useThree();
  useEffect(()=>{
    const canvas=gl.domElement, raycaster=new THREE.Raycaster(), pointer=new THREE.Vector2();
    raycaster.params.Line.threshold=2;
    let down: {x:number;y:number;id:number} | null=null, frame=0;
    const point=(event:PointerEvent)=>{
      const bounds=canvas.getBoundingClientRect(), {camera,scene}=get();
      pointer.set((event.clientX-bounds.left)/bounds.width*2-1,-(event.clientY-bounds.top)/bounds.height*2+1);
      raycaster.far=camera.far; raycaster.setFromCamera(pointer,camera);
      return pickModelPoint(scene,raycaster);
    };
    const begin=(event:PointerEvent)=>{if(interaction.current.active && event.button===0 && event.isPrimary) down={x:event.clientX,y:event.clientY,id:event.pointerId};else down=null;};
    const end=(event:PointerEvent)=>{
      if(interaction.current.active && down && event.pointerId===down.id && event.button===0 && Math.hypot(event.clientX-down.x,event.clientY-down.y)<5) {
        const hit=point(event); if(hit) interaction.current.onPick(hit);
      }
      down=null;
    };
    const move=(event:PointerEvent)=>{
      if(!interaction.current.active) return;
      if(down && Math.hypot(event.clientX-down.x,event.clientY-down.y)>=5) down=null;
      cancelAnimationFrame(frame);
      frame=requestAnimationFrame(()=>interaction.current.onPreview(point(event)));
    };
    const leave=()=>{cancelAnimationFrame(frame);interaction.current.onPreview(null);};
    const cancel=()=>{down=null;leave();};
    const blockClick=(event:MouseEvent)=>{if(interaction.current.active) event.stopImmediatePropagation();};
    canvas.addEventListener('pointerdown',begin,true); canvas.addEventListener('pointerup',end,true);
    canvas.addEventListener('pointermove',move); canvas.addEventListener('pointerleave',leave); canvas.addEventListener('pointercancel',cancel);
    canvas.addEventListener('click',blockClick,true);
    return()=>{
      cancelAnimationFrame(frame); canvas.removeEventListener('pointerdown',begin,true); canvas.removeEventListener('pointerup',end,true);
      canvas.removeEventListener('pointermove',move); canvas.removeEventListener('pointerleave',leave); canvas.removeEventListener('pointercancel',cancel);
      canvas.removeEventListener('click',blockClick,true);
    };
  },[interaction,gl,get]);
  const segments=[...measurements,...(active && start && preview ? [{id:0,a:start,b:preview}] : [])];
  return <group name="measurements">
    {segments.map(({id,a,b})=><group key={id} userData={{measurement:{a,b}}}>
      <Line points={[a,b]} color={sceneColors.measurementShadow} lineWidth={5} transparent opacity={.6} depthTest={false} depthWrite={false} renderOrder={80} raycast={noRaycast}/>
      <Line points={[a,b]} color={sceneColors.measurement} lineWidth={2} dashed={id===0} dashSize={2} gapSize={1} depthTest={false} depthWrite={false} toneMapped={false} renderOrder={81} raycast={noRaycast}/>
      {[a,b].map((p,index)=><Html key={index} position={p} center zIndexRange={[3,0]} style={{pointerEvents:'none'}}><span className="measure-endpoint"/></Html>)}
      <Html position={a.map((v,i)=>(v+b[i])/2) as ModelPoint} center zIndexRange={[3,0]} style={{pointerEvents:'none'}}><span className="measure-label">{id>0 && <small>{id} · </small>}{formatDistance(measureDistance(a,b).length)}</span></Html>
    </group>)}
    {active && start && !preview && <Html position={start} center zIndexRange={[3,0]} style={{pointerEvents:'none'}}><span className="measure-endpoint"/></Html>}
  </group>;
}
