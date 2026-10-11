import { useEffect, useMemo } from 'react';
import { Line } from '@react-three/drei';
import * as THREE from 'three';
import type { Feature } from '../data/layers';
import type { Terrain } from '../data/terrain';
import type { Projection } from './geometry';
import { buildSelectionGeometry } from './selection';
import { sceneColors } from './palette';

const halo = [
  {width:20,opacity:.08,color:sceneColors.haloOuter},
  {width:11,opacity:.3,color:sceneColors.haloCyan},
  {width:4,opacity:.95,color:sceneColors.haloBlue},
  {width:1.4,opacity:1,color:sceneColors.haloCore},
];
const roadHalo = [
  {width:20,opacity:.08,color:sceneColors.haloOuter},
  {width:12,opacity:.3,color:sceneColors.haloCyan},
  {width:7,opacity:.95,color:sceneColors.haloBlue},
  {width:3.5,opacity:1,color:sceneColors.haloCore},
];
const noRaycast = () => null;

export function SelectionHighlight({feature,project,terrain}:{feature:Feature;project:Projection;terrain:Terrain|null}) {
  const {fills,points}=useMemo(()=>buildSelectionGeometry(feature,project,terrain),[feature,project,terrain]);
  useEffect(()=>()=>fills.forEach(geometry=>geometry.dispose()),[fills]);
  return <group name="selection-highlight" userData={{selectionFor:feature.key}}>
    {fills.map((geometry,index)=><mesh key={index} geometry={geometry} raycast={noRaycast} renderOrder={40}>
      <meshBasicMaterial color={sceneColors.selectionFill} transparent opacity={feature.layer==='Buildings'?.12:.16} depthTest depthWrite={false} polygonOffset polygonOffsetFactor={-3} polygonOffsetUnits={-3} side={THREE.DoubleSide} toneMapped={false}/>
    </mesh>)}
    {points.length>0 && (feature.kind==='line'?roadHalo:halo).map((style,index)=><Line key={index} name={`selection-halo-${index}`} points={points} segments lineWidth={style.width} color={style.color} opacity={style.opacity} transparent depthTest depthWrite={false} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} toneMapped={false} renderOrder={41+index} raycast={noRaycast}/>)}
  </group>;
}
