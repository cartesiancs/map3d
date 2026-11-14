import * as THREE from 'three';
import { terrainHeight, type Terrain } from '../data/terrain.ts';
import type { Projection } from './geometry.ts';

/** The same sampled ground surface is used by the viewer and native model exports. */
export function buildTerrainGeometry(terrain:Terrain,project:Projection) {
  const {size,north,south,east,west}=terrain;
  const positions:number[]=[], indices:number[]=[];
  for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
    const point={lat:north+(south-north)*y/(size-1),lon:west+(east-west)*x/(size-1)}, v=project(point);
    positions.push(v.x,terrainHeight(terrain,point),-v.y);
    if(x<size-1 && y<size-1) {const i=y*size+x;indices.push(i,i+size,i+1,i+1,i+size,i+size+1);}
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setIndex(indices);geometry.computeVertexNormals();return geometry;
}
