import * as THREE from 'three';
import type { RootState } from '@react-three/fiber';

/** A forgiving world-space line hit must not steal a visibly separate surface. */
export function filterSceneHits(hits: THREE.Intersection[], { camera, pointer, size }: Pick<RootState, 'camera' | 'pointer' | 'size'>) {
  if (!hits.some(hit => (hit.object as THREE.Mesh).isMesh)) return hits;
  return hits.filter(hit => {
    if (!(hit.object as THREE.Line).isLine) return true;
    const screen = hit.point.clone().project(camera);
    const dx = (screen.x - pointer.x) * size.width / 2;
    const dy = (screen.y - pointer.y) * size.height / 2;
    return Math.hypot(dx, dy) <= 3;
  });
}
