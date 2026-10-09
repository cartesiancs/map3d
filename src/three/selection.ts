import * as THREE from 'three';
import { buildingDimensions, type Feature } from '../data/layers.ts';
import { terrainHeight, type Terrain } from '../data/terrain.ts';
import { buildFeatureGeometries, type Projection } from './geometry.ts';

/** Selection geometry uses world coordinates and never becomes part of a download. */
export function buildSelectionGeometry(feature: Feature, project: Projection, terrain: Terrain | null) {
  const fills = buildFeatureGeometries(feature, project, terrain);
  const points: THREE.Vector3[] = [];
  if (feature.kind === 'line') {
    // Preserve the open, terrain-draped route; never join the last point to the first.
    const positions = fills[0]?.getAttribute('position');
    if (positions) for (let i=0;i<positions.count-1;i++) {
      points.push(new THREE.Vector3().fromBufferAttribute(positions,i),new THREE.Vector3().fromBufferAttribute(positions,i+1));
    }
    fills.forEach(geometry=>geometry.dispose());
    return {fills:[],points};
  }
  const building = feature.layer === 'Buildings';
  const dimensions = buildingDimensions(feature.tags);
  const center = feature.geometry.reduce((p,v) => ({lat:p.lat+v.lat/feature.geometry.length,lon:p.lon+v.lon/feature.geometry.length}), {lat:0,lon:0});
  fills.forEach((geometry, index) => {
    if (building && index) geometry.translate(0,0,dimensions.bodyHeight);
    geometry.rotateX(-Math.PI/2);
    if (building) {
      geometry.translate(0,terrainHeight(terrain,center)+dimensions.base+.2,0);
      const edges = new THREE.EdgesGeometry(geometry,20), positions = edges.getAttribute('position');
      for (let i=0;i<positions.count;i++) points.push(new THREE.Vector3().fromBufferAttribute(positions,i));
      edges.dispose();
    }
  });
  if (!building) {
    // Follow only real boundaries, including holes, rather than triangulation edges.
    for (const ring of [feature.geometry,...(feature.holes || [])]) {
      for (let i=0;i<ring.length;i++) {
        const a=ring[i], b=ring[(i+1)%ring.length];
        const segments=terrain ? Math.min(100,Math.max(1,Math.ceil(project(a).distanceTo(project(b))/40))) : 1;
        const at=(t:number) => {
          const p={lat:a.lat+(b.lat-a.lat)*t,lon:a.lon+(b.lon-a.lon)*t}, v=project(p);
          return new THREE.Vector3(v.x,terrainHeight(terrain,p)+(feature.layer==='Land use'?.12:.35)+.08,-v.y);
        };
        if (project(a).distanceToSquared(project(b)) < 1e-10) continue;
        for (let j=0;j<segments;j++) points.push(at(j/segments),at((j+1)/segments));
      }
    }
  }
  return {fills,points};
}
