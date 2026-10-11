import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { formatDistance, metricScale, visibleHeight, viewDirections, type ProjectionMode, type ViewDirection } from './viewerMath';

export type ViewRequest = { id: number; direction: ViewDirection };
type Props = { projection: ProjectionMode; request: ViewRequest; reset: number; distance: number; scaleRef: RefObject<HTMLDivElement | null>; cubeRef: RefObject<HTMLDivElement | null> };
export function ViewerNavigation({ projection, request, reset, distance, scaleRef, cubeRef }: Props) {
  const { camera, get, set, size, invalidate } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);
  const target = useMemo(() => new THREE.Vector3(), []);
  const cameras = useMemo(() => ({ perspective: new THREE.PerspectiveCamera(45,1,.5,100000), isometric: new THREE.OrthographicCamera(-1,1,1,-1,.5,100000) }), []);
  const initial = useRef(true), distanceRef = useRef(distance);
  distanceRef.current = distance;
  const animation = useRef<{ from: THREE.Vector3; to: THREE.Vector3; time: number; radius: number } | null>(null);
  const matrix = useMemo(() => new THREE.Matrix4(), []);
  useLayoutEffect(() => {
    const current = get().camera;
    if (initial.current) { current.position.set(distanceRef.current*.7,distanceRef.current*.8,distanceRef.current*.8); current.lookAt(target); initial.current=false; }
    if (controls.current) target.copy(controls.current.target);
    const span = visibleHeight(current, target), radius = current.position.distanceTo(target);
    const direction = projection === 'isometric' ? new THREE.Vector3(1,1,1).normalize() : current.position.clone().sub(target).normalize();
    const next = cameras[projection]; Object.assign(next,{manual:true}); next.zoom=1; next.up.set(0,1,0);
    const nextRadius = projection==='perspective' ? span / (2*Math.tan(THREE.MathUtils.degToRad(45)/2)) : radius;
    next.position.copy(target).addScaledVector(direction,nextRadius);
    if (next instanceof THREE.OrthographicCamera) { next.top=span/2; next.bottom=-span/2; next.left=-span/2; next.right=span/2; }
    next.lookAt(target); next.updateProjectionMatrix(); animation.current=null;
    set({ camera: next }); invalidate();
  }, [projection,cameras,get,set,target,invalidate]);
  useLayoutEffect(() => {
    if (camera instanceof THREE.OrthographicCamera) { camera.left=-camera.top*size.width/size.height; camera.right=camera.top*size.width/size.height; }
    else camera.aspect=size.width/size.height;
    camera.updateProjectionMatrix(); invalidate();
  }, [camera,size.width,size.height,invalidate]);
  useEffect(() => {
    const current=get().camera; animation.current=null; target.set(0,0,0);
    const direction=current instanceof THREE.OrthographicCamera ? new THREE.Vector3(1,1,1).normalize() : new THREE.Vector3(.7,.8,.8).normalize();
    const radius=distance*Math.hypot(.7,.8,.8);
    current.up.set(0,1,0); current.position.copy(direction).multiplyScalar(radius);
    if (current instanceof THREE.OrthographicCamera) {
      current.zoom=1; current.top=radius*Math.tan(THREE.MathUtils.degToRad(45)/2); current.bottom=-current.top;
      current.left=-current.top*get().size.width/get().size.height; current.right=-current.left; current.updateProjectionMatrix();
    }
    current.lookAt(target); controls.current?.target.copy(target); controls.current?.update(); invalidate();
  }, [reset,distance,get,target,invalidate]);
  useEffect(() => {
    if (!request.id) return;
    const current=get().camera;
    if (controls.current) target.copy(controls.current.target);
    // A tiny offset at the poles keeps OrbitControls' north-up basis stable.
    const direction=new THREE.Vector3(...viewDirections[request.direction]);
    if (request.direction==='top' || request.direction==='bottom') direction.z=.000001;
    animation.current={from:current.position.clone().sub(target).normalize(),to:direction.normalize(),time:0,radius:current.position.distanceTo(target)};
    invalidate();
  }, [request,get,target,invalidate]);
  useFrame((state,delta) => {
    const current=state.camera, tween=animation.current;
    if (tween) {
      tween.time=Math.min(1,tween.time+delta/.28);
      const q=new THREE.Quaternion().setFromUnitVectors(tween.from,tween.to);
      const direction=tween.from.clone().applyQuaternion(new THREE.Quaternion().slerp(q,1-(1-tween.time)**3));
      current.position.copy(target).addScaledVector(direction,tween.radius); current.up.set(0,1,0); current.lookAt(target);
      controls.current?.update();
      if(tween.time===1) animation.current=null; else invalidate();
    }
    if (scaleRef.current) {
      const scale=metricScale(visibleHeight(current,controls.current?.target || target)/state.size.height);
      if(scale) {
        const element=scaleRef.current, bar=element.querySelector<HTMLElement>('.scale-bar')!, label=element.querySelector<HTMLElement>('.scale-distance')!;
        bar.style.width=`${scale.pixels}px`; element.querySelector<HTMLElement>('.scale-labels')!.style.width=`${scale.pixels}px`; label.textContent=formatDistance(scale.metres);
        element.dataset.metres=String(scale.metres); element.dataset.pixels=String(scale.pixels);
      }
    }
    if (cubeRef.current) {
      matrix.makeRotationFromQuaternion(current.quaternion.clone().invert());
      // Convert Three's upward Y axis to CSS's downward Y axis.
      for (const index of [1,4,6,9]) matrix.elements[index]*=-1;
      cubeRef.current.style.transform=`matrix3d(${matrix.elements.join(',')})`;
    }
  });
  return <OrbitControls ref={controls} makeDefault target={target} minDistance={1} maxDistance={distance*5} minZoom={.02} maxZoom={1000} maxPolarAngle={Math.PI} onStart={()=>{animation.current=null;}}/>;
}
