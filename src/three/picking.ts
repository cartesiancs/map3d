import * as THREE from 'three';
import type { RootState } from '@react-three/fiber';
import { featureAt } from './batches.ts';
import type { Feature } from '../data/layers.ts';

/** A forgiving world-space line hit must not steal a visibly separate surface. */
export function filterSceneHits(hits: THREE.Intersection[], { camera, pointer, size }: Pick<RootState, 'camera' | 'pointer' | 'size'>) {
  const nearestSolid = hits.find(hit => (hit.object as THREE.Mesh).isMesh);
  return hits.filter(hit => {
    if (!(hit.object as THREE.Line).isLine) return true;
    const screen = hit.point.clone().project(camera);
    const dx = (screen.x - pointer.x) * size.width / 2;
    const dy = (screen.y - pointer.y) * size.height / 2;
    // Roads behind a roof/facade are hidden by depth testing, even if the
    // forgiving line raycast reports a nearby point along the ray.
    return Math.hypot(dx, dy) <= 3 && (!nearestSolid || hit.distance <= nearestSolid.distance + .01);
  });
}

export function featureForHit(hit: THREE.Intersection): Feature | undefined {
  const metadata = hit.object.userData.mapBatch;
  if (!metadata) return hit.object.userData.mapFeature;
  const { batch, features } = metadata;
  const index = batch.kind === 'instances' ? batch.indices?.[hit.instanceId!] : featureAt(batch.ranges, batch.kind === 'line' ? hit.index! : hit.faceIndex! * 3);
  return index === undefined ? undefined : features[index];
}
