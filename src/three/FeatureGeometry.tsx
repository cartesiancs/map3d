import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { MapPin } from 'lucide-react';
import { buildingDimensions, type Feature, type GeoPoint } from '../data/layers';
import { terrainHeight, type Terrain } from '../data/terrain';
import { buildFeatureGeometries, featureColor, safeColor } from './geometry';
import type { Projection } from './geometry';
export function FeatureGeometry({ feature, project, terrain, selected, onSelect, exportable = true }: { feature: Feature; project: Projection; terrain: Terrain | null; selected: boolean; onSelect: (f: Feature) => void; exportable?: boolean }) {
  const building = feature.layer === 'Buildings';
  const color = selected ? '#dc9b50' : featureColor(feature);
  const center = feature.geometry.reduce((p,v) => ({ lat: p.lat + v.lat / feature.geometry.length, lon: p.lon + v.lon / feature.geometry.length }), { lat: 0, lon: 0 });
  const anchor = project(center), ground = terrainHeight(terrain, center);
  const dimensions = buildingDimensions(feature.tags);
  const geometries = useMemo(() => buildFeatureGeometries(feature, project, terrain), [feature, project, terrain]);
  useEffect(() => () => geometries.forEach(g => g.dispose()), [geometries]);
  const line = useMemo(() => feature.kind === 'line' ? new THREE.Line(geometries[0], new THREE.LineBasicMaterial({ color })) : null, [feature.kind, geometries, color]);
  useEffect(() => () => { if (line) (line.material as THREE.Material).dispose(); }, [line]);
  const pick = (e: { stopPropagation: () => void }) => { e.stopPropagation(); onSelect(feature); };
  if (feature.kind === 'point') {
    const tree = feature.tags.natural === 'tree';
    return <group position={[anchor.x, ground, -anchor.y]}>
      {!tree && <Html center position={[0,7,0]} zIndexRange={[4,0]}><button className="feature-marker" style={{ color }} aria-label={`Inspect ${feature.tags.name || feature.tags.amenity || feature.tags.railway || feature.tags.public_transport || feature.layer}`} title={feature.tags.name || feature.layer} onClick={e => { e.stopPropagation(); onSelect(feature); }}><MapPin size={14}/></button></Html>}
      {tree ? <><mesh position={[0,2,0]} onClick={pick} userData={{ exportToGLB: exportable }}><cylinderGeometry args={[.35,.5,4,6]}/><meshStandardMaterial color="#8f7961"/></mesh><mesh position={[0,6,0]} onClick={pick} userData={{ exportToGLB: exportable }}><icosahedronGeometry args={[3.5,0]}/><meshStandardMaterial color={color}/></mesh></> : <><mesh position={[0,2,0]} onClick={pick} userData={{ exportToGLB: exportable }}><cylinderGeometry args={[.4,.4,4,6]}/><meshStandardMaterial color={color}/></mesh><mesh position={[0,5,0]} onClick={pick} userData={{ exportToGLB: exportable }}><sphereGeometry args={[2.5,8,6]}/><meshStandardMaterial color={color}/></mesh></>}
    </group>;
  }
  if (line) return <primitive name={feature.key} object={line} onClick={pick} userData={{ exportToGLB: exportable }}/>;
  return <group rotation={[-Math.PI / 2,0,0]} position={[0, building ? ground + dimensions.base + .2 : 0, 0]}>
    <mesh name={feature.key} geometry={geometries[0]} onClick={pick} userData={{ exportToGLB: exportable }}><meshStandardMaterial color={color} roughness={.85} polygonOffset={selected} polygonOffsetFactor={-2} side={THREE.DoubleSide}/></mesh>
    {geometries[1] && <mesh name={`${feature.key}/roof`} geometry={geometries[1]} position={[0,0,dimensions.bodyHeight]} onClick={pick} userData={{ exportToGLB: exportable }}><meshStandardMaterial color={selected ? '#dc9b50' : safeColor(feature.tags['roof:colour'], '#9caaa1')} roughness={.9} polygonOffset={selected} polygonOffsetFactor={-2} side={THREE.DoubleSide}/></mesh>}
  </group>;
}
